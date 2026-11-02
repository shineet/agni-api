// Who is asking, what they are entitled to, and which allowance period they
// are in. One place, so estimate, research, ingredient and quota cannot
// disagree about any of it.

import { supabaseRPC } from './_supabase.js';
import {
  allowances, billingEnforced, billingEnforcedFor, budgetTierFor, cleanId, FEATURES, freeAIEnabled, periodFor, planOf, tierFor
} from './_billing.js';
import { deviceCheckConfigured } from './_devicecheck.js';

/// A subscription presented by more installs than this in 30 days is refused
/// on the next one: a leaked transaction, not a household.
export const MAX_KEYS_PER_SUBSCRIPTION = Number(process.env.MAX_INSTALLS_PER_SUBSCRIPTION || 10);

/// The device subject for an attested key.
///
/// The install id is the Keychain id the app keeps across reinstalls, and on
/// a current build it travels INSIDE the signed body or query, so it cannot
/// be swapped in flight. The key's device link is made once and never moves,
/// so even a forged id could only ever be used on a brand-new key.
function deviceSubject(installId, keyId) {
  const id = cleanId(installId);
  return 'dev:' + (id || `key:${String(keyId).slice(0, 40)}`);
}

export async function resolveCaller(auth, { installId } = {}) {
  if (auth.path === 'legacy') {
    const id = cleanId(installId);
    return {
      tier: 'legacy',
      budgetTier: 'legacy',
      subject: 'legacy:' + (id || `ip:${auth.ipHash}`),
      subjectKind: 'legacy',
      deviceSubject: null,
      enforced: billingEnforced(),
      context: null,
      period: periodFor('legacy', null)
    };
  }

  const rows = await supabaseRPC('agni_caller', {
    p_key_id: auth.keyId,
    p_device_subject: deviceSubject(installId, auth.keyId)
  });
  const context = Array.isArray(rows) ? rows[0] : rows;
  if (!context) throw new Error('caller context missing');

  // Per caller, not global: a device listed in BILLING_ENFORCED_DEVICES sees
  // launch behaviour (Free until it subscribes) while the switch is off.
  const enforced = billingEnforcedFor(context.device_subject);
  const tier = tierFor(context, { enforced });
  const subscribed = tier === 'trial' || tier === 'pro';
  return {
    tier,
    // Sandbox subscriptions unlock Pro but are accounted as `sandbox`.
    budgetTier: budgetTierFor(tier, context),
    subject: subscribed ? context.subscription_subject : context.device_subject,
    subjectKind: subscribed ? 'subscription' : 'device',
    // Always the device, whichever subject is charged: recorded on every
    // usage row so a device's own history can be told apart.
    deviceSubject: context.device_subject || null,
    enforced,
    context,
    period: periodFor(tier, context)
  };
}

/// Whether this caller may use this feature at all, before any money moves.
/// Returns null when allowed, or the refusal to send.
export function entitlementRefusal(caller, feature) {
  const spec = FEATURES[feature];
  if (!spec) return { status: 400, type: 'invalidRequest', message: 'Unknown feature.' };
  if (!spec.tiers.includes(caller.tier)) {
    return {
      status: 402, type: 'subscriptionRequired', feature, tier: caller.tier,
      message: 'This is part of Agni Pro. Search, barcode and quick add still work.'
    };
  }
  if (caller.tier === 'free' && !freeAIEnabled()) {
    return {
      status: 503, type: 'aiPaused', tier: caller.tier,
      message: 'AI analysis is paused for a little while. Search, barcode and quick add still work.'
    };
  }
  // A Free device must have been checked with DeviceCheck before it spends
  // its sample, when DeviceCheck is set up. The app answers 428 by refreshing
  // its allowance (which carries the device token) and trying once more.
  if (caller.tier === 'free' && deviceCheckConfigured() && !caller.context?.devicecheck_checked_at) {
    return {
      status: 428, type: 'deviceCheckRequired', tier: caller.tier,
      message: 'Agni needs to check this device first.'
    };
  }
  return null;
}

/// The allowance for this caller, with a Free sample DeviceCheck has already
/// seen used on this device shut to zero.
export function limitsFor(caller) {
  const limits = { ...(allowances()[caller.tier] || allowances().legacy) };
  if (caller.tier === 'free') {
    if (caller.context?.free_photo_exhausted) limits.photo = 0;
    if (caller.context?.free_search_exhausted) limits.search = 0;
  }
  return limits;
}

/// What the app shows: remaining credits per bucket and exact reset times.
export async function allowanceStatus(caller) {
  const limits = limitsFor(caller);
  const periodStart = new Date(caller.period.start).toISOString();
  let usage = { photo_used: 0, search_used: 0, web_used: 0, cost_usd: 0, photos_today: 0 };
  if (caller.subject) {
    const rows = await supabaseRPC('agni_allowance_status', {
      p_subject: caller.subject, p_period_start: periodStart, p_tier: caller.tier
    });
    usage = (Array.isArray(rows) ? rows[0] : rows) || usage;
  }
  const bucket = (used, limit) => limit === null || limit === undefined
    ? { used: Number(used || 0), limit: null, remaining: null }
    : { used: Number(used || 0), limit, remaining: Math.max(0, limit - Number(used || 0)) };
  const periodEnd = caller.period.end === 'infinity' ? null : new Date(caller.period.end).toISOString();
  const tomorrow = new Date();
  tomorrow.setUTCHours(24, 0, 0, 0);
  const costCap = limits.costCapUSD;
  const costUsed = Number(usage.cost_usd || 0);
  return {
    tier: caller.tier,
    billingEnforced: caller.enforced ?? billingEnforced(),
    plan: planOf(caller.context?.product_id) || null,
    // 'Sandbox' for TestFlight and App Review purchases, so a tester can see
    // which world they are in. Null on Free.
    environment: caller.tier === 'pro' || caller.tier === 'trial' ? (caller.context?.environment || null) : null,
    isTrial: caller.tier === 'trial',
    subscriptionExpiresAt: caller.context?.expires_date || null,
    // No reset for the Free sample: it is introductory, not monthly.
    periodStart: caller.tier === 'free' ? null : periodStart,
    resetsAt: caller.tier === 'free' ? null : periodEnd,
    buckets: {
      photo: bucket(usage.photo_used, limits.photo),
      search: bucket(usage.search_used, limits.search),
      web: bucket(usage.web_used, limits.web)
    },
    photosToday: Number(usage.photos_today || 0),
    photoDailyLimit: limits.burst ?? null,
    dailyResetAt: tomorrow.toISOString(),
    // Money is not shown to people. A fraction is, so the app can warn
    // quietly before the aggregate ceiling stops anything.
    budgetUsedFraction: costCap
      ? Math.min(1, Math.round((costUsed / (costCap + Number(usage.cost_cap_grant_usd || 0))) * 100) / 100)
      : null,
    // What Pro and the trial include, from the same configuration the server
    // enforces, so the paywall can never promise a number the server does
    // not honour.
    offer: {
      pro: { photo: allowances().pro.photo, search: allowances().pro.search, web: allowances().pro.web,
             photoDailyLimit: allowances().pro.burst },
      trial: { photo: allowances().trial.photo, search: allowances().trial.search, web: allowances().trial.web },
      free: { photo: allowances().free.photo, search: allowances().free.search }
    }
  };
}
