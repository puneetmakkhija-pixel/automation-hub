# Automation Hub

Two self-hosted services behind the BuddyLoan call centre: **`ivr-router`** (call
routing, OBD campaigns, the voice bot and the WhatsApp flows) and
**`data-jobs`** (scheduled ETL).

Deploys as **one GitHub repo → one Railway project ("Automation Hub")**. Each
service sets Railway's "Root Directory" to the folder it builds from — except
`ivr-voice-bot-system`, which must stay at the repo root. See the table below
before changing one.

## Services

Five Railway services: three built from this repo, plus two Railway-provisioned
databases. The Root Directory column is what each service is actually set to
today; times are UTC, because that is what Railway's cron field takes.

| Folder | What it's for | Railway service | Root Directory | How it starts |
| --- | --- | --- | --- | --- |
| `ivr-router` | Call routing, OBD campaigns, voice bot, WhatsApp flows, lender routing | `ivr-voice-bot-system` | *(repo root)* | root `Dockerfile`, via `railway.toml` |
| `data-jobs` | Press-1 lead enrichment | `jobs` | `data-jobs` | Railpack, `npm run enrich:press1:cron`, cron `30 22 * * *` |
| `data-jobs` | Lender serviceable-pincode sync | `pincode-sync` | `data-jobs` | Railpack, `npm run sync:pincodes:cron`, cron `30 21 * * *` |
| `data-jobs` | Hero disbursal report ingest | `hero-disbursal` | `data-jobs` | Railpack, `npm run ingest:hero-disbursal:cron`, cron `0 22 * * *` |
| — | Cache | `redis` | — | `redis:7` image |
| — | Database | `postgresql` | — | `postgres:16` image |

All three crons have restart policy NEVER: a scheduled run that fails should wait
for its next slot, not spin. 22:30 UTC is 04:00 IST, an hour behind the pincode sync
so the two never contend, and after both the day's dialling and se_base's
overnight rescoring. The Hero disbursal ingest runs at 22:00 UTC, half an hour
ahead of it, so the day's outcomes are in before enrichment reads them; its
four-day mailbox window means the exact hour is not load-bearing. The enrichment
job asks for `--days 2` rather than today alone, since presses land through the
evening and yesterday is still moving when today starts.

`npm start` still runs `data-jobs/run.js`, which reports which Supabase project
the service's credentials actually reach and exits. It is no longer any service's
start command — run it by hand when a job behaves as though its tables are
missing, which is what PGRST205 looks like from the wrong project.

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

### And what the lender did with them

`ivr-router/migrations/007_pl_press1_mis_outcome.sql` adds
`public.pl_press1_mis_outcome`: every press-1 lead joined to whatever Hero's and
Poonawalla's MIS say happened to it — applied, logged in, sanctioned, disbursed,
or a rejection reason — one row per press, showing the furthest stage reached.

It is a **view, not columns on `pl_press1_enriched`**. The MIS advances daily on
the lenders' schedule, independently of `pl_press1_enrich()`, so columns filled
at enrichment time would report "not sanctioned" for someone sanctioned that
morning and keep saying it until the next nightly run. The join costs ~600ms
across the whole book, so freezing it buys nothing.

**`mis_matched = false` does not mean "did not convert."** Coverage is badly
asymmetric: Hero echoes our `customer_id`, so all 1,711 of its MIS rows resolve;
Poonawalla's alias survives only in `UTM_Partner_AgentCode` shaped
`4773_alias_<7 chars>_`, and only for publisher 4773 — 60 rows out of 6,424. The
other publishers in that feed (4636 with 1,695 distinct tokens, plus 1309, 4154,
681) carry 10-character mixed-case tokens matching neither our codec nor any
alias in `crm.v_alias_sent`, under campaign names like `BDL_HeroCL_LBD_Aug1` that
make them look like ours. They are another affiliate's scheme, and matching on
them would attach other partners' applications to our leads.

So any conversion rate read off this view is a floor, and for Poonawalla a floor
roughly a hundred times below the truth. The durable fix is Poonawalla echoing
`client_reference_id` the way Hero already does; until then `mis_same_lender`
is worth watching, because 30 presses currently surface in the *other* lender's
book.

### Hero's disbursal report is the other half of Hero's MIS

