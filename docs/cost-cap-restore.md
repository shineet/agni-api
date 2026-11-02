# Restoring someone the cost safeguard stopped early

**What it is for:** the per-period cost safeguard (Pro $6.50, trial $2, Free $0.75) is sized above what the advertised counts use. If it ever stops someone who still has credits, they see:

> "AI analysis is paused by a cost safeguard before your allowance ran out. This has been recorded. Contact support with your Support ID (Settings > Agni Pro) to have it reviewed."

The stop is recorded in `agni_cost_cap_stops` (server-only), and a `cost_cap_before_counts` alert is written once a day. The alert names no one.

## 1. Find them

Either they write in with a Support ID, or the alert prompts you to look:

```bash
curl -s -X POST 'https://agni-api.vercel.app/api/quota?op=cost-cap-stops' \
  -H "x-admin-token: $BETA_ADMIN_TOKEN" -H 'content-type: application/json' -d '{"sinceDays":35}'
```

Each stop shows:
- `ref`;
- `tier`;
- `supportIds` (the phones linked to the subscription);
- the period and whether it is still running;
- `used` of `limit` in the bucket that was stopped;
- any headroom already restored.

No purchase identifier or install id is ever returned.

## 2. Preview, then restore

```bash
curl -s -X POST 'https://agni-api.vercel.app/api/quota?op=cost-cap-restore' \
  -H "x-admin-token: $BETA_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"preview","supportId":"AG-XXXXXXXXXX"}'
# then the same with "mode":"apply"
```

You can use `"ref"` instead of `"supportId"`, and an optional `"amountUSD"`. The default is the tier's own cap.

**What a restore does:**
- adds safeguard headroom to the ONE period in which they were stopped early;
- the total added to a period never exceeds the tier's cap, so the safeguard at most doubles.

**What it never changes:**
- the purchase or its expiry;
- the advertised counts;
- the 25-a-day photo limit;
- any other limit.

So it cannot create unlimited use. It is refused when:
- there is no recorded early stop for that person;
- the period has ended (the new period starts fresh anyway);
- the grant limit is reached.

Every restore writes a `cost_cap_restored` alert (no subject in it).

## 3. Tell them

Once `apply` returns `ok: true`, AI works again immediately for the rest of that period. Do not promise a restore before running it.

## Privacy

- `agni_cost_cap_stops` holds the subscription or device subject, the period, and counts and costs. It is deleted with that person's server data (`agni_delete_device_data`, `agni_delete_subscription_history`) and by retention with the periods it describes.
- The admin token is the only way in. The functions are not callable by `anon` or `authenticated`.
