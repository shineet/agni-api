import { checkQuota, json, report } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';

/// How many free estimates are left, so Settings can show it before someone
/// runs out rather than only at the moment they do.
export default async function handler(req, res) {
  // ATTESTATION FIRST, LEGACY STILL ACCEPTED. Backwards compatible by
  // construction: the only change here is additional acceptance, so every
  // client already in the field keeps working unchanged. Metered on the READ
  // class, which has its own counters -- a dish search must never consume the
  // ten-per-minute allowance that photo estimation depends on.
  const auth = await authenticate(req, {
    meterClass: MeterClass.read,
    path: '/api/quota',
    query: req.query || {},
    rawBody: typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '')
  });
  recordAuth('quota', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    return json(res, auth.status || 401,
      { error: { type: 'unauthorized', message: 'This device could not be verified.' } });
  }

  const installId = req.query?.installId;
  if (!installId || typeof installId !== 'string') {
    return json(res, 400, { error: { type: 'bad_install_id', message: 'Missing install id.' } });
  }

  try {
    const quota = await checkQuota(installId);
    return json(res, 200, quota);
  } catch (error) {
    report('quota check', error);
    return json(res, 503, { error: { type: 'quota_unavailable', message: 'Could not check usage.' } });
  }
}
