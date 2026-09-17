import { json, report, searchDishes, submitDish } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';

/// The shared dish table, both halves on one endpoint.
///
/// One file rather than two because Vercel's Hobby plan counts serverless
/// functions and this project would rather spend them on something else. The
/// two halves share nothing but the auth check, so the split is by method.
///
/// GET  ?q=kothu           search dishes other people have added
/// POST { dishes: [...] }  contribute, silently
export default async function handler(req, res) {
  // ATTESTATION FIRST, LEGACY STILL ACCEPTED. Backwards compatible by
  // construction: the only change here is additional acceptance, so every
  // client already in the field keeps working unchanged. Metered on the READ
  // class, which has its own counters -- a dish search must never consume the
  // ten-per-minute allowance that photo estimation depends on.
  const auth = await authenticate(req, {
    meterClass: MeterClass.read,
    path: '/api/dishes',
    query: req.query || {},
    rawBody: typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '')
  });
  recordAuth('dishes', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    json(res, auth.status || 401, { error: 'Unauthorized' });
    return;
  }

  const installId = String(
    req.headers['x-agni-install'] || req.query?.install_id || ''
  ).trim();

  if (req.method === 'GET') {
    const query = String(req.query?.q || '').trim();
    if (query.length < 2) {
      json(res, 200, { dishes: [] });
      return;
    }
    try {
      const dishes = await searchDishes(query, Number(req.query?.limit) || 15);
      json(res, 200, { dishes });
    } catch (error) {
      report('dishes/search', error);
      // Empty rather than an error status. Search that cannot reach the shared
      // table should quietly return nothing: the bundled table and the user's
      // own foods are still there, and a red banner over a network hiccup
      // helps nobody mid-meal.
      json(res, 200, { dishes: [] });
    }
    return;
  }

  if (req.method === 'POST') {
    if (installId.length < 8) {
      json(res, 400, { error: 'Missing install id.' });
      return;
    }

    const submitted = Array.isArray(req.body?.dishes) ? req.body.dishes : [];
    if (!submitted.length) {
      json(res, 200, { accepted: 0 });
      return;
    }

    // A cap per call, so a bug in a loop on one phone cannot fill the table.
    // Anything past it is dropped rather than refused: the app is contributing
    // in the background and has nothing useful to do with an error.
    const batch = submitted.slice(0, 25);
    let accepted = 0;
    for (const dish of batch) {
      const key = String(dish?.key || '').trim();
      const name = String(dish?.name || '').trim();
      const kcal = Number(dish?.kcal);
      if (key.length < 3 || !name || !Number.isFinite(kcal) || kcal <= 0) continue;
      try {
        await submitDish(installId, { ...dish, key, name, kcal });
        accepted += 1;
      } catch (error) {
        // One bad row must not lose the rest of the batch.
        report('dishes/submit', error);
      }
    }
    json(res, 200, { accepted });
    return;
  }

  json(res, 405, { error: 'Method not allowed' });
}
