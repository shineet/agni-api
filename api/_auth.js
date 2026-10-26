import { createHash } from 'node:crypto';
import { authorised, legacyTokenEnabled, LIMITS, report } from './_lib.js';
import { verifyAssertion } from './_attest.js';
import { supabaseRPC } from './_supabase.js';
import { hashIP } from './_billing.js';

/// One door for every endpoint, and three different allowances behind it.
///
/// WHY THIS FILE EXISTS. Attestation lived inside estimate.js, so it was the
/// only endpoint that had it. Four others -- variants, dishes, misses, quota --
/// accepted nothing but the shared token that ships inside the binary, and
/// `authorised()` opens with `if (!legacyTokenEnabled()) return false`. Turning
/// that flag off, which is the stated requirement before public launch, would
/// have refused every request to all four: community results gone, the miss log
/// silent, the quota check broken, and the model fallback that stops a search
/// ending in an empty screen dead with them.
///
/// PROVING WHO YOU ARE AND DECIDING WHAT YOU MAY SPEND ARE DIFFERENT QUESTIONS,
/// and until now they were welded together. `agni_attest_gate` increments the
/// per-minute, per-hour and per-day AI counters on EVERY call it sees. Wiring a
/// dish search through it would burn the ten-per-minute allowance during one
/// session of typing, and the next photograph would be refused with "Agni is
/// catching up". Search would starve the core feature of the app, silently, and
/// only under real use.
///
/// So verification is one path and metering is three classes.

export const MeterClass = {
  /// Costs money. The existing gate, unchanged.
  ai: 'ai',
  /// Cheap database reads. Replay-checked, generously limited, and it must
  /// never touch the AI counters or the spend ceiling.
  read: 'read',
  /// External food research. Its own budget and its own kill switch, so a
  /// runaway resolver cannot spend the estimation allowance either.
  research: 'research'
};

/// How the caller proved itself. Recorded for every request: this is the
/// evidence that decides when the legacy token can safely be switched off, and
/// without it that decision is a guess.
export const AuthPath = {
  attested: 'attested',
  legacy: 'legacy',
  development: 'development',
  refused: 'refused'
};

/// WHAT AN ASSERTION IS BOUND TO.
///
/// The app signs SHA256(challenge) || SHA256(canonical request). Binding the
/// request means an assertion captured from one call cannot be replayed onto
/// another.
///
/// It used to bind the BODY, which is enough for a POST and worth nothing for a
/// GET: /api/dishes?q=pizza and /api/dishes?q=beer have identical empty bodies,
/// so one captured assertion would have worked for every query anybody ever
/// made. The canonical string fixes that, and the query is SORTED so a client
/// that reorders parameters does not lock itself out.
export function canonicalRequest(method, path, query, rawBody) {
  const sorted = Object.keys(query || {}).sort()
    .map(k => `${k}=${Array.isArray(query[k]) ? query[k].join(',') : query[k]}`)
    .join('&');
  const bodyHash = createHash('sha256').update(rawBody || '').digest('hex');
  return [String(method || '').toUpperCase(), path || '', sorted, bodyHash].join('\n');
}

