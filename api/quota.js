import { checkQuota, json, report, readJSONBody } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';
import { supabaseRPC } from './_supabase.js';
import { resolveCaller, allowanceStatus, MAX_KEYS_PER_SUBSCRIPTION } from './_caller.js';
import { cleanId, raiseAlert } from './_billing.js';
import { verifyAppStoreJWS, transactionState, upsertSubscription, handleNotification } from './_storekit.js';
import { deviceCheckConfigured, queryBits, setBits } from './_devicecheck.js';
import { contribMigration } from './_contrib-migration.js';
import { deleteData } from './_deletion.js';

/// The account endpoint: allowance, subscription sync and App Store
/// notifications. One function, because Vercel's Hobby plan counts them and
/// this project is at its twelve.
///
///   GET  /api/quota?installId=...         allowance and tier (attested), or
///                                         the old free-estimate count (legacy)
///   POST /api/quota?op=sync               { installId, transactions: [jws] }
///                                         StoreKit 2 signed transactions from
///                                         the app, verified against Apple's
///                                         root, linked to this install
///   POST /api/app-store-notifications     App Store Server Notifications V2
///                                         (rewritten here as ?op=notify)
///   POST /api/quota?op=delete-data        the person deletes what the server
///                                         holds about this phone, or (as the
///                                         purchaser) their subscription's
///                                         history. App Attest only; see
///                                         api/_deletion.js
///   POST /api/quota?op=contrib-migrate    one-off admin conversion of stored
///                                         install ids to contributor hashes
///                                         (BETA_ADMIN_TOKEN; migrations/README.md)
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const op = String(req.query?.op || '');

  let rawBody = Buffer.alloc(0);
  let body = {};
  try {
    ({ raw: rawBody, body } = await readJSONBody(req));
  } catch {
    return json(res, 400, { error: { type: 'invalidRequest', message: 'Unreadable body.' } });
  }

  // Apple calls this one, not the app: its authority is Apple's signature on
  // the payload, checked before anything is written.
  if (req.method === 'POST' && op === 'notify') return notify(res, body);
  // The operator, not the app: authority is BETA_ADMIN_TOKEN, checked inside.
  if (req.method === 'POST' && op === 'contrib-migrate') return contribMigration(req, res, body);

  const auth = await authenticate(req, {
    meterClass: MeterClass.read,
    path: '/api/quota',
    query: req.query || {},
    rawBody,
    // Subscription sync and deletion are attested only. The shared token can
    // never tie a purchase to an install, or prove whose records are whose.
    allowLegacy: !(req.method === 'POST' && (op === 'sync' || op === 'delete-data'))
  });
  recordAuth(op === 'sync' ? 'quota-sync' : op === 'delete-data' ? 'quota-delete' : 'quota', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    return json(res, auth.status || 401,
      { error: { type: 'unauthorized', message: 'This device could not be verified.' } });
  }

  if (req.method === 'POST' && op === 'sync') return sync(req, res, auth, body);
  if (req.method === 'POST' && op === 'delete-data') return deleteData(req, res, auth, body);
  if (req.method === 'GET') return status(req, res, auth);
  return json(res, 405, { error: { type: 'invalidRequest', message: 'Method not allowed.' } });
}

