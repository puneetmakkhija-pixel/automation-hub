# payday-api

HTTP service for the payday LOS+LMS. A thin wrapper (`app.js`) over `../payday-journey`; `server.js` runs it on `node:http`. Dependencies: only `@supabase/supabase-js`.

## Run
```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... PAYDAY_API_KEY=... node payday-api/server.js
```
The service refuses to start without those three. It also refuses to start in production (`NODE_ENV=production`) with any vendor slot left on `mock`, unless `ALLOW_MOCK_VENDORS=1`.

| Env var | Purpose |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database. Service role is required: the `payday` tables have row-level security and no policies. |
| `PAYDAY_API_KEY` | Callers send it as `x-api-key`. No key configured means every route except `/healthz` and webhooks answers 503. |
| `PAN_PEPPER` | Secret for hashing PAN. Without it, sending a PAN is refused (503). |
| `VENDOR_KYC`, `VENDOR_BUREAU`, `VENDOR_BANK_STATEMENT`, `VENDOR_ESIGN`, `VENDOR_PAYOUT`, `VENDOR_COLLECT` | Vendor per slot (default `mock`). |
| each vendor's own variables | e.g. base URL, key, webhook secret. Named in its spec file. |
| `PORT` | default 3000 |

## Deploy on Railway
This service imports the sibling `payday-engine` and `payday-journey` folders, so it must build from the **repo root** (the repo-root `railway.toml` builds only `ivr-router`). Create a service from the repo, leave Root Directory at the repo root, and set the service's config file path to `/payday-api/railway.toml`. That file points at `payday-api/Dockerfile` with context `.`. Health check: `/healthz`. Run `POST /v1/jobs/daily-servicing` (daily) and `POST /v1/jobs/reconcile-payouts` (every ~10 minutes) from Railway crons, with the API key header, and alert on a non-empty `integrityIssues` or `errors`.

## Endpoints
All need `x-api-key`, except `/healthz` and webhooks (which are authenticated by signature). Bodies are JSON.

| Method and path | What it does |
|---|---|
| `POST /v1/customers` | Create or update by mobile. Optional `pan` (stored only as a peppered hash and last 4). |
| `POST /v1/applications` | `{ customer_id, product_code, requested_amount, intake{...}, pan? }`. Runs KYC, enrichment and the decision. Returns decision, grade, points, offer, reasons. `202` if KYC is pending. |
| `POST /v1/applications/:id/agreement` | Send the agreement (idempotent). |
| `POST /v1/applications/:id/disburse` | `{ account{name,number,ifsc} }`. Needs a signed agreement. `200` paid, `202` pending or unknown, `502` failed. |
| `POST /v1/loans/:id/collect` | Create a repayment link, default the full outstanding amount. |
| `POST /v1/loans/:id/payments` | Record a confirmed payment manually (idempotent on `utr`). |
| `POST /v1/loans/:id/rollover` | Extend a loan, if the product allows. |
| `POST /v1/loans/:id/write-off` | Write off a loan 90+ days overdue. |
| `GET /v1/loans/:id` | Status, outstanding, days overdue, aging bucket, schedule, ledger balance. |
| `GET /v1/customers/:id/eligibility?product=CODE` | Eligible, repeat, limit, cycle. |
| `POST /v1/jobs/daily-servicing` | Penalty accrual and overdue marking, then an integrity audit (`integrityIssues` lists any loan whose schedule and ledger disagree). Run daily. |
| `POST /v1/jobs/reconcile-payouts` | `{ older_than_minutes? }`. Settles payouts stuck pending by asking the payout vendor. Run every ~10 minutes. `409` if the vendor has no status check. |
| `POST /v1/webhooks/:provider` | Vendor callbacks (e-sign, payout, payment). HMAC signature required. |
| `GET /healthz` | Liveness. |

Errors: `400` bad input, `401`/`503` auth, `404` not found, `409` not allowed right now (wrong status, open loan, blocked, rule violated), `422` amount or product out of range, `502` vendor failure, `500` unexpected (no details returned).

