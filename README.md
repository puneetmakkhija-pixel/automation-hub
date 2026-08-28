# Automation Hub

Monorepo for the 5 self-hosted services from the MCP Cooldown Runbook:
`ivr-router`, `whatsapp-bot`, `chatbot-api`, `data-jobs`, `backend-api`.

This deploys as **one GitHub repo → one Railway project ("Automation Hub") → 5 services**,
each pointed at a different subfolder via Railway's "Root Directory" setting.
Your CRM (`Business loans CRM`, `easygoing-analysis`) and Samay projects
(`Samay Phase 1`, `humble-courtesy`) are untouched — this is new, separate infra.

## What's real vs stubbed

Every service below boots, responds to a health check, and has the correct
webhook/route shape for its job — but the actual business logic (what the IVR
says, what the WhatsApp bot replies, what the chatbot knows, what the data job
processes) is marked `TODO` and needs your input. Nothing here talks to a real
phone number, WhatsApp number, or database until you add credentials.

## Wiring each service into Railway (one-time, per service)

Once this repo is pushed to GitHub and connected to Railway:

1. Open each service in the **Automation Hub** project on railway.com.
2. Settings → Source → connect this repo.
3. Settings → Root Directory → set to the matching folder (e.g. `ivr-router`).
4. Settings → Variables → add the env vars listed in that service's `.env.example`.
5. Deploy. Railway gives it a `*.up.railway.app` URL — that's the webhook/API URL.

## Found while setting this up

You have **two CRM codebases each deployed twice**, in separate Railway
projects — worth a look when you have a minute (not touched here):

- `businessoans/dsa-business-crm` → running in both `Business loans CRM` and
  `easygoing-analysis`
- `puneetmakkhija-pixel/crm-backend` → running in both `happy-truth` and
  `ravishing-delight`

If those are stale test copies, cancelling the duplicates saves a subscription
+ usage cost for each one you drop.

## Services

| Service | What it's for | Needs before it's real |
| --- | --- | --- |
| `ivr-router` | Call routing / keypress menus in front of a voice agent | Twilio phone number + webhook config, ElevenLabs Agent ID, the actual menu script |
| `whatsapp-bot` | DSA updates, payment reminders, horoscope pushes | Twilio WhatsApp-enabled number + credentials, message templates |
| `chatbot-api` | Web widget chatbot for BuddyLoan/Samay sites | Anthropic API key, what it should actually know/answer |
| `data-jobs` | Scheduled data processing (ETL, reports) | Supabase project URL + service key, the actual job logic |
| `backend-api` | General BuddyLoan/Samay backend endpoints | Whatever the frontend/app actually needs to call |
