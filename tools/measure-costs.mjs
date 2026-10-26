// LIVE cost measurement for the Pro offer. Never run in CI, never deployed,
// never against production.
//
// Drives the REAL handlers (estimate, research, ingredient), the real
// metering and the real ledger SQL against a throwaway database on your local
// Postgres. Only the provider call is live. Every number it reports comes from
// the provider's own usage block, priced by the server's costFromUsage, and the
// reservation beside it is what the ledger actually held.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres \
//   ANTHROPIC_API_KEY=<a DEVELOPMENT key, not the production one> \
//   AGNI_MEASURE_LIVE=1 AGNI_MEASURE_MAX_USD=3 \
//   node tools/measure-costs.mjs [--photos dir] [--labels dir] [--rounds 3] [--out file.json]
//
// --photos / --labels: folders of JPEG or PNG food photos and nutrition labels
//   (stock or synthetic, never somebody's own meals). Resized with `sips` the
//   way the app does: 1568px long edge, and 512px for the drink check. Without
//   them the app's fixture image is used, which is a plain block: right for
//   INPUT tokens, wrong for output (the model says there is no food), and the
//   report says so.
//
// Refuses to start without AGNI_MEASURE_LIVE=1 and a key, and stops as soon as
// spend reaches AGNI_MEASURE_MAX_USD (default $3). Nothing is logged but
// tokens, cost, timings and outcomes: no prompt text, no reply text, no key.

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as h from '../test/helpers/harness.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const key = process.env.ANTHROPIC_API_KEY;
// DRY RUN: the provider is a stub, so the wiring (handlers, ledger, report) can
// be checked without a key. Its figures are NOT measurements and say so.
const DRY = process.env.AGNI_MEASURE_DRYRUN === '1';
const LIVE = DRY || (process.env.AGNI_MEASURE_LIVE === '1' && !!key);
const MAX_USD = Number(process.env.AGNI_MEASURE_MAX_USD || 3);
const ROUNDS = Number(option('--rounds', 3));
const OUT = option('--out', path.join(import.meta.dirname, '..', 'measurements', `costs-${new Date().toISOString().slice(0, 10)}.json`));

if (!LIVE) {
  console.error('Refusing: set AGNI_MEASURE_LIVE=1 and ANTHROPIC_API_KEY (a development key). This spends real money, capped by AGNI_MEASURE_MAX_USD.');
  process.exit(2);
}
if (!h.enabled) { console.error('AGNI_TEST_PG is required (a local, throwaway Postgres).'); process.exit(2); }

const bodies = JSON.parse(readFileSync(path.join(import.meta.dirname, '../test/fixtures/measure/request-bodies.json'), 'utf8'));
const template = name => JSON.parse(bodies[name]);

// MARK: - Images, resized the way the app resizes

function images(dir, edge) {
  if (!dir) return [];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'agni-measure-'));
  return readdirSync(dir).filter(f => /\.(jpe?g|png|heic)$/i.test(f)).sort().map(f => {
    const out = path.join(scratch, `${edge}-${f}.jpg`);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', String(edge),
                          path.join(dir, f), '--out', out], { stdio: 'ignore' });
    return { name: f, data: readFileSync(out).toString('base64') };
  });
}
const fixtureImage = name => template(name).messages[0].content.find(c => c.type === 'image').source.data;
const photos = images(option('--photos'), 1568);
const checks = images(option('--photos'), 512);
const labels = images(option('--labels'), 1568);
const SYNTHETIC_ONLY = photos.length === 0;

function withImage(name, data, text) {
  const request = template(name);
  request.messages[0].content = request.messages[0].content.map(block =>
    block.type === 'image' ? { ...block, source: { ...block.source, data } }
      : block.type === 'text' && text ? { ...block, text } : block);
  return request;
}
function withText(name, from, to) {
  const request = template(name);
  request.messages[0].content = request.messages[0].content.map(block =>
    block.type === 'text' ? { ...block, text: block.text.replace(from, to) } : block);
  return request;
}
// The fixture's photo text carries a cap-testing clue of 60 a's; a real one has none.
const PHOTO_TEXT = 'The cuisine is not specified. Work it out from the photograph. Richness: restaurant.\nEstimate this meal.';

// MARK: - The environment: real handlers, local ledger, live provider

h.setTestEnv({ ANTHROPIC_API_KEY: DRY ? 'dry-run' : key, BILLING_ENFORCED: 'true' });
h.freshDatabase('measure');
const realFetch = DRY
  ? async (url, options) => {
      const body = JSON.parse(options.body);
      if (options.signal?.aborted || (options.signal && body.max_tokens > 64 && false)) throw new Error('aborted');
      await new Promise(r => setTimeout(r, 20));
      const searches = body.tools ? 2 : 0;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: searches } } }),
        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'dry' } });
    }
  : globalThis.fetch;
