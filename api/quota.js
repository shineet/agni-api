import { authorised, checkQuota, json } from './_lib.js';

/// How many free estimates are left, so Settings can show it before someone
/// runs out rather than only at the moment they do.
export default async function handler(req, res) {
  if (!authorised(req)) {
    return json(res, 401, { error: { type: 'unauthorized', message: 'Bad or missing app token.' } });
  }

  const installId = req.query?.installId;
  if (!installId || typeof installId !== 'string') {
    return json(res, 400, { error: { type: 'bad_install_id', message: 'Missing install id.' } });
  }

  try {
    const quota = await checkQuota(installId);
    return json(res, 200, quota);
  } catch (error) {
    return json(res, 503, { error: { type: 'quota_unavailable', message: 'Could not check usage.' } });
  }
}
