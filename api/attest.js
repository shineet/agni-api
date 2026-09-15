import { randomBytes } from 'node:crypto';
import { json, report, fail, AgniError } from './_lib.js';
import { verifyAttestation } from './_attest.js';
import { supabaseRPC as supabaseCall } from './_supabase.js';

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
  if (req.method === 'GET') return issue(res);
  if (req.method === 'POST') return register(req, res);
  return fail(res, 405, AgniError.invalidRequest, 'POST or GET only.');
}

async function issue(res) {
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
