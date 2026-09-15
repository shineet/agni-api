import {
  authorised, legacyTokenEnabled, validateRequest, checkQuota, consume,
  json, report, fail, AgniError, aiEnabled
} from './_lib.js';
import { verifyAssertion } from './_attest.js';
import { supabaseRPC } from './_supabase.js';
import { createHash } from 'node:crypto';

/// Verifies one attested request, or explains why it could not.
///
/// The app signs SHA256(challenge) || SHA256(body). Binding the body means an
/// assertion captured from one request cannot be replayed onto another, and the
/// counter means it cannot be replayed onto the same one either.
async function attested(req) {
  const keyId = req.headers['x-agni-key-id'];
  const assertion = req.headers['x-agni-assertion'];
  const challenge = req.headers['x-agni-challenge'];
  if (!keyId || !assertion || !challenge) return null;

  const claimed = await supabaseRPC('agni_attest_claim',
                                    { p_nonce: challenge, p_max_age_seconds: 300 });
  if (!claimed) throw new Error('challenge was stale or already used');

  const rows = await supabaseRPC('agni_attest_lookup', { p_key_id: keyId });
  const record = Array.isArray(rows) ? rows[0] : rows;
  if (!record) throw new Error('key is not registered');
  if (record.revoked) throw new Error('key is revoked');

  const bodyHash = createHash('sha256')
    .update(JSON.stringify(req.body?.request ?? {}))
    .digest();
  const clientData = Buffer.concat([Buffer.from(challenge, 'base64'), bodyHash]);

  const { counter } = verifyAssertion({
    assertionBase64: assertion,
    clientData,
    publicKeyPem: record.public_key_pem,
    storedCounter: Number(record.counter)
  });

  const advanced = await supabaseRPC('agni_attest_advance',
                                     { p_key_id: keyId, p_counter: counter });
  if (!advanced) throw new Error('counter did not advance');

  return { keyId, environment: record.environment };
}

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

  // THE KILL SWITCH. One environment variable stops every paid call without
  // taking the deployment down and without an app release.
  if (!aiEnabled()) {
    return fail(res, 503, AgniError.serviceUnavailable,
                'Photo analysis is paused. You can still log food by hand.');
  }

  // ATTESTED FIRST, ALWAYS. A verified device is the production path; the
  // shared token is only a bridge for builds already on testers' phones, and
  // `legacyTokenEnabled()` turns it off server-side.
  let identity = null;
  try {
    identity = await attested(req);
  } catch (error) {
    report('attestation', error);
    return fail(res, 401, AgniError.temporaryVerificationFailure,
                'This device could not be verified.');
  }

  if (!identity) {
    if (!legacyTokenEnabled() || !authorised(req)) {
      return fail(res, 401, AgniError.temporaryVerificationFailure,
                  'This device could not be verified.');
    }
  }

  const { installId, request } = req.body || {};

  // The metering subject: an attested key where there is one, and the old
  // client-supplied id only on the legacy path, which is going away. A caller
  // cannot mint an attested key; that is the whole difference.
  const subject = identity?.keyId || installId;

  if (!subject || typeof subject !== 'string' || subject.length > 200) {
    return fail(res, 400, AgniError.invalidRequest, 'Missing caller identity.');
  }

  const invalid = validateRequest(request);
  if (invalid) {
    return json(res, 400, { error: { type: 'bad_request', message: invalid } });
  }

  let quota;
  try {
    quota = await checkQuota(subject);
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
      await consume(subject);
    } catch (error) {
      // The estimate already succeeded. Losing the count is the lesser failure.
      report('consume', error);
    }
  }

  res.status(upstream.status).setHeader('content-type', 'application/json');
  res.send(text);
}
