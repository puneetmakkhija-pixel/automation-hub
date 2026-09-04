# Automation Hub

Two self-hosted services behind the BuddyLoan call centre: **`ivr-router`** (call
routing, OBD campaigns, the voice bot and the WhatsApp flows) and
**`data-jobs`** (scheduled ETL).

Deploys as **one GitHub repo → one Railway project ("Automation Hub")**. Each
service sets Railway's "Root Directory" to the folder it builds from — except
`ivr-voice-bot-system`, which must stay at the repo root. See the table below
before changing one.

## Services

Four Railway services: two built from this repo, plus two Railway-provisioned
databases. The Root Directory column is what each service is actually set to
today.

| Folder | What it's for | Railway service | Root Directory | How it starts |
| --- | --- | --- | --- | --- |
| `ivr-router` | Call routing, OBD campaigns, voice bot, WhatsApp flows, lender routing | `ivr-voice-bot-system` | *(repo root)* | root `Dockerfile`, via `railway.toml` |
| `data-jobs` | Scheduled data processing | `jobs` | `data-jobs` | Railpack, `npm start` |
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

### Personal-loan press-1 leads are enriched, not just logged

A Poonawalla or Hero Fincorp press-1 hands the customer straight to that
lender's own journey, so the lead never enters the CRM and
`public.whatsapp_messages` is the only record that the call happened. That row
is a mobile number and a campaign name — no name, no bureau, no GST, no
pincode — which is not enough to decide which of a day's ~6,000 presses is
worth a callback.

`data-jobs/enrich-press1-leads.js` walks each IST day through
`public.pl_press1_enrich()`, which joins those mobiles to `se_base` (reached
from this project as the foreign table `fed.se_base`) and lands the result in
`public.pl_press1_enriched` — one row per press, carrying a snapshot of bureau,
GST, banking, pincode and score. `npm run enrich:press1:cron` does the last two
days and is safe to re-run; the schema and the reasons for its shape are in
[`ivr-router/migrations/005_pl_press1_enrichment.sql`](ivr-router/migrations/005_pl_press1_enrichment.sql).

Backfilled 01-04 Sep 2026: 15,714 presses, 6,130 matched in `se_base` (39%).
The unmatched are real — the personal-loan dialling lists are not drawn from
`se_base` — so the per-day match rate is the number to watch. It is reported
per day rather than per run for that reason.

### Which of those leads could carry a business loan

`ivr-router/migrations/006_pl_press1_business_loan_targeting.sql` goes a step
further than the enrichment: `public.pl_press1_sme` snapshots
`sme_user_master` for the same mobiles (banking turnover, average bank balance,
GST turnover slab and business-loan tradelines — none of which `se_base` holds),
`public.pl_press1_bl_candidate` scores every GST-active lead against all 14
lender BREs read live from `fed.se_lender_bre`, and
`public.pl_press1_bl_target` is the callable list. `pl_press1_sme_refresh()`
rebuilds the snapshot in ~10s and matches 7,301 of 13,434 press-1 mobiles,
against `se_base`'s 5,174.

Two things in that file are load-bearing and easy to undo by accident.
`writeoff_settled = 99` and `max_dpd = 180` are **sentinels in the source, not
measurements** — read literally they fail every lender with a write-off or DPD
cap — so they are nulled and surfaced as `wo_sentinel` / `dpd_sentinel`. And a
threshold whose input is missing leaves a lead *provisional* for that lender
rather than passed or failed, because a NULL ABB means "no banking held", never
"a low balance".

`pl_press1_bl_target` is a **floor**. Of the 2,616 self-employed press-1 users
above bureau 730, only 426 fail its four tests; 1,824 hold no data on any of
them. Coverage across all 13,434 users is ABB and banking turnover 6%,
tradelines 4%, GST slab 2% — so a count read off that view is roughly a third
of the real pool, and collecting the missing inputs is worth more than working
the list harder.

Part A of that migration is one `GRANT` that runs in the **Database** project,
not in smecircle; the file says so and leaves it commented for that reason.

### Which lender a press belongs to is read off the link

`public.pl_press_lender()` and `lenderOfLink()` in
`ivr-router/lib/plTracker.js` are the same rule in two places and must change
together. The link is what the customer actually opened; `metadata->>'variant'`
is only the slug the IVR panel was pointed at, and the two have already
disagreed in live data.

Poonawalla is also reached through the Whistleloop affiliate shortener, whose
links carry no lender domain at all. Before `offerid=1351` was mapped, 3,740
presses on 3-4 Sep 2026 counted as `unknown`: 4 Sep read as ~952 Poonawalla
presses against an actual ~4,568. A **new** offer id will read as `unknown`
rather than be guessed at — matching on the `PFL_%` campaign name instead was
rejected because that name is typed by hand in the panel.

### Four Railway services were deleted on 1 Sep 2026

`api`, `chatbot` and `whatsapp` backed the three stub folders removed below.
`ivr` was a duplicate rooted at `ivr-router` with zero environment variables —
no `SUPABASE_URL`, no `OBD_*`, no `CONSOLE_SECRET` — so it could not have been
doing the job `ivr-voice-bot-system` does. Nothing in this repo or in
`dsa-business-crm` called any of their domains, and nothing broke.

### The twice-daily cron monitor was retired on 2 Sep 2026

`morning-check` and `afternoon-check` are gone, along with `status-monitor.js`,
`setup-monitoring.js` and their config.

Nothing ever wrote to the tables the monitor read. `setup-monitoring.js` seeded
one placeholder row per job in `public.cron_job_status`; no production code
path in this repo or in `dsa-business-crm` ever recorded a run against it. The
eleven monitored jobs were therefore reported `NEVER_RUN` for as long as the
monitor existed, which was accurate — it was reporting that nothing reported to
it. `cron_job_executions` and `cron_status_reports` never held a single row.

Enrichment already logs to `crm.enrich_run_log`, which is live, and
`crm.rpt_api_error_daily` and `crm.rpt_api_error_recent` already read it. That
is the surviving monitoring surface.

`data-jobs/migrations/002_drop_cron_monitoring_tables.sql` drops the three
tables. It is **not applied** — run it once the two services are gone.

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

## Tests

Both folders carry check files — 13 in `ivr-router`, one in `data-jobs`, ~150
assertions between them. Plain node, no credentials and no network; each exits
non-zero on failure.

```
cd ivr-router && npm ci && for f in test-*.mjs; do node "$f"; done
cd data-jobs  && npm ci && npm test
```

`.github/workflows/tests.yml` runs exactly that on every push and pull request,
one matrix job per folder. It **globs** `test-*.mjs` rather than reading
`package.json` scripts — three of `ivr-router`'s check files were never wired
into a script, so a hand-maintained list would have been missing them from the
start. A new check file is picked up by existing there.

It does not cover the SQL. `ivr-router/migrations/*.sql` are applied by hand
against Supabase, and `005` reads `fed.se_base` — a foreign table pointing at
another project — so a throwaway Postgres in CI could not run it without
standing up both sides. A green tick means the JavaScript is sound, not the
migration.

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
