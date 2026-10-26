import { randomBytes } from 'node:crypto';
import { json, report, fail, AgniError } from './_lib.js';
import { verifyAttestation } from './_attest.js';
import { supabaseRPC as supabaseCall } from './_supabase.js';
import { hashIP, raiseAlert } from './_billing.js';

/// How long a challenge is good for. Long enough for a slow network, short
/// enough that a captured one is worthless.
const CHALLENGE_SECONDS = 300;

/// Issues a nonce, and registers an attested key.
///
/// Two jobs in one function because Vercel counts functions and these are four
/// lines apart in the same flow.
///
///   GET  /api/attest            -> { challenge }
///   POST /api/attest            { keyId, attestation, challenge } -> { ok }
export default async function handler(req, res) {
  if (req.method === 'GET') return issue(req, res);
  if (req.method === 'POST') return register(req, res);
  return fail(res, 405, AgniError.invalidRequest, 'POST or GET only.');
}

/// RATE LIMITS ON THE ONLY UNAUTHENTICATED DOOR.
///
/// Every new install registers a key here, and every attested request starts
/// with a challenge from here. Neither was limited: a script could mint
/// challenges (a database row each) or register keys as fast as it liked.
///
/// Per IP hash, and generous, because carrier NAT puts many real phones
/// behind one address: a busy person uses a few challenges a minute and
/// registers a key once per install. The registration cap across ALL
/// addresses is an anomaly alarm, not a business limit: it alerts and then
/// refuses until the hour turns, which is what an attack deserves and what a
/// launch-day spike should make an operator raise.
const CHALLENGES_PER_IP_MINUTE = Number(process.env.ATTEST_CHALLENGES_PER_IP_MINUTE || 120);
const REGISTRATIONS_PER_IP_HOUR = Number(process.env.ATTEST_REGISTRATIONS_PER_IP_HOUR || 20);
const REGISTRATIONS_PER_HOUR = Number(process.env.ATTEST_REGISTRATIONS_PER_HOUR || 2000);

async function inside(bucket, ipHash, seconds, limit) {
  try {
    return await supabaseCall('agni_ip_window', {
      p_bucket: bucket, p_ip_hash: ipHash, p_window_seconds: seconds, p_limit: limit
    });
  } catch (error) {
    // A guard, not a dependency: verification itself still has to pass.
    report('attest window', error);
    return true;
  }
}

async function issue(req, res) {
  if (!(await inside('challenge', hashIP(req), 60, CHALLENGES_PER_IP_MINUTE))) {
    res.setHeader('retry-after', '60');
    return fail(res, 429, AgniError.rateLimited, 'Too many verification attempts. Try again shortly.');
  }
  const challenge = randomBytes(32).toString('base64');
  try {
    await supabaseCall('agni_attest_issue', { p_nonce: challenge });
  } catch (error) {
    report('challenge issue', error);
    return fail(res, 503, AgniError.temporaryVerificationFailure,
                'Could not start verification.');
  }
  return json(res, 200, { challenge });
}

async function register(req, res) {
  const { keyId, attestation, challenge } = req.body || {};
  if (!keyId || !attestation || !challenge) {
    return fail(res, 400, AgniError.invalidRequest, 'Missing attestation fields.');
  }

  if (!(await inside('register', hashIP(req), 3600, REGISTRATIONS_PER_IP_HOUR))) {
    res.setHeader('retry-after', '3600');
    return fail(res, 429, AgniError.rateLimited, 'Too many verification attempts. Try again later.');
  }
  if (!(await inside('register-all', 'all', 3600, REGISTRATIONS_PER_HOUR))) {
    raiseAlert('attestation registrations over the hourly ceiling', { limit: REGISTRATIONS_PER_HOUR });
    res.setHeader('retry-after', '600');
    return fail(res, 503, AgniError.temporaryVerificationFailure, 'Verification is busy. Try again shortly.');
  }

  // The challenge must be one this server issued, unused, and recent. Claiming
  // it here means a captured attestation cannot be submitted twice.
  let claimed = false;
  try {
    claimed = await supabaseCall('agni_attest_claim',
                                 { p_nonce: challenge, p_max_age_seconds: CHALLENGE_SECONDS });
  } catch (error) {
    report('challenge claim', error);
    return fail(res, 503, AgniError.temporaryVerificationFailure,
                'Could not complete verification.');
  }
  if (!claimed) {
    return fail(res, 401, AgniError.temporaryVerificationFailure,
                'That verification has expired. Try again.');
  }

  let verified;
  try {
    verified = verifyAttestation({
      attestationBase64: attestation,
      keyIdBase64: keyId,
      challenge: Buffer.from(challenge, 'base64')
    });
  } catch (error) {
    // Logged in full, reported as nothing. The detail is for whoever is
    // debugging; a caller learns only that it did not verify.
    report('attestation verify', error);
    return fail(res, 401, AgniError.temporaryVerificationFailure,
                'This device could not be verified.');
  }

  try {
    await supabaseCall('agni_attest_register', {
      p_key_id: keyId,
      p_public_key: verified.publicKeyPem,
      p_environment: verified.environment
    });
  } catch (error) {
    report('attest register', error);
    return fail(res, 503, AgniError.temporaryVerificationFailure,
                'Could not finish verification.');
  }

  return json(res, 200, { ok: true, environment: verified.environment });
}
