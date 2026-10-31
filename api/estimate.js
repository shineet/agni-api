import { randomUUID } from 'node:crypto';
import {
  json, report, fail, AgniError, aiEnabled, UPSTREAM_TIMEOUT_MS, MAX_BODY_BYTES,
  refusal, checkQuota, consume, readRawBody
} from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';
import {
  FEATURES, inferFeature, validateModelRequest, hasImage, bucketFor, reservationFor,
  promptCacheFeatures, withPromptCache, cleanId, metered, allowanceRefusal, sendRefusal
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
  if (!caller.enforced) {
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

  // STREAMED when the app asks for it, which only builds that can read a
  // stream do. Every other build gets exactly the buffered reply it always has.
  // A big plate is estimated in parallel parts (x-agni-part 1, 2, 3...). They
  // share the photo's actionId, so the ledger credits the photo once; the main
  // call that started them is stopped by the app and gives its credit back.
  const stream = request.stream === true;
  const part = stream ? Math.max(0, Math.min(9, Number(req.headers['x-agni-part'] || 0) || 0)) : 0;
  const allowance = (reservation) => JSON.stringify({
    tier: caller.tier, bucket,
    used: reservation.used ?? null, limit: reservation.lim ?? null,
    credited: !!reservation.credited
  });

  let result;
  try {
    result = await metered({
      subject: caller.subject, subjectKind: caller.subjectKind, tier: caller.tier,
      budgetTier: caller.budgetTier,
      authPath: auth.path, feature, bucket, counts: FEATURES[feature].counts,
      actionId, requestId, model: request.model, period: caller.period, reserveUSD, limits
    }, async (reservation) => {
      if (stream) return relayStream(req, res, upstreamBody, part, allowance(reservation));
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

  // Builds 174 to 176 have no actionId, so their parts are separate actions:
  // only the main call or part 1 spends the beta credit, never both.
  if (outcome.ok && quota && !quota.unlimited && part <= 1) {
    try { await consume(quota.subject); } catch (error) { report('consume', error); }
  }

  // A stream has already answered, in events, whatever happened to it.
  if (outcome.handled) return;

  if (!outcome.httpStatus) {
    return fail(res, 503, AgniError.serviceUnavailable,
                outcome.timedOut
                  ? 'Photo analysis took too long. You can log this meal by hand.'
                  : 'Photo analysis is unavailable right now. You can log this meal by hand.');
  }

  // Only a real answer costs a beta credit (above): a 429 or a 500 is not the
  // tester's fault and should not burn one of their free goes.
  // What is left, so the app can show it without asking again.
  res.setHeader('x-agni-allowance', allowance(result.reservation));
  res.status(outcome.httpStatus).setHeader('content-type', 'application/json');
  res.send(outcome.text);
}

/// How long a streamed answer may run, end to end.
///
/// Longer than the buffered 40s on purpose. A big thali was timed at 28s and
/// one failed outright past 50s: the answer is long because the plate is, and
/// a stream shows the dishes as they come, so waiting is no longer staring at
/// a spinner. Still inside the function's maxDuration in vercel.json, so a
/// slow upstream ends as an error event the app can read, never as a kill.
export const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS || 110_000);

/// Relays Anthropic's server-sent events to the app as they arrive, and
/// returns the outcome the ledger settles with.
///
/// Only a COMPLETE answer is a success, so only it is credited: complete means
/// Anthropic sent message_stop, the one event that cannot arrive early.
///
/// THE COST OF A STOPPED STREAM. Anthropic reports output tokens only at the
/// end, in message_delta, and a stream the app stops (the main call of a split
/// plate, always) never gets there. Input is known from message_start; output
/// is counted from the bytes relayed, at three per token, which over-counts
/// English and so never under-charges the caps. A stream cut before
/// message_start is ambiguous and keeps its reservation, as a timeout does.
async function relayStream(req, res, body, part, allowanceHeader) {
  // STOPPED WHEN THE APP HANGS UP. The app stops a stream once parallel parts
  // have covered the rest of the plate, and without this Anthropic would go on
  // writing an answer nobody reads, and billing for it.
  const hangUp = new AbortController();
  res.on('close', () => { if (!res.writableEnded) hangUp.abort(); });

  const open = () => {
    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-agni-allowance', allowanceHeader);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  };
  const errorEvent = (message) => {
    res.write('event: error\ndata: ' + JSON.stringify({
      type: 'error', error: { type: AgniError.serviceUnavailable, message }
    }) + '\n\n');
    res.end();
  };

  // A PART IS ANSWERED BEFORE THE MODEL IS ASKED. The app signs parts one at
  // a time and waits for each to be accepted before signing the next, because
  // the replay counter must reach this server in the order it was signed.
  // Verification and the allowance are already done by here, so saying so now
  // makes that wait half a second rather than the model's time to first word.
  // The cost: a part's later failures arrive as an error event, not a status,
  // which the app handles the same way (the part is dropped and the main call
  // covers it).
  const early = part > 0;
  if (early) {
    open();
    res.write(': accepted\n\n');
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
      body: JSON.stringify(body),
      signal: AbortSignal.any([hangUp.signal, AbortSignal.timeout(STREAM_TIMEOUT_MS)])
    });
  } catch (error) {
    report('anthropic stream call', error);
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    if (!early) return { ok: false, ambiguous: true, reason: timedOut ? 'timeout' : 'network', timedOut };
    errorEvent('Photo analysis is unavailable right now.');
    return { ok: false, ambiguous: true, reason: 'network', handled: true };
  }

  // A refusal before the stream starts (400, 429, 529) is an ordinary JSON
  // error, passed back to the handler exactly as the buffered path does.
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    const outcome = { ok: false, httpStatus: upstream.status, text, providerRequestId: upstream.headers.get('request-id') };
    if (!early) return outcome;
    report('anthropic part refused', new Error(`${upstream.status}: ${text.slice(0, 200)}`));
    errorEvent(`The model refused this part (${upstream.status}).`);
    return { ...outcome, handled: true };
  }

  if (!early) open();

  const decoder = new TextDecoder();
  let pending = '';
  let usage = null;
  let finalOutput = null;
  let relayed = 0;
  let stopped = false;
  const read = (text) => {
    pending += text;
    let cut;
    while ((cut = pending.indexOf('\n\n')) >= 0) {
      const event = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      const data = event.split('\n').find(line => line.startsWith('data:'));
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data.slice(5)); } catch { continue; }
      if (parsed?.type === 'message_start' && parsed.message?.usage) usage = { ...parsed.message.usage };
      else if (parsed?.type === 'message_delta' && parsed.usage) {
        usage = { ...(usage || {}), ...parsed.usage };
        finalOutput = parsed.usage.output_tokens ?? finalOutput;
      } else if (parsed?.type === 'message_stop') stopped = true;
    }
  };

  let failure = null;
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      relayed += chunk.length;
      read(decoder.decode(chunk, { stream: true }));
    }
  } catch (error) {
    failure = error;
    report('anthropic stream cut', error);
  }

  if (usage && finalOutput == null) {
    usage.output_tokens = Math.max(Number(usage.output_tokens || 0), Math.ceil(relayed / 3));
  }
  const providerRequestId = upstream.headers.get('request-id');

  if (failure) {
    const timedOut = failure?.name === 'TimeoutError' || failure?.name === 'AbortError';
    if (!res.writableEnded && !res.destroyed) {
      errorEvent(timedOut
        ? 'Photo analysis took too long. You can log this meal by hand.'
        : 'Photo analysis was cut off. You can try again or log this meal by hand.');
    }
    return {
      ok: false, httpStatus: 200, usage, ambiguous: !usage, handled: true, providerRequestId,
      label: hangUp.signal.aborted ? 'stopped' : (timedOut ? 'timeout' : 'cut')
    };
  }
  res.end();
  return { ok: stopped, httpStatus: 200, usage, ambiguous: !usage, handled: true, providerRequestId,
           label: stopped ? 'ok' : 'incomplete' };
}
