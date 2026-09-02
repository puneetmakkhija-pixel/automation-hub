# Automation Hub

Two self-hosted services behind the BuddyLoan call centre: **`ivr-router`** (call
routing, OBD campaigns, the voice bot and the WhatsApp flows) and
**`data-jobs`** (scheduled ETL and the cron monitor).

Deploys as **one GitHub repo → one Railway project ("Automation Hub")**. Each
service sets Railway's "Root Directory" to the folder it builds from — except
`ivr-voice-bot-system`, which must stay at the repo root. See the table below
before changing one.

## Services

Six Railway services: four built from this repo, plus two Railway-provisioned
databases. The Root Directory column is what each service is actually set to
today.

| Folder | What it's for | Railway service | Root Directory | How it starts |
| --- | --- | --- | --- | --- |
| `ivr-router` | Call routing, OBD campaigns, voice bot, WhatsApp flows, lender routing | `ivr-voice-bot-system` | *(repo root)* | root `Dockerfile`, via `railway.toml` |
| `data-jobs` | Scheduled data processing | `jobs` | `data-jobs` | Railpack, `npm start` |
| `data-jobs` | Morning cron monitor, `0 5 * * *` UTC | `morning-check` | `data-jobs` | Railpack, `npm run cron:morning` |
| `data-jobs` | Afternoon cron monitor, `30 8 * * *` UTC | `afternoon-check` | `data-jobs` | Railpack, `npm run cron:afternoon` |
| — | Cache | `redis` | — | `redis:7` image |
| — | Database | `postgresql` | — | `postgres:16` image |

Env vars for each are in that folder's `.env.example`. `redis` and `postgresql`
are provisioned from Docker images and build nothing from this repo.

### `data-jobs` carries its own build config

`data-jobs/railway.toml` sets the Railpack builder for every service rooted
there. Without it those services fall through to the repo-root `railway.toml`,
which sets `builder = "dockerfile"`; Railway resolves that against the root
directory and the build dies on a `data-jobs/Dockerfile` that does not exist.

`data-jobs/package.json` also pins `engines.node` to `>=22.0.0`.
`@supabase/supabase-js` constructs a `RealtimeClient` on `createClient()` and
needs a native WebSocket, so it cannot start on Node 20 or below.

### Leave `ivr-voice-bot-system` rooted at the repo root

It holds the live IVR configuration — every `ANANTA_*`, `OBD_*`, `ORISERVE_*`
and `SUPABASE_*` variable, plus `CONSOLE_SECRET` — and rooting it at the repo
root is what makes Railway read the root `railway.toml` and build the root
`Dockerfile`. That is the only build here that copies `ivr-router/public/`,
which `GET /console` serves via `res.sendFile('public/console.html')`
(`ivr-router/index.js`). Repointing it at `ivr-router` moves the build to
`ivr-router/Dockerfile` and drops `railway.toml` out of scope, so change it
only deliberately.

### The ORI voice bot

BuddyLoan's Oriserve tenant, the campaign it triggers and the shape of the
trigger call are in
[`ivr-router/ORI_VOICE_BOT_CAMPAIGN.md`](ivr-router/ORI_VOICE_BOT_CAMPAIGN.md).
`ORISERVE_API_KEY` is a live credential and is not in this repo — it is set on
the Railway service only.

### Four Railway services were deleted on 1 Sep 2026

`api`, `chatbot` and `whatsapp` backed the three stub folders removed below.
`ivr` was a duplicate rooted at `ivr-router` with zero environment variables —
no `SUPABASE_URL`, no `OBD_*`, no `CONSOLE_SECRET` — so it could not have been
doing the job `ivr-voice-bot-system` does. Nothing in this repo or in
`dsa-business-crm` called any of their domains, and nothing broke.

`morning-check` and `afternoon-check` were also lost that day and have been
recreated, now rooted at `data-jobs` rather than the repo root. The originals
ran `npm --prefix data-jobs run cron:*` from a repo-root build of the root
`Dockerfile`, which copies only `ivr-router/` — so the image never contained
`data-jobs` and the schedule had nothing to execute. They built green and did
nothing.

## Three services were removed on 31 Aug 2026

`backend-api`, `chatbot-api` and `whatsapp-bot` are gone. Each was a ~40-line
Express stub that answered `/health` and one placeholder route whose body was a
`TODO` — `whatsapp-bot` replied "This bot isn't wired up to real data yet." to
every message it received. None of the three had gained a line of business logic
since it was scaffolded, and the work each was a placeholder for had meanwhile
been built properly elsewhere:

- WhatsApp is `ivr-router/lib/routes/` — `ivrWhatsAppRoutes.js` (the IVR
  keypress send), `whatsappBotRoutes.js` and `whatsappFlowRoutes.js`, over the
  Ananta client, service and webhook handler — plus `lib/whatsapp/` in
  `dsa-business-crm`.
- The chatbot is `/apply` in `dsa-business-crm` (`lib/chat/`), with guardrails.
- The backend is `dsa-business-crm` itself.

The Railway services that backed them — `api`, `chatbot` and `whatsapp` — were
deleted on 1 Sep 2026, so nothing is left paying for a replica that answers
only `/health`.

## Design mockups were removed too

Twelve standalone HTML files at the repo root (~16.6k lines, of which
`dashboard-design-themes.html` alone was 11k) plus `canvas.json`. They were
theme explorations for a dashboard, served by nothing and referenced by no code.
`dashboard/index.html` is kept — it is the working dashboard the deployment
docs describe.

Anything worth recovering is in git history; nothing is lost by their absence
from the working tree.

## Wiring a *new* service into Railway (one-time)

The six services above are already wired; this is for adding another.

1. Open the service in the **Automation Hub** project on railway.com.
2. Settings → Source → connect this repo.
3. Settings → Root Directory → the folder it should build from, **or leave it
   at the repo root** if it needs the root `railway.toml`, the root
   `Dockerfile`, or files from more than one folder. If you root it at a
   subfolder, that folder needs its own `railway.toml` — otherwise the
   repo-root one applies and the build looks for a Dockerfile that is not
   there. `data-jobs/railway.toml` exists for exactly this reason.
4. Settings → Variables → the vars in that folder's `.env.example`.
5. Deploy. Railway gives it a `*.up.railway.app` URL.
