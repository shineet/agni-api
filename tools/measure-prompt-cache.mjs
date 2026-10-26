// Measures whether shared-prefix prompt caching saves anything on a real
// Agni request, WITHOUT changing what the model is asked.
//
//   ANTHROPIC_API_KEY=... node tools/measure-prompt-cache.mjs request.json [runs]
//
// request.json is one Messages body exactly as the app sends it (Settings >
// Advanced > a DEBUG build can dump one; the `request` field of an
// /api/estimate envelope is the same thing). The script sends it `runs` times
// (default 4) with the system prompt marked cacheable, a few seconds apart,
// and prints the usage the provider reports for each: a working cache shows
// cache_creation on the first call and cache_read on the rest. It then prints
// what each call cost and what it would have cost uncached.
//
// WHAT TO LOOK FOR
//   * cache_read_input_tokens > 0 on calls 2..n: the prefix is long enough
//     and caching works for this feature. Enable it with
//     PROMPT_CACHE_FEATURES=photo,label (etc.) on Vercel.
//   * cache_creation and cache_read both 0: the prefix is below the model's
//     minimum cacheable length. Caching cannot help this feature as built.
//   * Compare the answers: the content must match an uncached run's quality.
//     Caching changes billing, not the prompt, but check rather than assume.
//
// It spends real money: about two to eight cents for four photo calls.

import { readFileSync } from 'node:fs';
import { costFromUsage, withPromptCache } from '../api/_billing.js';

const [file, runsArg] = process.argv.slice(2);
if (!file || !process.env.ANTHROPIC_API_KEY) {
  console.error('usage: ANTHROPIC_API_KEY=... node tools/measure-prompt-cache.mjs request.json [runs]');
  process.exit(2);
}
const runs = Number(runsArg || 4);
const request = JSON.parse(readFileSync(file, 'utf8'));
const cached = withPromptCache(request);
let total = 0;
let uncached = 0;
for (let i = 1; i <= runs; i += 1) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
               'anthropic-version': '2023-06-01' },
    body: JSON.stringify(cached),
    signal: AbortSignal.timeout(60_000)
  });
  const body = await response.json();
  const u = body.usage || {};
  const cost = costFromUsage(request.model, u);
  const plain = costFromUsage(request.model, {
    input_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    output_tokens: u.output_tokens || 0 });
  total += cost;
  uncached += plain;
  console.log(`run ${i}: status ${response.status} input ${u.input_tokens} output ${u.output_tokens} ` +
              `cache_write ${u.cache_creation_input_tokens || 0} cache_read ${u.cache_read_input_tokens || 0} ` +
              `cost $${cost.toFixed(5)} (uncached $${plain.toFixed(5)})`);
  await new Promise(r => setTimeout(r, 3000));
}
console.log(`total $${total.toFixed(5)} vs $${uncached.toFixed(5)} uncached: ` +
            `${(100 * (1 - total / uncached)).toFixed(1)}% saved over ${runs} calls`);
