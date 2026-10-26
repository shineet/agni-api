// Apple DeviceCheck: two bits per device that survive deleting the app.
//
// AN ABUSE SIGNAL, NOT A LEDGER. The bits say one thing each -- this device
// has already used its Free photo sample (bit0), its Free AI search sample
// (bit1) -- and they only ever close a sample, never open one. Counting
// lives in agni_allowance_periods.
//
// OPTIONAL. Without DEVICECHECK_KEY_ID, DEVICECHECK_TEAM_ID and
// DEVICECHECK_PRIVATE_KEY nothing here runs and the Free sample is held by the
// device subject alone, which a reinstall that also clears the Keychain can
// reset. The report names this as a launch item.

import { createPrivateKey, randomUUID, sign } from 'node:crypto';

export function deviceCheckConfigured() {
  return !!(process.env.DEVICECHECK_KEY_ID && process.env.DEVICECHECK_TEAM_ID
            && process.env.DEVICECHECK_PRIVATE_KEY);
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function deviceCheckJWT(now = Date.now()) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: process.env.DEVICECHECK_KEY_ID }));
  const payload = b64url(JSON.stringify({ iss: process.env.DEVICECHECK_TEAM_ID, iat: Math.floor(now / 1000) }));
  const key = createPrivateKey(String(process.env.DEVICECHECK_PRIVATE_KEY).replace(/\\n/g, '\n'));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

function host(environment) {
  return environment === 'production'
    ? 'https://api.devicecheck.apple.com'
    : 'https://api.development.devicecheck.apple.com';
}

/// { photo, search } exhausted flags, or null when the answer is unknown.
export async function queryBits(deviceToken, environment) {
  if (!deviceCheckConfigured() || !deviceToken) return null;
  const response = await fetch(`${host(environment)}/v1/query_two_bits`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceCheckJWT()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ device_token: deviceToken, transaction_id: randomUUID(), timestamp: Date.now() }),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) return null;
  const text = await response.text();
  // A device never written to answers 200 with a sentence, not JSON.
  if (!text.trim().startsWith('{')) return { photo: false, search: false };
  const bits = JSON.parse(text);
  return { photo: bits.bit0 === true, search: bits.bit1 === true };
}

export async function setBits(deviceToken, environment, { photo, search }) {
  if (!deviceCheckConfigured() || !deviceToken) return false;
  const response = await fetch(`${host(environment)}/v1/update_two_bits`, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceCheckJWT()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      device_token: deviceToken, transaction_id: randomUUID(), timestamp: Date.now(),
      bit0: !!photo, bit1: !!search
    }),
    signal: AbortSignal.timeout(5000)
  });
  return response.ok;
}
