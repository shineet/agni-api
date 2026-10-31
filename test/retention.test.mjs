// agni_retention_cleanup: counts by default, deletes only when told to, and
// never touches what the code still reads. Prepared, not scheduled: these
// tests are what has to pass before it is.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';

before(() => { if (h.enabled) h.freshDatabase('retention'); });
after(() => { if (h.enabled) h.dropDatabase(); });

const ago = days => `now() - interval '${days} days'`;

async function counts(dryRun) {
  const rows = await h.sqlJSON(`select * from agni_retention_cleanup(${dryRun})`);
  return Object.fromEntries(rows.map(r => [r.record, Number(r.rows)]));
}

async function seed() {
  await h.sql(`
    insert into agni_subjects (subject_id, kind) values ('dev:old', 'device'), ('dev:new', 'device');
    insert into agni_subjects (subject_id, kind, environment, product_id, expires_date) values
      ('sub:ended', 'subscription', 'Production', 'com.shinethankappan.agni.pro.monthly', ${ago(500)}),
      ('sub:recent', 'subscription', 'Production', 'com.shinethankappan.agni.pro.monthly', ${ago(30)}),
      ('sub:active', 'subscription', 'Production', 'com.shinethankappan.agni.pro.annual', now() + interval '200 days');
    insert into agni_subjects (subject_id, kind, environment, product_id, expires_date, revocation_date) values
      ('sub:refunded', 'subscription', 'Production', 'com.shinethankappan.agni.pro.annual', now() + interval '100 days', ${ago(450)});
    insert into agni_key_links (key_id, device_subject, subscription_subject, subscription_linked_at) values
      ('key-ended', 'dev:old', 'sub:ended', ${ago(600)}),
      ('key-active', 'dev:new', 'sub:active', ${ago(10)});
    insert into agni_usage_events (subject_id, request_id, feature, bucket, tier, auth_path, model, period_start, day, reserved_usd, status, created_at) values
      ('dev:old', 'r-old', 'photo', 'photo', 'free', 'attest', 'm', ${ago(400)}, (${ago(400)})::date, 0.01, 'settled', ${ago(400)}),
      ('dev:old', 'r-stuck', 'photo', 'photo', 'free', 'attest', 'm', ${ago(400)}, (${ago(400)})::date, 0.01, 'reserved', ${ago(400)}),
      ('dev:new', 'r-new', 'photo', 'photo', 'free', 'attest', 'm', ${ago(5)}, (${ago(5)})::date, 0.01, 'settled', ${ago(5)});
    insert into agni_actions (subject_id, action_id, bucket, period_start, created_at) values
      ('dev:old', 'a-old', 'photo', ${ago(400)}, ${ago(400)}),
      ('dev:new', 'a-new', 'photo', ${ago(5)}, ${ago(5)});
    insert into agni_subject_days (subject_id, day) values ('dev:old', (${ago(40)})::date), ('dev:new', current_date);
    insert into agni_allowance_periods (subject_id, period_start, period_end, tier) values
      ('dev:old', ${ago(400)}, ${ago(370)}, 'pro'),
      ('dev:new', ${ago(20)}, now() + interval '10 days', 'pro'),
      ('dev:new', ${ago(3000)}, 'infinity', 'free'),
      ('sub:ended', ${ago(530)}, ${ago(500)}, 'pro');
    insert into agni_budget_days (day, ceiling_usd) values ((${ago(900)})::date, 5), ((${ago(800)})::date, 6);
    insert into agni_research_cache (key, payload, expires_at) values ('gone|m', '{}', ${ago(1)}), ('kept|m', '{}', now() + interval '5 days');
    insert into agni_variant_cache (query_key, payload, created_at) values ('old', '{}', ${ago(200)}), ('new', '{}', ${ago(10)});
    insert into agni_auth_events (day, endpoint, auth_path, meter_class, allowed, build) values
      ((${ago(500)})::date, 'estimate', 'attest', 'paid', true, '177'), (current_date, 'estimate', 'attest', 'paid', true, '177');
    insert into agni_store_notifications (notification_uuid, received_at) values ('n-old', ${ago(500)}), ('n-new', ${ago(3)});
    insert into agni_alerts (kind, at) values ('degraded', ${ago(500)}), ('degraded', now());
  `);
}

