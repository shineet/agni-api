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
/// Timeouts, ordered so each layer outlives the one below it.
///
/// A slow upstream then produces a clean structured error instead of a
/// connection cut at a random point. A Sonnet vision call is normally 5 to 15
/// seconds, so 40 is generous without being indefinite.
///
///   Anthropic upstream   40s   (here)
///   Vercel function      55s   (vercel.json)
///   Agni client          65s   (AnthropicConfig)
export const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 40_000);

/// The largest request body accepted, in bytes.
///
/// MEASURED, not guessed. At Agni's real settings a food estimate body is about
/// 280 KB: a 1568px JPEG at quality 0.7 is 203 KB, which is 270 KB once base64
/// encoded, plus about 5 KB of prompt and schema. A drink routing check is
/// about 30 KB.
///
/// 1.5 MB is roughly five times the food payload. It rejects a full-resolution
/// photograph outright while leaving room for a denser picture than the one
/// measured.
///
/// Deliberately NOT accompanied by server-side JPEG dimension parsing: this cap
/// already bounds the cost, and decoding image headers would be more parsing
/// code inside a security path for no further protection.
export const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1_500_000);

/// Approved limits, per attested key. Every one is remotely configurable, so a
/// limit that turns out to be wrong is an environment variable rather than a
/// deploy.
///
/// Derived from measured usage rather than chosen: ONE FOOD PHOTO IS TWO AI
/// CALLS, the drink routing check and the estimate, so a limit in calls reads
/// as half that in photographs.
///
///   per minute  10   one photo is 2 calls in ~5s; a double retry is 4; a thali
///                    plus three breakdowns is 5. Five times the busiest
///                    legitimate minute, and it stops a script immediately.
///   per hour    60   an active hour, four meals with corrections, is about 15.
///   per day    100   a heavy user is 25 to 30.
///   spend    $1.00   a normal user costs $0.07 to $0.13 a day, heavy about
///                    $0.40. Bounds the worst case 100 calls could reach.
///   global   $25.00  untouchable at current scale. It exists so a bug or an
///                    attack cannot produce an open-ended bill overnight.
export const LIMITS = {
  perMinute: Number(process.env.RATE_PER_MINUTE || 10),
  perHour: Number(process.env.RATE_PER_HOUR || 60),
  perDay: Number(process.env.RATE_PER_DAY || 100),
  daySpendUSD: Number(process.env.DAY_SPEND_CAP_USD || 1.0),
  globalDaySpendUSD: Number(process.env.GLOBAL_DAY_SPEND_CAP_USD || 25.0)
};

/// List pricing, so the cost of a finished call can be recorded.
const PRICING = {
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 }
};

/// What a completed call cost, from the tokens Anthropic reported.
///
/// An unknown model is priced at the dearest rate rather than free: a model the
/// allow-list somehow let through should cost more than nothing.
export function costOfUsage(model, usage) {
  const rate = PRICING[model] || { input: 2.0, output: 10.0 };
  const input = Number(usage?.input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  return (input / 1_000_000) * rate.input + (output / 1_000_000) * rate.output;
}

/// Turns a gate refusal into something the app can act on differently.
///
/// The distinction matters: waiting a minute fixes `minute`, and does nothing
/// at all for `day` or `spend`. Telling somebody to try again shortly when they
/// cannot is worse than telling them nothing.
export function refusal(reason) {
  switch (reason) {
    case 'minute':
    case 'hour':
      return { status: 429, type: AgniError.rateLimited,
               message: 'Agni is catching up. Try again in a moment, or log this meal by hand.' };
    case 'day':
      return { status: 429, type: AgniError.usageLimitReached,
               message: "That is today's limit for photo analysis. You can still log meals by hand." };
    case 'spend':
      return { status: 429, type: AgniError.usageLimitReached,
               message: "That is today's limit for photo analysis. You can still log meals by hand." };
    case 'global_spend':
      return { status: 503, type: AgniError.serviceUnavailable,
               message: 'Photo analysis is paused for now. You can still log meals by hand.' };
    case 'replay':
    case 'unknown_key':
      return { status: 401, type: AgniError.temporaryVerificationFailure,
               message: 'This device could not be verified.' };
    default:
      return { status: 503, type: AgniError.serviceUnavailable,
               message: 'Photo analysis is unavailable right now. You can still log meals by hand.' };
  }
}

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
