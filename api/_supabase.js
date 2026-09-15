// The Supabase RPC transport, split out so the attestation endpoints can use
// the same connection handling as the quota ones rather than a second copy.

export function supabaseBase() {
  const raw = (process.env.SUPABASE_URL || '').trim();
  return raw.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

export async function supabaseRPC(fn, args) {
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

