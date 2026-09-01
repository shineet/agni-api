# agni-api

Authenticated proxy so people can try [Agni](https://github.com/shineet/agni) without
creating an Anthropic account first.

## What it is

Two serverless functions, no npm dependencies.

- `POST /api/estimate` — takes the exact Anthropic request body the app would have sent,
  checks the caller's quota, adds the API key, forwards it, and counts the estimate.
- `GET /api/quota?installId=…` — how many free estimates are left.

The app sends the whole request body on purpose. The system prompt and the response
schema live only in the app, so changing the prompt is an app change and there is no
server-side copy to drift out of step with it.

Because the body is supplied by the client it is also untrusted, so `_lib.js` restricts
which models will be paid for and caps `max_tokens`.

## How the app decides

- **A personal Anthropic key is set in Settings** → the app calls Anthropic directly and
  never touches this service.
- **No personal key** → the app calls here, with a free allowance per install.

So a tester installs and it just works. When the allowance runs out, Settings asks for
their own key, and from then on their usage is theirs. Photo estimation is the only thing
that stops: the dish table, manual logging, Health writing, Activity and the watch app all
keep working with no API at all.

## Identity

An install id is a UUID the app generates on first launch and keeps in its Keychain. It
identifies a phone, not a person. No account, no email, nothing traceable to anyone.

## Environment variables

| Name | What |
|---|---|
| `ANTHROPIC_API_KEY` | The key that pays for trial usage |
| `APP_TOKEN` | Shared secret the app sends as `Authorization: Bearer …` |
| `SUPABASE_URL` | The Agni Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (`sb_secret_…`), or a legacy service_role key. Server side only, never in the app. |
| `FREE_ESTIMATE_LIMIT` | Optional, defaults to 50 |

`APP_TOKEN` ships inside the app binary and is therefore extractable by anyone determined.
The per-install quota is the real defence, not the token. Rotate it if it is ever abused.

## Setup

1. Create a Supabase project for Agni, separate from the other apps.
2. Run `schema.sql` in its SQL editor.
3. Deploy this repo to Vercel and set the environment variables above. For the key,
   use Settings -> API Keys -> **Secret keys -> default**, not the publishable one.
4. Put the deployment URL and `APP_TOKEN` into the app's `BackendConfig.swift`.

## Managing testers

```sql
-- see who is using it
select install_id, estimates_used, unlimited, note, last_seen
from agni_installs order by last_seen desc;

-- unlimited, for your own phone or your wife's
update agni_installs set unlimited = true, note = 'Shine' where install_id = '…';

-- cut someone off
update agni_installs set unlimited = false, estimates_used = 999999 where install_id = '…';
```
