// Apple App Attest verification.
//
// WHAT IS HAND-WRITTEN AND WHAT IS NOT, because the distinction is the whole
// security argument. Certificate chain validation and signature verification
// are done by Node's own `crypto`, which is reviewed code. What is written here
// is PARSING: pulling a nonce out of a certificate extension and reading fixed
// offsets out of authenticator data. Parsing is written strictly, so a bug in
// it fails a verification rather than passing one.
//
// Procedure follows Apple's published steps for "Validating Apps That Connect
// to Your Server". Each step below is numbered as Apple numbers them.

import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeCBOR } from './_cbor.js';

const APP_ID = process.env.APP_ATTEST_APP_ID || '';

/// Apple's root, shipped with the function rather than fetched at runtime: a
/// root you download on demand is a root an attacker can substitute.
let cachedRoot = null;
function appleRoot() {
  if (!cachedRoot) {
    const pem = readFileSync(new URL('../apple-app-attest-root.pem', import.meta.url), 'utf8');
    cachedRoot = new X509Certificate(pem);
  }
  return cachedRoot;
}

const AAGUID_PRODUCTION = Buffer.from('appattest\0\0\0\0\0\0\0', 'binary');
const AAGUID_DEVELOPMENT = Buffer.from('appattestdevelop', 'binary');

/// Apple puts the attestation nonce in this certificate extension.
const NONCE_OID = '1.2.840.113635.100.8.2';

// MARK: - A DER walker, only as much as is needed

/// Finds the value of one extension inside a certificate's DER.
///
/// Deliberately narrow: it walks tag-length-value structures looking for the
/// OID, then takes the OCTET STRING that follows. It never interprets anything
/// it does not recognise and throws instead of guessing.
function extensionValue(der, oidBytes) {
  for (let i = 0; i + oidBytes.length <= der.length; i += 1) {
    if (!der.subarray(i, i + oidBytes.length).equals(oidBytes)) continue;
    // The extension is SEQUENCE { OID, [critical], OCTET STRING value }.
    let cursor = i + oidBytes.length;
    if (der[cursor] === 0x01) cursor += 3;           // optional BOOLEAN critical
    if (der[cursor] !== 0x04) continue;              // expect OCTET STRING
    cursor += 1;
    const { length, next } = readDERLength(der, cursor);
    return der.subarray(next, next + length);
  }
  throw new Error('attestation: nonce extension not found');
}

function readDERLength(der, offset) {
  const first = der[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4) throw new Error('attestation: bad DER length');
  let length = 0;
  for (let i = 0; i < count; i += 1) length = (length << 8) | der[offset + 1 + i];
  return { length, next: offset + 1 + count };
}

