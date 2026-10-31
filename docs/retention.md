# Server record retention (prepared 2026-10-31, NOT in force)

Nothing here runs yet. `schema-retention.sql` defines `agni_retention_cleanup(p_dry_run boolean default true)`;
it is not applied to production and not scheduled. The privacy policy must not quote these periods until it runs.

| Record | Kind | Proposed | Why |
|---|---|---|---|
| agni_usage_events (settled/expired) | operational | 180 days | Read for the current and previous allowance period and stale-reservation sweeps; 180 days also covers Apple's usual refund window for reconciling a refunded period. Open reservations are never deleted. |
| agni_actions | operational | 180 days | Idempotency of a credited action within its period; same margin as usage events. |
| agni_subject_days | operational | 35 days | Only today's row is read (25 photos a day); a month for support questions. |
| agni_allowance_periods | operational | 180 days after period end | agni__carry_source reads back under a month; "infinity" Free periods kept. |
| agni_auth_events | operational, no identifiers | 400 days | Daily counts per endpoint/build; agni_auth_summary reads 14 days by default. |
| agni_alerts | operational | 400 days | Ceiling and abuse alerts; a year for comparison. |
| agni_budget_days | operational, no identifiers | 730 days, newest row always kept | Tomorrow's ceiling grows from the latest earlier row. |
| agni_research_cache | cache | until expires_at (30 days) | Never read past expiry; previously never purged. |
| agni_ingredient_evidence | cache | until expires_at (7 to 90 days) | Sweep existed but nothing called it. |
| agni_variant_cache | cache | 180 days from creation | Had no expiry column and was kept forever. |
| agni_attest_challenges, agni_ip_windows | operational | 1 day | Already swept on use; also swept here. |
| agni_store_notifications | purchase | 400 days | Dedupe of Apple redeliveries needs days; a year covers an annual cycle when reconciling a refund. |
| agni_subjects (subscriptions) | purchase / refund / fraud | 400 days after it ended (expiry past grace, or revocation) | Late refunds and chargebacks still find it; a restore after that recreates it from Apple's signed transaction. Links lose the subscription; the device keeps its link. |
| agni_subjects (devices), agni_key_links, agni_attest_keys | fraud / Free-sample abuse | NOT deleted yet | Deleting an attest key makes that phone's next request fail with "key is not registered"; the app's recovery has not been verified on a device. Proposed once verified: 400 days after the key was last seen. |
| agni_installs (legacy token path) | legacy | delete 90 days after LEGACY_TOKEN_ENABLED=false | Only builds before App Attest use it. Not in the function (needs the env state). |
| agni_beta_signups | legacy, has email | Shine's decision | Suggest deleting 90 days after launch, or on request. Not in the function. |
| agni_dish_submissions, agni_dish_misses | product data | kept while the table is used | Contributor hash since 91bc943: pseudonymous, not anonymous. The server can recompute it from an install id, so it stays linkable by whoever holds the secret; it only removes the raw id from beside dish data. |

## Scheduling (not wired)

Either works; neither is set up:
- **Supabase pg_cron** (simplest): `select cron.schedule('agni-retention', '17 9 * * *', $$select * from agni_retention_cleanup(false)$$);`
  The job history keeps each run's result.
- **Vercel cron**: a route calling the RPC with the service role, plus a `crons` entry in vercel.json. Costs one of the
  twelve functions unless folded into an existing route (quota.js already multiplexes with `?op=`).

Run it once with the default dry run first and compare the counts with expectations. Apply with
`schema-retention.sql` then `schema-lockdown.sql` (lockdown must run last so the new function is service-role only).

## Backups

Deleted rows persist in Supabase's automatic backups until those age out. The backup window is set by the plan and
is not visible from this repo: UNKNOWN until checked in Supabase > Database > Backups (Pro is expected to keep
7 days of daily backups). The policy should say deleted records leave backups within that window, once confirmed.
