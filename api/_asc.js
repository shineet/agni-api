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
export async function inviteTester({ email, name, groupId }) {
  const [first, ...rest] = (name || '').trim().split(/\s+/);

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
          // defeats the point of asking.
          firstName: first || 'Beta',
          lastName: rest.join(' ') || 'Tester'
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