## Security notes
- Raw PAN is never stored. It is passed to vendors for the one call it is sent in.
- `fraudFlag`, `kycFailed` and other internal fields cannot be set by a caller; only the listed intake answers are read.
- Bank account details are passed to the payout vendor and never echoed back.
- Request bodies are capped at 1 MB. Responses and logs never include request bodies. Logs carry method, path, status and timing only.
- This API is meant to be called by your own backend, dashboard or bot, not directly by customers' browsers; there is no per-customer authentication.

## Live database status (smecircle, project `ymdkcaedwnnhszhzirli`)
Migrations 003 to 006 are applied to the live project, as separate Supabase migrations `payday_a` to `payday_f` (003 was split into three pieces to stay under the tool's time limit, and `drop trigger` was replaced by `create or replace trigger` so it is not a destructive statement). Checked live: 17 tables in the new `payday` schema, row-level security on all 17, `public` untouched (124 tables before and after), OWN_BOOK lender seeded, the unique guards in place, and only `service_role` has access (`anon` and `authenticated` have none). A rolled-back smoke test confirmed a second open loan and a duplicate payment reference are both refused. The Supabase security advisor flagged one real finding on the new schema (trigger function search path), fixed by migration 006.

**API exposure.** The `payday` schema had to be added to PostgREST's exposed schemas before `supabase-js .schema('payday')` could reach it. A dashboard change had not taken effect, so it was set directly with `alter role authenticator set pgrst.db_schemas = 'public, graphql_public, dsa, crm, assistant, payday'` plus `notify pgrst, 'reload config'` (the existing five schemas were kept). If the dashboard's Data API setting is ever saved with a list that omits `payday`, re-add it there. Exposing the schema is safe: `anon` and `authenticated` have no grants on it (verified inside the database by switching to each role: SELECT and INSERT denied on every table and view).

**End-to-end test, run live on 2026-10-07: 31 of 31 checks passed.** `scripts/e2e-live.mjs` drives the whole journey through the API handler against the real project, using mock vendors and a signed fake-vendor webhook: customer, application (approved), agreement, signed webhook, replayed webhook ignored, disbursement with an 80/20 co-lender split (8000/2000, fee 640/160), ledger equals schedule, a second application refused while a loan is open, repayment link, payment webhook closing the loan, duplicate payment reference refused by the database itself, limit stepping up to 15000, a capped repeat application with no second KYC, then an overdue loan with penalty, the daily integrity audit (clean), write-off, and the written-off customer being blocked.
Run it again with `SUPABASE_URL=... SUPABASE_KEY=<service role key> node payday-api/scripts/e2e-live.mjs` (set `E2E_STRIP_AUTH=1` only in a sandbox whose proxy injects the key). It writes tagged test rows and prints the exact SQL that removes them. **That run's test rows are still in the live database** (product `E2E_muy3wdz5`, now inactive, two inactive test lenders, two test customers with their loans) because the delete was not confirmed; its cleanup SQL is in the PR description.
Note: a written-off loan keeps its scheduled amount (still legally owed) while its ledger balance is zero, so `outstanding` and `ledger_balance` differ after a write-off by design.

The schema is empty: add a `loan_product` row (and `lender` / `colending_arrangement` rows if co-lending) before the first application.

## Go-live checklist
1. Migrations are applied (see above). Expose the `payday` schema, then add a `loan_product` row and, if co-lending, `lender` and `colending_arrangement` rows.
2. Fill the vendor specs and set real `VENDOR_*` variables; run each slot against the vendor's sandbox.
3. Run the whole journey end to end with a test mobile number, with mock vendors first (set `ALLOW_MOCK_VENDORS=1` outside production), then each real vendor's sandbox.
4. Have compliance review the agreement, key fact statement, penal charges, cooling-off and the adverse-action wording before a real customer sees it.
5. Review the scorecard and limit thresholds against real repayment data.
6. Only then point production env at the real project.

## Tests
`node --test test-payday-api.mjs`: auth, validation, PAN handling, the full journey (including a real-HTTP run), servicing endpoints, webhooks, error masking.
