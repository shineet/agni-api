// App Store signed data: StoreKit 2 transactions, renewal info and App Store
// Server Notifications V2.
//
// VERIFIED BY APPLE'S OWN LIBRARY. Every one of these is a JWS signed by a
// leaf certificate, issued by Apple's WWDR intermediate, issued by Apple Root
// CA - G3. The checking is done by @apple/app-store-server-library's
// SignedDataVerifier, which Apple maintains: chain to the trusted root, the
// App Store marker extension on the leaf and the WWDR marker on the
// intermediate read as real X.509 extensions, validity at the signing date,
// the signature, and then the bundle id, the environment and (Production)
// the App Apple ID.
//
// WHY NOT THE VERIFIER THAT WAS HERE. It found the marker OIDs by searching
// the certificate's raw bytes. The WWDR intermediate also issues developers'
// own certificates, and a developer chooses their RSA modulus, so the marker's
// bytes could be planted in a certificate that is not an App Store one. The
// test "an OID planted outside the extensions is refused" pins this.
//
// The ROOT is still shipped with the function (apple-root-ca-g3.pem, SHA-256
// 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79,
// checked against Apple's published value on 2026-10-07). A root that came
// with the message would prove nothing.
//
// SANDBOX AND PRODUCTION ARE DIFFERENT WORLDS. TestFlight and App Review buy
// in Sandbox. Their transactions verify against a Sandbox verifier, land on
// `sbx:` subjects, are metered under their own budget, and never count as a
// paid subscriber. Xcode and local StoreKit testing are never accepted: that
// data is not signed by Apple at all.

import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { SignedDataVerifier, Environment } from '@apple/app-store-server-library';
import { BUNDLE_ID, planOf, sandboxAllowed } from './_billing.js';

let pinnedRoot = null;
export function appleRootG3() {
  // THE TESTS sign with a stand-in chain (test/fixtures/storekit). Honoured
  // only inside `node --test`, which sets NODE_TEST_CONTEXT for every test
  // file and which no deployment runs.
  if (process.env.NODE_TEST_CONTEXT && process.env.AGNI_TEST_APPLE_ROOT) {
    return new X509Certificate(readFileSync(process.env.AGNI_TEST_APPLE_ROOT, 'utf8'));
  }
  if (!pinnedRoot) {
    const pem = readFileSync(new URL('../apple-root-ca-g3.pem', import.meta.url), 'utf8');
    pinnedRoot = new X509Certificate(pem);
  }
  return pinnedRoot;
}