h.installFetch();
const harnessFetch = globalThis.fetch;
let spent = 0;
const provider = [];
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://api.anthropic.com/v1/messages') return harnessFetch(url, options);
  if (spent >= MAX_USD) throw new Error(`measurement cap of $${MAX_USD} reached`);
  const started = Date.now();
  const res = await realFetch(url, options);
  const copy = res.clone();
  let usage = null;
  try { usage = (await copy.json()).usage || null; } catch { /* not JSON */ }
  provider.push({ status: res.status, ms: Date.now() - started, usage, model: JSON.parse(options.body).model });
  return res;
};
const { costFromUsage } = await import('../api/_billing.js');
const estimateHandler = (await import('../api/estimate.js')).default;
const researchHandler = (await import('../api/research.js')).default;
const ingredientHandler = (await import('../api/ingredient.js')).default;

// A fresh Pro subscriber per round, so the burst guard (25 a day) and the
// monthly counts never shape what is being measured.
let dev;
async function freshSubscriber() {
  dev = await h.device();
  await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
}
await freshSubscriber();
const id = prefix => `${prefix}-${randomBytes(6).toString('hex')}`;

// MARK: - Recording

const results = [];
async function run(scenario, feature, call) {
  const before = provider.length;
  const requestId = id('r');
  const started = Date.now();
  let res;
  try { res = await call(requestId); } catch (error) { res = { statusCode: 0, error: error.message }; }
  const calls = provider.slice(before);
  const providerUsd = calls.reduce((sum, c) => sum + (c.usage ? costFromUsage(c.model, c.usage) : 0), 0);
  spent += providerUsd;
  const [ledger] = await h.sqlJSON(`select reserved_usd::float as reserved, actual_usd::float as actual, status, outcome,
      input_tokens, output_tokens, cache_read_tokens, web_searches
      from agni_usage_events where request_id = '${requestId}'`);
  const row = {
    scenario, feature, http: res.statusCode, ms: Date.now() - started, providerCalls: calls.length,
    providerStatus: calls.map(c => c.status), providerUsd: Number(providerUsd.toFixed(6)),
    reservedUsd: ledger?.reserved ?? null, settledUsd: ledger?.actual ?? null, ledgerStatus: ledger?.status ?? null,
    outcome: ledger?.outcome ?? null,
    inputTokens: calls.reduce((s, c) => s + (c.usage?.input_tokens || 0), 0),
    outputTokens: calls.reduce((s, c) => s + (c.usage?.output_tokens || 0), 0),
    webSearches: calls.reduce((s, c) => s + (c.usage?.server_tool_use?.web_search_requests || 0), 0)
  };
  results.push(row);
  console.log(`${scenario.padEnd(28)} ${String(row.http).padEnd(4)} $${row.providerUsd.toFixed(4)} `
    + `reserved $${(row.reservedUsd ?? 0).toFixed(4)} in ${row.inputTokens} out ${row.outputTokens} `
    + `web ${row.webSearches} ${row.ms} ms ${row.outcome ?? ''}`);
  return res;
}
const estimate = (feature, request, actionId = id('a')) => requestId =>
  h.estimate(estimateHandler, dev, { feature, actionId, requestId, request });

// MARK: - Scenarios

const DISHES = ['Chicken biryani', 'Masala dosa with sambar', 'Spaghetti carbonara', 'Chicken caesar salad',
                'Beef pho', 'Paneer butter masala with two rotis', 'Pepperoni pizza, two slices', 'Greek yogurt with granola'];
const SEARCHES = ['kothu parotta', 'chicken shawarma wrap', 'pad thai', 'idli', 'burrito bowl', 'ramen', 'chole bhature', 'poke bowl'];
const WEB = ['moringa leaves', 'jackfruit seeds', 'sattu flour', 'teff flour'];

for (let round = 0; round < ROUNDS; round += 1) {
  if (round > 0) await freshSubscriber();
  // A PHOTO: the routing drink check and the estimate, one action, as the app sends them.
  const photoSet = SYNTHETIC_ONLY ? [{ data: fixtureImage('photo'), check: fixtureImage('drink_check') }]
    : photos.map((p, i) => ({ data: p.data, check: checks[i].data }));
  for (const p of photoSet) {
    const action = id('photo');
    await run('photo: drink check', 'drink_check', estimate('drink_check', withImage('drink_check', p.check), action));
    await run('photo: estimate', 'photo', estimate('photo', withImage('photo', p.data, PHOTO_TEXT), action));
  }
  const labelSet = labels.length ? labels : [{ data: fixtureImage('label') }];
  for (const l of labelSet) await run('label', 'label', estimate('label', withImage('label', l.data)));
  await run('drink (typed)', 'drink_id', estimate('drink_id', template('drink')));

  // A SEARCH is several calls on one action: research, then the variants.
  for (const query of SEARCHES.slice(round * 3 % SEARCHES.length).slice(0, 3)) {
    const action = id('search');
    const q = `${query} ${round}-${randomBytes(2).toString('hex')}`;   // defeats the shared cache: this measures misses
    await run('search: research', 'research', requestId => h.attestedPost(researchHandler, dev, '/api/research',
      { query: q, installId: dev.installId, actionId: action, requestId }));
    await run('search: variants', 'variant_search', estimate('variant_search', withText('variant', 'kothu parotta', query), action));
  }
  for (const dish of DISHES.slice(round * 3 % DISHES.length).slice(0, 3)) {
    await run('breakdown', 'breakdown', estimate('breakdown', withText('breakdown', 'Chicken biryani', dish)));
  }
  // WEB LOOKUPS: the two routes that search the web.
  const web = WEB[round % WEB.length];
  await run('web: ingredient', 'ingredient', requestId => h.attestedPost(ingredientHandler, dev, '/api/ingredient',
    { query: `${web} ${randomBytes(2).toString('hex')}`, installId: dev.installId, actionId: id('a'), requestId }));
  await run('web: research retrieve', 'research', requestId => h.attestedPost(researchHandler, dev, '/api/research',
    { query: `${web} nutrition ${randomBytes(2).toString('hex')}`, retrieve: true, installId: dev.installId,
      actionId: id('a'), requestId }));
}

