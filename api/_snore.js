// Two phones, one bed (SHAI 1.3). Pairing and the exchange of snore marks between two paired phones.
//
//   POST /api/snore   (rewritten to /api/quota?op=snore; App Attest only)
//   { installId, action, ... }
//     clock                         -> { now }                      milliseconds, for the phone's clock correction
//     pair-start                    -> { code, expires }            a six-digit code for ten minutes
//     pair-join  { code }           -> { paired: true }
//     status                        -> { paired, code?, since? }
//     unpair                        -> { unpaired: true }           both phones' nights and the pair go
//     put { began, ended, marks }   -> { kept: true }               marks: { v: 2, start, step, b64 } (209: loudness every
//                                                                   five minutes, replacing the row) or { v: 1, base, b64 } (208)
//     get { from, to }              -> { paired, nights: [...] }    the partner's nights in that time
//     compared { from, to }         -> { deleted }                  the partner's marks for that time are dropped
//
// WHY ITS OWN FUNCTION IS NOT ONE: Vercel's Hobby plan counts functions and this project is at its twelve, so it rides
// on quota.js the way the companion rides on research.js. The phone signs the public path, /api/snore.
//
// WHAT IS KEPT: see migrations/2026-11-26-snore-partners.sql. No sound; the marks are opaque here and never read.

import { json } from './_lib.js';
import { authenticate, recordAuth, MeterClass } from './_auth.js';
import { supabaseRPC } from './_supabase.js';
import { resolveCaller } from './_caller.js';

export const SNORE_LIMITS = { marksB64: 400_000, levelsB64: 120_000, codeDigits: 6, nightHours: 16 };

function when(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/// The checks, apart from the database, so they can be tested without one.
export function validateSnore(action, body) {
  switch (action) {
    case 'clock': case 'pair-start': case 'status': case 'unpair': return null;
    case 'pair-join':
      return /^\d{6}$/.test(String(body.code || '')) ? null : 'code must be six digits';
    case 'put': {
      const b = when(body.began), e = when(body.ended), m = body.marks;
      if (!b || !e || Date.parse(e) <= Date.parse(b)) return 'began and ended must be times, ended after began';
      if (Date.parse(e) - Date.parse(b) > SNORE_LIMITS.nightHours * 3600_000) return 'a night is at most 16 hours';
      // v2 (SHAI 209): the night's loudness so far, sent every five minutes. v1 (208): snore marks, kept so 208 still works.
      if (m && m.v === 2) {
        if (!Number.isFinite(m.start) || m.step !== 0.75 || typeof m.b64 !== 'string') return 'levels must be { v: 2, start, step: 0.75, b64 }';
        if (m.b64.length > SNORE_LIMITS.levelsB64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.b64)) return 'levels too large or not base64';
        return null;
      }
      if (!m || m.v !== 1 || !Number.isFinite(m.base) || typeof m.b64 !== 'string') return 'marks must be { v: 2, start, step, b64 } or { v: 1, base, b64 }';
      if (m.b64.length > SNORE_LIMITS.marksB64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.b64)) return 'marks too large or not base64';
      return null;
    }
    case 'get': case 'compared': {
      const f = when(body.from), t = when(body.to);
      if (!f || !t || Date.parse(t) <= Date.parse(f)) return 'from and to must be times, to after from';
      if (Date.parse(t) - Date.parse(f) > SNORE_LIMITS.nightHours * 3600_000) return 'at most 16 hours at a time';
      return null;
    }
    default: return 'unknown action';
  }
}

export async function snoreHandler(req, res, rawBody, body) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
  const { op, ...query } = req.query || {};
  void op;
  const auth = await authenticate(req, { meterClass: MeterClass.read, path: '/api/snore', query, rawBody, allowLegacy: false });
  recordAuth('snore', auth, req);
  if (!auth.ok) {
    if (auth.retryAfter > 0) res.setHeader('retry-after', String(auth.retryAfter));
    return json(res, auth.status || 401, { error: 'unauthorized' });
  }
  const action = String(body?.action || '');
  const problem = validateSnore(action, body || {});
  if (problem) return json(res, 400, { error: 'invalid', reason: problem });
  if (action === 'clock') return json(res, 200, { now: Date.now() });

  let device;
  try {
    device = (await resolveCaller(auth, { installId: body.installId })).deviceSubject;
  } catch (e) {
    console.error('[agni-snore] caller', e?.message);
    return json(res, 503, { error: 'unavailable' });
  }
  if (!device) return json(res, 401, { error: 'unauthorized' });

  const call = {
    'pair-start': () => supabaseRPC('agni_snore_pair_start', { p_device: device }),
    'pair-join': () => supabaseRPC('agni_snore_pair_join', { p_device: device, p_code: String(body.code) }),
    status: () => supabaseRPC('agni_snore_status', { p_device: device }),
    unpair: () => supabaseRPC('agni_snore_unpair', { p_device: device }),
    put: () => supabaseRPC('agni_snore_put', { p_device: device, p_began: when(body.began), p_ended: when(body.ended),
                                               p_marks: body.marks.v === 2
                                                 ? { v: 2, start: body.marks.start, step: 0.75, b64: body.marks.b64 }
                                                 : { v: 1, base: body.marks.base, b64: body.marks.b64 } }),
    get: () => supabaseRPC('agni_snore_get', { p_device: device, p_from: when(body.from), p_to: when(body.to) }),
    compared: () => supabaseRPC('agni_snore_compared', { p_device: device, p_from: when(body.from), p_to: when(body.to) })
  }[action];
  try {
    const out = await call();
    const r = Array.isArray(out) ? out[0] : out;
    if (r?.error) return json(res, 409, { error: r.error });
    // Counts and states only in the log: never a code, a device or a mark.
    console.log(`[agni-snore] ${action} ok`);
    return json(res, 200, r || {});
  } catch (e) {
    console.error(`[agni-snore] ${action} failed`, e?.message);
    return json(res, 503, { error: 'unavailable' });
  }
}
