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
    "notification_webhook_url": "https://ivr-voice-bot-system-production.up.railway.app/webhooks/oriserve",
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
curl -X POST "https://ivr-voice-bot-system-production.up.railway.app/api/oriserve/campaigns/trigger" \
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
ORISERVE_WEBHOOK_URL=https://ivr-voice-bot-system-production.up.railway.app/webhooks/oriserve
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
railway variables --set "ORISERVE_API_KEY=vx_..."
```

`setup-railway-vars.sh` reads it from your shell rather than carrying a copy:

```bash
ORISERVE_API_KEY=vx_... ./setup-railway-vars.sh
```

Run without it, the script sets everything else and skips the key with a note.

An earlier key, `vx_iJvvN0WW…`, was committed to this repo in `.env.railway`
and `setup-railway-vars.sh` and is in the git history. It should be treated as
compromised and rotated at Oriserve, whether or not it is still the live key.

## The service domain

Callback and API URLs here use:

```
https://ivr-voice-bot-system-production.up.railway.app
```

That is the Railway service domain for `ivr-voice-bot-system`, pointed at port
8080, which is the port the service logs on startup.

**Not `automation-hub-production.up.railway.app`.** That host is the project's
name, not a domain that exists — nothing serves it, and Railway's edge answers
every request to it with `{"status":"error","code":404,"message":"Application
not found"}` and a `request_id`. That 404 shape is the edge, not this service:
a 404 from the service itself would not carry a `request_id`. Every webhook URL
in this repo pointed at it until Sep 2026, so a callback configured from an
older copy of these files never arrived.

## The verification probe

Provider panels commonly `GET` a webhook URL before they will save it. This one
answered `404` to that until Sep 2026 — four such probes arrived on 2 Sep from
AWS addresses — and a `404` reads to a panel as "there is nothing here", which
can stop the URL being accepted at all.

`GET /webhooks/oriserve` now answers `200`:

```json
{ "success": true, "service": "oriserve_voice_callback",
  "message": "Endpoint is live. Send call outcomes as POST with Content-Type: application/json." }
```

`?challenge=` or `?hub.challenge=` is echoed back as plain text, which is the
convention most panels use to confirm they reached the right endpoint. The echo
is capped at 256 characters of `[\w.-]` and ignored otherwise, so it cannot
reflect arbitrary content.

The `GET` is deliberately unauthenticated. It accepts nothing, writes nothing,
and discloses nothing a caller did not already know by holding the URL — and a
panel that probes *before* saving has not been given the token yet, so requiring
it would defeat the purpose. `POST`, the only method that carries data, keeps
its shared secret.

## Securing the callback

`/webhooks/oriserve` runs `verifyWebhookSecret("ORISERVE_WEBHOOK_SECRET",
"ORISERVE")`. Oriserve does not sign its callbacks, so this is a shared secret,
accepted three ways — a header, a bearer token, or `?token=` on the URL for a
panel that offers only a URL field:

```
https://ivr-voice-bot-system-production.up.railway.app/webhooks/oriserve?token=<secret>
```

**The check fails open while `ORISERVE_WEBHOOK_SECRET` is unset**, which sets
the order you have to do this in:

1. Deploy. The webhook keeps accepting every caller; the service logs
   `[ORISERVE] ORISERVE_WEBHOOK_SECRET is not set — webhook is UNAUTHENTICATED`
   once per process.
2. Configure the secret at Oriserve, on the notification webhook URL.
3. Only then `railway variables --set "ORISERVE_WEBHOOK_SECRET=..."`.

Setting the variable before step 2 rejects genuine callbacks with `401` and
loses the outcomes, because a callback is not replayable. The fail-open default
exists for exactly this window; it is not an invitation to leave it unset.

Rejections log `[ORISERVE] Rejected request: missing secret` or `bad secret`
with the caller's IP.

## Checking it worked

The trigger response is only Oriserve's acceptance of the request. The outcome
arrives later on `POST /webhooks/oriserve`, handled in `index.js` — carrying
`campaign_id`, `mobile`, `status`, `call_duration`, `result` and the `metadata`
you sent. Watch the service log for the `ORISERVE_CALLBACK` line.

### Where the outcome is stored

The handler writes two rows through `db.logVoiceCallOutcome()`
(`lib/supabaseClient.js`), because they answer different questions:

| Table | What it holds | Why |
| --- | --- | --- |
| `public.webhook_events` | `source='oriserve_voice'`, `event`=the status, `ext_ref`=the mobile, `payload`=the whole callback | `ext_ref` is what joins an outcome back to a lead — the callback carries no lead ID of its own. Same shape the existing `onclickx_ivr` rows use. |
| `crm.voice_call_events` | `provider='oriserve'`, `call_id`, `event_status`, `duration_sec`, `raw` | The typed row reporting reads, with `provider` set so Oriserve and Deepcall sit side by side. |

`metadata` survives whole in both (`payload` and `raw`), so whatever you put in
it at trigger time — `account_id` especially — is what you join on later:

```sql
SELECT received_at,
       ext_ref                        AS mobile,
       event                          AS status,
       payload->>'result'             AS result,
       payload->'metadata'->>'account_id' AS account_id
  FROM public.webhook_events
 WHERE source = 'oriserve_voice'
 ORDER BY received_at DESC
 LIMIT 20;
```

**A storage failure never fails the request.** The call already happened and
Oriserve cannot usefully replay the callback, so a 500 would only buy a retry
that helps nobody. The route answers `200` either way and reports what landed:

```json
"saved": { "webhook_events": true, "voice_call_events": true }
```

When either insert fails the response carries an `errors` array and the service
logs `ORISERVE_CALLBACK_NOT_SAVED` — grep that context to find outcomes that
were received but not persisted. `saved` reading `false` for both with a
`supabase client not configured` error means `SUPABASE_URL` or
`SUPABASE_SERVICE_ROLE_KEY` is missing on the service.

Both target tables are in the `smecircle` project, and `crm` is exposed through
PostgREST — hence `.schema('crm')` rather than a `crm.`-prefixed table name,
which PostgREST reads as a literal table called `crm.voice_call_events` in
`public` and does not find.

`lib/oriserveRoutes.js` carries a second, log-only copy of the handler at
`/api/oriserve/webhooks/oriserve`. The webhook URL configured above hits the
`index.js` one, so that is the copy that persists.

A quick liveness check on the credentials. `/api/oriserve` is behind
`CONSOLE_SECRET` — the whole router, because `/campaigns/trigger` and
`/campaigns/bulk-trigger` place calls that cost money and `/campaigns/:id/cancel`
stops a live one — so the check carries the token:

```bash
curl -s "https://ivr-voice-bot-system-production.up.railway.app/api/oriserve/health?token=$CONSOLE_SECRET"
```

Without it the answer is `401`, and `503` means `CONSOLE_SECRET` is unset on the
service. Railway's own container check uses the top-level `/health`, which is
open and unaffected.

`{"success": false, ... "Missing ORISERVE_API_KEY"}` is a configuration
problem; anything else is a real answer from the tenant.
