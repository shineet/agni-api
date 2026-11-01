# Release runbook: launch-privacy-prep (PREPARED 2026-10-31, NOT RUN)

Every step needs Shine's explicit go. Each one ends with a verification and names its rollback point.

- Production now: server **3ef4e97** (`dpl_4RPGpXMBUDTkfUqctbMnKdPpMozk`), the 3ef4e97 schema.
- Supabase project: **Agni, nglfxnzxseshrklypxhg, us-east-1**. Check the project name in the dashboard header before pasting anything.
- Evidence for every claim here is in `docs/migration-review.md`.

## 1. Local preparation (Claude, no external effect)

- [ ] On `launch-privacy-prep`, run the full suite. Expected: all pass except `fatsecret.test.mjs` (route parked in September) and the 2 app-body skips.
- [ ] `node scripts/build-release-sql.mjs`, then `git diff --exit-code migrations/2026-10-31-release.sql`. It must be unchanged.
- [ ] Record the rollback target: Vercel deployment for 3ef4e97 = `dpl_4RPGpXMBUDTkfUqctbMnKdPpMozk`.
- [ ] Confirm today's Supabase daily backup exists (Database > Backups) before step 2.

## 2. Database application (Shine runs it in the Supabase SQL editor)

- [ ] New query in the Agni project. Paste the whole of `migrations/2026-10-31-release.sql`, which is one transaction with lockdown last, and Run.
- [ ] If it errors, nothing was applied. Stop and report; don't run parts of it.
- [ ] Verify (read-only):
  ```sql
  select count(*) from pg_proc where proname = 'agni_reserve';                                -- 1
  select count(*) from information_schema.columns
   where table_name in ('agni_usage_events','agni_actions') and column_name = 'device_subject'; -- 2
  select count(*) from agni_usage_events where device_subject is not null;                    -- 0
  select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'agni%'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'));                      -- 0
  ```
- [ ] Smoke test the CURRENT server: an attested photo on a TestFlight build still works. Expected, because 3ef4e97 runs on the new SQL (212 of 215, its own baseline).
- **Rollback point:** none needed. **Never re-apply 3ef4e97 SQL files**: they recreate a second `agni_reserve` and break every request.

## 3. Merge and push (git; Claude after Shine's go)

- [ ] `git checkout main && git merge --ff-only launch-privacy-prep`. If it's not a fast-forward, stop.
- [ ] `git push origin main`. **This is the deploy trigger** for agni-api (Vercel builds main automatically).

## 4. Server deployment (Vercel, automatic on push)

- [ ] Wait until the new deployment is READY (Vercel MCP `list_deployments`).
- [ ] Smoke tests:
  - `GET /api/attest` 200;
  - unauthenticated `POST /api/estimate` 401;
  - `POST /api/quota?op=delete-data` without a signature 401;
  - `POST /api/app-store-notifications` with no body 400.
- [ ] One attested photo from a TestFlight build succeeds. `agni_usage_events` gains a row with `device_subject` set.
- **Rollback point:** Vercel instant rollback, or promote `dpl_4RPGpXMBUDTkfUqctbMnKdPpMozk`. The SQL stays as it is (compatible). Rows already written keep `device_subject` (harmless).

## 5. Contributor conversion (admin op; Shine supplies the token from his password manager to his own shell)

- [ ] `{"mode":"preview"}`, then `{"mode":"apply"}`, then `{"mode":"verify"}` against `POST /api/quota?op=contrib-migrate`, as in `migrations/README.md`.
- [ ] Verify must show: `raw_submissions_left = 0`, `raw_misses_left = 0`, `changed_counts = 0`.
- **Rollback point:** `{"mode":"rollback"}`, while `agni_dish_contrib_backup_20261031` exists. **Keep the backup.** Dropping it needs a separate go, proposed 7 days after a clean verify.

## 6. Test-dish cleanup (admin op; only with the approved list)

- [ ] `POST /api/quota?op=test-dish-cleanup` with `{"mode":"preview","pairs":[...33 pairs...]}`, the exact body in `docs/readonly-queries/test-dish-cleanup-proposal.md`. It must report **33 matched across 8 keys**, all `published_now: true` and `published_after: false`.
- [ ] Then `{"mode":"apply", ...}`: expect `deleted: 33`, `backedUp: 33`, `keysUnpublished: 8`.
- [ ] Then `{"mode":"verify", ...}`: expect `remaining: 0`.
- [ ] Read-only check: `select key from agni_community_dishes` no longer lists the 8 fixture keys. The two real contributions (pint of beer, rice) are still present, now hashed.
- **Rollback point:** `{"mode":"rollback"}` restores all 33 (in converted form), while `agni_dish_cleanup_backup_20261031` exists. **Keep the backup.** Dropping it needs a separate go.

## 7. Retention (dry run, then schedule)

- [ ] `select * from agni_retention_cleanup();` is a DRY RUN by default. Compare the counts with expectations: no active, grace-period, billing-retry or recently refunded subscription is listed, and no open reservation.
- [ ] Only on Shine's go: `select * from agni_retention_cleanup(false);` once, then re-run the dry run, which should show 0 eligible.
- [ ] Only on Shine's go: schedule it daily (pg_cron, `docs/retention.md`). Beta-email cleanup is scheduled from launch + 90 days: `agni_beta_signup_cleanup('<launch date>', false)`.
- **Rollback point:** none. Deletions are permanent beyond Supabase's 7 daily backups, and PITR is OFF.

## App steps (Agni repo; separate from all of the above)

**Pushing app code to git does NOT build, upload or distribute anything.**

1. Bump `CURRENT_PROJECT_VERSION` in the Agni project and commit.
2. `~/Documents/Projects/tools/ship.sh agni --upload` archives, exports and uploads to App Store Connect. **Only when Shine says "push".**
3. `~/Documents/Projects/tools/asc.py builds agni`: poll until VALID.
4. `~/Documents/Projects/tools/asc.py notes agni <build> <file>` sets the "What to Test" notes.
5. `~/Documents/Projects/tools/asc.py release agni <build>` hands the build to TestFlight groups. Only Me gets it automatically; others only on Shine's word.
