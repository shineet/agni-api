// Operator ops: find who the cost safeguard stopped with credits left, and
// restore them. Runbook: docs/cost-cap-restore.md.
//
//   POST /api/quota?op=cost-cap-stops     x-admin-token: <BETA_ADMIN_TOKEN>
//   { "sinceDays": 35 }                   (default 35, at most 400)
//
//   POST /api/quota?op=cost-cap-restore   x-admin-token: <BETA_ADMIN_TOKEN>
//   { "mode": "preview" | "apply", "supportId": "AG-XXXXXXXXXX" }   or   { ..., "ref": "<from the list>" }
//   optional "amountUSD" (default: the tier's own cap, so the period's
//   safeguard at most doubles)
//
// WHY AN OP AND NOT AN ALERT ALONE. An alert with no subject in it cannot tell
// anyone whose access to restore, and an alert WITH one would put a purchase
// identifier into logs and webhooks. The subject stays in a server-only table
// (agni_cost_cap_stops); this op, behind the admin token, turns it into
// something an operator can act on: the Support IDs the person sees in
// Settings, the period, and how far through their counts they were.
//
// WHAT A RESTORE CAN AND CANNOT DO. It adds safeguard headroom to the ONE
// period in which the person was stopped early, only if they were recorded as
// stopped there, and never more in total than the tier's own cap. Purchases,
// the advertised counts, the daily photo limit and every other limit are
// untouched, so a restore can never create unlimited usage or a free
// subscription. Responses never carry a purchase identifier or install id.

import crypto from 'node:crypto';
import { json, report, supportId } from './_lib.js';
import { supabaseRPC } from './_supabase.js';
import { allowances } from './_billing.js';

function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorised(req, res) {
  const expected = process.env.BETA_ADMIN_TOKEN;
  if (!expected) { json(res, 503, { ok: false, message: 'Admin ops are not switched on.' }); return false; }
  const given = req.headers['x-admin-token'];
  if (typeof given !== 'string' || !given || !sameSecret(given, expected)) {
    json(res, 401, { ok: false, message: 'Not authorised.' });
    return false;
  }
  res.setHeader('cache-control', 'no-store, private');
  return true;
}

/// A stable, non-reversible handle for one stop, so the operator can name it
/// back without the response ever carrying the subject.
export function stopRef(subjectId, periodStart) {
  return crypto.createHash('sha256')
    .update('agni-stop-v1:' + subjectId + '|' + new Date(periodStart).toISOString())
    .digest('hex').slice(0, 16);
}

function supportIdsOf(deviceSubjects) {
  return (deviceSubjects || [])
    .filter(d => typeof d === 'string' && d.startsWith('dev:'))
    .map(d => supportId(d.slice(4)));
}

function describe(row, now = new Date()) {
  return {
    ref: stopRef(row.subject_id, row.period_start),
    tier: row.tier,
    kind: String(row.subject_id).startsWith('sbx:') ? 'sandbox'
      : String(row.subject_id).startsWith('sub:') ? 'subscription' : 'device',
    supportIds: supportIdsOf(row.device_subjects),
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: row.period_end && row.period_end !== 'infinity' ? new Date(row.period_end).toISOString() : null,
    periodRunning: !row.period_end || row.period_end === 'infinity' || new Date(row.period_end) > now,
    firstStoppedAt: row.first_at, lastStoppedAt: row.last_at, stops: Number(row.stops || 0),
    bucket: row.bucket, used: row.used, limit: row.lim,
    restoredUSD: Number(row.restored_usd || 0), grantUSD: Number(row.grant_usd || 0)
  };
}

async function stops(sinceDays) {
  const days = Math.min(400, Math.max(1, Number(sinceDays) || 35));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await supabaseRPC('agni_cost_cap_stops_list', { p_since: since });
  return Array.isArray(rows) ? rows : [];
}

export async function costCapStops(req, res, body) {
  if (!authorised(req, res)) return;
  try {
    const rows = await stops(body?.sinceDays);
    return json(res, 200, { ok: true, stops: rows.map(r => describe(r)) });
  } catch {
    report('cost cap stops', new Error('list failed'));
    return json(res, 503, { ok: false, message: 'The list could not be read.' });
  }
}

export async function costCapRestore(req, res, body) {
  if (!authorised(req, res)) return;
  const mode = String(body?.mode || '');
  if (mode !== 'preview' && mode !== 'apply') return json(res, 400, { ok: false, message: 'mode must be preview or apply.' });
  const wantSupport = typeof body?.supportId === 'string' ? body.supportId.trim().toUpperCase() : '';
  const wantRef = typeof body?.ref === 'string' ? body.ref.trim().toLowerCase() : '';
  if (!/^AG-[A-Z2-7]{10}$/.test(wantSupport) && !/^[0-9a-f]{16}$/.test(wantRef)) {
    return json(res, 400, { ok: false, message: 'Name the stop by supportId (AG-...) or by ref from the list.' });
  }
  try {
    const now = new Date();
    const matches = (await stops(400)).filter(r => wantRef
      ? stopRef(r.subject_id, r.period_start) === wantRef
      : supportIdsOf(r.device_subjects).includes(wantSupport));
    const running = matches.filter(r => describe(r, now).periodRunning);
    if (running.length === 0) {
      return json(res, 404, { ok: false, message: matches.length
        ? 'That person was stopped early in a period that has ended; the new period already starts fresh.'
        : 'No early stop is recorded for that reference.' });
    }
    if (running.length > 1) {
      return json(res, 409, { ok: false, message: 'More than one running stop matches; restore by ref.',
                              stops: running.map(r => describe(r, now)) });
    }
    const row = running[0];
    const cap = Number(allowances()[row.tier]?.costCapUSD || 0);
    if (!(cap > 0)) return json(res, 409, { ok: false, message: 'That tier has no cost safeguard to restore.' });
    const amount = body?.amountUSD === undefined ? cap : Number(body.amountUSD);
    if (!(amount > 0) || amount > cap) {
      return json(res, 400, { ok: false, message: `amountUSD must be above 0 and at most ${cap}.` });
    }
    const stop = describe(row, now);
    if (mode === 'preview') {
      return json(res, 200, { ok: true, mode, stop, wouldGrantUSD: Math.min(amount, Math.max(0, cap - stop.grantUSD)),
                              maxGrantUSD: cap });
    }
    const out = await supabaseRPC('agni_cost_cap_restore', {
      p_subject: row.subject_id, p_period_start: new Date(row.period_start).toISOString(),
      p_grant_usd: amount, p_max_grant_usd: cap
    });
    const r = Array.isArray(out) ? out[0] : out;
    if (!r?.ok) return json(res, 409, { ok: false, mode, reason: r?.reason || 'refused', stop });
    return json(res, 200, { ok: true, mode, stop: { ...stop, grantUSD: Number(r.total_grant) },
                            grantedUSD: Number(r.granted), maxGrantUSD: cap });
  } catch {
    report('cost cap restore', new Error(`${mode} failed`));
    return json(res, 503, { ok: false, mode, message: 'The step failed; nothing was changed.' });
  }
}
