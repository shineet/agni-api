import { authorised, validateRequest, checkQuota, consume, json, report } from './_lib.js';

/// Authenticated proxy to the Anthropic Messages API.
///
/// The app sends the EXACT body it would have sent itself, and this adds the
/// key. That is the whole design: the system prompt and the JSON schema live in
/// one place, in the app, so a prompt change ships with the app and cannot
/// drift out of step with a copy on the server.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: { type: 'method_not_allowed', message: 'POST only.' } });
  }

  if (!authorised(req)) {
    return json(res, 401, { error: { type: 'unauthorized', message: 'Bad or missing app token.' } });
  }

  const { installId, request } = req.body || {};

  if (!installId || typeof installId !== 'string' || installId.length > 100) {
    return json(res, 400, { error: { type: 'bad_install_id', message: 'Missing install id.' } });
  }

  const invalid = validateRequest(request);
  if (invalid) {
    return json(res, 400, { error: { type: 'bad_request', message: invalid } });
  }

  let quota;
  try {
    quota = await checkQuota(installId);
  } catch (error) {
    report('quota check', error);
    return json(res, 503, { error: { type: 'quota_unavailable', message: 'Could not check usage.' } });
  }

  if (!quota.allowed) {
    return json(res, 402, {
      error: {
        type: 'quota_exceeded',
        message: `You have used all ${quota.limit} free estimates. Add your own Anthropic API key in Settings to keep going.`
      },
      quota
    });
  }

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(request)
    });
  } catch (error) {
    report('anthropic call', error);
    return json(res, 502, { error: { type: 'upstream_unreachable', message: 'Could not reach Anthropic.' } });
  }

  const text = await upstream.text();

  // Only a real answer costs a credit. A 429 or a 500 is not the tester's fault
  // and should not burn one of their free goes.
  if (upstream.ok && !quota.unlimited) {
    try {
      await consume(installId);
    } catch (error) {
      // The estimate already succeeded. Losing the count is the lesser failure.
      report('consume', error);
    }
  }

  res.status(upstream.status).setHeader('content-type', 'application/json');
  res.send(text);
}