test('a dry run counts what would go and deletes nothing', { skip }, async () => {
  await seed();
  const c = await counts(true);
  assert.deepEqual(c, {
    agni_usage_events: 1, agni_actions: 1, agni_subject_days: 1, agni_allowance_periods: 2,
    agni_auth_events: 1, agni_alerts: 1, agni_budget_days: 1, agni_store_notifications: 1,
    agni_research_cache: 1, agni_ingredient_evidence: 0, agni_variant_cache: 1,
    agni_attest_challenges: 0, agni_ip_windows: 0, 'agni_subjects (ended subscriptions)': 2
  });
  assert.equal(await h.sql(`select count(*) from agni_usage_events`), '3');
  assert.equal(await h.sql(`select count(*) from agni_subjects`), '6');
});

test('the real run removes only expired records and keeps everything still read', { skip }, async () => {
  await counts(false);
  assert.equal(await h.sql(`select string_agg(request_id, ',' order by request_id) from agni_usage_events`), 'r-new,r-stuck',
               'a reservation still open is never deleted, however old');
  assert.equal(await h.sql(`select string_agg(action_id, ',') from agni_actions`), 'a-new');
  assert.equal(await h.sql(`select count(*) from agni_subject_days`), '1');
  assert.equal(await h.sql(`select count(*) from agni_allowance_periods where subject_id = 'dev:new'`), '2',
               'the current period and the open-ended Free period stay');
  assert.equal(await h.sql(`select string_agg(key, ',') from agni_research_cache`), 'kept|m');
  assert.equal(await h.sql(`select string_agg(query_key, ',') from agni_variant_cache`), 'new');
  assert.equal(await h.sql(`select count(*) from agni_auth_events`), '1');
  assert.equal(await h.sql(`select count(*) from agni_alerts`), '1');
  assert.equal(await h.sql(`select string_agg(notification_uuid, ',') from agni_store_notifications`), 'n-new');
});

test('the newest budget day survives even when it is old, because tomorrow grows from it', { skip }, async () => {
  assert.equal(await h.sql(`select count(*) from agni_budget_days`), '1');
});

test('ended subscriptions go after 400 days, with their periods; links lose the subscription, devices stay', { skip }, async () => {
  assert.equal(await h.sql(`select string_agg(subject_id, ',' order by subject_id) from agni_subjects where kind = 'subscription'`),
               'sub:active,sub:recent', 'refunded 450 days ago and expired 500 days ago are gone; ended 30 days ago is kept');
  assert.equal(await h.sql(`select count(*) from agni_allowance_periods where subject_id = 'sub:ended'`), '0');
  const [link] = await h.sqlJSON(`select device_subject, subscription_subject from agni_key_links where key_id = 'key-ended'`);
  assert.deepEqual(link, { device_subject: 'dev:old', subscription_subject: null });
  assert.equal(await h.sql(`select subscription_subject from agni_key_links where key_id = 'key-active'`), 'sub:active');
  assert.equal(await h.sql(`select count(*) from agni_subjects where kind = 'device'`), '2', 'device subjects are not touched');
});

test('running it again finds nothing more to do', { skip }, async () => {
  const c = await counts(false);
  assert.ok(Object.values(c).every(v => v === 0), JSON.stringify(c));
});

test('only the service role can run it', { skip }, async () => {
  const exposed = await h.sql(`select has_function_privilege('anon', 'agni_retention_cleanup(boolean)', 'execute')
                                   or has_function_privilege('authenticated', 'agni_retention_cleanup(boolean)', 'execute')`);
  assert.equal(exposed, 'f');
});
