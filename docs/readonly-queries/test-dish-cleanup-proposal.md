# Test-dish cleanup: proposal for review (NOT RUN)

Prepared 2026-10-31 from a read-only inventory of production (Agni Supabase
project nglfxnzxseshrklypxhg, project verified before querying). **Nothing has
been deleted.** Every step below needs Shine's approval of these exact rows.

## Why

- Every `-AgniSelfTest` run saved fixture meals, and saving a meal posted its
  dishes to `/api/dishes`. Fixed in the app on 2026-10-31: self-tests no
  longer contribute, and every flagged Debug launch is network-isolated.
- A dish is offered to everyone once it has two submission rows
  (`agni_community_dishes`).
- **All 8 dishes published today are published only because of self-test rows.**

## The 33 rows (exact (key, install_id) pairs)

| # | key | install_id |
|---|---|---|
| 1 | amma s dal | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 2 | coffee | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 3 | lager pint | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 4 | pint of beer | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 5 | rice | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 6 | test food | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 7 | toast | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 8 | vanishing curry | 05F7BACD-A5F2-404F-B087-11564CBB2659 |
| 9 | amma s dal | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 10 | coffee | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 11 | lager pint | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 12 | pint of beer | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 13 | rice | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 14 | test food | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 15 | toast | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 16 | vanishing curry | 13923BC8-6341-47C7-9C86-C87506BC5250 |
| 17 | amma s dal | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 18 | coffee | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 19 | lager pint | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 20 | pint of beer | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 21 | rice | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 22 | test food | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 23 | toast | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 24 | vanishing curry | 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 |
| 25 | amma s dal | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 26 | coffee | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 27 | lager pint | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 28 | pint of beer | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 29 | rice | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 30 | test food | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 31 | toast | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 32 | vanishing curry | E01AEE34-0681-4687-97B5-DEDF5358FACB |
| 33 | pint of beer | 1DF058F8-F6A1-40A4-A8E6-F49C9E707F49 |

## Evidence, per install

A time window alone only flags a candidate. Each install below is identified by
four independent things together:

1. **It is a simulator.** The install id was read from that simulator's own
   Keychain on 2026-10-31 by an isolated Debug launch (`-AgniWriteInstallID`,
   nothing sent).
2. **Its writes line up with its own self-test reports.** Each simulator keeps
   `Documents/selftest.txt`, stamped when a run finishes.
3. **It wrote exactly the self-test fixtures.** Each of the four main installs
   wrote the same 8 keys, with the fixture calories from `RepeatMealTests`
   (for example Lager, pint 208 and Coffee 120).
4. **No real phone could plausibly match all of the above.**

| Install | Device | Write times vs self-test reports |
|---|---|---|
| 05F7BACD-A5F2-404F-B087-11564CBB2659 | iPhone 17 Pro simulator | first write 2026-09-13 17:48 CT; last write 2026-10-31 18:35 CT = the self-test run at 18:35 CT (Vercel request log shows 13 POST /api/dishes at 18:35:57) |
| 13923BC8-6341-47C7-9C86-C87506BC5250 | iPhone 16e simulator | writes 2026-10-05 16:09 to 2026-10-08 15:14 CT; that simulator's last self-test report is Oct 8 15:13:59 |
| 42A5F948-3CF6-4898-86FB-1A2B0879F7A0 | AgniSE3 simulator | writes 2026-10-26 15:58 to 16:07 CT; last self-test report Oct 26 16:07:37 |
| E01AEE34-0681-4687-97B5-DEDF5358FACB | iPhone 17e (F9E5) simulator | writes 2026-10-31 12:51 to 12:54 CT; last self-test report Oct 31 12:54:23 |
| 1DF058F8-F6A1-40A4-A8E6-F49C9E707F49 | iPhone 17 simulator | writes 2026-09-20 00:37 to 2026-09-22 00:06 CT; last self-test report Sep 22 00:06:31. One row only: `pint of beer`, the Alcohol self-test fixture |

**Fixture match.**
- `RepeatMealTests.swift`: Amma's dal, Coffee (120 kcal), Lager, pint (208 kcal), Rice, Test food (300 kcal in one test), Toast (160), Vanishing curry.
- `Alcohol.swift`: `Pint of beer`, both a self-test fixture and a built-in drink preset. That's why a real person can also have it, and one does.

