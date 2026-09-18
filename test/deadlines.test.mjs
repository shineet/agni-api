import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/// EVERY OUTBOUND CALL NEEDS A DEADLINE, checked at the source rather than
/// trusted.
///
/// This exists because the same bug shipped twice in one day. A try/catch
/// around a call catches an ERROR and not SLOWNESS: when the far end simply
/// takes its time, nothing throws, the function runs past its ceiling and the
/// platform kills it. A kill runs no catch, so every considered failure path
/// the caller wrote is skipped. It cost a 504 on the beta page and a dropped
/// TestFlight invitation for somebody who had just signed up.
///
/// A per-call signal turns that into an ordinary rejection, which the callers
/// already handle well.

const dir = path.join(import.meta.dirname, '..', 'api');

test('every fetch in api/ carries its own timeout', () => {
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/\bfetch\s*\(/g)) {
      // The options object lives between the call and the balanced close. A
      // window is enough: these call sites are short and none nests a fetch.
      const window = src.slice(m.index, m.index + 900);
      const upToNextFetch = window.split(/\bfetch\s*\(/)[1] !== undefined
        ? window.slice(0, window.indexOf('fetch(', 6) === -1 ? window.length : window.indexOf('fetch(', 6))
        : window;
      if (!/signal\s*:/.test(upToNextFetch)) {
        const line = src.slice(0, m.index).split('\n').length;
        offenders.push(`${name}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `fetch without a timeout at: ${offenders.join(', ')}. ` +
    `Add signal: AbortSignal.timeout(ms), shorter than the function's maxDuration.`);
});