/// Verifies an attested request WITHOUT metering it.
///
/// Returns the key id and the advanced counter, or null when the request
/// carries no attestation headers at all, which is the ordinary case for an
/// older client and is not an error.
///
/// THE CHALLENGE MUST HAVE BEEN CLAIMED BY THIS CALL AND THE KEY MUST NOT BE
/// REVOKED. estimate.js checked both; this shared path, which research,
/// ingredient and every read route use, checked neither, so a revoked key or
/// a reused challenge passed here. agni_attest_begin already returns both.
///
/// `rawBodyBinding` accepts the ORIGINAL estimate binding,
/// SHA256(challenge) || SHA256(body), which builds 174 and 175 sign. Only
/// /api/estimate passes it; every other route has only ever been bound to the
/// canonical request.
const COUNTER_WINDOW = 16;
async function verify(req, canonical, { rawBody = '', rawBodyBinding = false } = {}) {
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

  const challengeBytes = Buffer.from(challenge, 'base64');
  const bindings = [createHash('sha256').update(canonical).digest()];
  if (rawBodyBinding) bindings.push(createHash('sha256').update(rawBody || '').digest());

  let counter = null;
  let lastError = null;
  for (const binding of bindings) {
    try {
      ({ counter } = verifyAssertion({
        assertionBase64: assertion,
        clientData: Buffer.concat([challengeBytes, binding]),
        publicKeyPem: record.public_key_pem,
        // The same out-of-order window the gates allow (see schema-limits.sql):
        // replay is stopped by the single-use challenge claimed above.
        storedCounter: Number(record.counter) - COUNTER_WINDOW
      }));
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (counter === null) throw lastError || new Error('assertion did not verify');

  return { keyId, counter, environment: record.environment, unlimited: !!record.unlimited };
}

/// Applies the allowance for one class.
///
/// SPEND IS NO LONGER COUNTED HERE. These gates keep doing what they are good
/// at -- the replay counter and the per-minute, per-hour and per-day call
/// windows -- and money moved to agni_reserve, which knows what a call really
/// cost. So the client-reported cost is gone (always 0) and the old spend caps
/// are passed as unreachable, which leaves the SQL untouched and every shipped
/// build's verification exactly as it was.
const NO_CAP = 1e9;
async function meter(keyId, counter, meterClass) {
  if (meterClass === MeterClass.ai) {
    const verdict = await supabaseRPC('agni_attest_gate', {
      p_key_id: keyId,
      p_counter: counter,
      p_previous_cost_usd: 0,
      p_per_minute: LIMITS.perMinute,
      p_per_hour: LIMITS.perHour,
      p_per_day: LIMITS.perDay,
      p_day_spend_cap: NO_CAP,
      p_global_day_cap: NO_CAP
    });
    const gate = Array.isArray(verdict) ? verdict[0] : verdict;
    if (!gate) throw new Error('gate returned nothing');
    return gate;
  }

  // read and research share a gate that advances the same replay counter and
  // counts against ITS OWN columns. The counter is shared on purpose: it is a
  // freshness check on the device, not an allowance, and letting two classes
  // keep separate counters would reopen the replay window between them.
  //
  // AI NEVER REACHES HERE, and the gate now refuses it rather than metering it
  // as research, which is what it silently did before verification caught it.
  // If a future class is added, add it in BOTH places or it will be refused,
  // which is the failure worth having.
  const verdict = await supabaseRPC('agni_attest_gate_class', {
    p_key_id: keyId,
    p_counter: counter,
    p_class: meterClass,
    p_per_minute: meterClass === MeterClass.read
      ? Number(process.env.READ_PER_MINUTE || 120)
      : Number(process.env.RESEARCH_PER_MINUTE || 6),
    p_per_day: meterClass === MeterClass.read
      ? Number(process.env.READ_PER_DAY || 4000)
      : Number(process.env.RESEARCH_PER_DAY || 120),
    p_previous_cost_usd: 0,
    // 0 switches the old research spend caps off in the SQL; agni_reserve
    // meters research and ingredient spend now, from real usage.
    p_day_spend_cap: 0,
    p_global_day_cap: 0
  });
  const gate = Array.isArray(verdict) ? verdict[0] : verdict;
  if (!gate) throw new Error('class gate returned nothing');
  return gate;
}

/// Is external research switched on at all.
///
/// A kill switch of its own, separate from AI_ENABLED, so research can be
/// stopped dead without taking photo estimation down with it.
export function researchEnabled() {
  return (process.env.RESEARCH_ENABLED || 'true').toLowerCase() !== 'false';
}

/// The one call every endpoint makes.
///
/// BACKWARDS COMPATIBLE BY CONSTRUCTION. Attestation is tried first; when the
/// headers are absent, the legacy token is accepted exactly as it is today.
/// Nothing that works now stops working, because the only change is additional
/// acceptance. New endpoints pass `allowLegacy: false` and are attested from
/// birth, so no fresh surface is ever added to the token being retired.
///
/// `rawBody` MUST BE THE BYTES THAT ARRIVED. Every route used to pass
/// `JSON.stringify(req.body ?? '')`, which re-serialises a POST (so an
/// attested POST could never verify) and turns an empty GET body into the two
/// characters `""` (so an attested GET could never verify either). Nothing
/// attested those routes yet, which is the only reason it went unseen.
///
/// The legacy path is rate limited per IP: the token is in every IPA and an
/// unthrottled shared secret is an open door.
export async function authenticate(req, {
  meterClass = MeterClass.read,
  allowLegacy = true,
  rawBody = '',
  rawBodyBinding = false,
  path = '',
  query = {}
} = {}) {
  const canonical = canonicalRequest(req.method, path, query, rawBody);
  const ipHash = hashIP(req);

  let verified = null;
  try {
    verified = await verify(req, canonical, { rawBody, rawBodyBinding });
  } catch (error) {
    report('attestation', error);
    return { ok: false, path: AuthPath.refused, status: 401, reason: 'verification', ipHash };
  }

  if (!verified) {
    if (allowLegacy && legacyTokenEnabled() && authorised(req)) {
      let inside = true;
      try {
        inside = await supabaseRPC('agni_ip_window', {
          p_bucket: 'legacy', p_ip_hash: ipHash, p_window_seconds: 600,
          p_limit: Number(process.env.LEGACY_PER_IP_10MIN || 300)
        });
      } catch (error) {
        // The window table is a guard, not a dependency.
        report('legacy window', error);
      }
      if (inside === false) {
        return { ok: false, path: AuthPath.legacy, status: 429, reason: 'minute', retryAfter: 60, meterClass, ipHash };
      }
      return { ok: true, path: AuthPath.legacy, keyId: null, meterClass, ipHash };
    }
    return { ok: false, path: AuthPath.refused, status: 401, reason: 'unverified', ipHash };
  }

  let gate;
  try {
    gate = await meter(verified.keyId, verified.counter, meterClass);
  } catch (error) {
    report('metering', error);
    return { ok: false, path: AuthPath.refused, status: 401, reason: 'metering', ipHash };
  }

  if (!gate.allowed) {
    return {
      ok: false, path: AuthPath.attested, keyId: verified.keyId, meterClass,
      status: gate.reason === 'replay' || gate.reason === 'unknown_key' ? 401 : 429,
      reason: gate.reason, retryAfter: gate.retry_after || 0, ipHash
    };
  }

  return {
    ok: true, path: AuthPath.attested, keyId: verified.keyId,
    environment: verified.environment, meterClass, ipHash
  };
}

/// Records what happened, so the legacy flag can be flipped on evidence.
///
/// Fire and forget, and deliberately never awaited by a request path: telemetry
/// that can fail a request is worse than no telemetry. Counts only. No query
/// text, no install id, nothing that says who anybody is.
export function recordAuth(endpoint, result, req) {
  const build = String(req.headers['x-agni-build'] || '').slice(0, 24) || null;
  supabaseRPC('agni_auth_record', {
    p_endpoint: String(endpoint).slice(0, 64),
    p_auth_path: result.path,
    p_meter_class: result.meterClass || null,
    p_allowed: !!result.ok,
    p_build: build
  }).catch(() => {});
}
