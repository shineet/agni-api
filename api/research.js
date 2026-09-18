import { json, report, costOfUsage } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';

/// Ask a model what a food IS, and what goes into it.
///
/// THIS IS MODEL KNOWLEDGE. IT IS NOT WEB RESEARCH, AND SAYING SO IS THE POINT.
/// The Anthropic configuration this project uses is the plain Messages API with
/// no tools and no web search, so nothing here retrieves a page, and no answer
/// from it has a source that could be checked. Every response is flagged
/// `evidence: "model_knowledge"` and carries no URL, because a URL a model
/// writes is a string that looks like a citation and is not one. If retrieval
/// is added later it gets its own flag, its own provenance and its own
/// confidence, and the two never share a label.
///
/// IT RETURNS INGREDIENTS, NEVER CALORIES. Any energy figure the model emits is
/// stripped here rather than trusted, so there is no path by which a model's
/// arithmetic becomes Agni's. RecipeCalculator prices the ingredients, exactly
/// as it does for a curated dish.
///
/// Metered on research. POST { query, hint }.
const MODEL = process.env.RESEARCH_MODEL || 'claude-haiku-4-5';
const UPSTREAM_TIMEOUT_MS = 20000;

const SYSTEM = `You identify foods for a nutrition app.

Answer ONLY with JSON in this exact shape:
{"identity":{"kind":"generic|dish|brand|restaurant|unknown",
             "canonical_name":"","brand":"","restaurant":"",
             "language":"","english_name":"","cuisine":"",
             "product_type":"","modifiers":[],"variant":""},
 "recipe":{"serving_grams":0,"servings":1,
           "ingredients":[{"name":"","grams":0}],
           "preparation":""},
 "certainty":"high|medium|low"}

Rules:
- NEVER give calories, kilojoules, protein, carbohydrate or fat. They are
  calculated elsewhere from the ingredients you list. Any nutrition figure you
  write will be discarded.
- NEVER give a URL, citation or source. You are not being asked to research;
  you are being asked what you already know.
- Ingredient names must be ordinary food words: "chicken, cooked", "wheat
  flour, white", "coconut milk". No brand names inside ingredients.
- grams are for ONE serving of serving_grams total.
- If the food is a packaged product or a restaurant item, set kind and the
  brand or restaurant, and leave recipe empty: a published panel is better than
  a guess at a recipe.
- For a packaged or restaurant item also give product_type, which is what sort
  of thing it is in ordinary words: "chocolate bar", "breakfast cereal", "steak
  bake pastry", "margherita pizza". This is used to reject a different product
  from the same company, so be specific about the FORM of the food.
- Put anything that changes which product it is in modifiers: "diet", "zero",
  "thin crust", "no cheese". Put a stated size in variant: "330ml", "grande".
- If you do not recognise the food, set kind to "unknown" and certainty to
  "low". Saying you do not know is a correct answer.
- Keep the original name in canonical_name when it is a real dish name in
  another language, and put the English in english_name.`;

/// Anything that smells like a nutrition figure, removed rather than trusted.
const BANNED = /^(kcal|calorie|calories|energy|kj|protein|carb|carbs|carbohydrate|fat|sugar|sodium)/i;

function cleanIngredients(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, 24)) {
    const name = String(item?.name || '').trim().slice(0, 80);
    const grams = Number(item?.grams);
    if (!name || BANNED.test(name)) continue;
    if (!Number.isFinite(grams) || grams <= 0 || grams > 2000) continue;
    out.push({ name, grams: Math.round(grams * 10) / 10 });
  }
  return out;
}

function shape(parsed) {
  const identity = parsed?.identity || {};
  const recipe = parsed?.recipe || {};
  const ingredients = cleanIngredients(recipe.ingredients);
  const servingGrams = Number(recipe.serving_grams);
  return {
    // NO source_url FIELD EXISTS. There is nowhere for a model to put one.
    evidence: 'model_knowledge',
    identity: {
      kind: ['generic', 'dish', 'brand', 'restaurant', 'unknown']
        .includes(identity.kind) ? identity.kind : 'unknown',
      canonical_name: String(identity.canonical_name || '').trim().slice(0, 120),
      brand: String(identity.brand || '').trim().slice(0, 80) || null,
      restaurant: String(identity.restaurant || '').trim().slice(0, 80) || null,
      language: String(identity.language || '').trim().slice(0, 16) || null,
      english_name: String(identity.english_name || '').trim().slice(0, 120) || null,
      cuisine: String(identity.cuisine || '').trim().slice(0, 40) || null,
      product_type: String(identity.product_type || '').trim().slice(0, 60) || null,
      modifiers: Array.isArray(identity.modifiers)
        ? identity.modifiers.slice(0, 6).map(m => String(m).trim().slice(0, 30)).filter(Boolean)
        : [],
      variant: String(identity.variant || '').trim().slice(0, 30) || null
    },
    recipe: ingredients.length > 0 ? {
      serving_grams: Number.isFinite(servingGrams) && servingGrams > 0
        ? Math.round(servingGrams)
        : ingredients.reduce((total, item) => total + item.grams, 0),
      ingredients,
      preparation: String(recipe.preparation || '').trim().slice(0, 200)
    } : null,
    certainty: ['high', 'medium', 'low'].includes(parsed?.certainty)
      ? parsed.certainty : 'low'
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
  const auth = await authenticate(req, {
    meterClass: MeterClass.research,
    path: '/api/research',
    query: req.query || {},
    rawBody
  });
  recordAuth('research', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    return json(res, auth.status || 401, { error: 'Unauthorized' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    report('research', new Error('ANTHROPIC_API_KEY is not set'));
    return json(res, 503, { error: 'unavailable', reason: 'not_configured' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const query = String(body.query || '').trim().slice(0, 200);
  if (query.length < 2) return json(res, 400, { error: 'query too short' });

  const started = Date.now();
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
        max_tokens: 900,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: query }]
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    report('research', error);
    return json(res, 503, { error: 'unavailable', reason: timedOut ? 'timeout' : 'upstream' });
  }

  if (upstream.status === 429) {
    return json(res, 429, { error: 'unavailable', reason: 'rate_limited' });
  }
  if (!upstream.ok) {
    report('research', new Error(`anthropic returned ${upstream.status}`));
    return json(res, 503, { error: 'unavailable', reason: 'upstream' });
  }

  let payload;
  try {
    payload = await upstream.json();
  } catch (error) {
    return json(res, 503, { error: 'unavailable', reason: 'malformed' });
  }

  const text = (payload?.content || []).filter(part => part.type === 'text')
    .map(part => part.text).join('').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return json(res, 503, { error: 'unavailable', reason: 'malformed' });
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return json(res, 503, { error: 'unavailable', reason: 'malformed' });
  }

  const result = shape(parsed);
  result.cost_usd = costOfUsage(MODEL, payload?.usage);
  result.took_ms = Date.now() - started;
  result.model = MODEL;
  res.setHeader('cache-control', 'no-store');
  return json(res, 200, result);
}
