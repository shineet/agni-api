import crypto from 'node:crypto';
import { json, report } from './_lib.js';
import { supabaseRPC } from './_supabase.js';
import { listTesters } from './_asc.js';

/// The whole beta on one page: who signed up, whether their invitation landed,
/// and what is actually on their phone.
///
/// Those are three different systems and each one alone lies by omission. The
/// signups table is the ONLY place somebody whose invite failed exists, because
/// a failed invite never becomes a tester. App Store Connect is the only place
/// an install exists. And a tester quietly sitting on an old build is invisible
/// in both unless you go looking -- which is how six people once stayed on
/// build 130 while six builds went past them.
///
/// Open it in a browser and it asks for a password. There is deliberately no
/// token in the URL: a link in a browser history, a screenshot, or a message to
/// somebody is not where a credential that reads every tester's email address
/// should end up.

const CAP_DEFAULT = 20;

/// Failed attempts, per address, so a short password is not a short password to
/// a script. Nothing here is stored: the map lives in one warm function
/// instance and empties itself when that instance goes away.
///
/// HONEST ABOUT WHAT IT IS: several instances can be warm at once, so a
/// determined attacker spread across them sees a fraction of this backoff. It
/// is not a lockout and it is not meant to be one. What it does do is turn
/// thousands of guesses a second into a handful, which is the difference
/// between a guessable password and a guessed one. The page is also noindex and
/// its URL is not linked from anywhere.
const failures = new Map();
const BACKOFF_STEP_MS = 250;
const BACKOFF_MAX_MS = 4000;

function clientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export function backoffFor(attempts) {
  return Math.min(BACKOFF_MAX_MS, attempts * BACKOFF_STEP_MS);
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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

/// "1.0 (138)" -> 138. The build number is what moves; the marketing version
/// sits still for months, so comparing the whole string would call everybody
/// current forever.
export function buildNumber(text) {
  const match = /\((\d+)\)/.exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

/// Joins the two systems on the email address, lowercased on both sides because
/// Postgres stores it lowered and Apple does not promise to.
///
/// A signup with no matching tester is NOT an error to hide: it is either an
/// invitation that failed, or one Apple accepted and then lost. Either way the
/// row stays visible and says so.
export function merge(signups, testers) {
  const seen = new Set();
  const rows = signups.map(s => {
    const key = String(s.email || '').toLowerCase();
    seen.add(key);
    const tester = testers.byEmail.get(key) || null;
    return {
      name: s.name,
      email: s.email,
      created_at: s.created_at,
      // THE FLAG IS A LOCAL NOTE; APPLE IS THE AUTHORITY. The invite and the
      // write recording it are two steps, and the second can be lost while the
      // first succeeded: that is exactly what happened on 18 Sept, when a
      // signup showed "invite failed" in red while Apple had had the person as
      // a tester since the moment they signed up. Anybody Apple knows about
      // was invited, whatever this row remembers.
      invited: Boolean(s.invited || tester),
      state: tester?.state || null,
      build: tester?.build || null,
      sessions: tester?.sessions ?? null,
      crashes: tester?.crashes ?? null,
      devices: tester?.devices || []
    };
  });

  // Everybody Apple knows about who did not come through the form: the close
  // testers, Shine himself, and the anonymous public-link joiners. Without
  // them the page would quietly under-report the beta.
  const others = [];
  for (const [email, t] of testers.byEmail) {
    if (!seen.has(email)) others.push({ ...t, email });
  }
  for (const t of testers.anonymous) others.push({ ...t, email: null });

  return { rows, others };
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

/// One word for what is true of this person, and the class that colours it.
/// Ordered worst first, because the first true thing is the one to act on.
function verdict(row, newest) {
  if (!row.invited) return { label: 'invite failed', cls: 'bad' };
  if (!row.state) return { label: 'not a tester', cls: 'bad' };
  if (row.state !== 'INSTALLED') return { label: 'never opened the email', cls: 'warn' };
  const n = buildNumber(row.build);
  if (newest && n && n < newest) return { label: `behind, on ${n}`, cls: 'warn' };
  return { label: 'installed', cls: 'ok' };
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --line: #8883; --bad: #c0392b; --warn: #b9770e; --ok: #1e8449; --muted: #8889;
  }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 20px 20px 40px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 6px; opacity: .7; font-weight: 600; }
  p.count { margin: 0 0 18px; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 560px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; font-size: 13px; opacity: .6; }
  td.time { white-space: nowrap; opacity: .65; }
  td.verdict { white-space: nowrap; font-weight: 600; }
  .bad { color: var(--bad); } .warn { color: var(--warn); } .ok { color: var(--ok); }
  a { color: inherit; }
  .note { margin-top: 16px; font-size: 13px; opacity: .75; max-width: 46em; }
  .stale { color: var(--muted); font-size: 13px; }
`;

/// How much somebody has used it, or a dash.
///
/// A DASH IS NOT A ZERO. Somebody invited yesterday who has not opened it has
/// no sessions to report; somebody who installed it and never opened it has
/// zero. The first is waiting, the second is a problem, and printing "0" for
/// both would hide the only one worth acting on.
function usageCell(row) {
  if (row.sessions === null || row.sessions === undefined) return '<td class="num stale">--</td>';
  const crashed = Number(row.crashes || 0) > 0
    ? ` <span class="bad" title="${row.crashes} crash${row.crashes === 1 ? '' : 'es'}">!</span>`
    : '';
  return `<td class="num">${row.sessions}${crashed}</td>`;
}

/// Which phone, in words, with the OS underneath.
///
/// Every device, not just the first: a person testing on two is worth knowing
/// about, and the second one is usually where the layout breaks.
function deviceCell(row) {
  const devices = row.devices || [];
  if (!devices.length) return '<td class="stale">--</td>';
  return `<td>${devices.map(d => `${escape(d.model || '?')}${
    d.os ? `<br><span class="stale">iOS ${escape(d.os)}</span>` : ''}`).join('<hr class="sep">')}</td>`;
}

function page({ rows, others, cap, newest, ascError }) {
  const invited = rows.filter(r => r.invited).length;
  const installed = rows.filter(r => r.state === 'INSTALLED').length;
  const left = Math.max(0, cap - rows.length);
  const needsYou = rows.filter(r => verdict(r, newest).cls !== 'ok');

  const body = rows.map(r => {
    const v = verdict(r, newest);
    return `
      <tr>
        <td class="time">${escape(when(r.created_at))}</td>
        <td>${escape(r.name || '(no name)')}</td>
        <td><a href="mailto:${escape(r.email)}">${escape(r.email)}</a></td>
        <td class="verdict ${v.cls}">${escape(v.label)}</td>
        ${usageCell(r)}
        ${deviceCell(r)}
      </tr>`;
  }).join('');

  const rest = others.map(t => `
      <tr>
        <td class="time">${escape(t.inviteType === 'PUBLIC_LINK' ? 'public link' : 'added by hand')}</td>
        <td>${escape(t.name || 'Anonymous')}</td>
        <td>${t.email ? `<a href="mailto:${escape(t.email)}">${escape(t.email)}</a>`
                      : '<span class="stale">no address, cannot be contacted</span>'}</td>
        <td class="verdict ${t.state === 'INSTALLED' && buildNumber(t.build) === newest ? 'ok' : 'warn'}">${
          escape(t.state === 'INSTALLED' ? `on ${buildNumber(t.build) ?? '?'}` : (t.state || '').toLowerCase())}</td>
        ${usageCell(t)}
        ${deviceCell(t)}
      </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Agni beta</title>
<style>${STYLE}
.num { text-align: right; font-variant-numeric: tabular-nums; }
th.num { text-align: right; }
hr.sep { border: 0; border-top: 1px solid var(--line); margin: 6px 0; }
</style></head><body>
<h1>Agni beta</h1>
<p class="count">${rows.length} signed up · ${invited} invited · ${installed} installed${
  newest ? ` · newest build ${newest}` : ''} · cap ${cap}, ${left} left
${needsYou.length ? `<br><span class="warn"><strong>${needsYou.length} need${
  needsYou.length === 1 ? 's' : ''} you.</strong></span>` : ''}</p>

${ascError ? `<p class="note bad">App Store Connect could not be reached, so the TestFlight column is
  blank. The signup list below is still correct.</p>` : ''}

<div class="wrap"><table>
  <tr><th>Signed up</th><th>Name</th><th>Email</th><th>TestFlight</th><th class="num">Sessions</th><th>Device</th></tr>${body}
</table></div>

${others.length ? `<h2>Testers who did not come through the form</h2>
<div class="wrap"><table>
  <tr><th>How</th><th>Name</th><th>Email</th><th>TestFlight</th><th class="num">Sessions</th><th>Device</th></tr>${rest}
</table></div>` : ''}

<p class="note">Sessions are every time somebody opened the app, for the last year, counted by
  App Store Connect. A dash means nobody has told us yet: an invitation not yet accepted has no
  sessions, which is not the same as zero. A red <span class="bad">!</span> marks a crash.
  <br>"Behind" means installed, but on an older build than the newest anybody has.
  A public-link tester has no name and no address by design, which is why the signup form exists:
  there is no way to ask an anonymous tester what the dish in their photograph actually was.</p>
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

  const ip = clientIP(req);
  const given = presentedToken(req);
  if (!given || !sameSecret(given, expected)) {
    // Counted BEFORE the wait, so the delay applies to this attempt too rather
    // than only to the next one.
    const attempts = (failures.get(ip) || 0) + 1;
    failures.set(ip, attempts);
    await pause(backoffFor(attempts));

    // The challenge is what makes a browser ask. Without it an unauthorised
    // visitor gets a bare 401 page and no way to supply anything.
    res.setHeader('www-authenticate', 'Basic realm="Agni beta", charset="UTF-8"');
    return json(res, 401, { ok: false, message: 'Not authorised.' });
  }
  failures.delete(ip);

  let signups;
  try {
    // A security definer function, not a select on the table. The service role
    // has no SELECT privilege here: RLS bypass is not a grant, and a direct
    // read answers 42501, "permission denied for table".
    const result = await supabaseRPC('agni_beta_list', {});
    signups = Array.isArray(result) ? result : [];
  } catch (error) {
    report('beta signups', error);
    return json(res, 503, { ok: false, message: 'Could not read the signup list.' });
  }

  // App Store Connect is the SECOND source and must never be able to take the
  // page down. If Apple is slow or the key is rejected, the signup list is
  // still the answer to most of the question.
  let testers = { byEmail: new Map(), anonymous: [] };
  let ascError = null;
  try {
    testers = await listTesters();
  } catch (error) {
    report('beta testers', error);
    ascError = error;
  }

  const { rows, others } = merge(signups, testers);
  const newest = Math.max(0, ...[...rows, ...others]
    .map(r => buildNumber(r.build)).filter(Boolean)) || null;
  const cap = Number(process.env.BETA_CAP || CAP_DEFAULT);

  // Never stored by a browser or an intermediary: it is a list of real people's
  // email addresses behind a password.
  res.setHeader('cache-control', 'no-store, private');

  if (String(req.headers.accept || '').includes('text/html')) {
    res.status(200).setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(page({ rows, others, cap, newest, ascError }));
  }

  return json(res, 200, {
    ok: true,
    cap,
    newest,
    total: rows.length,
    invited: rows.filter(r => r.invited).length,
    installed: rows.filter(r => r.state === 'INSTALLED').length,
    ascReachable: !ascError,
    signups: rows,
    others
  });
}
