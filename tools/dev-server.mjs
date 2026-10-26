// A LOCAL development server for the companion prototype. Never deployed.
//
// Serves POST /api/companion from the real handler, with the real metering,
// against a throwaway database on your local Postgres (the test harness's),
// so the simulator can exercise the whole path: app -> server -> ledger.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node tools/dev-server.mjs
//
// THE PROVIDER IS A LABELLED STUB unless you give it a key:
//   ANTHROPIC_API_KEY=... AGNI_DEV_LIVE_PROVIDER=1 node tools/dev-server.mjs
// Stub replies begin "(stub provider)" so nobody mistakes them for a model.
//
// The simulator cannot use App Attest, so this server accepts the app's
// shared token for the companion route (COMPANION_ALLOW_LEGACY). The token is
// read from the app's source at start-up and never printed.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as h from '../test/helpers/harness.mjs';

const PORT = Number(process.env.PORT || 3999);
const live = process.env.AGNI_DEV_LIVE_PROVIDER === '1' && !!process.env.ANTHROPIC_API_KEY;
const realKey = process.env.ANTHROPIC_API_KEY;

const appSource = path.join(process.env.HOME || '', 'Documents/Projects/Agni/Agni/Core/BackendConfig.swift');
const token = (readFileSync(appSource, 'utf8').match(/static let appToken = "([^"]+)"/) || [])[1];
if (!token) throw new Error('could not read the app token from BackendConfig.swift');

h.setTestEnv({
  COMPANION_ENABLED: 'true',
  COMPANION_ALLOW_LEGACY: 'true',
  APP_TOKEN: token,
  BILLING_ENFORCED: 'false',
  ANTHROPIC_API_KEY: live ? realKey : 'stub'
});
h.freshDatabase('devserver');
const realFetch = globalThis.fetch;
h.installFetch();
const harnessFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://api.anthropic.com/v1/messages') {
    if (live) return realFetch(url, options);
    const body = JSON.parse(options.body);
    const asked = body.messages.at(-1).content;
    const text = `(stub provider) I heard "${String(asked).slice(0, 80)}". A real model would answer here from today's summary.`;
    return new Response(JSON.stringify({ content: [{ type: 'text', text }],
                                         usage: { input_tokens: 0, output_tokens: 0 } }),
                        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'stub' } });
  }
  return harnessFetch(url, options);
};

const research = (await import('../api/research.js')).default;

http.createServer(async (req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.send = body => res.end(body);
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'POST' && url.pathname === '/api/companion') {
    req.query = { ...Object.fromEntries(url.searchParams), op: 'companion' };
    try {
      await research(req, res);
    } catch (error) {
      console.error('[dev-server]', error.message);
      if (!res.headersSent) res.status(500).send('{"error":"dev server"}');
    }
    return;
  }
  res.status(404).send('{"error":"not found"}');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-server] companion on http://127.0.0.1:${PORT}/api/companion `
    + `(provider: ${live ? 'LIVE Anthropic' : 'STUB'}; database: local, throwaway)`);
});

process.on('SIGINT', () => { h.dropDatabase(); process.exit(0); });
