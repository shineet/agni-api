// One-off admin op: remove self-test dishes from the shared dish table, by
// exact row. Proposal, evidence and runbook:
// docs/readonly-queries/test-dish-cleanup-proposal.md. NOT RUN.
//
//   POST /api/quota?op=test-dish-cleanup   x-admin-token: <BETA_ADMIN_TOKEN>
//   { "mode": "preview" | "apply" | "verify" | "rollback",
//     "pairs": [ { "key": "coffee", "install_id": "05F7BACD-..." }, ... ] }
//
// EXACT ROWS ONLY. The request names each (dish key, install id) pair. There
// is no wildcard, no "all rows from this install", no match on a dish name.
// Each pair is expanded here to both forms a row may hold: the raw install id
// (rows from before the contributor conversion) and its c1: hash (after). The
// salt stays in this process; responses carry dish keys and counts, never an
// install id or a hash.

import crypto from 'node:crypto';
import { contributorId, json, report } from './_lib.js';
import { supabaseRPC } from './_supabase.js';
import { cleanId } from './_billing.js';

const MODES = new Set(['preview', 'apply', 'verify', 'rollback']);
export const MAX_PAIRS = 200;

function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/// The pairs as the SQL takes them, or an error message.
export function expandPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return { error: 'pairs must list at least one (key, install_id).' };
  if (pairs.length > MAX_PAIRS) return { error: `at most ${MAX_PAIRS} pairs per request.` };
  const out = [];
  for (const p of pairs) {
    const key = typeof p?.key === 'string' ? p.key.trim() : '';
    const id = cleanId(p?.install_id);
    if (!key || !id || /[%*?]/.test(key)) return { error: 'every pair needs an exact key and install_id.' };
    out.push({ key, install_id: id });
    const hashed = contributorId(id);
    if (hashed && hashed !== id) out.push({ key, install_id: hashed });
  }
  return { pairs: out };
}

export async function dishCleanup(req, res, body) {
  const expected = process.env.BETA_ADMIN_TOKEN;
  if (!expected) return json(res, 503, { ok: false, message: 'Admin ops are not switched on.' });
  const given = req.headers['x-admin-token'];
  if (typeof given !== 'string' || !given || !sameSecret(given, expected)) {
    return json(res, 401, { ok: false, message: 'Not authorised.' });
  }
  const mode = String(body?.mode || '');
  if (!MODES.has(mode)) return json(res, 400, { ok: false, message: 'mode must be preview, apply, verify or rollback.' });
  res.setHeader('cache-control', 'no-store, private');

  try {
    if (mode === 'rollback') {
      const restored = await supabaseRPC('agni_dish_cleanup_rollback', {});
      return json(res, 200, { ok: true, mode, restored: Number(restored || 0) });
    }
    const { pairs, error } = expandPairs(body?.pairs);
    if (error) return json(res, 400, { ok: false, message: error });

    if (mode === 'preview') {
      const rows = await supabaseRPC('agni_dish_cleanup_preview', { p_pairs: pairs });
      return json(res, 200, { ok: true, mode, keys: Array.isArray(rows) ? rows : [] });
    }
    if (mode === 'apply') {
      const rows = await supabaseRPC('agni_dish_cleanup_apply', { p_pairs: pairs });
      const r = Array.isArray(rows) ? rows[0] : rows;
      return json(res, 200, { ok: true, mode, backedUp: Number(r?.backed_up || 0), deleted: Number(r?.deleted || 0),
                              keysUnpublished: Number(r?.keys_unpublished || 0) });
    }
    const rows = await supabaseRPC('agni_dish_cleanup_verify', { p_pairs: pairs });
    const r = Array.isArray(rows) ? rows[0] : rows;
    return json(res, 200, { ok: true, mode, remaining: Number(r?.remaining || 0), inBackup: Number(r?.in_backup || 0),
                            unpublishedKeys: r?.unpublished_keys || [] });
  } catch (error) {
    // Not the database's message: it could quote a row and its contributor.
    report('dish cleanup', new Error(`${mode} failed`));
    return json(res, 503, { ok: false, mode, message: 'The step failed; nothing in that step was kept.' });
  }
}
