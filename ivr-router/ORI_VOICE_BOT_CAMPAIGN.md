# ORI voice bot — campaign trigger

The ORI voice bot places outbound AI voice calls through Oriserve. One HTTP
call per customer: you hand Oriserve a campaign, a mobile number and whatever
metadata the bot should know, and Oriserve calls back on your webhook when the
call ends.

This page is the reference for the BuddyLoan campaign. The client that speaks
this API is `lib/oriserveVoiceClient.js`; the routes that expose it are
`lib/oriserveRoutes.js`, mounted at `/api/oriserve` in `index.js`.

## The tenant

BuddyLoan runs on its **own** Oriserve tenant:

```
https://api-buddy-loan-vox.oriserve.com/api/v1
```

Not `api-voice-agent.oriserve.com`, which is the shared host this repo used to
point at. The two hosts do not share campaigns or API keys — a key issued for
one returns 401 on the other, and a campaign ID from one is simply unknown to
the other. If calls stop going out after an environment change, check the host
before anything else.

## The campaign

| | |
| --- | --- |
| Campaign ID | `6a969a1c91b08220629d6b88` |
| Base URL | `https://api-buddy-loan-vox.oriserve.com/api/v1` |
| Trigger | `POST /campaigns/trigger` |

The ID is not a secret and lives in the repo, in `.env.example` and
`.env.railway` as `ORISERVE_CAMPAIGN_ID`. The API key is a secret and does not
— see [The API key](#the-api-key) below.

## The raw call

What the client sends, and what to paste into a terminal when you want to test
the campaign without going through the service:

```bash
curl -X POST "https://api-buddy-loan-vox.oriserve.com/api/v1/campaigns/trigger" \
  -H "X-API-Key: $ORISERVE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "campaign_id": "6a969a1c91b08220629d6b88",
    "mobile": "+91XXXXXXXXXX",
    "notification_webhook_url": "https://automation-hub-production.up.railway.app/webhooks/oriserve",
    "metadata": {
      "customer_name": "<name>",
      "account_id": "<account_id>"
    }
  }'
```

### The headers

`X-API-Key` authenticates. `Idempotency-Key` is a fresh UUID per **intended**
call — Oriserve dedupes on it, so replaying a request with the same key returns
the first result instead of dialling the customer twice. That is the point:
retry a timed-out request with the *same* key and you cannot double-dial;
generate a new one and you will. `lib/oriserveVoiceClient.js` mints one with
`crypto.randomUUID()` on every `makeRequest`, so an application-level retry
through the client is a genuine second call, not a safe replay.

### The body

- **`campaign_id`** — which script the bot runs. Required by the API; the
  client and the route fall back to `ORISERVE_CAMPAIGN_ID` when the caller
  omits it, so day-to-day BuddyLoan traffic does not have to repeat it.
- **`mobile`** — `+91XXXXXXXXXX`, twelve digits including the country code.
  `validatePhoneNumber()` strips non-digits and rejects anything that is not
  twelve digits starting `91`, so a ten-digit number from a CRM export is
  refused before it reaches Oriserve rather than silently failing to dial.
- **`notification_webhook_url`** — where Oriserve posts the outcome. Optional
  per request; omitted, the client fills in `ORISERVE_WEBHOOK_URL`.
- **`metadata`** — passed through untouched and returned on the callback. This
  is how a disposition gets back to a customer: put `account_id` (or whatever
  key the CRM joins on) in here, because the callback carries no lead ID of its
  own.

## Through the service

Same call, with the key, host and campaign coming from the environment:

```bash
curl -X POST "https://automation-hub-production.up.railway.app/api/oriserve/campaigns/trigger" \
  -H "Content-Type: application/json" \
  -d '{
    "mobile": "+91XXXXXXXXXX",
    "metadata": { "customer_name": "<name>", "account_id": "<account_id>" }
  }'
```

For a list, `POST /api/oriserve/campaigns/bulk-trigger` takes
`{ customers: [{ mobile, metadata }], delayMs }` and paces itself — 1000 ms
between calls by default. It is a sequential loop, not a queue, so a 500-row
batch holds the request open for about eight minutes; run it from a job rather
than a browser.

## Environment variables

On the `ivr-voice-bot-system` service:

```bash
ORISERVE_API_KEY=vx_...                                              # secret, Railway only
ORISERVE_BASE_URL=https://api-buddy-loan-vox.oriserve.com/api/v1
ORISERVE_CAMPAIGN_ID=6a969a1c91b08220629d6b88
ORISERVE_WEBHOOK_URL=https://automation-hub-production.up.railway.app/webhooks/oriserve
```

`ORISERVE_BASE_URL` is also the client's compiled-in default, so a service that
loses the variable still reaches the right tenant. `ORISERVE_API_KEY` has no
default: without it `OriserveVoiceClient` throws in its constructor,
`lib/oriserveRoutes.js` catches that at import time and leaves `oriserveClient`
undefined, and every route answers `503` with
`Oriserve client not initialized`. That message means the key is missing, not
that Oriserve is down.

## The API key

The key is **not** committed. Set it on Railway and nowhere else:

```bash
railway variables set ORISERVE_API_KEY "vx_..."
```

`setup-railway-vars.sh` reads it from your shell rather than carrying a copy:

```bash
ORISERVE_API_KEY=vx_... ./setup-railway-vars.sh
```

Run without it, the script sets everything else and skips the key with a note.

An earlier key, `vx_iJvvN0WW…`, was committed to this repo in `.env.railway`
and `setup-railway-vars.sh` and is in the git history. It should be treated as
compromised and rotated at Oriserve, whether or not it is still the live key.

## Checking it worked

The trigger response is only Oriserve's acceptance of the request. The outcome
arrives later on `POST /webhooks/oriserve`, handled in `index.js` — carrying
`campaign_id`, `mobile`, `status`, `call_duration`, `result` and the `metadata`
you sent. Watch the service log for the `ORISERVE_CALLBACK` line.

That handler currently only logs. It does not write the disposition to Supabase
and does not forward `metadata`, so nothing joins the call outcome back to the
lead yet — that wiring is still to be built. `lib/oriserveRoutes.js` carries a
second copy of the same handler at `/api/oriserve/webhooks/oriserve`; the
webhook URL configured above hits the `index.js` one, so that is the copy to
change.

A quick liveness check on the credentials:

```bash
curl -s https://automation-hub-production.up.railway.app/api/oriserve/health
```

`{"success": false, ... "Missing ORISERVE_API_KEY"}` is a configuration
problem; anything else is a real answer from the tenant.
