// FAIL CLOSED: no test may reach a real network host.
//
// Imported first by every test file (and by the harness), so it is in place
// before any handler module loads. It replaces fetch with a guard that throws
// for anything but a loopback address. Tests that need a provider install
// their own stub over it (harness installFetch); restoreFetch puts THIS guard
// back, never the real fetch, so a test that forgets to stub fails loudly
// instead of calling Anthropic, Supabase, Apple or USDA for real.
//
// Why it exists: on 2026-10-31 a guard-removed simulator build of the app
// sent five real, paid requests to production. The server suite was already
// stubbed file by file; this makes that the default rather than a habit.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export const blocked = [];

async function guard(url, options) {
  const target = String(url?.url ?? url);
  let host = '';
  try { host = new URL(target).hostname; } catch {}
  if (LOOPBACK.has(host)) return realFetch(url, options);
  blocked.push(target);
  throw new Error(`no-network: a test tried to reach ${target}. Stub it.`);
}

const realFetch = globalThis.__agniRealFetch ?? globalThis.fetch;
if (!globalThis.__agniNoNetwork) {
  globalThis.__agniRealFetch = realFetch;
  globalThis.fetch = guard;
  globalThis.__agniNoNetwork = guard;
}
export const noNetworkFetch = globalThis.__agniNoNetwork;
