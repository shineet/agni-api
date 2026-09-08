import { authorised, cachedVariants, cacheVariants, json, report } from './_lib.js';

/// The cache in front of the variant search.
///
/// GET  ?q=milk+tea          the answer somebody else already paid for
/// POST { query, variants }  keep this one for the next person
///
/// Both halves fail quietly. A cache that cannot be reached must cost nothing
/// but the time it took to ask: the app falls through to the model on a miss
/// and carries on without the store on a failed write, and neither is worth a
/// banner over somebody's dinner.
export default async function handler(req, res) {
  if (!authorised(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET') {
    const key = String(req.query?.q || '').trim().toLowerCase();
    if (key.length < 4 || key.length > 60) {
      json(res, 200, { variants: null });
      return;
    }
    try {
      json(res, 200, { variants: await cachedVariants(key) });
    } catch (error) {
      report('variants/get', error);
      json(res, 200, { variants: null });
    }
    return;
  }

  if (req.method === 'POST') {
    const key = String(req.body?.query || '').trim().toLowerCase();
    const variants = Array.isArray(req.body?.variants) ? req.body.variants : [];
    if (key.length < 4 || key.length > 60 || !variants.length) {
      json(res, 200, { stored: false });
      return;
    }
    try {
      // Capped, so one odd answer cannot put a novel in the table.
      await cacheVariants(key, variants.slice(0, 3));
      json(res, 200, { stored: true });
    } catch (error) {
      report('variants/put', error);
      json(res, 200, { stored: false });
    }
    return;
  }

  json(res, 405, { error: 'Method not allowed' });
}
