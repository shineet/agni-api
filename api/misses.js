import { json, report, reportMiss } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';

/// What Agni did not know, from every phone.
///
/// Write only. There is no GET, deliberately: nothing in the app reads this
/// back and an endpoint that could serve it would be a way to enumerate what
/// other people have been eating. The list is read in the Supabase console by
/// the one person deciding what to build next.
///
///   POST /api/misses { misses: [...] }   header x-agni-install
export default async function handler(req, res) {
  // ATTESTATION FIRST, LEGACY STILL ACCEPTED. Backwards compatible by
  // construction: the only change here is additional acceptance, so every
  // client already in the field keeps working unchanged. Metered on the READ
  // class, which has its own counters -- a dish search must never consume the
  // ten-per-minute allowance that photo estimation depends on.
  const auth = await authenticate(req, {
    meterClass: MeterClass.read,
    path: '/api/misses',
    query: req.query || {},
    rawBody: typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '')
  });
  recordAuth('misses', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    json(res, auth.status || 401, { error: 'Unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  const installId = String(req.headers['x-agni-install'] || '').trim();
  if (installId.length < 8) {
    json(res, 400, { error: 'Missing install id.' });
    return;
  }

  const submitted = Array.isArray(req.body?.misses) ? req.body.misses : [];
  if (!submitted.length) {
    json(res, 200, { accepted: 0 });
    return;
  }

  // A phone that has been used for a year might have a long list; anything past
  // this is dropped rather than refused, because the app is uploading in the
  // background and has nothing useful to do with an error.
  let accepted = 0;
  for (const miss of submitted.slice(0, 200)) {
    const key = String(miss?.key || '').trim();
    const name = String(miss?.name || '').trim();
    const kind = String(miss?.kind || '').trim();
    if (key.length < 3 || !name || !kind) continue;
    try {
      await reportMiss(installId, { ...miss, key, name, kind });
      accepted += 1;
    } catch (error) {
      // One bad row must not lose the rest of the list.
      report('misses/report', error);
    }
  }

  json(res, 200, { accepted });
}
