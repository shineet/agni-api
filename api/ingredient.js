import { json, report, costOfUsage } from './_lib.js';
import { authenticate, recordAuth, MeterClass, researchEnabled } from './_auth.js';

/// Look up what one INGREDIENT contains, on the public web, with sources.
///
/// WHY THIS IS NOT A MODE OF /api/research. That endpoint's contract is
/// "ingredients, never calories", and the prohibition is load-bearing: it is
/// what stops a model's arithmetic becoming Agni's. Asking it a nutrition
/// question does not merely bend that contract, it BREAKS the endpoint --
/// measured at 40% malformed responses, because a model told never to give
/// calories and then asked for calories stops producing the schema at all.
/// "spinach" succeeded and "spinach raw nutrition per 100 g" did not.
///
/// So this is a separate route with a separate contract, and research.js is
/// left exactly as it is.
///
/// WHAT MAKES A FIGURE SOURCED. Only a number a page actually published, on a
/// page something actually fetched. Citations are read from the retrieval
/// tool's own result blocks, never from the model's prose, for the reason
/// research.js already gives: a URL a model writes is a string shaped like a
/// citation. With no retrieved evidence there is no sourced nutrition here,
/// and the endpoint says so rather than answering from memory.
///
/// EVERY FIGURE CARRIES ITS OWN IDENTITY. A page about banana flower can quote
/// nutrition for banana FRUIT, for banana flower COOKIES, or for dried banana
/// POWDER, and all three were seen in the live inspection. So a result says
/// which food ITS number describes, and the client refuses the ones that do
/// not match. Validating the page title would have accepted all three.
///
/// Metered as research, on the existing budget and the existing kill switch.
/// POST { query, form }.
const MODEL = process.env.RESEARCH_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = 45000;
/// $10 per 1,000 searches, published. Same figure research.js records.
const SEARCH_COST_USD = 0.01;

const SYSTEM = `You research the nutrition of ONE ingredient using web search.

Search first. Answer ONLY with JSON in this exact shape:
{"identity":{"canonical_name":"","also_known_as":[],"scientific_name":null},
 "results":[{"source_name":"","source_url":"","source_tier":1,
             "declared_upstream":null,"source_identity":"",
             "form":null,"form_stated":false,
             "basis":{"kind":"per_100g","grams":null},
             "nutrition":{"kcal":0,"protein_g":null,"carbs_g":null,"fat_g":null},
             "extraction":"stated_in_text"}],
 "notes":""}

THE FIGURE'S OWN IDENTITY IS THE MOST IMPORTANT FIELD.
- source_identity is the food THE NUMBER describes, as that page words it, not
  the page's title and not what was asked for. A page about banana flower that
  quotes banana fruit, banana flower cookies, or dried banana powder must
  record THAT food in source_identity. Do not silently relabel it.
- If you cannot tell which food a number is for, leave the result out.

FORM.
- form is one of: raw, cooked, dried, powder, fried, roasted, canned, brine,
  frozen -- or null.
- Set form ONLY when the source states it. Set form_stated accordingly.
- NEVER write "raw" because the page did not say. Silence is null, not raw.

BASIS AND ARITHMETIC.
- kind is "per_100g", "per_serving" or "per_piece".
- For per_serving or per_piece you MUST give the gram weight the source itself
  states, in grams. If the source does not state a weight, use that basis with
  grams null and do NOT convert.
- You may convert ounces to grams (1 oz = 28.3495 g) and you may convert a
  stated gram weight to 100 g. Mark those "converted_from_stated_weight".
- NEVER convert cups, tablespoons or "1 piece" without a stated weight. That
  needs a density nobody gave you.

SOURCES.
- source_url must be a page the search actually returned. Never write a URL
  from memory.
- source_tier: 1 government/national food-composition database. 2 university,
  academic or peer-reviewed food-composition data. 3 recognised health
  institution. 4 manufacturer panel for that exact product. 5 nutrition
  database or aggregator. 6 food publication or recipe site. 7 blog or
  ordinary website.
- declared_upstream: if the page says where its data came from ("taken from
  the ASEAN food composition tables"), put that here verbatim.
- extraction: "stated_in_text" when the number is written on the page,
  "converted_from_stated_weight" when you did the arithmetic above, or
  "image_only" when the page has the data only inside an image. For image_only
  leave nutrition values null.

WHAT YOU MAY NOT DO.
- Never invent a nutrition value, and never fill a missing macro from memory.
  Unknown macros are null. A missing number is not a zero.
- Never average or reconcile sources. Report each separately and let them
  disagree.
- Never claim two names are the same food unless a source you retrieved says
  so. Put such a name in also_known_as only with that evidence.
- If searching finds no usable published figure, return results: [] and say
  why in notes. That is a correct answer.`;

