# Paid-allowance cost analysis: from code (2026-10-31)

**Status.** Everything here is a CODE-DERIVED ESTIMATE. No telemetry was read,
and no paid call was made. Typical costs need the production read of
`agni_usage_events` (actual_usd per feature), which is blocked until Chrome is
signed in to the Agni Supabase account.

## Pricing and limits used (api/_billing.js)

- **Model rates:** claude-sonnet-5 is $2 in and $10 out per million tokens.
  claude-haiku-4-5 is $1 in and $5 out. A web search is $0.01.
- **Cost caps:** `costCapUSD` is Pro 3.00 and trial 1.00 per period.
- **Daily photo limit:** `burst` is 25 photos a day.
- **Reservations:** each call reserves a conservative bound before it runs.
  - Every input byte is counted as a token, plus 600 framing tokens.
  - Images are charged from their real dimensions, up to 4,784 tokens (Sonnet).
  - Output is charged at the full `max_tokens`.
- **The cap test** is `cost_usd + reservation > cap`, so the last call before
  the cap needs a full reservation of headroom.
  (`schema-billing.sql:588`)

Request sizes come from the app's real bodies: the simulator self-test dump,
`Documents/request-bodies.json`. The app sends a 1568 px longest edge, so an
image is at most 3,364 tokens.

## Request paths and what each credited operation can call

| Operation (bucket) | Provider calls per credited action | Upper bound per call, in USD | Upper bound per action |
|---|---|---|---|
| Meal photo, small plate (photo) | 1: Sonnet streamed, max_tokens 8000 | 0.109 to 0.112 | 0.112 |
| Meal photo, 6+ dishes split (photo) | main + up to 3 parts (`splitMaxCalls` 4), one actionId, credited once | main 0.112, part 0.111 | **0.443** |
| Nutrition label (photo) | 1: Sonnet, 4096 | 0.057 | 0.057 |
| Drink identified after a photo (photo) | 1: Haiku. **Gets a NEW action id**, so it takes a SECOND photo credit | 0.023 to 0.028 | 0.028 + 1 credit |
| Variant search / describe (search) | 1: Haiku, 4096 | 0.025 | 0.025 |
| Refine / breakdown (search) | 1: Sonnet, 4096 | 0.052 | 0.052 |
| Research, no retrieval (search) | 1: Haiku, 900. A cache hit costs 0 and no credit | 0.007 | 0.007 |
| Ingredient lookup (web) | 1 call; up to 3 server-side web searches inside it | 0.178 (*) | 0.178 |
| Research with retrieve (web) | 1 call; up to 3 searches. No shipping build sends it | similar | similar |

(*) Web-search result size is an ESTIMATE in the code (20k tokens), not a
bound. Without results the floor is 0.058.

**Not double-counted.**
- Photo and label share the photo bucket.
- The searches inside an ingredient lookup are paid from the WEB bucket once;
  they are not a search-bucket credit.
- A web lookup never draws on search: research with retrieve is re-bucketed
  to web.

**Retries and failures.**
- A failed call gives its credit back but keeps its provider cost. That is the
  actual cost, or the whole reservation if the outcome is ambiguous (timeout or
  dropped connection). So failures consume the cost cap without consuming
  counts.
- Up to `MAX_CALLS_PER_ACTION` = 8 calls per action.
- The 428 DeviceCheck retry is refused before any reservation, so it costs 0.
- A user's corrected ("hinted") retry is a new action: a new credit and a new
  cost.

## Advertised allowances against the caps (upper bounds)

| Mix | Photo/label | Search | Web | Total bound | Cap |
|---|---|---|---|---|---|
| Pro, plain photos | 100 x 0.112 = 11.19 | 60 x 0.025 = 1.47 | 5 x 0.178 = 0.89 | **13.55** | 3.00 |
| Pro, all split plates | 100 x 0.443 = 44.3 | 60 x 0.052 = 3.13 | 0.89 | **48.3** | 3.00 |
| Pro, cheapest mix (labels, cached-free research) | 100 x 0.057 = 5.72 | 60 x 0.007 = 0.42 | 0.89 | **7.03** | 3.00 |
| Trial | 25 x 0.112 = 2.80 | 25 x 0.025 = 0.61 | 3 x 0.178 = 0.53 | **3.94** | 1.00 |

These are worst cases: every byte counted as a token, and full max_tokens
output. Real calls are smaller.

**Illustrative typical, ASSUMPTION ONLY, not measured:** about 4 bytes per
token for text, an image of about 2,500 tokens, and about 1,500 output tokens
per photo.
- A plain photo would then cost about $0.026.
- 100 photos, plus 60 Haiku searches at about $0.004, plus 5 lookups at about
  $0.10, is about $3.3 against a $3.00 cap.

So even typical use may reach the Pro cap before 100/60/5. Telemetry has to
confirm or refute that before any wording or setting changes.

## Is paid traffic protected from the daily ceiling today? No.

`schema-billing.sql:600-607`:
- Each tier is refused when `total + reserve > ceiling * share`, with shares of
  free 0.5, trial and sandbox 0.8, and pro 1.
- `total` is every tier's spend for the day. So once the day's total spend
  reaches the ceiling, Pro is refused (`degraded`) too.
- Paid traffic is guaranteed only the band between 80% and 100% of the
  ceiling, which Free and trial cannot enter.
- The ceiling is `base_ceiling_usd` 25 + 0.10 x paid subscribers, capped at
  `hard_max_ceiling_usd` 150 (`schema-billing.sql:180-192, 287-291`). Those
  are the defaults; the production row is not read.

To claim protection, it would have to be implemented (for example, Pro exempt
until `hard_max_ceiling_usd`, or a separate paid ledger). Tests would need to
show:
1. a Pro reserve succeeds when Free and trial have filled their shares and the
   total is at the ceiling;
2. Pro is refused only at the hard maximum;
3. Free and trial are still refused at their shares;
4. concurrent Pro reserves at the edge never exceed the hard maximum.

## Found on the way

**The alcoholic-drink path charges two photo credits for one photo.**
`EstimateFlowView` calls `AnthropicClient.drink(image:)` after
`estimate(...)` returns, outside the photo's `AIAction` scope, so it sends a
fresh actionId. The fix would be to run it inside the same action scope, or to
send `counts: false`. Not changed here.
