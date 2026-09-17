import { cachedVariants, cacheVariants, json, report } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';

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
  // ATTESTATION FIRST, LEGACY STILL ACCEPTED. Backwards compatible by
  // construction: the only change here is additional acceptance, so every
  // client already in the field keeps working unchanged. Metered on the READ
  // class, which has its own counters -- a dish search must never consume the
  // ten-per-minute allowance that photo estimation depends on.
  const auth = await authenticate(req, {
    meterClass: MeterClass.read,
    path: '/api/variants',
    query: req.query || {},
    rawBody: typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '')
  });
  recordAuth('variants', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    json(res, auth.status || 401, { error: 'Unauthorized' });
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