**Not test rows, kept.**
- `pint of beer` from contributor C8D973B3... (2026-09-22 19:27 CT, 224 kcal).
- `rice` from contributor AF89B83E... (2026-09-07 18:11 CT, 150 kcal).
- Neither is a simulator id, and neither lines up with a self-test run.

**Missed-dish table:** 0 rows from these installs (251 rows, 240 dishes, 14 phones). Nothing to clean there.

## Publication impact

| key | rows now | rows after | offered now | offered after |
|---|---|---|---|---|
| amma s dal | 4 | 0 | yes | no |
| coffee | 4 | 0 | yes | no |
| lager pint | 4 | 0 | yes | no |
| pint of beer | 6 | 1 | yes | no (one real contributor remains) |
| rice | 5 | 1 | yes | no (one real contributor remains) |
| test food | 4 | 0 | yes | no |
| toast | 4 | 0 | yes | no |
| vanishing curry | 4 | 0 | yes | no |

After cleanup, the shared table offers no community dishes until two real
phones agree on one. The bundled dish table in the app is unaffected.

## How it would run (each step on Shine's go)

1. Deploy agni-api `launch-privacy-prep`, then apply `schema-dish-cleanup.sql` then `schema-lockdown.sql` in the Agni SQL editor (project name checked first). This creates the backup table and functions and changes no rows.
2. **Preview** (writes nothing): returns, per key, rows matched and publication now/after.
   ```
   curl -sS -X POST 'https://agni-api.vercel.app/api/quota?op=test-dish-cleanup' \
     -H "x-admin-token: $BETA_ADMIN_TOKEN" -H 'content-type: application/json' \
     --data @pairs-preview.json
   ```
   `pairs-preview.json` is `{"mode":"preview","pairs":[...the 33 pairs above...]}`. The token comes from your password manager into the shell variable, never into chat or a file.
   - Expect 8 keys, 33 matched.
   - Every key: `published_now` true, `published_after` false.
3. **Apply**: the same body with `"mode":"apply"`. It runs as one transaction: copy the 33 rows into `agni_dish_cleanup_backup_20261031`, then delete them. Expect `deleted` 33, `backedUp` 33, `keysUnpublished` 8.
4. **Verify**: `"mode":"verify"` with the same pairs. Expect `remaining` 0, `inBackup` 33, and `unpublishedKeys` listing the 8 keys.
5. **Rollback, if anything looks wrong**: `{"mode":"rollback"}` restores every backed-up row. A row since re-submitted is left as written.
6. **After 7 days with no problem**: `drop table agni_dish_cleanup_backup_20261031;` in the SQL editor. Until then it holds the contributor values of those rows.

**Order with the contributor conversion.** Either order works: each pair is matched by the raw install id and by its `c1:` hash, computed inside the server. Running this cleanup first is simplest.

## The request that would be sent (apply)

```json
{
 "mode": "apply",
 "pairs": [
  {
   "key": "amma s dal",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "coffee",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "lager pint",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "pint of beer",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "rice",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "test food",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "toast",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "vanishing curry",
   "install_id": "05F7BACD-A5F2-404F-B087-11564CBB2659"
  },
  {
   "key": "amma s dal",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "coffee",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "lager pint",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "pint of beer",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "rice",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "test food",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "toast",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "vanishing curry",
   "install_id": "13923BC8-6341-47C7-9C86-C87506BC5250"
  },
  {
   "key": "amma s dal",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "coffee",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "lager pint",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "pint of beer",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "rice",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "test food",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "toast",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "vanishing curry",
   "install_id": "42A5F948-3CF6-4898-86FB-1A2B0879F7A0"
  },
  {
   "key": "amma s dal",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "coffee",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "lager pint",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "pint of beer",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "rice",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "test food",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "toast",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "vanishing curry",
   "install_id": "E01AEE34-0681-4687-97B5-DEDF5358FACB"
  },
  {
   "key": "pint of beer",
   "install_id": "1DF058F8-F6A1-40A4-A8E6-F49C9E707F49"
  }
 ]
}
```
