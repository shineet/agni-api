import { randomUUID } from 'node:crypto';
import {
  json, report, fail, AgniError, aiEnabled, UPSTREAM_TIMEOUT_MS, MAX_BODY_BYTES,
  refusal, checkQuota, consume, readRawBody
} from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';
import {
  FEATURES, inferFeature, validateModelRequest, hasImage, bucketFor, reservationFor,
  promptCacheFeatures, withPromptCache, cleanId, metered, allowanceRefusal, sendRefusal,
  billingEnforced
} from './_billing.js';
import { resolveCaller, entitlementRefusal, limitsFor } from './_caller.js';

/// Metered proxy to the Anthropic Messages API, for the calls whose prompts
/// live in the app.
///
/// The app sends the request body it would send Anthropic, wrapped:
///
///   { installId, feature, actionId, requestId, request: { ...Messages body } }
///
/// Builds 174 and 175 send only { installId, request }; their feature is
/// inferred and each call is its own action.
///
/// WHAT CHANGED, and why each part is here:
///
///   * The body must be the app's shape and nothing else (validateModelRequest).
///     It used to forward anything that named an allowed model, which let a
///     caller add web-search tools, extra images or a 1.5 MB system prompt.
///   * Cost is computed HERE from the usage Anthropic returns. The client's
///     x-agni-last-cost header is ignored: a client that reported 0 never moved
///     the old cap at all.
///   * A conservative cost is reserved before the call and reconciled after,
///     under a row lock, against the caller's allowance and the day's ceiling.
///   * A failed or abandoned call gives the credit back; its provider spend
///     stays recorded.
///
/// The prompts stay in the app on purpose. Moving the vision prompt server-side
/// would touch the recognition path that was validated on real meals; the
/// allowlist bounds what a caller can make the proxy pay for without that.

/// A parsed body cannot be hashed: re-serialising it produces different bytes
/// from the ones that were signed.
export const config = { api: { bodyParser: false } };

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
  let envelope;
  try {
    rawBody = await readRawBody(req, MAX_BODY_BYTES);
    envelope = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    if (error?.tooLarge) {
      return fail(res, 400, AgniError.invalidRequest, 'That photo was too large to send.');
    }
    return fail(res, 400, AgniError.invalidRequest, 'Body was not readable JSON.');
  }

  const auth = await authenticate(req, {
    meterClass: MeterClass.ai,
    rawBody,
    // Builds 174 and 175 bind the assertion to the body alone.
    rawBodyBinding: true,
    path: '/api/estimate',
    query: req.query || {}
  });
  recordAuth('estimate', auth, req);
  if (!auth.ok) {
    if (auth.status === 429) {
      // Refused by a call window rather than by verification. The app is told
      // WHICH, because "try again shortly" is right for a burst and wrong for
      // a daily cap.
      const { status, type, message } = refusal(auth.reason);
      if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
      return json(res, status, { error: { type, message }, retryAfterSeconds: auth.retryAfter || undefined });
    }
    return fail(res, 401, AgniError.temporaryVerificationFailure, 'This device could not be verified.');
  }

  const { installId, request } = envelope || {};
  const feature = FEATURES[envelope?.feature] && envelope.feature !== 'research' && envelope.feature !== 'ingredient'
    ? envelope.feature
    : inferFeature(request);

  const invalid = validateModelRequest(feature, request);
  if (invalid) return fail(res, 400, AgniError.invalidRequest, invalid);

  let caller;
  try {
    caller = await resolveCaller(auth, { installId });
  } catch (error) {
    report('estimate caller', error);
    return fail(res, 503, AgniError.serviceUnavailable,
                'AI analysis is unavailable right now. You can still log meals by hand.');
  }

  const entitlement = entitlementRefusal(caller, feature);
  if (entitlement) return sendRefusal(res, entitlement);

  // THE BETA ALLOWANCE, kept exactly as testers know it until launch: a
  // lifetime count per install, waived for installs marked unlimited.
  let quota = null;
  if (!billingEnforced()) {
    const quotaSubject = auth.keyId || cleanId(installId);
    if (!quotaSubject) return fail(res, 400, AgniError.invalidRequest, 'Missing caller identity.');
    try {
      quota = await checkQuota(quotaSubject);
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
    quota.subject = quotaSubject;
  }

  const image = hasImage(request);
  const bucket = bucketFor(feature, image);
  const requestId = cleanId(envelope?.requestId) || randomUUID();
  const actionId = cleanId(envelope?.actionId) || requestId;
  const cached = promptCacheFeatures().has(feature);
  const upstreamBody = cached ? withPromptCache(request) : request;
  const reserveUSD = reservationFor(feature, request, { promptCached: cached });
  const limits = limitsFor(caller);
  if (quota?.unlimited) limits.dayCostCapUSD = null;

  let result;
  try {
    result = await metered({
      subject: caller.subject, subjectKind: caller.subjectKind, tier: caller.tier,
      budgetTier: caller.budgetTier,
      authPath: auth.path, feature, bucket, counts: FEATURES[feature].counts,
      actionId, requestId, model: request.model, period: caller.period, reserveUSD, limits
    }, async () => {
      let upstream;
      try {
        upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(upstreamBody),
          // Bounded, so a hung upstream cannot hold the function to its own
          // limit and produce a connection cut rather than an answer.
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
      } catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        // Nobody can know whether a call that timed out was billed.
        return { ok: false, ambiguous: true, reason: timedOut ? 'timeout' : 'network', timedOut };
      }
      const text = await upstream.text();
      let usage = null;
      try { usage = JSON.parse(text)?.usage || null; } catch { usage = null; }
      return {
        ok: upstream.ok,
        httpStatus: upstream.status,
        usage,
        // A 200 whose usage could not be read was billed for an unknown
        // amount: keep the reservation as its cost.
        ambiguous: upstream.ok && !usage,
        text,
        providerRequestId: upstream.headers.get('request-id')
      };
    });
  } catch (error) {
    // The ledger could not be reached. Without it nothing can be metered, so
    // nothing is spent: fail closed for money, open for logging.
    report('estimate metering', error);
    return fail(res, 503, AgniError.serviceUnavailable,
                'AI analysis is unavailable right now. You can still log meals by hand.');
  }

  if (result.refused) {
    report('allowance refused', new Error(`${caller.tier} ${feature}: ${result.refused.reason}`));
    return sendRefusal(res, allowanceRefusal(result.refused, { tier: caller.tier, bucket, limit: result.limit }));
  }

  const { outcome } = result;
  if (!outcome.httpStatus) {
    return fail(res, 503, AgniError.serviceUnavailable,
                outcome.timedOut
                  ? 'Photo analysis took too long. You can log this meal by hand.'
                  : 'Photo analysis is unavailable right now. You can log this meal by hand.');
  }

  // Only a real answer costs a beta credit. A 429 or a 500 is not the
  // tester's fault and should not burn one of their free goes.
  if (outcome.ok && quota && !quota.unlimited) {
    try { await consume(quota.subject); } catch (error) { report('consume', error); }
  }

  // What is left, so the app can show it without asking again.
  const reservation = result.reservation;
  res.setHeader('x-agni-allowance', JSON.stringify({
    tier: caller.tier, bucket,
    used: reservation.used ?? null, limit: reservation.lim ?? null,
    credited: !!reservation.credited
  }));
  res.status(outcome.httpStatus).setHeader('content-type', 'application/json');
  res.send(outcome.text);
}
