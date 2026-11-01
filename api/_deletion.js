// Deleting what the server holds, asked for by the person in the app.
//
//   POST /api/quota?op=delete-data   (App Attest only; the shared token never)
//   { installId, scope: "device" | "subscription", requestId, signedTransaction? }
//
//   200 { scope, deleted: { category: count }, kept: [{ category, count, reason }] }
//   403 { error, message }   ownership could not be proved
//   409 { error, message }   a request from this phone is still in flight
//   429 { error, message }   more than 3 deletion requests today from this key
//
// OWNERSHIP IS PROVED, NEVER NAMED. The device is the one whose App Attest key
// signed this request: its link row must say 'dev:' + the signed installId.
// No field in the body, a Support ID included, can point the deletion at
// anybody else. The subscription scope additionally needs a StoreKit 2 signed
// transaction for the subscription this key is linked to, verified against
// Apple's root, bought by this Apple Account (PURCHASED, not FAMILY_SHARED).
//
// Spec: Agni repo docs/legal-drafts/deletion-design.md. SQL: schema-deletion.sql.

import { createHash } from 'node:crypto';
import { contributorId, json, report } from './_lib.js';
import { supabaseRPC } from './_supabase.js';
import { cleanId } from './_billing.js';
import { verifyAppStoreJWS, transactionState, subjectFor } from './_storekit.js';

export const DELETIONS_PER_DAY = 3;

function refuse(res, status, type, message) {
  return json(res, status, { error: { type, message }, message });
}

/// What the app shows: counts deleted by category, and every kept category
/// with its reason.
export function shape(scope, rows) {
  const deleted = {};
  const kept = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const count = Number(r.rows || 0);
    if (r.outcome === 'deleted') deleted[r.category] = (deleted[r.category] || 0) + count;
    else if (r.outcome === 'kept') kept.push({ category: r.category, count, reason: r.reason });
  }
  return { scope, deleted, kept };
}

export async function deleteData(req, res, auth, body) {
  res.setHeader('cache-control', 'no-store, private');
  const scope = String(body?.scope || '');
  if (scope !== 'device' && scope !== 'subscription') {
    return refuse(res, 400, 'invalidRequest', 'scope must be device or subscription.');
  }
  const installId = cleanId(body?.installId);
  if (!installId || !auth.keyId) {
    return refuse(res, 403, 'notOwner', 'This phone could not be matched to its records.');
  }

  // The key decides whose records these are.
  let link;
  try {
    const rows = await supabaseRPC('agni_key_context', { p_key_id: auth.keyId });
    link = Array.isArray(rows) ? rows[0] : rows;
  } catch (error) {
    report('deletion context', error);
    return refuse(res, 503, 'serviceUnavailable', 'Could not reach your records just now. Try again shortly.');
  }
  const deviceSubject = 'dev:' + installId;
  if (!link || link.device_subject !== deviceSubject) {
    return refuse(res, 403, 'notOwner', 'This phone can only delete its own records.');
  }

  let subscriptionSubject = link.subscription_subject || null;
  if (scope === 'subscription') {
    if (!subscriptionSubject) {
      return refuse(res, 403, 'noSubscription', 'This phone is not linked to a subscription.');
    }
    let payload;
    try {
      payload = await verifyAppStoreJWS(String(body?.signedTransaction || ''), { kind: 'transaction' });
    } catch (error) {
      report('deletion transaction', error);
      return refuse(res, 403, 'purchaseNotVerified', 'That purchase could not be verified with Apple.');
    }
    // Bundle, product and environment rules exactly as purchases. 'upgraded'
    // still proves ownership of the subscription it belonged to.
    const state = transactionState(payload);
    if (state.error && state.error !== 'upgraded') {
      return refuse(res, 403, 'purchaseNotVerified', 'That purchase could not be verified with Apple.');
    }
    if (subjectFor(payload.environment, payload.originalTransactionId) !== subscriptionSubject) {
      return refuse(res, 403, 'notThisSubscription', 'That purchase is not the subscription this phone uses.');
    }
    if (payload.inAppOwnershipType !== 'PURCHASED') {
      return refuse(res, 403, 'notPurchaser',
        'Only the person who bought the subscription can delete its whole history. You can still delete this phone’s records.');
    }
  }

  // Three a day per key: a deletion is cheap, but repeating it is no use.
  try {
    const keyHash = createHash('sha256').update('deletion|' + auth.keyId).digest('hex').slice(0, 32);
    const inside = await supabaseRPC('agni_ip_window', {
      p_bucket: 'deletion', p_ip_hash: keyHash, p_window_seconds: 86400, p_limit: DELETIONS_PER_DAY
    });
    if (inside === false) {
      res.setHeader('retry-after', '3600');
      return refuse(res, 429, 'rateLimited', 'That is today’s limit for deletion requests. Try again tomorrow.');
    }
  } catch (error) {
    report('deletion window', error);
  }

  // Both forms the dish tables may hold: the raw id (rows from before the
  // contributor conversion) and the c1: hash. The salt stays in this process.
  const contributors = [installId, contributorId(installId)].filter(Boolean);

  let rows;
  try {
    rows = scope === 'device'
      ? await supabaseRPC('agni_delete_device_data', {
          p_device_subject: deviceSubject, p_contributors: contributors, p_subscription_subject: subscriptionSubject
        })
      : await supabaseRPC('agni_delete_subscription_history', {
          p_subscription_subject: subscriptionSubject, p_device_subject: deviceSubject, p_contributors: contributors
        });
  } catch (error) {
    // Not the database's message: it could quote a row.
    report('deletion', new Error(`${scope} deletion failed`));
    return refuse(res, 503, 'serviceUnavailable', 'Nothing was deleted. Try again shortly.');
  }

  if ((Array.isArray(rows) ? rows : []).some(r => r.outcome === 'blocked')) {
    return refuse(res, 409, 'requestInFlight',
      'A request from this phone is still being processed. Nothing was deleted. Try again in a minute.');
  }
  return json(res, 200, shape(scope, rows));
}
