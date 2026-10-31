// The app's REAL request bodies against the server's allowlist.
//
// The app's self-test (-AgniSelfTest, DEBUG) writes every feature's request
// body to Documents/request-bodies.json. Point AGNI_APP_BODIES at that file:
//
//   AGNI_APP_BODIES=.../Documents/request-bodies.json node --test test/app-bodies.test.mjs
//
// Skipped without it. This is the check that a prompt change in the app cannot
// silently start failing the proxy's validation for every user.

import './helpers/no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateModelRequest, reservationFor, imageDimensions, inferFeature } from '../api/_billing.js';

const file = process.env.AGNI_APP_BODIES;
const skip = !file && 'AGNI_APP_BODIES not set';
const FEATURE = { photo: 'photo', photo_streamed: 'photo', photo_part: 'photo', label: 'label', breakdown: 'breakdown', drink: 'drink_id',
                  drink_check: 'drink_check', variant: 'variant_search' };

test('every real app request passes the server allowlist, with its real JPEG', { skip }, () => {
  const bodies = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(bodies).sort(), Object.keys(FEATURE).sort());
  for (const [name, text] of Object.entries(bodies)) {
    const request = JSON.parse(text);
    assert.equal(validateModelRequest(FEATURE[name], request), null, name);
    assert.ok(reservationFor(FEATURE[name], request) > 0, name);
    const image = request.messages[0].content.find(block => block.type === 'image');
    if (image) {
      // The app's own downscaler output: dimensions readable, within the edge.
      const size = imageDimensions(image.source.data);
      assert.ok(size, `${name}: the server can read the app's JPEG`);
      const edge = name === 'drink_check' ? 512 : 1568;
      assert.equal(Math.max(size.width, size.height), edge, `${name}: ${JSON.stringify(size)}`);
    }
  }
  // An old build sending the 512 check without naming a feature is still read as the routing check.
  assert.equal(inferFeature(JSON.parse(bodies.drink_check)), 'drink_check');
});
