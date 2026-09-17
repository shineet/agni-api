import crypto from 'node:crypto';
import { json, report } from './_lib.js';
import { supabaseRPC } from './_supabase.js';

/// Is it safe to switch the legacy token off yet.
///
/// That is the only question this page answers, and it answers it with counts
/// rather than opinion: how much traffic arrived on the shared token, on which
/// endpoint, from which build, on each of the last fourteen days.
///
/// WITHOUT THIS, FLIPPING THE FLAG IS A GUESS. With it, the decision is
/// "legacy traffic has been zero on every endpoint for a fortnight", which is a
/// fact somebody can check.
///
/// Counts only. No query text, no install id, no key id. The table this reads
/// is not capable of saying who anybody is or what they searched for.

export function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function presentedToken(req) {
  const header = req.headers['x-admin-token'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return null;
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page(rows) {
  const byPath = {};
  for (const r of rows) byPath[r.auth_path] = (byPath[r.auth_path] || 0) + Number(r.hits);
  const total = Object.values(byPath).reduce((a, b) => a + b, 0) || 1;
  const legacy = byPath.legacy || 0;

  // The verdict, stated rather than left to be worked out from a table.
  const verdict = legacy === 0
    ? { text: 'No legacy traffic in this window. Safe to switch off, if the window is long enough.', cls: 'ok' }
    : { text: `${legacy} requests still arrived on the legacy token. NOT safe to switch off.`, cls: 'bad' };

  const body = rows.map(r => `
      <tr class="${r.auth_path === 'legacy' ? 'legacy' : ''}">
        <td>${escape(r.day)}</td><td>${escape(r.endpoint)}</td>
        <td>${escape(r.auth_path)}</td><td>${escape(r.meter_class || '')}</td>
        <td>${r.allowed ? 'allowed' : 'refused'}</td>
        <td>${escape(r.build || '')}</td><td class="n">${escape(r.hits)}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Agni auth telemetry</title>
<style>
  :root { color-scheme: light dark; --line:#8883; --bad:#c0392b; --ok:#1e8449; }
  body { font:15px/1.5 -apple-system, system-ui, sans-serif; margin:0; padding:20px 20px 40px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .verdict { font-weight:600; margin:0 0 16px; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:640px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); font-size:13px; }
  th { font-weight:600; opacity:.6; }
  td.n { text-align:right; font-variant-numeric:tabular-nums; }
  tr.legacy td { color:var(--bad); font-weight:600; }
  .note { margin-top:16px; font-size:13px; opacity:.75; max-width:46em; }
</style></head><body>
<h1>Agni auth telemetry</h1>
<p class="verdict ${verdict.cls}">${escape(verdict.text)}</p>
<p>attested ${byPath.attested || 0} \u{00B7} legacy ${legacy} \u{00B7} development ${byPath.development || 0}
   \u{00B7} refused ${byPath.refused || 0} \u{00B7} legacy share ${(legacy / total * 100).toFixed(1)}%</p>
<div class="wrap"><table>
  <tr><th>Day</th><th>Endpoint</th><th>Auth</th><th>Class</th><th>Result</th><th>Build</th><th>Hits</th></tr>
  ${body}
</table></div>
<p class="note">Counts only. This table cannot say who anybody is or what they searched for.
  Legacy rows are the ones that must reach zero before LEGACY_TOKEN_ENABLED is set to false.</p>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, message: 'GET only.' });

  const expected = process.env.BETA_ADMIN_TOKEN;
  if (!expected) {
    report('auth telemetry', new Error('BETA_ADMIN_TOKEN is not set'));
    return json(res, 503, { ok: false, message: 'This view is not switched on.' });
  }
  const given = presentedToken(req);
  if (!given || !sameSecret(given, expected)) {
    res.setHeader('www-authenticate', 'Basic realm="Agni admin", charset="UTF-8"');
    return json(res, 401, { ok: false, message: 'Not authorised.' });
  }

  const days = Math.min(90, Math.max(1, Number(req.query?.days || 14)));
  let rows;
  try {
    const result = await supabaseRPC('agni_auth_summary', { p_days: days });
    rows = Array.isArray(result) ? result : [];
  } catch (error) {
    report('auth telemetry', error);
    return json(res, 503, { ok: false, message: 'Could not read the telemetry.' });
  }

  res.setHeader('cache-control', 'no-store, private');
  if (String(req.headers.accept || '').includes('text/html')) {
    res.status(200).setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(page(rows));
  }
  const legacy = rows.filter(r => r.auth_path === 'legacy')
                     .reduce((a, r) => a + Number(r.hits), 0);
  return json(res, 200, { ok: true, days, legacyHits: legacy, safeToDisableLegacy: legacy === 0, rows });
}