The Hero MIS we ingest (`crm.pl_lender_mis`, lender `herofincorp`) is an
**application** feed: all 2,464 rows it has ever sent carry a NULL sanction and
a NULL disbursal. It has identity and no outcome — Hero echoes our
`customer_id`, so `crm.v_pl_mis` decodes 100% of it to a mobile.

Hero's daily disbursal report is the mirror image: sanction and disbursal
amounts, and no mobile, no PAN, no name. Its `App ID` is the same identifier
space as `pl_lender_mis.lan_id`, which is the only thing joining the two.

So `pl_press1_mis_outcome` reporting every Hero lead as unconverted was never a
fact about the customers — it was a column the feed does not contain.

`data-jobs/ingest-hero-disbursal.js` loads that report into
`crm.mis_hero_disbursal` (migration 008), and the outcome view joins the halves
on `lan_id`. It is a separate table rather than a merge into `pl_lender_mis`,
which the CRM's own MIS pipeline writes: two writers on one row is how one of
them silently loses.

```
npm --prefix data-jobs run ingest:hero-disbursal -- --dry-run report.xlsx
npm --prefix data-jobs run ingest:hero-disbursal -- report.xlsx
npm --prefix data-jobs run ingest:hero-disbursal:cron          # fetches the mail itself
```

Dates in that file are **DD-MM-YYYY**, which `Date.parse` reads as MM-DD-YYYY:
silently wrong for every day below the 13th and rejected above it. They are
parsed by hand for that reason and `test-hero-disbursal.mjs` pins it, because
the failure looks like plausible data in the wrong month for about 40% of rows.

The join is proven but barely exercised: of the first file's 58 applications,
3 exist in the Hero MIS window and 1 carries a real disbursal. The other 54 are
older than anything the MIS holds — the two feeds are cut from different date
ranges, so the fix is asking Hero to widen the MIS window or to put sanction and
disbursal fields in the main feed.

#### It fetches its own mail, on its own cron

Hero sends **two** daily emails from two different people:

| Email | From | Carries | Ingested by |
| --- | --- | --- | --- |
| `Daily Pulse - Buddy Loan` | `digital.marketing@herofincorp.com` | applications, identity (`cuid`) | the CRM's mail watcher, into `crm.pl_lender_mis` |
| `Buddy Loan Disbursement Report` | `sandeep.pant@herofincorp.com` | sanction and disbursal amounts | `ingest:hero-disbursal:cron` here, into `crm.mis_hero_disbursal` |

`npm run ingest:hero-disbursal:cron` runs `--from-email`: it opens the MIS
mailbox over IMAP, takes the newest message from that sender whose subject
matches, parses the attachment **in memory**, and upserts on `lan_id`. A day with
no report logs `found: false` and exits 0 — Hero does not send on Sundays, and a
weekend should not page anyone.

The IMAP connection is opened **read-only**. The CRM's watcher reads the same
mailbox and marks what it has ingested `\Seen`; a second reader able to set flags
could mark a report seen before that watcher had processed it, and the report
would look handled while nothing had been written.

#### Why not just add a sender to the CRM's mail watcher

That was the plan, and it is wrong. `crm.upsert_pl_mis` coalesces every scalar
column — it fills nulls and never clobbers — but it **replaces `raw` wholesale**:

```sql
raw = coalesce(excluded.raw, t.raw),   -- replaced, not merged
```

`raw` is where Hero's application feed keeps the customer. `crm.v_pl_lead`
resolves the mobile from `raw->>'cuid'`, and the disbursal report has no `cuid`
column. Routing it through that RPC would blank the mobile on every LAN the two
feeds share — silently, and on a growing share of the book as the overlap grows.

The adapter shape is also lossy: `NormalizedLead` has no field for `decile`,
`appsflyerid`, `Campaign Id`, the `Utm_*`, `CPV Action`, `Sanction Rate` or the
city, so campaign-level attribution would survive only inside the `raw` this
report must not write.

So the report keeps its own parser and its own table, and
`pl_press1_mis_outcome` joins the two halves on `lan_id`.

#### What it needs to run

| Variable | Why |
| --- | --- |
| `MIS_IMAP_USER` / `MIS_IMAP_APP_PASSWORD` | the MIS mailbox, Gmail app password |
| `GMAIL_IMAP_USER` / `GMAIL_IMAP_APP_PASSWORD` | fallback names for the same pair |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | already set on every `data-jobs` service |

Without the IMAP pair the job exits non-zero naming both variables, rather than
reporting an empty mailbox.

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
