# Automation Hub

Two self-hosted services behind the BuddyLoan call centre: **`ivr-router`** (call
routing, OBD campaigns, the voice bot and the WhatsApp/ChatSense journeys) and
**`data-jobs`** (scheduled ETL and the cron monitor).

Deploys as **one GitHub repo → one Railway project ("Automation Hub")**, each
service pointed at its subfolder via Railway's "Root Directory" setting.

## Services

| Service | What it's for | Railway service | Root Directory |
| --- | --- | --- | --- |
| `ivr-router` | Call routing, OBD campaigns, voice bot, WhatsApp/ChatSense journeys, lender routing | `ivr-voice-bot-system`, `ivr` | `ivr-router` |
| `data-jobs` | Scheduled data processing and the twice-daily cron monitor | `jobs`, `morning-check`, `afternoon-check` | `data-jobs` |

Env vars for each are in that folder's `.env.example`.

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

## Wiring a service into Railway (one-time)

1. Open the service in the **Automation Hub** project on railway.com.
2. Settings → Source → connect this repo.
3. Settings → Root Directory → the matching folder above.
4. Settings → Variables → the vars in that folder's `.env.example`.
5. Deploy. Railway gives it a `*.up.railway.app` URL.