/// Every page the RETRIEVAL actually fetched. Not the model's prose.
function citedURLs(payload) {
  const found = new Set();
  for (const block of payload?.content || []) {
    if (block.type === 'web_search_tool_result') {
      for (const item of block.content || []) if (item?.url) found.add(item.url);
    }
    for (const citation of block?.citations || []) if (citation?.url) found.add(citation.url);
  }
  return found;
}

const FORMS = new Set(['raw', 'cooked', 'dried', 'powder', 'fried', 'roasted',
                       'canned', 'brine', 'frozen']);
const BASES = new Set(['per_100g', 'per_serving', 'per_piece']);
const EXTRACTIONS = new Set(['stated_in_text', 'converted_from_stated_weight', 'image_only']);

function macro(value) {
  const number = Number(value);
  // NULL IS A VALUE HERE. An absent macro is unknown, and writing zero would
  // be the same lie the app spent three commits removing from its own tables.
  if (value === null || value === undefined || !Number.isFinite(number)) return null;
  if (number < 0 || number > 1000) return null;
  return Math.round(number * 100) / 100;
}

/// One result, kept only if it is genuinely sourced and internally consistent.
function cleanResult(raw, cited) {
  const url = String(raw?.source_url || '').trim();
  // THE GATE. A figure whose page nothing fetched is model knowledge wearing a
  // link, and it does not leave this function.
  if (!cited.has(url)) return null;

  const extraction = EXTRACTIONS.has(raw?.extraction) ? raw.extraction : 'stated_in_text';
  const kcal = macro(raw?.nutrition?.kcal);
  if (extraction !== 'image_only' && (kcal === null || kcal <= 0)) return null;

  const kind = BASES.has(raw?.basis?.kind) ? raw.basis.kind : 'per_100g';
  const grams = Number(raw?.basis?.grams);
  const weighed = Number.isFinite(grams) && grams > 0 && grams <= 5000;
  // A serving with no weight cannot be turned into 100 g by this endpoint or
  // by anything downstream. It is reported as it stands and the client refuses
  // to count it.
  if (kind !== 'per_100g' && !weighed) return null;

  const stated = raw?.form_stated === true;
  const form = stated && FORMS.has(raw?.form) ? raw.form : null;

  return {
    source_name: String(raw?.source_name || '').trim().slice(0, 120) || url.slice(0, 120),
    source_url: url.slice(0, 500),
    source_tier: [1, 2, 3, 4, 5, 6, 7].includes(Number(raw?.source_tier))
      ? Number(raw.source_tier) : 7,
    declared_upstream: String(raw?.declared_upstream || '').trim().slice(0, 160) || null,
    // NEVER DEFAULTED TO THE QUERY. An absent source_identity means the model
    // could not say which food the number was for, and that is exactly the
    // case the client has to be able to refuse.
    source_identity: String(raw?.source_identity || '').trim().slice(0, 160) || null,
    form,
    form_stated: stated && form !== null,
    basis: { kind, grams: weighed ? Math.round(grams * 10) / 10 : null },
    nutrition: {
      kcal,
      protein_g: macro(raw?.nutrition?.protein_g),
      carbs_g: macro(raw?.nutrition?.carbs_g),
      fat_g: macro(raw?.nutrition?.fat_g)
    },
    extraction
  };
}

/// How far two figures for one food may sit apart and still be one answer.
/// The same 0.35 the app uses, and the app's own comment explains it: 279 to
/// 333 kcal is four products and one sausage; 10 to 400 is not one ingredient.
const COHERENCE = 0.35;
/// Two figures this close are one measurement quoted twice, not two sources.
const DUPLICATE_KCAL = 0.5;

