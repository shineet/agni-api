// Shared helpers. No npm dependencies anywhere in this project, deliberately:
// it is two endpoints and a fetch, and a dependency tree would be more code to
// maintain than the thing it serves.

export const FREE_LIMIT = Number(process.env.FREE_ESTIMATE_LIMIT || 50);

/// Models this proxy will pay for. The app supplies the whole request body so
/// the prompt lives in one place, which means the body is also untrusted: without
/// this, anyone holding the app token could bill an expensive model to the key.
const ALLOWED_MODELS = new Set(['claude-sonnet-5', 'claude-haiku-4-5']);
const MAX_TOKENS_CAP = 4096;

/// THE LEGACY PATH, and its sunset.
///
/// The shared token ships inside the app binary and anyone can extract it from
/// an IPA. It is not authentication and must not be treated as such once Agni
/// is public. It stays only so builds already on testers' phones keep working
/// while App Attest rolls out.
///
/// SERVER-CONTROLLED. Set LEGACY_TOKEN_ENABLED=false on Vercel and every legacy
/// request stops being accepted, with no app release and no redeploy of the
/// client. Before public launch this must be off.
export function legacyTokenEnabled() {
  return (process.env.LEGACY_TOKEN_ENABLED || 'true').toLowerCase() !== 'false';
}

export function authorised(req) {
  if (!legacyTokenEnabled()) return false;
  const expected = process.env.APP_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${expected}`;
}

/// Errors the app knows how to explain. The provider's own words never reach a
/// customer: they can carry internals, and "overloaded_error" is not something
/// anybody photographing their lunch can act on.
export const AgniError = {
  serviceUnavailable: 'serviceUnavailable',
  rateLimited: 'rateLimited',
  usageLimitReached: 'usageLimitReached',
  subscriptionRequired: 'subscriptionRequired',
  invalidRequest: 'invalidRequest',
  temporaryVerificationFailure: 'temporaryVerificationFailure'
};

export function fail(res, status, type, message) {
  return json(res, status, { error: { type, message } });
}

/// The master switch. One environment variable stops all AI spend immediately,
/// without taking the deployment down and without an app release.
export function aiEnabled() {
  return (process.env.AI_ENABLED || 'true').toLowerCase() !== 'false';
}

/// How many complimentary analyses a new, attested installation gets before it
/// is asked to subscribe. Remotely configurable, deliberately: the number is a
/// commercial decision and must not need an app release to change.
export function complimentaryLimit() {
  return Number(process.env.FREE_AI_ANALYSES || 3);
}

export function validateRequest(body) {
  if (!body || typeof body !== 'object') return 'Missing request body.';
  if (!ALLOWED_MODELS.has(body.model)) return `Model ${body.model} is not allowed.`;
  if (typeof body.max_tokens !== 'number' || body.max_tokens > MAX_TOKENS_CAP) {
    return `max_tokens must be a number no greater than ${MAX_TOKENS_CAP}.`;
  }
  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    return 'Expected exactly one message.';
  }
  return null;
}

/// Accepts either form Supabase shows you: the bare project URL from Settings,
/// or the Data API URL, which already ends in /rest/v1/. Pasting the second into
/// a variable the code appends /rest/v1/ to is an easy and very confusing 404.
import { supabaseRPC } from './_supabase.js';


/// Fails loudly in the logs, quietly to the caller.
///
/// The first failure of this service was a 503 with nothing in the logs to say
/// why, because the reason was caught and dropped. A tester never needs the
/// detail; whoever is debugging it always does.
export function report(where, error) {
  console.error(`[agni-api] ${where}: ${error?.message || error}`);
}

export async function checkQuota(installId) {
  const rows = await supabaseRPC('agni_check', { p_install_id: installId });
  const row = Array.isArray(rows) ? rows[0] : rows;
  const used = row?.used ?? 0;
  const unlimited = row?.is_unlimited ?? false;
  return { used, unlimited, limit: FREE_LIMIT, allowed: unlimited || used < FREE_LIMIT };
}

export async function consume(installId) {
  const used = await supabaseRPC('agni_consume', { p_install_id: installId });
  return typeof used === 'number' ? used : Number(used);
}

/// Records one person's version of a dish. Their own previous answer for the
/// same dish is replaced, so somebody entering chapati every week is one voice.
export async function submitDish(installId, dish) {
  await supabaseRPC('agni_submit_dish', {
    p_install_id: installId,
    p_key: dish.key,
    p_name: dish.name,
    p_unit: dish.unit ?? 'serving',
    p_grams_per_unit: dish.gramsPerUnit ?? 0,
    p_kcal: dish.kcal,
    p_protein_g: dish.proteinG ?? 0,
    p_carbs_g: dish.carbsG ?? 0,
    p_fat_g: dish.fatG ?? 0
  });
}

/// Published dishes only. The view behind this is what enforces that, so no
/// caller can leak an uncorroborated entry by forgetting a condition.
export async function searchDishes(query, limit) {
  const rows = await supabaseRPC('agni_search_dishes', {
    p_query: query,
    p_limit: limit
  });
  return Array.isArray(rows) ? rows : [];
}

/// Records one phone's count for one missing dish. Idempotent: the phone sends
/// its running total, which replaces what is stored rather than adding to it.
export async function reportMiss(installId, miss) {
  await supabaseRPC('agni_report_miss', {
    p_install_id: installId,
    p_key: miss.key,
    p_name: miss.name,
    p_kind: miss.kind,
    p_times: miss.times ?? 1,
    p_first_seen: miss.firstSeen ?? null,
    p_last_seen: miss.lastSeen ?? null
  });
}

/// The variant cache, both directions. Returns null on a miss rather than
/// throwing: a miss is the ordinary case, not a failure.
export async function cachedVariants(key) {
  const payload = await supabaseRPC('agni_cached_variants', { p_key: key });
  return payload ?? null;
}

export async function cacheVariants(key, variants) {
  await supabaseRPC('agni_cache_variants', { p_key: key, p_payload: variants });
}

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.send(JSON.stringify(body));
}