async function status(req, res, auth) {
  const installId = req.query?.installId;

  // OLD BUILDS read used, limit and unlimited and nothing else. Kept, so the
  // Settings line on 174 and 175 says exactly what it says today.
  let legacyQuota = null;
  const quotaSubject = auth.keyId || cleanId(installId);
  if (quotaSubject) {
    try { legacyQuota = await checkQuota(quotaSubject); } catch (error) { report('quota check', error); }
  }
  if (auth.path === 'legacy') {
    if (!legacyQuota) {
      return json(res, 503, { error: { type: 'quota_unavailable', message: 'Could not check usage.' } });
    }
    return json(res, 200, legacyQuota);
  }

  let caller;
  try {
    caller = await resolveCaller(auth, { installId });
  } catch (error) {
    report('quota caller', error);
    return json(res, 503, { error: { type: 'quota_unavailable', message: 'Could not check usage.' } });
  }

  // DEVICECHECK, at the moment the app asks for its allowance rather than in
  // front of a photo: a Free device that has used its sample before, on any
  // install, is closed before it can spend it again.
  const deviceToken = String(req.headers['x-agni-devicecheck'] || '').slice(0, 8000);
  if (caller.tier === 'free' && deviceCheckConfigured() && deviceToken) {
    try {
      if (!caller.context?.devicecheck_checked_at) {
        const bits = await queryBits(deviceToken, auth.environment);
        if (bits) {
          await supabaseRPC('agni_mark_device', {
            p_subject: caller.context.device_subject, p_photo: bits.photo, p_search: bits.search
          });
          caller = await resolveCaller(auth, { installId });
        }
      }
    } catch (error) {
      report('devicecheck query', error);
    }
  }

  let allowance;
  try {
    allowance = await allowanceStatus(caller);
  } catch (error) {
    report('allowance status', error);
    return json(res, 503, { error: { type: 'quota_unavailable', message: 'Could not check usage.' } });
  }

  // A Free sample just used up is written to the device, so a reinstall
  // cannot hand it out again.
  if (caller.tier === 'free' && deviceCheckConfigured() && deviceToken) {
    const photo = allowance.buckets.photo.remaining === 0;
    const search = allowance.buckets.search.remaining === 0;
    if ((photo && !caller.context?.free_photo_exhausted) || (search && !caller.context?.free_search_exhausted)) {
      setBits(deviceToken, auth.environment, {
        photo: photo || caller.context?.free_photo_exhausted,
        search: search || caller.context?.free_search_exhausted
      }).catch(error => report('devicecheck update', error));
    }
  }

  return json(res, 200, {
    used: legacyQuota?.used ?? 0,
    limit: legacyQuota?.limit ?? 0,
    unlimited: legacyQuota?.unlimited ?? false,
    allowed: legacyQuota?.allowed ?? true,
    allowance
  });
}

/// StoreKit 2 transactions from the app: purchase, restore, renewal, launch.
///
/// Each JWS is verified by Apple's App Store Server Library, against the
/// pinned root, before anything is read from it. Sandbox purchases (TestFlight,
/// App Review) are accepted onto their own `sbx:` subjects. The newest still-active transaction becomes this install's
/// subscription; an expired, refunded or revoked one is still WRITTEN, so the
/// record moves forward, but it entitles nothing.
async function sync(req, res, auth, body) {
  const signed = Array.isArray(body.transactions) ? body.transactions.slice(0, 10) : [];
  if (signed.length === 0) return json(res, 400, { error: { type: 'invalidRequest', message: 'No transactions.' } });

  const accepted = [];
  for (const jws of signed) {
    let state;
    try {
      state = transactionState(await verifyAppStoreJWS(jws, { kind: 'transaction' }));
    } catch (error) {
      report('storekit verify', error);
      continue;
    }
    if (state.error) {
      report('storekit transaction', new Error(state.error));
      continue;
    }
    try {
      await upsertSubscription(supabaseRPC, state);
      accepted.push(state);
    } catch (error) {
      report('storekit upsert', error);
    }
  }
  if (accepted.length === 0) {
    return json(res, 422, { error: { type: 'invalidTransaction', message: 'No purchase could be verified.' } });
  }

  // The subscription to link: the one whose stored state is newest.
  const latest = accepted.slice().sort((a, b) => new Date(b.expires_date) - new Date(a.expires_date))[0];
  let link;
  try {
    // Device subject first, so the key exists in agni_key_links.
    await resolveCaller(auth, { installId: body.installId });
    const rows = await supabaseRPC('agni_link_key', {
      p_key_id: auth.keyId,
      p_device_subject: 'dev:' + (cleanId(body.installId) || `key:${String(auth.keyId).slice(0, 40)}`),
      // sub: for Production, sbx: for Sandbox (TestFlight, App Review).
      p_subscription_subject: latest.subject_id,
      p_max_keys: MAX_KEYS_PER_SUBSCRIPTION
    });
    link = Array.isArray(rows) ? rows[0] : rows;
  } catch (error) {
    report('subscription link', error);
    return json(res, 503, { error: { type: 'serviceUnavailable', message: 'Could not save the purchase.' } });
  }
  if (!link?.linked) {
    raiseAlert('subscription refused for too many installs', { reason: link?.reason });
    return json(res, 409, { error: { type: 'tooManyInstalls',
      message: 'This subscription is in use on too many devices. Contact support if this is wrong.' } });
  }

  const caller = await resolveCaller(auth, { installId: body.installId });
  return json(res, 200, { allowance: await allowanceStatus(caller) });
}

async function notify(res, body) {
  if (!body?.signedPayload) return json(res, 400, { error: 'signedPayload missing' });
  try {
    const result = await handleNotification(supabaseRPC, body.signedPayload);
    return json(res, 200, { ok: true, ...result });
  } catch (error) {
    // Unverifiable: not Apple, or not this app. Apple retries anything other
    // than a 2xx, which is right for a database blip and harmless here.
    report('store notification', error);
    return json(res, 400, { error: 'unverifiable' });
  }
}
