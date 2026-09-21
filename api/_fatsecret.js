// PARKED, NOT DELETED, AND ONE `git mv` FROM RETURNING.
//
// Vercel's Hobby plan allows twelve Serverless Functions per deployment and
// /api/ingredient was the thirteenth. This adapter is the one that costs
// nothing to stand down: it is under evaluation, it is blocked upstream by an
// IP allow-list that Vercel's rotating egress cannot satisfy, its policy says
// `approvedForProduction: false`, and `FatSecretProvider()` is not constructed
// anywhere in the app -- not in the shipping registry, not in the bake-off.
// Nothing calls it, so nothing breaks.
//
// The leading underscore is what makes it stop being a route. The code is
// untouched below. To bring it back: rename to fatsecret.js and restore its
// entry in vercel.json.
import { json, report } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';

/// FatSecret Platform, proxied.
///
/// UNDER EVALUATION, NOT IN PRODUCTION. This exists to answer one question:
/// does FatSecret carry the branded and chain products Agni still cannot
/// resolve, particularly British and Indian ones. Nothing here is wired into
/// the ordinary resolution policy.
///
/// METERED ON READ, like FoodData Central and for the same reason: the free
/// tier costs nothing, so charging it against the research class would spend a
/// budget it does not use. What needs protecting is a daily call ceiling.
///
/// THE KEY PAIR NEVER LEAVES THE SERVER, and neither does the access token.
/// OAuth 2.0 client credentials are exchanged here and the token is held in
/// module memory for its lifetime, so a warm function does not re-authenticate
/// on every lookup.
const TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
const API_URL = 'https://platform.fatsecret.com/rest/server.api';

let cachedToken = null;
let cachedTokenExpiry = 0;

async function accessToken() {
  const now = Date.now();
  // A minute of margin, so a token cannot expire between being checked and
  // being used.
  if (cachedToken && now < cachedTokenExpiry - 60_000) return cachedToken;

  const id = process.env.FATSECRET_CLIENT_ID;
  const secret = process.env.FATSECRET_CLIENT_SECRET;
  if (!id || !secret) throw new Error('FATSECRET credentials are not set');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
    },
    body: 'grant_type=client_credentials&scope=basic',
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`token endpoint returned ${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error('token endpoint returned no token');
  cachedToken = body.access_token;
  cachedTokenExpiry = now + Number(body.expires_in || 86400) * 1000;
  return cachedToken;
}

/// FatSecret's v1 shape writes the whole panel into one sentence:
/// "Per 100g - Calories: 250kcal | Fat: 12.10g | Carbs: 32.60g | Protein: 4.30g"
///
/// Read rather than guessed at: every figure is captured with its unit, and a
/// description that does not parse yields nothing rather than a partial panel,
/// because half a panel priced as a whole one is worse than no answer.
export function readDescription(text) {
  if (typeof text !== 'string' || !text) return null;
  const portion = text.match(/^Per\s+([^-]+?)\s*-/i);
  const energy = text.match(/Calories:\s*([\d.]+)\s*kcal/i);
  const fat = text.match(/Fat:\s*([\d.]+)\s*g/i);
  const carbs = text.match(/Carbs:\s*([\d.]+)\s*g/i);
  const protein = text.match(/Protein:\s*([\d.]+)\s*g/i);
  if (!energy) return null;
  const grams = portion ? portion[1].match(/([\d.]+)\s*g\b/i) : null;
  return {
    serving_description: portion ? portion[1].trim() : null,
    serving_grams: grams ? Number(grams[1]) : null,
    kcal: Number(energy[1]),
    fat_g: fat ? Number(fat[1]) : 0,
    carbs_g: carbs ? Number(carbs[1]) : 0,
    protein_g: protein ? Number(protein[1]) : 0
  };
}

/// One food, trimmed to what the app uses and to what may be recorded.
function trim(food) {
  const panel = readDescription(food.food_description);
  if (!panel) return null;
  return {
    food_id: String(food.food_id || ''),
    name: String(food.food_name || ''),
    brand: food.brand_name ? String(food.brand_name) : null,
    food_type: food.food_type ? String(food.food_type) : null,
    ...panel
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only.' });

  const auth = await authenticate(req, {
    meterClass: MeterClass.read,
    path: '/api/fatsecret',
    query: req.query || {},
    rawBody: ''
  });
  recordAuth('fatsecret', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    return json(res, auth.status || 401, { error: 'Unauthorized' });
  }

  const query = String(req.query?.q || '').trim();
  if (query.length < 2) return json(res, 200, { foods: [] });

  const started = Date.now();
  let token;
  try {
    token = await accessToken();
  } catch (error) {
    report('fatsecret token', error);
    // NOT notFound. The app caches "there is no such food" and must never
    // cache "this provider could not authenticate".
    return json(res, 503, { error: 'unavailable', reason: 'not_configured' });
  }

  const url = new URL(API_URL);
  url.searchParams.set('method', 'foods.search');
  url.searchParams.set('search_expression', query);
  url.searchParams.set('max_results', '10');
  url.searchParams.set('format', 'json');

  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 429) {
      return json(res, 429, { error: 'unavailable', reason: 'rate_limited' });
    }
    if (!response.ok) {
      report('fatsecret', new Error(`search returned ${response.status}`));
      return json(res, 503, { error: 'unavailable', reason: 'upstream' });
    }
    const body = await response.json();
    // FatSecret reports its own errors inside a 200.
    if (body?.error) {
      report('fatsecret', new Error(String(body.error.message || 'api error')));
      const code = Number(body.error.code);
      // 12 and 13 are rate and quota in FatSecret's error table.
      const rateLimited = code === 12 || code === 13;
      return json(res, rateLimited ? 429 : 503,
                  { error: 'unavailable', reason: rateLimited ? 'rate_limited' : 'upstream' });
    }
    const list = body?.foods?.food;
    const foods = (Array.isArray(list) ? list : list ? [list] : [])
      .map(trim).filter(Boolean);
    res.setHeader('cache-control', 'no-store');
    return json(res, 200, { foods, took_ms: Date.now() - started });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    report('fatsecret', error);
    return json(res, 503, { error: 'unavailable', reason: timedOut ? 'timeout' : 'upstream' });
  }
}