function agreementOf(results) {
  const usable = results.filter(r => r.nutrition.kcal !== null);
  if (usable.length === 0) return 'none';
  // An aggregator and the source it names are ONE source. So are two pages
  // printing the same number: copying is not corroboration.
  const distinct = [];
  for (const result of usable) {
    const upstream = (result.declared_upstream || '').toLowerCase();
    const duplicate = distinct.some(kept =>
      Math.abs(kept.nutrition.kcal - result.nutrition.kcal) <= DUPLICATE_KCAL
      || (upstream && upstream === (kept.declared_upstream || '').toLowerCase())
      || (upstream && upstream === kept.source_name.toLowerCase()));
    if (!duplicate) distinct.push(result);
  }
  if (distinct.length === 1) return 'single';
  const values = distinct.map(r => r.nutrition.kcal);
  const low = Math.min(...values), high = Math.max(...values);
  const midpoint = (low + high) / 2;
  if (midpoint <= 0) return 'conflicting';
  const spread = (high - midpoint) / midpoint;
  if (spread <= DUPLICATE_KCAL / 100) return 'corroborated';
  return spread <= COHERENCE ? 'variable' : 'conflicting';
}

function shape(parsed, cited) {
  const identity = parsed?.identity || {};
  const results = Array.isArray(parsed?.results)
    ? parsed.results.slice(0, 8).map(raw => cleanResult(raw, cited)).filter(Boolean)
    : [];
  return {
    identity: {
      canonical_name: String(identity.canonical_name || '').trim().slice(0, 120),
      // ONLY WITH EVIDENCE. The prompt forbids an unsourced equivalence and
      // this caps how far one can travel even when offered.
      also_known_as: Array.isArray(identity.also_known_as)
        ? identity.also_known_as.slice(0, 6).map(n => String(n).trim().slice(0, 80)).filter(Boolean)
        : [],
      scientific_name: String(identity.scientific_name || '').trim().slice(0, 80) || null
    },
    results,
    agreement: agreementOf(results),
    notes: String(parsed?.notes || '').trim().slice(0, 300)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
  const auth = await authenticate(req, {
    meterClass: MeterClass.research,
    path: '/api/ingredient',
    query: req.query || {},
    rawBody
  });
  recordAuth('ingredient', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    return json(res, auth.status || 401, { error: 'Unauthorized' });
  }

  // THE SAME KILL SWITCH. One switch stops all external food research, and
  // this endpoint does not get a private way to stay alive.
  if (!researchEnabled()) {
    return json(res, 503, { error: 'unavailable', reason: 'not_configured' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    report('ingredient', new Error('ANTHROPIC_API_KEY is not set'));
    return json(res, 503, { error: 'unavailable', reason: 'not_configured' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const query = String(body.query || '').trim().slice(0, 120);
  if (query.length < 2) return json(res, 400, { error: 'query too short' });
  const wantedForm = FORMS.has(body.form) ? body.form : null;

  const started = Date.now();
  const asked = wantedForm
    ? `${query} (${wantedForm}) -- nutrition per 100 g, with sources`
    : `${query} -- nutrition per 100 g, with sources`;

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        temperature: 0,
        system: SYSTEM,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: asked }]
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    report('ingredient', error);
    return json(res, 503, { error: 'unavailable', reason: timedOut ? 'timeout' : 'upstream' });
  }

  if (upstream.status === 429) return json(res, 429, { error: 'unavailable', reason: 'rate_limited' });
  if (!upstream.ok) {
    report('ingredient', new Error(`anthropic returned ${upstream.status}`));
    return json(res, 503, { error: 'unavailable', reason: 'upstream' });
  }

  let payload;
  try { payload = await upstream.json(); }
  catch { return json(res, 503, { error: 'unavailable', reason: 'malformed' }); }

  const text = (payload?.content || []).filter(part => part.type === 'text')
    .map(part => part.text).join('').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return json(res, 503, { error: 'unavailable', reason: 'malformed' });
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); }
  catch { return json(res, 503, { error: 'unavailable', reason: 'malformed' }); }

  const cited = citedURLs(payload);
  const result = shape(parsed, cited);
  const searches = Number(payload?.usage?.server_tool_use?.web_search_requests || 0);
  result.query = query;
  result.requested_form = wantedForm;
  // EVIDENCE IS WHAT WAS RETRIEVED. A run that searched and kept nothing
  // citable is model knowledge with a bigger bill, and says so.
  result.evidence = result.results.length > 0 ? 'retrieval_backed' : 'model_knowledge';
  result.cost_usd = costOfUsage(MODEL, payload?.usage) + searches * SEARCH_COST_USD;
  result.search_operations = searches;
  result.retrieved_at = new Date().toISOString();
  result.took_ms = Date.now() - started;
  result.model = MODEL;
  res.setHeader('cache-control', 'no-store');
  return json(res, 200, result);
}
