// Shared helpers. No npm dependencies anywhere in this project, deliberately:
// it is two endpoints and a fetch, and a dependency tree would be more code to
// maintain than the thing it serves.

export const FREE_LIMIT = Number(process.env.FREE_ESTIMATE_LIMIT || 50);

/// Models this proxy will pay for. The app supplies the whole request body so
/// the prompt lives in one place, which means the body is also untrusted: without
/// this, anyone holding the app token could bill an expensive model to the key.
const ALLOWED_MODELS = new Set(['claude-sonnet-5', 'claude-haiku-4-5']);
const MAX_TOKENS_CAP = 4096;

export function authorised(req) {
  const expected = process.env.APP_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${expected}`;
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
function supabaseBase() {
  const raw = (process.env.SUPABASE_URL || '').trim();
  return raw.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

async function supabaseRPC(fn, args) {
  const base = supabaseBase();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Named explicitly. A missing SUPABASE_URL otherwise surfaces as a confusing
  // "Failed to parse URL" from fetch, which reads like a code bug rather than
  // an environment variable nobody set.
  if (!base) throw new Error('SUPABASE_URL is not set on this deployment.');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set on this deployment.');

  const url = `${base}/rest/v1/rpc/${fn}`;

  // Supabase has two generations of key. The legacy service_role key is a JWT
  // and goes in both headers. The current sb_secret_… key is not a JWT, and
  // putting a non-JWT in Authorization is how you get an "invalid JWT" 401.
  // Detecting on the shape means either generation works.
  const headers = {
    'content-type': 'application/json',
    apikey: key
  };
  if (key.startsWith('eyJ')) {
    headers.authorization = `Bearer ${key}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(args)
  });

  if (!response.ok) {
    throw new Error(`Supabase ${fn} failed: ${response.status} ${await response.text()}`);
  }

  // A function that returns void answers 204 with an empty body, and .json()
  // throws on nothing at all. That threw AFTER the row had already been
  // written, so the insert worked, the caller counted it as a failure, and
  // every submit answered "accepted: 0" while the data quietly landed.
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

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

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.send(JSON.stringify(body));
}
