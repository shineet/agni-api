import { authorised, json, report, reportMiss } from './_lib.js';

/// What Agni did not know, from every phone.
///
/// Write only. There is no GET, deliberately: nothing in the app reads this
/// back and an endpoint that could serve it would be a way to enumerate what
/// other people have been eating. The list is read in the Supabase console by
/// the one person deciding what to build next.
///
///   POST /api/misses { misses: [...] }   header x-agni-install
export default async function handler(req, res) {
  if (!authorised(req)) {
    json(res, 401, { error: 'Unauthorized' });
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
