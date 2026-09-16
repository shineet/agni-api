// End-to-end test of the request binding: the bytes the client signs against
// the bytes the server verifies.
//
// WHY THIS EXISTS. The client signed `Data(body.utf8)` and the server hashed
// `JSON.stringify(req.body.request)`. Those are not the same bytes and could
// never be made so: the app interpolates its JSON schema RAW, so what it sends
// carries thousands of characters of pretty-printed newlines and indentation
// that a parse and re-serialise silently strips. Every assertion failed with
// "signature does not verify", and nothing in the unit tests noticed, because
// nothing exercised both halves against one another.
//
// This builds a payload shaped like the real one, signs it the way Apple signs,
// and verifies it the way the server verifies.
//
//   node --test test/attest-assertion.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

process.env.APP_ATTEST_APP_ID = 'B2WG3MN7S3.com.shinethankappan.agni';
const { verifyAssertion } = await import('../api/_attest.js');

const APP_ID = process.env.APP_ATTEST_APP_ID;

/// A body shaped like Agni's: hand-assembled, with the schema interpolated raw
/// and therefore pretty-printed. This is the detail that broke it.
function agniPayload() {
  const prettySchema = [
    '{',
    '  "type": "object",',
    '  "properties": {',
    '    "dishes": { "type": "array" }',
    '  }',
    '}'
  ].join('\n');
  const request =
    `{"model":"claude-sonnet-5","max_tokens":4096,"system":"You estimate food.",` +
    `"output_config":{"format":{"type":"json_schema","schema":${prettySchema}}},` +
    `"messages":[{"role":"user","content":[{"type":"text","text":"a plate"}]}]}`;
  return Buffer.from(`{"installId":"UUID-HERE","request":${request}}`, 'utf8');
}

/// authenticatorData as Apple lays it out for an assertion.
function authenticatorData(counter) {
  const rpIdHash = createHash('sha256').update(APP_ID).digest();
  const header = Buffer.alloc(5);
  header[0] = 0x00;
  header.writeUInt32BE(counter, 1);
  return Buffer.concat([rpIdHash, header]);
}

/// What the device does inside generateAssertion: sign
/// SHA256(authenticatorData || clientDataHash).
function signLikeApple(privateKey, authData, clientData) {
  const clientDataHash = createHash('sha256').update(clientData).digest();
  const nonce = createHash('sha256')
    .update(Buffer.concat([authData, clientDataHash])).digest();
  return createSign('SHA256').update(nonce).sign(privateKey);
}

/// Minimal CBOR encoder for { signature, authenticatorData }, so the test feeds
/// the verifier the same shape Apple does.
function encodeAssertion(signature, authData) {
  const byteString = (b) => Buffer.concat([
    Buffer.from([0x40 + 24]), Buffer.from([0]), b   // placeholder, fixed below
  ]);
  const bytes = (b) => {
    if (b.length < 24) return Buffer.concat([Buffer.from([0x40 + b.length]), b]);
    if (b.length < 256) return Buffer.concat([Buffer.from([0x58, b.length]), b]);
    const len = Buffer.alloc(2); len.writeUInt16BE(b.length);
    return Buffer.concat([Buffer.from([0x59]), len, b]);
  };
  const text = (s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([0x60 + b.length]), b]);
  };
  void byteString;
  return Buffer.concat([
    Buffer.from([0xa2]),
    text('signature'), bytes(signature),
    text('authenticatorData'), bytes(authData)
  ]);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const challenge = Buffer.alloc(32, 0x5a);

test('a correctly bound assertion verifies', () => {
  const payload = agniPayload();
  const clientData = Buffer.concat([
    challenge, createHash('sha256').update(payload).digest()
  ]);
  const authData = authenticatorData(7);
  const assertion = encodeAssertion(
    signLikeApple(privateKey, authData, clientData), authData);

  const result = verifyAssertion({
    assertionBase64: assertion.toString('base64'),
    clientData,
    publicKeyPem,
    storedCounter: 6
  });
  assert.equal(result.counter, 7);
});

test('THE BUG: hashing a JSON round-trip instead of the raw bytes fails', () => {
  // Exactly what the server used to do. The payload's pretty-printed schema
  // does not survive JSON.parse followed by JSON.stringify, so the reconstructed
  // clientData differs and the signature cannot verify.
  const payload = agniPayload();
  const signedClientData = Buffer.concat([
    challenge, createHash('sha256').update(payload).digest()
  ]);
  const authData = authenticatorData(8);
  const assertion = encodeAssertion(
    signLikeApple(privateKey, authData, signedClientData), authData);

  const roundTripped = Buffer.from(
    JSON.stringify(JSON.parse(payload.toString('utf8'))), 'utf8');
  assert.notEqual(roundTripped.toString('utf8'), payload.toString('utf8'),
                  'the round trip must actually differ, or this proves nothing');

  const wrongClientData = Buffer.concat([
    challenge, createHash('sha256').update(roundTripped).digest()
  ]);
  assert.throws(() => verifyAssertion({
    assertionBase64: assertion.toString('base64'),
    clientData: wrongClientData,
    publicKeyPem,
    storedCounter: 7
  }), /signature does not verify/);
});

test('a different body cannot reuse an assertion', () => {
  const authData = authenticatorData(9);
  const clientData = Buffer.concat([
    challenge, createHash('sha256').update(agniPayload()).digest()
  ]);
  const assertion = encodeAssertion(
    signLikeApple(privateKey, authData, clientData), authData);

  const tampered = Buffer.concat([
    challenge,
    createHash('sha256').update(Buffer.from('a completely different body')).digest()
  ]);
  assert.throws(() => verifyAssertion({
    assertionBase64: assertion.toString('base64'),
    clientData: tampered, publicKeyPem, storedCounter: 8
  }), /signature does not verify/);
});

test('a stale counter is rejected, so a captured request cannot be replayed', () => {
  const authData = authenticatorData(4);
  const clientData = Buffer.concat([
    challenge, createHash('sha256').update(agniPayload()).digest()
  ]);
  const assertion = encodeAssertion(
    signLikeApple(privateKey, authData, clientData), authData);

  assert.throws(() => verifyAssertion({
    assertionBase64: assertion.toString('base64'),
    clientData, publicKeyPem, storedCounter: 4
  }), /counter did not advance/);
});

test('an assertion for another app is rejected', () => {
  const foreign = Buffer.concat([
    createHash('sha256').update('OTHERTEAM.com.someone.else').digest(),
    Buffer.from([0x00, 0, 0, 0, 3])
  ]);
  const clientData = Buffer.concat([
    challenge, createHash('sha256').update(agniPayload()).digest()
  ]);
  const assertion = encodeAssertion(
    signLikeApple(privateKey, foreign, clientData), foreign);

  assert.throws(() => verifyAssertion({
    assertionBase64: assertion.toString('base64'),
    clientData, publicKeyPem, storedCounter: 0
  }), /different app/);
});
