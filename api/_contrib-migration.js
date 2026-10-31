// One-off admin op: convert the raw install ids already stored beside dish
// data to the contributor hash new rows get. Runbook: migrations/README.md.
//
//   POST /api/quota?op=contrib-migrate   x-admin-token: <BETA_ADMIN_TOKEN>
//   { "mode": "preview" | "apply" | "verify" | "rollback" }
//
// THE SECRET STAYS HERE. The hash is keyed on CONTRIBUTOR_SALT or IP_HASH_SALT.
// This op reads the raw ids, computes each hash in this process with the same
// contributorId() every new row uses, and passes the database a map of raw id
// to hash. The secret is never sent to the database, a SQL editor, a log or a
// response, and responses carry counts only: never an id or a hash.
//
// Pseudonymous, not anonymous: whoever holds the secret and an install id can
// recompute that phone's hash. The conversion only stops the raw install id
// sitting beside dish data, where a plain join reached usage records.

import crypto from 'node:crypto';
import { contributorId, json, report } from './_lib.js';
import { supabaseRPC } from './_supabase.js';

const MODES = new Set(['preview', 'apply', 'verify', 'rollback']);
const PAGE = 1000;   // ids read per page
const CHUNK = 500;   // ids converted per transaction

function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function rawIds() {
  const ids = [];
  let after = '';
  for (;;) {
    const page = await supabaseRPC('agni_contrib_raw_ids', { p_after: after, p_limit: PAGE });
    const rows = (Array.isArray(page) ? page : []).map(r => (typeof r === 'string' ? r : Object.values(r)[0]));
    ids.push(...rows);
    if (rows.length < PAGE) return ids;
    after = rows[rows.length - 1];
  }
}

function mapFor(ids) {
  return ids.map(raw => ({ raw, hashed: contributorId(raw) })).filter(e => e.hashed);
}

function sum(rows, field) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) out[r.tbl] = Number(r[field] || 0);
  return out;
}

function checks(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) out[r.check_name] = Number(r.value);
  return out;
}

export async function contribMigration(req, res, body) {
  const expected = process.env.BETA_ADMIN_TOKEN;
  if (!expected) return json(res, 503, { ok: false, message: 'Admin ops are not switched on.' });
  const given = req.headers['x-admin-token'];
  if (typeof given !== 'string' || !given || !sameSecret(given, expected)) {
    return json(res, 401, { ok: false, message: 'Not authorised.' });
  }
  // Without the real key, contributorId falls back to a built-in constant and
  // would write hashes that match nothing the server writes. Refuse.
  if (!process.env.CONTRIBUTOR_SALT && !process.env.IP_HASH_SALT) {
    return json(res, 503, { ok: false, message: 'No contributor key is configured.' });
  }
  const mode = String(body?.mode || '');
  if (!MODES.has(mode)) return json(res, 400, { ok: false, message: 'mode must be preview, apply, verify or rollback.' });

  res.setHeader('cache-control', 'no-store, private');
  try {
    if (mode === 'verify') {
      return json(res, 200, { ok: true, mode, checks: checks(await supabaseRPC('agni_contrib_verify', {})) });
    }
    if (mode === 'rollback') {
      const rows = await supabaseRPC('agni_contrib_rollback', {});
      return json(res, 200, { ok: true, mode, removed: sum(rows, 'removed'), restored: sum(rows, 'restored'),
                              checks: checks(await supabaseRPC('agni_contrib_verify', {})) });
    }

    const map = mapFor(await rawIds());
    if (mode === 'preview') {
      const rows = map.length ? await supabaseRPC('agni_contrib_preview', { p_map: map }) : [];
      return json(res, 200, { ok: true, mode, rawIds: map.length,
                              rawRows: sum(rows, 'raw_rows'), merges: sum(rows, 'merges') });
    }

    // apply: snapshot with the FULL map first, then convert in chunks. Each
    // chunk is one transaction with its own backup; a failure part-way leaves
    // converted chunks converted and the rest raw, and a re-run finishes it.
    const snapshotDishes = map.length ? await supabaseRPC('agni_contrib_snapshot', { p_map: map }) : 0;
    const totals = { backedUp: {}, merged: {}, converted: {} };
    for (let i = 0; i < map.length; i += CHUNK) {
      const rows = await supabaseRPC('agni_contrib_apply', { p_map: map.slice(i, i + CHUNK) });
      for (const r of Array.isArray(rows) ? rows : []) {
        totals.backedUp[r.tbl] = (totals.backedUp[r.tbl] || 0) + Number(r.backed_up || 0);
        totals.merged[r.tbl] = (totals.merged[r.tbl] || 0) + Number(r.merged || 0);
        totals.converted[r.tbl] = (totals.converted[r.tbl] || 0) + Number(r.converted || 0);
      }
    }
    return json(res, 200, { ok: true, mode, rawIds: map.length, snapshotDishes: Number(snapshotDishes || 0),
                            ...totals, checks: checks(await supabaseRPC('agni_contrib_verify', {})) });
  } catch (error) {
    // NOT the database's message: a constraint error quotes the row it hit,
    // and that row holds an install id. The mode is enough to find it.
    report('contrib migration', new Error(`${mode} failed`));
    return json(res, 503, { ok: false, mode, message: 'The conversion step failed; nothing in that step was kept.' });
  }
}
