import {
  authorised, legacyTokenEnabled, validateRequest, checkQuota, consume,
  json, report, fail, AgniError, aiEnabled, UPSTREAM_TIMEOUT_MS, MAX_BODY_BYTES,
  LIMITS, refusal
} from './_lib.js';
import { verifyAssertion } from './_attest.js';
import { supabaseRPC } from './_supabase.js';
import { createHash } from 'node:crypto';

/// Verifies one attested request, or explains why it could not.
///
/// The app signs SHA256(challenge) || SHA256(body). Binding the body means an
/// assertion captured from one request cannot be replayed onto another, and the
/// counter means it cannot be replayed onto the same one either.
/// Verifies one attested request and decides whether it is allowed.
///
/// TWO ROUND TRIPS, DOWN FROM THREE. `agni_attest_begin` claims the challenge
/// and returns the key together; `agni_attest_gate` advances the replay counter
/// and applies every limit in the same write. One food photo is two AI calls,
/// so this is four database journeys per photograph instead of six, with the
/// controls added rather than bolted on.
///
/// NOTHING ABOUT VERIFICATION CHANGED. Same single-use challenge, same body
/// binding, same signature check, same strictly-advancing counter. Only the
/// plumbing around it moved.
async function attested(req, rawBody, previousCostUSD) {
  const keyId = req.headers['x-agni-key-id'];
  const assertion = req.headers['x-agni-assertion'];
  const challenge = req.headers['x-agni-challenge'];
  if (!keyId || !assertion || !challenge) return null;

  const rows = await supabaseRPC('agni_attest_begin', {
    p_key_id: keyId, p_nonce: challenge, p_max_age_seconds: 300
  });
  const record = Array.isArray(rows) ? rows[0] : rows;
  if (!record) throw new Error('key is not registered');
  if (!record.claimed) throw new Error('challenge was stale or already used');
  if (record.revoked) throw new Error('key is revoked');

  const bodyHash = createHash('sha256').update(rawBody).digest();
  const clientData = Buffer.concat([Buffer.from(challenge, 'base64'), bodyHash]);

  const { counter } = verifyAssertion({
    assertionBase64: assertion,
    clientData,
    publicKeyPem: record.public_key_pem,
    storedCounter: Number(record.counter)
  });

  const verdict = await supabaseRPC('agni_attest_gate', {
    p_key_id: keyId,
    p_counter: counter,
    p_previous_cost_usd: previousCostUSD || 0,
    p_per_minute: LIMITS.perMinute,
    p_per_hour: LIMITS.perHour,
    p_per_day: LIMITS.perDay,
    p_day_spend_cap: LIMITS.daySpendUSD,
    p_global_day_cap: LIMITS.globalDaySpendUSD
  });
  const gate = Array.isArray(verdict) ? verdict[0] : verdict;
  if (!gate) throw new Error('gate returned nothing');

  return {
    keyId,
    environment: record.environment,
    allowed: gate.allowed,
    reason: gate.reason,
    retryAfter: gate.retry_after
  };
}

/// Authenticated proxy to the Anthropic Messages API.
///
/// The app sends the EXACT body it would have sent itself, and this adds the
/// key. That is the whole design: the system prompt and the JSON schema live in
/// one place, in the app, so a prompt change ships with the app and cannot
/// drift out of step with a copy on the server.
/// Vercel parses JSON bodies by default, and a parsed body cannot be hashed:
/// re-serialising it produces different bytes from the ones that were signed.
export const config = { api: { bodyParser: false } };

/// Reads the body, refusing anything oversized.
///
/// TWO CHECKS, and the second is the one that matters. Content-Length is read
/// first so an obviously huge request is refused before a byte of it is
/// accepted. But a caller writes that header, so it is also enforced while
/// streaming: a request that lies about its size, or omits the header
/// altogether, is cut off the moment it exceeds the cap rather than being
/// believed.
async function readRawBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) {
    const error = new Error('body too large');
    error.tooLarge = true;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('body too large');
      error.tooLarge = true;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

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

  let rawBody;
  let parsed;
  try {
    rawBody = await readRawBody(req, MAX_BODY_BYTES);
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    if (error?.tooLarge) {
      return fail(res, 400, AgniError.invalidRequest,
                  'That photo was too large to send.');
    }
    return fail(res, 400, AgniError.invalidRequest, 'Body was not readable JSON.');
  }

  // ATTESTED FIRST, ALWAYS. A verified device is the production path; the
  // shared token is only a bridge for builds already on testers' phones, and
  // `legacyTokenEnabled()` turns it off server-side.
  // What the LAST call cost, reported by the app from the usage Anthropic
  // returned. Spend is therefore charged one request late, which can overshoot
  // by a single request and never by a session. Charging an estimate up front
  // would bill people for calls that failed.
  const previousCostUSD = Math.max(0, Math.min(1,
    Number(req.headers['x-agni-last-cost'] || 0)));

  let identity = null;
  try {
    identity = await attested(req, rawBody, previousCostUSD);
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
  } else if (!identity.allowed) {
    // Refused by a limit rather than by verification. The app is told WHICH,
    // because "try again shortly" is right for a burst and actively wrong for a
    // daily cap.
    const { status, type, message } = refusal(identity.reason);
    if (identity.retryAfter > 0) res.setHeader('retry-after', String(identity.retryAfter));
    report('gate refused', new Error(`${identity.keyId.slice(0, 8)}: ${identity.reason}`));
    return json(res, status, {
      error: { type, message },
      retryAfterSeconds: identity.retryAfter || undefined
    });
  }

  const { installId, request } = parsed || {};

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
      body: JSON.stringify(request),
      // Bounded, so a hung upstream cannot hold the function to its own limit
      // and produce a connection cut rather than an answer.
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (error) {
    report('anthropic call', error);
    // A timeout and an unreachable host are the same thing to somebody waiting:
    // the service is not answering, and manual logging is the way forward.
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return fail(res, 503, AgniError.serviceUnavailable,
                timedOut
                  ? 'Photo analysis took too long. You can log this meal by hand.'
                  : 'Photo analysis is unavailable right now. You can log this meal by hand.');
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
