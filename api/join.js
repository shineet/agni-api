import { json, report } from './_lib.js';
import { supabaseRPC } from './_supabase.js';
import { inviteTester } from './_asc.js';

/// Beta signup. Someone gives their name and address on a public page and
/// Apple invites them straight away.
///
/// Why this exists at all: a TestFlight public link produces testers who are
/// literally called "Anonymous" in App Store Connect, with no address. You
/// cannot ask an anonymous tester what the dish in their photograph actually
/// was, which is the only question worth asking during this beta.

const CAP_DEFAULT = 20;

/// Deliberately loose. The job here is to catch a typo and an obvious robot,
/// not to adjudicate RFC 5322. Anything that gets past this and is not real
/// simply never receives Apple's email.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/;

function clientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, message: 'POST only.' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const email = String(body.email || '').trim().toLowerCase();
  // Asked as two fields, because Apple stores two. Splitting one field on a
  // space guessed wrong for anybody who types a single word: "Nadia" became
  // "Nadia Tester" in App Store Connect, which reads like a placeholder.
  const first = String(body.first || '').trim();
  const last = String(body.last || '').trim();
  const name = [first, last].filter(Boolean).join(' ');

  // A field the page hides and a person therefore never fills in. Filled means
  // a bot walked the form, and the quietest possible answer is to accept it
  // and do nothing, so the bot has no signal to adapt to.
  if (String(body.company || '').trim()) {
    return json(res, 200, { ok: true, status: 'accepted', title: 'Thank you', message: 'You are on the list.' });
  }

  if (!LOOKS_LIKE_EMAIL.test(email) || email.length > 254) {
    return json(res, 400, { ok: false, status: 'bad_email', title: 'Check that address',
      message: 'That does not look like an email address.' });
  }
  if (!first || !last) {
    return json(res, 400, { ok: false, status: 'bad_name', title: 'One thing missing',
      message: 'TestFlight shows both names, so it needs each one.' });
  }
  if (first.length > 40 || last.length > 40) {
    return json(res, 400, { ok: false, status: 'bad_name', title: 'Check that name',
      message: 'That name is too long.' });
  }

  const cap = Number(process.env.BETA_CAP || CAP_DEFAULT);
  const groupId = process.env.ASC_BETA_GROUP_ID;
  if (!groupId) {
    report('beta signup', new Error('ASC_BETA_GROUP_ID is not set'));
    return json(res, 503, { ok: false, status: 'unavailable', title: 'Not open yet',
      message: 'Signups are not switched on yet. Try again shortly.' });
  }

  let claim;
  try {
    const rows = await supabaseRPC('agni_beta_claim', {
      p_email: email, p_name: name, p_ip: clientIP(req), p_cap: cap
    });
    claim = Array.isArray(rows) ? rows[0] : rows;
  } catch (error) {
    report('beta claim', error);
    return json(res, 503, { ok: false, status: 'unavailable', title: 'Try again shortly',
      message: 'Could not reach the signup list. Try again shortly.' });
  }

  const status = claim?.status;

  if (status === 'full') {
    return json(res, 200, { ok: false, status: 'full', title: 'The beta is full',
      message: 'The beta is full. All the places have gone.' });
  }
  if (status === 'slow_down') {
    return json(res, 429, { ok: false, status: 'slow_down', title: 'Slow down a moment',
      message: 'That is a few signups from here already. Try again in an hour.' });
  }
  if (status === 'already') {
    return json(res, 200, { ok: true, status: 'already', title: 'You are already in',
      message: 'That address is already on the list. Check your email for the TestFlight invitation.' });
  }

  // The address is recorded before Apple is called, on purpose. If the invite
  // fails, the row survives with invited = false, so the person is not lost:
  // they can be chased by hand. Inviting first and recording after would throw
  // away exactly the addresses that need following up.
  try {
    const result = await inviteTester({ email, first, last, groupId });
    await supabaseRPC('agni_beta_invited', { p_email: email, p_tester_id: result.id || null });

    // Apple sends nothing for an address that is ALREADY a tester, so saying
    // "check your email" would leave that person waiting for a message that is
    // never coming. They do not need an invitation: they need telling that the
    // app is already sitting in TestFlight on their phone.
    if (result.already) {
      return json(res, 200, { ok: true, status: 'already_tester', title: 'You already have it',
        message: 'That address is already a TestFlight tester for Agni. Open TestFlight on your iPhone and Agni is there, no new invitation needed.' });
    }

    return json(res, 200, { ok: true, status: 'invited', title: 'Check your email',
      message: 'Invitation sent. It comes from TestFlight and usually arrives within a minute.' });
  } catch (error) {
    report('beta invite', error);
    return json(res, 200, { ok: true, status: 'pending', title: 'You are on the list',
      message: 'You are on the list. Your invitation is being sent by hand, so give it a day.' });
  }
}
