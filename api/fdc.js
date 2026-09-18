import { json, report } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';

/// USDA FoodData Central, proxied.
///
/// WHY THIS IS A BACKEND ENDPOINT AND NOT A CALL FROM THE PHONE. FoodData
/// Central rate-limits to 1,000 requests an hour PER IP ADDRESS. Calling it
/// from devices would work perfectly in testing and then, the first time a few
/// hundred people used Agni from the same mobile network or the same office,
/// block all of them for an hour with no way to tell why. Proxying makes the
/// limit ours to see, ours to spread and ours to raise.
///
/// It also keeps the key off the phone, which is the ordinary reason, and the
/// less interesting one.
///
/// METERED ON THE READ CLASS. A food lookup must never be able to spend photo
/// estimation's allowance, which is what the separate classes are for. It is
/// READ rather than RESEARCH because FoodData Central is free: the research
/// class exists to cap money, and charging a free call against it starved the
/// one call in the chain that does cost something. What needs protecting here
/// is the thousand-an-hour request ceiling, which is what read is for.
///
/// GET ?q=<query>&kind=<search|barcode>
const FDC_SEARCH = 'https://api.nal.usda.gov/fdc/v1/foods/search';

/// The nutrient numbers FoodData Central uses. Read by id rather than by name,
/// because the names differ between data types and the ids do not.
const NUTRIENT = { energy: 1008, protein: 1003, fat: 1004, carbs: 1005 };

function nutrients(food) {
  const found = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const entry of food.foodNutrients || []) {
    const id = entry.nutrientId ?? entry.nutrient?.id;
    const value = Number(entry.value ?? entry.amount ?? 0);
    if (!Number.isFinite(value)) continue;
    if (id === NUTRIENT.energy) {
      // Some rows carry kilojoules as well. Take the kcal one.
      const unit = String(entry.unitName ?? entry.nutrient?.unitName ?? '').toLowerCase();
      if (unit === 'kj' && found.kcal) continue;
      found.kcal = unit === 'kj' ? value / 4.184 : value;
    }
    if (id === NUTRIENT.protein) found.protein_g = value;
    if (id === NUTRIENT.fat) found.fat_g = value;
    if (id === NUTRIENT.carbs) found.carbs_g = value;
  }
  return found;
}

/// What the app is told about one row.
///
/// TRIMMED ON PURPOSE. FoodData Central returns a large object per food and the
/// app needs six fields of it. Sending the rest would cost bandwidth on a
/// phone, and would put data in a response that nothing reads and everything
/// could start depending on.
function trim(food) {
  return {
    fdc_id: food.fdcId,
    name: food.description,
    brand: food.brandOwner || food.brandName || null,
    data_type: food.dataType || null,
    serving_grams: Number(food.servingSize) > 0
      && String(food.servingSizeUnit || '').toLowerCase() === 'g'
      ? Number(food.servingSize) : null,
    ingredients: food.ingredients || null,
    per_100g: nutrients(food)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only.' });

  const auth = await authenticate(req, {
    meterClass: MeterClass.read,
    path: '/api/fdc',
    query: req.query || {},
    rawBody: ''
  });
  recordAuth('fdc', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    return json(res, auth.status || 401, { error: 'Unauthorized' });
  }

  const key = process.env.USDA_FDC_API_KEY;
  if (!key) {
    report('fdc', new Error('USDA_FDC_API_KEY is not set'));
    // NOT FOUND WOULD BE A LIE. The app distinguishes "there is no such food"
    // from "this provider could not run", and caches the first. Saying the
    // wrong one here would teach the cache that real foods do not exist.
    return json(res, 503, { error: 'unavailable', reason: 'not_configured' });
  }

  const query = String(req.query?.q || '').trim();
  if (query.length < 2) return json(res, 200, { foods: [] });

  const url = new URL(FDC_SEARCH);
  url.searchParams.set('api_key', key);
  url.searchParams.set('query', query);
  url.searchParams.set('pageSize', '5');
  // NO dataType FILTER, AND THAT IS DELIBERATE TWICE OVER.
  //
  // Passing one produced a 400 from FoodData Central, because the list has to
  // contain "Survey (FNDDS)" with a space and brackets in it and the GET form
  // does not accept that shape.
  //
  // It should not be filtered anyway. The question this endpoint exists to
  // answer is how much a LIVE table adds over the extract already inside the
  // app, and narrowing it to the branded catalogue would decide that answer in
  // advance rather than measure it.

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (response.status === 429) {
      return json(res, 429, { error: 'unavailable', reason: 'rate_limited' });
    }
    if (!response.ok) {
      report('fdc', new Error(`FDC returned ${response.status}`));
      return json(res, 503, { error: 'unavailable', reason: 'upstream' });
    }
    const body = await response.json();
    const foods = (body.foods || []).map(trim);
    res.setHeader('cache-control', 'no-store');
    return json(res, 200, { foods, took_ms: Date.now() - started });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    report('fdc', error);
    return json(res, 503, { error: 'unavailable', reason: aborted ? 'timeout' : 'upstream' });
  }
}