// FAILURES, each once: what a failed call costs and what it leaves reserved.
{
  // Truncated: the reply cut off by the token limit, which the app cannot parse.
  const truncated = withImage('photo', SYNTHETIC_ONLY ? fixtureImage('photo') : photos[0].data, PHOTO_TEXT);
  truncated.max_tokens = 64;
  await run('failure: truncated photo', 'photo', estimate('photo', truncated));
  // Refused before the provider: an image over the edge limit (should cost $0).
  const huge = withImage('photo', Buffer.alloc(10).toString('base64'));
  await run('failure: unreadable image', 'photo', estimate('photo', huge));
  // Provider timeout: the request aborted mid-flight; the ledger settles it.
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url) === 'https://api.anthropic.com/v1/messages'
    ? saved(url, { ...options, signal: AbortSignal.timeout(300) }) : saved(url, options);
  await run('failure: provider timeout', 'photo', estimate('photo', withImage('photo', fixtureImage('photo'), PHOTO_TEXT)));
  globalThis.fetch = saved;
}

// MARK: - Caching, measured SEPARATELY and directly against the provider
//
// The server does not set cache_control today. This asks what it would save:
// the same Sonnet photo prefix sent twice with the system prompt marked
// cacheable, comparing cache writes and reads. Different images, same prefix,
// so the image is never what is cached.
const caching = [];
{
  const cacheable = data => {
    const request = withImage('photo', data, PHOTO_TEXT);
    request.system = [{ type: 'text', text: typeof request.system === 'string' ? request.system : JSON.stringify(request.system),
                        cache_control: { type: 'ephemeral' } }];
    return request;
  };
  const pair = SYNTHETIC_ONLY ? [fixtureImage('photo'), fixtureImage('label')] : [photos[0].data, (photos[1] || photos[0]).data];
  for (const [i, data] of pair.entries()) {
    if (spent >= MAX_USD) break;
    const request = cacheable(data);
    const res = await realFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', body: JSON.stringify(request),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    });
    const usage = (await res.json()).usage || {};
    const usd = costFromUsage(request.model, usage);
    spent += usd;
    caching.push({ call: i + 1, http: res.status, usd: Number(usd.toFixed(6)), input: usage.input_tokens,
                   cacheWrite: usage.cache_creation_input_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0,
                   output: usage.output_tokens });
    console.log(`cache probe ${i + 1}: $${usd.toFixed(4)} write ${caching.at(-1).cacheWrite} read ${caching.at(-1).cacheRead}`);
  }
}

// MARK: - Summary

const summary = {};
for (const r of results.filter(r => r.http === 200)) {
  const s = summary[r.scenario] ??= { n: 0, usd: [], reserved: [] };
  s.n += 1; s.usd.push(r.providerUsd); if (r.reservedUsd != null) s.reserved.push(r.reservedUsd);
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const s of Object.values(summary)) {
  Object.assign(s, { mean: s.usd.reduce((a, b) => a + b, 0) / s.n, p50: pct(s.usd, 0.5), p90: pct(s.usd, 0.9),
                     max: Math.max(...s.usd), reservedMax: s.reserved.length ? Math.max(...s.reserved) : null });
}
const report = {
  dryRun: DRY, measuredAt: new Date().toISOString(), rounds: ROUNDS, spentUsd: Number(spent.toFixed(4)), capUsd: MAX_USD,
  syntheticImagesOnly: SYNTHETIC_ONLY,
  note: DRY ? 'DRY RUN: stub provider, figures are not measurements.' : SYNTHETIC_ONLY ? 'Photo and label OUTPUT costs are understated: the fixture image is a plain block. Re-run with --photos and --labels.' : null,
  summary, caching, calls: results
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nspent $${spent.toFixed(4)} of a $${MAX_USD} cap; written to ${OUT}`);
h.dropDatabase();
