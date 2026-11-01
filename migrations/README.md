# Contributor-hash conversion: runbook (PREPARED 2026-10-31, NOT RUN)

Converts the raw install ids already stored in `agni_dish_submissions` and
`agni_dish_misses` to the contributor hash new rows get (`contributorId` in
`api/_lib.js`).

**What the hash is.** It is pseudonymous, not anonymous. The server holds the
key, CONTRIBUTOR_SALT or else IP_HASH_SALT, and can recompute any phone's value
from its install id. The conversion removes the raw install id from beside dish
data, where a plain equality reached that phone's `dev:<install id>` usage
records. It does not make the rows unlinkable for whoever holds the key.

**Where the secret is.** It stays in the Vercel runtime. The admin op computes
each hash in Node and passes the database only a map of raw id to hash. No
step below puts the secret in a file, a SQL editor, a log, a response or git.
Responses carry counts only.

## Who runs what, in order

Every step needs Shine's go-ahead. Nothing here has been run against
production.

1. **Deploy the server branch** that contains `contributorId`, the admin op
   and `schema-contributor-migration.sql` (agni-api `launch-privacy-prep`).
   From then on, new rows are written hashed. *Shine approves the deploy.*
2. **Apply the SQL**, in the Supabase SQL editor of the Agni project
   (project ref nglfxnzxseshrklypxhg; check the project name before pasting):
   `schema-contributor-migration.sql`, then `schema-lockdown.sql`. This
   creates the backup and count tables and the functions and changes no rows.
   *Shine runs it, or approves it.*
3. **Preview** (read only):
   ```
   curl -sS -X POST 'https://agni-api.vercel.app/api/quota?op=contrib-migrate' \
     -H "x-admin-token: $BETA_ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"mode":"preview"}'
   ```
   Expect `{ rawIds, rawRows: {submissions, misses}, merges: {...} }`. Merges
   are raw rows whose phone has since written a hashed row for the same dish.
   Take the token from your own password manager into the shell variable. Do
   not paste it into chat or into a file.
4. **Apply**: the same call with `{"mode":"apply"}`.
   - It snapshots distinct contributors per dish, then converts in chunks of
     500 ids. Each chunk is one transaction that first copies every row it
     will change or delete into `agni_dish_contrib_backup_20261031`.
   - The response ends with `checks`.
   - Re-running is safe: ids already converted have no raw rows left.
   - If it fails part-way, run it again.
5. **Verify**: `{"mode":"verify"}`. All three must hold:
   - `raw_submissions_left = 0`
   - `raw_misses_left = 0`
   - `changed_counts = 0`, meaning no dish gained or lost a distinct
     contributor.

   If `changed_counts` is anything else, roll back (step 6) and stop.
6. **Rollback, if needed**: `{"mode":"rollback"}`.
   - Restores every backed-up row exactly, and keeps the backup so the
     conversion can be applied again.
   - A row the same phone wrote for the same dish after step 4 is replaced by
     its snapshot, so roll back promptly or not at all.
   - Not possible after step 7.
7. **Drop the backup** 7 days after a clean verify. The backup holds raw
   install ids, which is what the conversion exists to remove:
   ```sql
   drop table if exists agni_dish_contrib_backup_20261031;
   drop table if exists agni_dish_contrib_counts_20261031;
   ```
   The dropped rows remain in Supabase's own backups until those age out (the
   plan's backup window, to be confirmed on the Backups page). The functions
   can be dropped in the same session (`agni_contrib_%`, `agni__contrib_map`)
   or left; they are service-role only.

## Tests

`test/contrib-migration.test.mjs` runs against local Postgres and covers:
token rejection (none, wrong, short, unset); refusal without a contributor key;
preview writing nothing; counts-only responses; apply producing exactly
`contributorId()` with twin merges and the backup; idempotent re-apply;
rollback to the exact prior rows and re-apply; and lockdown of the new tables
and functions.

# Deletion, retention and test-dish cleanup (PREPARED 2026-10-31, NOT RUN)

**SQL first, then the server.** The new server calls `agni_reserve` with
`p_device_subject`. The new SQL accepts calls with or without it, but the old
SQL does not know it. So apply the SQL before promoting the deploy:

1. `migrations/2026-10-31-device-attribution.sql`
2. `schema-billing.sql`
3. `schema-deletion.sql`
4. `schema-retention.sql`
5. `schema-dish-cleanup.sql` (only if the cleanup is approved)
6. `schema-lockdown.sql` (last)

Then promote the server deploy. Nothing in these files deletes data. The
deletion functions run only when a person asks in the app. The retention and
beta-email functions are dry runs unless called with `false`, and nothing
schedules them. The dish cleanup runs only through its admin op, with the 33
pairs listed in `docs/readonly-queries/test-dish-cleanup-proposal.md`.
