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

async function supabaseRPC(fn, args) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  return response.json();
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

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.send(JSON.stringify(body));
}
