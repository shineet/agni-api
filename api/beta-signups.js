import crypto from 'node:crypto';
import { json, report } from './_lib.js';
import { supabaseSelect } from './_supabase.js';

/// Who signed up, and whether their invitation actually reached Apple.
///
/// App Store Connect answers a different question. It knows who is a TESTER:
/// name, state, and the build on their device. It does not know who gave their
/// address and got nothing back, because a signup whose invite failed never
/// becomes a tester at all. That person exists in exactly one place, this
/// table, as a row with invited = false, and they are the ones worth chasing.
///
/// Open it in a browser and it asks for a password. There is deliberately no
/// token in the URL: a link in a browser history, a screenshot, or a message to
/// somebody is not where a credential that reads every tester's email address
/// should end up.

const CAP_DEFAULT = 20;

/// Compared byte for byte in constant time. A plain === on a secret leaks its
/// length and its prefix to anyone patient enough to measure, and this one
/// guards a list of real people's addresses.
export function sameSecret(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  // timingSafeEqual THROWS on a length mismatch rather than returning false,
  // so the lengths have to be compared first. That comparison is not itself
  // constant time, which is accepted: the length of the token is not the
  // secret, the token is.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function presentedToken(req) {
  const header = req.headers['x-admin-token'];
  if (typeof header === 'string' && header) return header;

  // Basic auth, so a browser shows its own password box. The username is
  // ignored: there is one secret here, not an account.
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

/// Chicago, because that is where the person reading this is. A timestamp in
/// UTC means doing arithmetic to answer "did that arrive after I posted it".
function when(iso) {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'America/Chicago',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

function page(rows, cap) {
  const invited = rows.filter(r => r.invited).length;
  const stuck = rows.filter(r => !r.invited);
  const left = Math.max(0, cap - rows.length);

  const body = rows.map(r => `
      <tr class="${r.invited ? '' : 'stuck'}">
        <td>${escape(when(r.created_at))}</td>
        <td>${escape(r.name || '(no name)')}</td>
        <td><a href="mailto:${escape(r.email)}">${escape(r.email)}</a></td>
        <td>${r.invited ? 'invited' : 'NOT INVITED'}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Agni beta signups</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --stuck: #c0392b; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.count { margin: 0 0 18px; opacity: .75; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 520px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; font-size: 13px; opacity: .6; }
  td:first-child { white-space: nowrap; opacity: .7; }
  tr.stuck td { color: var(--stuck); font-weight: 600; }
  .note { margin-top: 18px; font-size: 13px; opacity: .75; max-width: 46em; }
</style></head><body>
<h1>Agni beta signups</h1>
<p class="count">${rows.length} signed up · ${invited} invited · ${stuck.length} not invited · cap ${cap}, ${left} left</p>
<div class="wrap"><table>
  <tr><th>When</th><th>Name</th><th>Email</th><th>Invite</th></tr>${body}
</table></div>
${stuck.length ? `<p class="note">The rows in red gave their address and Apple never accepted the
  invitation. They are invisible in App Store Connect, so nothing else will remind you they exist.
  Inviting them by hand from the group's Testers + button is the fix.</p>` : ''}
<p class="note">Signups only. Whether somebody actually installed the build is a different question,
  and App Store Connect answers that one: <code>asc.py testers agni</code>.</p>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return json(res, 405, { ok: false, message: 'GET only.' });
  }

  const expected = process.env.BETA_ADMIN_TOKEN;
  if (!expected) {
    report('beta signups', new Error('BETA_ADMIN_TOKEN is not set'));
    return json(res, 503, { ok: false, message: 'This view is not switched on.' });
  }

  const given = presentedToken(req);
  if (!given || !sameSecret(given, expected)) {
    // The challenge is what makes a browser ask. Without it an unauthorised
    // visitor gets a bare 401 page and no way to supply anything.
    res.setHeader('www-authenticate', 'Basic realm="Agni beta", charset="UTF-8"');
    return json(res, 401, { ok: false, message: 'Not authorised.' });
  }

  let rows;
  try {
    rows = await supabaseSelect('agni_beta_signups',
      'select=name,email,created_at,invited,tester_id&order=created_at.desc');
  } catch (error) {
    report('beta signups', error);
    return json(res, 503, { ok: false, message: 'Could not read the signup list.' });
  }

  const cap = Number(process.env.BETA_CAP || CAP_DEFAULT);

  // Never stored by a browser or an intermediary: it is a list of real people's
  // email addresses behind a password.
  res.setHeader('cache-control', 'no-store, private');

  if (String(req.headers.accept || '').includes('text/html')) {
    res.status(200).setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(page(rows, cap));
  }

  return json(res, 200, {
    ok: true,
    cap,
    total: rows.length,
    invited: rows.filter(r => r.invited).length,
    signups: rows
  });
}