/// The App Apple ID (App Store Connect > App Information > Apple ID). Apple's
/// verifier requires it for Production and checks it on every notification.
/// Unset means Production data is REFUSED, never accepted unchecked.
export function appAppleId() {
  const n = Number(process.env.APP_APPLE_ID || '');
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const ENVIRONMENTS = { Production: Environment.PRODUCTION, Sandbox: Environment.SANDBOX };

/// The only two environments Agni honours, with Sandbox behind its switch.
export function acceptedEnvironment(environment) {
  if (environment === 'Production') return true;
  if (environment === 'Sandbox') return sandboxAllowed();
  return false;
}

function b64urlJSON(part) {
  try {
    return JSON.parse(Buffer.from(String(part).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/// Which environment a JWS CLAIMS to be from, read before verifying, ONLY to
/// pick the verifier. The verifier then refuses it unless the verified
/// payload says the same.
function claimedEnvironment(kind, jws) {
  const payload = b64urlJSON(String(jws || '').split('.')[1] || '');
  if (!payload) return null;
  if (kind === 'notification') return payload.data?.environment || payload.summary?.environment || null;
  return payload.environment || null;
}

const verifiers = new Map();
function verifierFor(environment, { root, bundleId }) {
  if (!ENVIRONMENTS[environment]) throw new Error(`storekit: environment ${environment} is not accepted`);
  if (!acceptedEnvironment(environment)) throw new Error(`storekit: ${environment} transactions are switched off`);
  const appleId = appAppleId();
  if (environment === 'Production' && appleId === undefined) {
    throw new Error('storekit: APP_APPLE_ID is not configured, so Production data cannot be verified');
  }
  const key = `${environment}|${bundleId}|${appleId}|${root.fingerprint256}`;
  if (!verifiers.has(key)) {
    // Online checks (OCSP) off: a network round trip on every verification,
    // and the certificates are checked at the date Apple signed the data.
    verifiers.set(key, new SignedDataVerifier([root.raw], false, ENVIRONMENTS[environment], bundleId, appleId));
  }
  return verifiers.get(key);
}

/// Verifies one App Store JWS and returns its payload. Throws on anything else.
///
/// `kind` is 'transaction', 'renewal' or 'notification'. `root` exists for
/// tests, which sign with a chain of their own.
export async function verifyAppStoreJWS(jws, { kind = 'transaction', root = appleRootG3(), bundleId = BUNDLE_ID,
                                               environment } = {}) {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3 || parts.some(p => !p)) throw new Error('storekit: not a JWS');
  const env = environment || claimedEnvironment(kind, jws);
  const verifier = verifierFor(env, { root, bundleId });
  try {
    if (kind === 'notification') return await verifier.verifyAndDecodeNotification(jws);
    if (kind === 'renewal') return await verifier.verifyAndDecodeRenewalInfo(jws);
    return await verifier.verifyAndDecodeTransaction(jws);
  } catch (error) {
    // VerificationException carries a numeric status; say which in the log.
    throw new Error(`storekit: verification failed (status ${error?.status ?? 'unknown'})`);
  }
}

function date(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/// A verified transaction as the subject row stores it, or a reason it is not
/// one Agni will honour.
///
/// A FREE TRIAL is an introductory offer (offerType 1) whose discount is a
/// free trial. offerDiscountType arrived in a later payload version; for an
/// older payload, an introductory offer at price zero is the same thing.
export function transactionState(payload, renewal = null, { bundleId = BUNDLE_ID } = {}) {
  if (payload?.bundleId !== bundleId) return { error: 'wrong_bundle' };
  if (payload?.type && payload.type !== 'Auto-Renewable Subscription') return { error: 'not_a_subscription' };
  if (!planOf(payload?.productId)) return { error: 'unknown_product' };
  if (!acceptedEnvironment(payload?.environment)) return { error: 'environment' };
  // Superseded by an upgrade inside the group: the transaction that replaced
  // it is the one that entitles. (Both plans share one level, so Agni's own
  // plan switches are crossgrades at renewal; this covers any later change.)
  if (payload?.isUpgraded === true) return { error: 'upgraded' };
  if (!payload?.originalTransactionId || !payload?.purchaseDate || !payload?.expiresDate) {
    return { error: 'incomplete' };
  }
  const intro = Number(payload.offerType) === 1;
  const isTrial = intro && (payload.offerDiscountType === 'FREE_TRIAL'
    || (payload.offerDiscountType === undefined && Number(payload.price) === 0));
  return {
    // The subject this transaction belongs to: Production and Sandbox never
    // share one, so a TestFlight purchase can never stand for a paid one.
    subject_id: subjectFor(payload.environment, payload.originalTransactionId),
    original_transaction_id: String(payload.originalTransactionId),
    transaction_id: String(payload.transactionId || ''),
    product_id: payload.productId,
    environment: payload.environment || null,
    purchase_date: date(payload.purchaseDate),
    original_purchase_date: date(payload.originalPurchaseDate),
    expires_date: date(payload.expiresDate),
    revocation_date: date(payload.revocationDate),
    revocation_reason: payload.revocationReason ?? null,
    offer_type: payload.offerType ?? null,
    offer_discount_type: payload.offerDiscountType ?? null,
    is_trial: isTrial,
    grace_expires_date: date(renewal?.gracePeriodExpiresDate),
    auto_renew: renewal ? Number(renewal.autoRenewStatus) === 1 : null,
    signed_date: date(payload.signedDate) || new Date().toISOString()
  };
}

/// `sub:` for a Production subscription, `sbx:` for a Sandbox one.
export function subjectFor(environment, originalTransactionId) {
  return (environment === 'Production' ? 'sub:' : 'sbx:') + String(originalTransactionId);
}

/// Writes a verified transaction. Never goes backwards (see the SQL).
export async function upsertSubscription(rpc, state) {
  const rows = await rpc('agni_subscription_upsert', {
    p_original_transaction_id: state.original_transaction_id,
    p_transaction_id: state.transaction_id,
    p_product_id: state.product_id,
    p_environment: state.environment,
    p_purchase_date: state.purchase_date,
    p_original_purchase_date: state.original_purchase_date,
    p_expires_date: state.expires_date,
    p_revocation_date: state.revocation_date,
    p_revocation_reason: state.revocation_reason,
    p_offer_type: state.offer_type,
    p_offer_discount_type: state.offer_discount_type,
    p_is_trial: state.is_trial,
    p_grace_expires_date: state.grace_expires_date,
    p_auto_renew: state.auto_renew,
    p_signed_date: state.signed_date
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

/// One App Store Server Notification V2, verified, applied once.
///
/// Every type that changes what someone is entitled to (SUBSCRIBED,
/// DID_RENEW, EXPIRED, DID_FAIL_TO_RENEW with grace, GRACE_PERIOD_EXPIRED,
/// REFUND, REVOKE, DID_CHANGE_RENEWAL_PREF, OFFER_REDEEMED...) carries the
/// transaction as it now stands, so the handling is the same for all of
/// them: verify it and write it, and the never-backwards rule settles the
/// order they arrive in.
export async function handleNotification(rpc, signedPayload, options = {}) {
  const outer = await verifyAppStoreJWS(signedPayload, { ...options, kind: 'notification' });
  const data = outer.data || {};
  const environment = data.environment || outer.summary?.environment;
  if (outer.notificationType === 'TEST') return { applied: false, reason: 'test', type: 'TEST', environment };
  if (!data.signedTransactionInfo) return { applied: false, reason: 'no_transaction', type: outer.notificationType };

  // The wrapped data must come from the SAME environment as the envelope.
  const inner = { ...options, environment };
  const transaction = await verifyAppStoreJWS(data.signedTransactionInfo, { ...inner, kind: 'transaction' });
  const renewal = data.signedRenewalInfo
    ? await verifyAppStoreJWS(data.signedRenewalInfo, { ...inner, kind: 'renewal' }) : null;
  const state = transactionState(transaction, renewal, options);
  if (state.error) return { applied: false, reason: state.error, type: outer.notificationType };

  const uuid = String(outer.notificationUUID || '');
  if (!uuid) return { applied: false, reason: 'no_uuid', type: outer.notificationType };
  const known = await rpc('agni_store_notification_known', { p_uuid: uuid });
  if (known === true) return { applied: false, reason: 'redelivery', type: outer.notificationType };

  // WRITE FIRST, RECORD SECOND. Recording the notification before the write
  // would turn a database blip into a refund or renewal that is never
  // applied, because Apple's retry would be ignored as a redelivery. The
  // write itself is idempotent, so a retry after a failed record is harmless.
  const row = await upsertSubscription(rpc, state);
  await rpc('agni_store_notification_seen', {
    p_uuid: uuid,
    p_type: outer.notificationType || null,
    p_subtype: outer.subtype || null,
    p_original_transaction_id: state.original_transaction_id,
    p_signed_date: date(outer.signedDate)
  });
  return { applied: !!row?.applied, type: outer.notificationType, subtype: outer.subtype || null,
           environment: state.environment };
}
