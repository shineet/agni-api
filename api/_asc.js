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

  const byEmail = new Map();
  const anonymous = [];
  for (const tester of (await response.json())?.data || []) {
    const a = tester.attributes || {};
    const devices = a.appDevices || [];
    const entry = {
      state: a.state || 'UNKNOWN',
      build: devices[0]?.appBuildVersion || null,
      inviteType: a.inviteType || null,
      name: `${a.firstName || ''} ${a.lastName || ''}`.trim()
    };
    if (a.email) byEmail.set(String(a.email).toLowerCase(), entry);
    else anonymous.push(entry);
  }
  return { byEmail, anonymous };
}
