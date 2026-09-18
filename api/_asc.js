// App Store Connect, only enough of it to add one beta tester.
//
// The private key here is an App Manager key: it can drive TestFlight, builds
// and app metadata. It is the most dangerous secret in this project, which is
// why the endpoint that uses it is capped at a fixed number of signups. A bug
// there should be able to waste the beta, not the account.

import crypto from 'node:crypto';

const API = 'https://api.appstoreconnect.apple.com/v1';

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/// A ten minute ES256 token. Apple rejects anything longer than twenty.
function token() {
  const keyId = process.env.ASC_KEY_ID;
  const issuer = process.env.ASC_ISSUER_ID;

  // Vercel's environment variables keep newlines, but pasting a .p8 through
  // some tooling turns them into a literal backslash-n and openssl then reads
  // the key as garbage. Accepting both costs one replace and saves an hour.
  const pem = (process.env.ASC_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

  if (!keyId) throw new Error('ASC_KEY_ID is not set on this deployment.');
  if (!issuer) throw new Error('ASC_ISSUER_ID is not set on this deployment.');
  if (!pem) throw new Error('ASC_PRIVATE_KEY is not set on this deployment.');

  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1'
  }));

  // ieee-p1363 is the raw r||s pair a JWT wants. Node's default is DER, and a
  // DER signature in a JWT is rejected by Apple as simply "401 unauthorized",
  // which tells you nothing about why.
  const signature = crypto.sign('sha256', Buffer.from(`${head}.${body}`), {
    key: crypto.createPrivateKey(pem),
    dsaEncoding: 'ieee-p1363'
  });

  return `${head}.${body}.${b64url(signature)}`;
}

/// Add one tester to one group. Apple emails the invitation itself, which is
/// the whole reason this is worth doing: the person is never waiting on Shine.
///
/// Returns { id } on success, or { already: true } when Apple says the address
/// is already a tester. That is not a failure worth showing anybody.
export async function inviteTester({ email, first, last, groupId }) {

  const response = await fetch(`${API}/betaTesters`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      data: {
        type: 'betaTesters',
        attributes: {
          email,
          // Apple accepts a tester with no name, but then App Store Connect
          // shows the same "Anonymous" that the public link would have, which
          // defeats the point of asking. Both are collected as their own field
          // now: splitting one on a space turned "Nadia" into "Nadia Tester".
          firstName: first || 'Beta',
          lastName: last || 'Tester'
        },
        relationships: {
          betaGroups: { data: [{ type: 'betaGroups', id: groupId }] }
        }
      }
    })
  });

  if (response.status === 201) {
    const body = await response.json();
    return { id: body?.data?.id || null };
  }

  const text = await response.text();

  // 409 is Apple's answer for an address that is already a tester on this app.
  // Someone signing up twice should be told they are in, not shown an error.
  if (response.status === 409 && /already exists|ENTITY_ERROR|duplicate/i.test(text)) {
    return { already: true };
  }

  throw new Error(`App Store Connect ${response.status}: ${text.slice(0, 400)}`);
}

