// The paywall's fallback numbers against the server's.
//
// Before the server has answered, the app's paywall shows
// AllowanceStatus.Offer.shippedDefault (Agni/Core/AgniPro.swift). If that ever
// drifted from DEFAULT_ALLOWANCES, the app would advertise an allowance the
// server does not honour. Point AGNI_APP_SOURCE at the app's source folder;
// skipped without it (and when the default checkout path is missing).

import './helpers/no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ALLOWANCES } from '../api/_billing.js';

const source = process.env.AGNI_APP_SOURCE
  || path.join(process.env.HOME || '', 'Documents/Projects/Agni/Agni');
const file = path.join(source, 'Core/AgniPro.swift');
const skip = !existsSync(file) && `no app source at ${file}`;

test('the app\'s shipped offer equals the server\'s default allowances', { skip }, () => {
  const text = readFileSync(file, 'utf8');
  const block = text.slice(text.indexOf('// BEGIN SHIPPED OFFER'), text.indexOf('// END SHIPPED OFFER'));
  const tier = name => {
    const match = block.match(new RegExp(`${name}: Allowance\\(([^)]*)\\)`));
    assert.ok(match, `${name} present`);
    const value = key => {
      const m = match[1].match(new RegExp(`${key}: (\\w+)`));
      return m && m[1] !== 'nil' ? Number(m[1]) : null;
    };
    return { photo: value('photo'), search: value('search'), web: value('web'), burst: value('photoDailyLimit') };
  };
  const d = DEFAULT_ALLOWANCES;
  assert.deepEqual(tier('pro'), { photo: d.pro.photo, search: d.pro.search, web: d.pro.web, burst: d.pro.burst });
  assert.deepEqual({ ...tier('trial'), burst: null }, { photo: d.trial.photo, search: d.trial.search, web: d.trial.web, burst: null });
  assert.deepEqual({ photo: tier('free').photo, search: tier('free').search },
                   { photo: d.free.photo, search: d.free.search });
});