/// The OID above, as it appears in DER: 06 0A then the encoded arc bytes.
const NONCE_OID_DER = Buffer.from([0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);

// MARK: - Authenticator data

/// The fixed layout Apple documents. Read by offset, with every length checked.
export function parseAuthenticatorData(authData) {
  if (authData.length < 37) throw new Error('attestation: authenticator data too short');
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const counter = authData.readUInt32BE(33);
  let aaguid = null;
  let credentialId = null;
  if (authData.length >= 55) {
    aaguid = authData.subarray(37, 53);
    const credentialIdLength = authData.readUInt16BE(53);
    credentialId = authData.subarray(55, 55 + credentialIdLength);
    if (credentialId.length !== credentialIdLength) {
      throw new Error('attestation: truncated credential id');
    }
  }
  return { rpIdHash, flags, counter, aaguid, credentialId };
}

function appIdHash() {
  if (!APP_ID) throw new Error('APP_ATTEST_APP_ID is not set on this deployment');
  return createHash('sha256').update(APP_ID).digest();
}

// MARK: - Registration

/// Verifies a fresh attestation and returns the public key to remember.
///
/// `challenge` is the exact nonce this server issued and has not seen used.
export function verifyAttestation({ attestationBase64, keyIdBase64, challenge }) {
  const attestation = decodeCBOR(Buffer.from(attestationBase64, 'base64'));

  if (attestation.fmt !== 'apple-appattest') {
    throw new Error(`attestation: unexpected format ${attestation.fmt}`);
  }
  const x5c = attestation.attStmt?.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new Error('attestation: missing certificate chain');
  }

  const credCert = new X509Certificate(Buffer.from(x5c[0]));
  const intermediate = new X509Certificate(Buffer.from(x5c[1]));

  // STEP 1. Chain to Apple's root. Node does the cryptography.
  if (!credCert.checkIssued(intermediate)) {
    throw new Error('attestation: leaf was not issued by the intermediate');
  }
  if (!credCert.verify(intermediate.publicKey)) {
    throw new Error('attestation: leaf signature does not verify');
  }
  if (!intermediate.checkIssued(appleRoot())) {
    throw new Error('attestation: intermediate was not issued by Apple');
  }
  if (!intermediate.verify(appleRoot().publicKey)) {
    throw new Error('attestation: intermediate signature does not verify');
  }
  const now = Date.now();
  for (const cert of [credCert, intermediate]) {
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) {
      throw new Error('attestation: certificate is outside its validity window');
    }
  }

  const authData = Buffer.from(attestation.authData);

  // STEPS 2 and 3. The nonce is SHA256(authData || SHA256(challenge)), and it
  // must equal what Apple put in the certificate extension.
  const clientDataHash = createHash('sha256').update(challenge).digest();
  const expectedNonce = createHash('sha256')
    .update(Buffer.concat([authData, clientDataHash]))
    .digest();

  const extension = extensionValue(credCert.raw, NONCE_OID_DER);
  // The extension wraps the nonce in SEQUENCE { [1] { OCTET STRING } }, so the
  // digest is the last 32 bytes of it.
  const presentedNonce = extension.subarray(extension.length - 32);
  if (!expectedNonce.equals(presentedNonce)) {
    throw new Error('attestation: nonce does not match');
  }

  // STEP 4. The key id is the SHA256 of the public key.
  const publicKey = credCert.publicKey;
  const raw = publicKey.export({ type: 'spki', format: 'der' });
  // The uncompressed point is the trailing 65 bytes of an SPKI P-256 key.
  const point = raw.subarray(raw.length - 65);
  const expectedKeyId = createHash('sha256').update(point).digest();
  if (!expectedKeyId.equals(Buffer.from(keyIdBase64, 'base64'))) {
    throw new Error('attestation: key id does not match the certificate');
  }

  const parsed = parseAuthenticatorData(authData);

  // STEP 5. This has to be OUR app, not merely some app.
  if (!parsed.rpIdHash.equals(appIdHash())) {
    throw new Error('attestation: this attestation is for a different app');
  }

  // STEP 6. A fresh key has never signed anything.
  if (parsed.counter !== 0) {
    throw new Error('attestation: counter is not zero on a new key');
  }

  // STEP 7. Which environment produced it. Both are accepted so Xcode builds
  // and TestFlight builds both work; WHICH is recorded, so production can be
  // required later without another app release.
  let environment;
  if (parsed.aaguid.equals(AAGUID_PRODUCTION)) environment = 'production';
  else if (parsed.aaguid.equals(AAGUID_DEVELOPMENT)) environment = 'development';
  else throw new Error('attestation: unrecognised attestation environment');

  // STEP 8. The credential id is the key id.
  if (!parsed.credentialId.equals(Buffer.from(keyIdBase64, 'base64'))) {
    throw new Error('attestation: credential id does not match the key id');
  }

  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    environment,
    counter: parsed.counter
  };
}

// MARK: - Every call after registration

/// Verifies one assertion against a remembered public key.
///
/// `clientData` is the exact bytes the app hashed: the challenge plus a digest
/// of the request body, so an assertion cannot be lifted onto a different
/// request.
export function verifyAssertion({ assertionBase64, clientData, publicKeyPem, storedCounter }) {
  const assertion = decodeCBOR(Buffer.from(assertionBase64, 'base64'));
  const signature = Buffer.from(assertion.signature || []);
  const authData = Buffer.from(assertion.authenticatorData || []);
  if (!signature.length || !authData.length) {
    throw new Error('assertion: missing signature or authenticator data');
  }

  const clientDataHash = createHash('sha256').update(clientData).digest();
  const nonce = createHash('sha256')
    .update(Buffer.concat([authData, clientDataHash]))
    .digest();

  const key = createPublicKey(publicKeyPem);
  // The digest is already computed, so the payload is signed as-is.
  if (!verify(null, nonce, key, signature)) {
    throw new Error('assertion: signature does not verify');
  }

  const parsed = parseAuthenticatorData(authData);
  if (!parsed.rpIdHash.equals(appIdHash())) {
    throw new Error('assertion: this assertion is for a different app');
  }

  // REPLAY. Apple increments the counter on every assertion, so one that does
  // not advance is a recording of an earlier request being played back.
  if (parsed.counter <= storedCounter) {
    throw new Error('assertion: counter did not advance');
  }

  return { counter: parsed.counter };
}