/// Everyone Apple currently considers a tester, keyed by lowercased email.
///
/// This is the other half of the beta picture. The signups table knows who
/// asked; only App Store Connect knows who actually installed, and which build
/// they are on. A tester sitting quietly on an old build is invisible
/// everywhere else, which is how six people once sat on build 130 while six
/// builds went past them.
///
/// PUBLIC_LINK testers have no email at all -- they are literally "Anonymous" --
/// so they cannot be keyed. They are returned separately because they still
/// count: they hold a build, and nobody can tell them anything.
export async function listTesters() {
  const groupId = process.env.ASC_BETA_GROUP_ID;
  if (!groupId) throw new Error('ASC_BETA_GROUP_ID is not set on this deployment.');

  const headers = { authorization: `Bearer ${token()}` };

  // The app id comes from the group rather than a second environment variable.
  // Two things that must agree are one thing that can silently disagree.
  const appResponse = await fetch(`${API}/betaGroups/${groupId}/app`, { headers });
  if (!appResponse.ok) {
    throw new Error(`App Store Connect app lookup ${appResponse.status}`);
  }
  const appId = (await appResponse.json())?.data?.id;
  if (!appId) throw new Error('App Store Connect returned no app for that group.');

  // NOTE: /apps/{id}/betaTesters is FORBIDDEN for GET -- Apple allows only
  // DELETE on that relationship. The filter form is the only way to list them.
  const response = await fetch(
    `${API}/betaTesters?filter[apps]=${appId}&limit=200`, { headers });
  if (!response.ok) {
    throw new Error(`App Store Connect testers ${response.status}`);
  }

  const testers = (await response.json())?.data || [];

  // HOW MUCH EACH PERSON ACTUALLY USED IT, in one request rather than one per
  // tester. `groupBy=betaTesters` returns a row per person with the same three
  // figures App Store Connect shows: sessions, crashes and feedback.
  //
  // Asked for separately and allowed to fail on its own. Sessions are the
  // interesting column and they are not worth losing the whole page over, so a
  // failure here leaves the counts blank and the rest of the table intact.
  const usage = new Map();
  try {
    const metrics = await fetch(
      `${API}/apps/${appId}/metrics/betaTesterUsages?groupBy=betaTesters&limit=200`,
      { headers });
    if (metrics.ok) {
      for (const row of (await metrics.json())?.data || []) {
        const id = row?.dimensions?.betaTesters?.data?.id;
        const values = row?.dataPoints?.[0]?.values;
        if (!id || !values) continue;
        usage.set(id, {
          sessions: Number(values.sessionCount || 0),
          crashes: Number(values.crashCount || 0),
          feedback: Number(values.feedbackCount || 0)
        });
      }
    }
  } catch {
    // Left empty on purpose. See above.
  }

  const byEmail = new Map();
  const anonymous = [];
  for (const tester of testers) {
    const a = tester.attributes || {};
    const devices = a.appDevices || [];
    const counts = usage.get(tester.id) || {};
    const entry = {
      state: a.state || 'UNKNOWN',
      build: devices[0]?.appBuildVersion || null,
      inviteType: a.inviteType || null,
      name: `${a.firstName || ''} ${a.lastName || ''}`.trim(),
      sessions: counts.sessions ?? null,
      crashes: counts.crashes ?? null,
      feedback: counts.feedback ?? null,
      // Every device a person has run it on, not only the first. Somebody
      // testing on a phone and an iPad is exactly who you want to hear from.
      devices: devices.map(d => ({
        model: deviceName(d.model),
        raw: d.model || null,
        os: d.osVersion || null,
        build: d.appBuildVersion || null
      }))
    };
    if (a.email) byEmail.set(String(a.email).toLowerCase(), entry);
    else anonymous.push(entry);
  }
  return { byEmail, anonymous };
}

/// Apple's internal model identifier, in the words people use.
///
/// The API returns "iPhone17_2" and nobody knows what that is. An identifier
/// that is not in this table is shown AS ITSELF rather than guessed at,
/// because "iPhone" would be a worse answer than the raw string for anybody
/// trying to reproduce a bug on the right hardware.
///
/// The iPhone 17 family is the part worth being careful about, and only the
/// two entries below are confirmed against real devices: iPhone18,1 is a
/// tester's iPhone 17 Pro and iPhone18,2 is Shine's iPhone 17 Pro Max. The
/// rest of that family is deliberately absent. I had guessed at it and had
/// iPhone18,1 wrong, which is the failure worth avoiding: an unknown
/// identifier shown as itself sends somebody to look it up, while a confident
/// wrong name sends them to the wrong phone.
const DEVICE_NAMES = {
  iPhone18_1: 'iPhone 17 Pro', iPhone18_2: 'iPhone 17 Pro Max',
  iPhone17_1: 'iPhone 16 Pro', iPhone17_2: 'iPhone 16 Pro Max',
  iPhone17_3: 'iPhone 16', iPhone17_4: 'iPhone 16 Plus',
  iPhone17_5: 'iPhone 16e',
  iPhone16_1: 'iPhone 15 Pro', iPhone16_2: 'iPhone 15 Pro Max',
  iPhone15_4: 'iPhone 15', iPhone15_5: 'iPhone 15 Plus',
  iPhone15_2: 'iPhone 14 Pro', iPhone15_3: 'iPhone 14 Pro Max',
  iPhone14_7: 'iPhone 14', iPhone14_8: 'iPhone 14 Plus',
  iPhone14_2: 'iPhone 13 Pro', iPhone14_3: 'iPhone 13 Pro Max',
  iPhone14_4: 'iPhone 13 mini', iPhone14_5: 'iPhone 13',
  iPhone13_1: 'iPhone 12 mini', iPhone13_2: 'iPhone 12',
  iPhone13_3: 'iPhone 12 Pro', iPhone13_4: 'iPhone 12 Pro Max',
  iPhone14_6: 'iPhone SE (3rd gen)', iPhone12_8: 'iPhone SE (2nd gen)',
  iPhone12_1: 'iPhone 11', iPhone12_3: 'iPhone 11 Pro',
  iPhone12_5: 'iPhone 11 Pro Max'
};

export function deviceName(identifier) {
  if (!identifier) return null;
  const key = String(identifier).replace(/,/g, '_');
  return DEVICE_NAMES[key] || String(identifier).replace(/_/g, ',');
}
