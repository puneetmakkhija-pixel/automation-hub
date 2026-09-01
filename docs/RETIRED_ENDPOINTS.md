# Retired endpoints

What came off ivr-router, when, and where the job went instead. Written so that
a 404 on a path you remember is explainable rather than alarming.

## 1 Sep 2026 — four CRUD routers

`/api/db`, `/api/ivr-campaigns`, `/api/lenders`, `/api/recordings` — 1,353 lines
across four files, plus the three dashboard tabs that were their only callers in
this repository.

These were **mounted and reachable**. This is not the unreachable code PR #32
removed; requests to two of them were served as recently as 31 Aug. They came
off because of what they were writing to, checked against the live database:

| Path | Table it used | State of that table |
| --- | --- | --- |
| `/api/db` | `customers` | 0 rows |
| | `campaigns`, `campaign_results` | **do not exist** |
| | `webhook_events` | 1 row; last written before this window |
| `/api/ivr-campaigns` | `ivr_campaigns` | 0 rows, and no other file in this repo reads it |
| | `ivr_campaign_metrics` | 0 rows |
| `/api/lenders` | `public.lenders` | 5 rows — against `crm.lenders`' 13 and `crm.lender_bre`'s 12 |
| `/api/recordings` | `ivr_recordings` | **has never existed** |

Seven days of production traffic before removal:

| Path | Requests | Result |
| --- | --- | --- |
| `/api/ivr-campaigns` | 22 | 20 × 500, then 2 × 2xx on 31 Aug |
| `/api/lenders` | 1 | 500 |
| `/api/recordings` | 0 | — |
| `/api/db/health` | 0 | — |
| `/api/db/webhooks/log` | 0 | — although `setup-railway-vars.sh` sets `SUPABASE_WEBHOOK_URL` to it |

### Where the work lives now

**Lenders — the CRM.** `crm.lenders`, `crm.lender_bre`, `crm.lender_pincode`,
`crm.lender_payout_slabs`, `crm.lender_mis`, `crm.lender_pendency` and about
fifteen more. `public.lenders` held five rows with a `webhook_url` and a loan
range; the CRM holds the policy the business actually routes on.

**Campaigns — the CRM.** `crm.campaign` and `crm.campaign_alias`, the one
campaign dimension across IVR, WhatsApp, bot and chatbot doors. Nothing needed
migrating: `ivr_campaigns` was empty.

**Customers — the CRM**, and has been for a long time. `public.customers` never
took a row.

**Recordings — nowhere, because there was nothing.** The router queried a table
that has never existed in this project, so every call it ever served failed.

### What was NOT touched

- **`lib/supabaseClient.js` stays.** Thirteen modules import it — the state
  machine, the Ananta webhook handler and the LLM clients among them. Only the
  HTTP surface at `/api/db` came off, not the client behind it.
- **`/api/router`, `/api/bre`, `/api/mis`, `/api/crm`, `/webhooks/*`** and every
  other mount are untouched. `POST /api/crm/lead-intake-sync` is still the
  endpoint that pushes a lead into the CRM.
- **The tables themselves.** Dropping them is a database change with a different
  blast radius; this removed the code that reached them. `public.lenders`' five
  rows are still there to look at.

### If you need one of these back

You almost certainly want the CRM instead — that is where the data is. If a
genuine gap turns up, `git show 18666db~1` and the commit that removed these
hold the full implementations.

## Earlier

**`/api/chatsense/voice-disposition`** (PR #29, #30) — the Chatsense integration
came out of ivr-router. The replacement is `POST /api/crm/lead-intake-sync`;
see `docs/WEBHOOK_CONFIGURATION.md`. Chatsense still places the OBD calls and
captures the DTMF disposition — only the code path through this repo went.
