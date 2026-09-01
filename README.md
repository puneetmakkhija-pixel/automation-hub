# Automation Hub

Two self-hosted services behind the BuddyLoan call centre: **`ivr-router`** (call
routing, OBD campaigns, the voice bot and the WhatsApp/ChatSense journeys) and
**`data-jobs`** (scheduled ETL and the cron monitor).

Deploys as **one GitHub repo → one Railway project ("Automation Hub")**. Each
service sets Railway's "Root Directory" to the folder it builds from — or
leaves it at the repo root, which three of the five do. See the table below
before changing one.

## Services

Two folders, five Railway services. The Root Directory column is what each
service is actually set to today — it is not uniform, and three of them
deliberately build from the repo root rather than from a subfolder.

| Folder | What it's for | Railway service | Root Directory | How it starts |
| --- | --- | --- | --- | --- |
| `ivr-router` | Call routing, OBD campaigns, voice bot, WhatsApp/ChatSense journeys, lender routing | `ivr-voice-bot-system` | *(repo root)* | root `Dockerfile`, via `railway.toml` |
| `data-jobs` | Scheduled data processing | `jobs` | `data-jobs` | Railpack |
| `data-jobs` | Twice-daily cron monitor | `morning-check` (`0 5 * * *` UTC), `afternoon-check` (`30 8 * * *` UTC) | *(repo root)* | `npm --prefix data-jobs run cron:morning` / `cron:afternoon` |

Env vars for each are in that folder's `.env.example`.

### Leave `ivr-voice-bot-system` rooted at the repo root

It holds the live IVR configuration — every `ANANTA_*`, `OBD_*`, `ORISERVE_*`
and `SUPABASE_*` variable, plus `CONSOLE_SECRET` — and rooting it at the repo
root is what makes Railway read the root `railway.toml` and build the root
`Dockerfile`. That is the only build here that copies `ivr-router/public/`,
which `GET /console` serves via `res.sendFile('public/console.html')`
(`ivr-router/index.js`). Repointing it at `ivr-router` moves the build to
`ivr-router/Dockerfile` and drops `railway.toml` out of scope, so change it
only deliberately.

`morning-check` and `afternoon-check` are rooted at the repo root for the same
kind of reason: they reach into the folder with `npm --prefix data-jobs`
instead.

### The `ivr` service has no variables set

There is a fifth service, `ivr` (`ivr-production-38c0.up.railway.app`), rooted
at `ivr-router` with **zero environment variables** — no `SUPABASE_URL`, no
`OBD_*`, no `CONSOLE_SECRET`. It cannot be doing the job
`ivr-voice-bot-system` is doing. Worth confirming it is a leftover and
deleting it along with the three below.

## Three services were removed on 31 Aug 2026

`backend-api`, `chatbot-api` and `whatsapp-bot` are gone. Each was a ~40-line
Express stub that answered `/health` and one placeholder route whose body was a
`TODO` — `whatsapp-bot` replied "This bot isn't wired up to real data yet." to
every message it received. None of the three had gained a line of business logic
since it was scaffolded, and the work each was a placeholder for had meanwhile
been built properly elsewhere:

- WhatsApp is `ivr-router/lib/journeys/` plus `lib/whatsapp/` in
  `dsa-business-crm` — Ananta and ChatSense, templates, the bot engine, tested.
- The chatbot is `/apply` in `dsa-business-crm` (`lib/chat/`), with guardrails.
- The backend is `dsa-business-crm` itself.

**They still have Railway services pointing at the deleted folders**, each with a
replica running and a public domain:

| Railway service | Domain | Was rooted at |
| --- | --- | --- |
| `api` | `api-production-c082.up.railway.app` | `backend-api` |
| `chatbot` | `chatbot-production-6845.up.railway.app` | `chatbot-api` |
| `whatsapp` | `whatsapp-production-44e7.up.railway.app` | `whatsapp-bot` |

Nothing in this repo or in `dsa-business-crm` calls any of those three domains.
Their current containers keep serving until something triggers a redeploy, at
which point the build fails on the missing folder. **Delete the three Railway
services** — that is the point of removing the folders, and until it happens
they are three replicas being paid for to answer `/health`.

## Design mockups were removed too

Twelve standalone HTML files at the repo root (~16.6k lines, of which
`dashboard-design-themes.html` alone was 11k) plus `canvas.json`. They were
theme explorations for a dashboard, served by nothing and referenced by no code.
`dashboard/index.html` is kept — it is the working dashboard the deployment
docs describe.

Anything worth recovering is in git history; nothing is lost by their absence
from the working tree.

## Wiring a *new* service into Railway (one-time)

The five services above are already wired; this is for adding another.

1. Open the service in the **Automation Hub** project on railway.com.
2. Settings → Source → connect this repo.
3. Settings → Root Directory → the folder it should build from, **or leave it
   at the repo root** if it needs `railway.toml`, the root `Dockerfile`, or
   files from more than one folder. Check the table above before assuming a
   subfolder is right — three of the five existing services build from the
   repo root.
4. Settings → Variables → the vars in that folder's `.env.example`.
5. Deploy. Railway gives it a `*.up.railway.app` URL.
