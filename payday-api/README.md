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
This service imports the sibling `payday-engine` and `payday-journey` folders, so it must build from the **repo root** (the repo-root `railway.toml` builds only `ivr-router`). Create a service from the repo, leave Root Directory at the repo root, and set the service's config file path to `/payday-api/railway.toml`. That file points at `payday-api/Dockerfile` with context `.`. Health check: `/healthz`. Run the daily job (`POST /v1/jobs/daily-servicing`) from a Railway cron, with the API key header.

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
| `POST /v1/jobs/daily-servicing` | Penalty accrual and overdue marking. |
| `POST /v1/webhooks/:provider` | Vendor callbacks (e-sign, payout, payment). HMAC signature required. |
| `GET /healthz` | Liveness. |

Errors: `400` bad input, `401`/`503` auth, `404` not found, `409` not allowed right now (wrong status, open loan, blocked, rule violated), `422` amount or product out of range, `502` vendor failure, `500` unexpected (no details returned).

## Security notes
- Raw PAN is never stored. It is passed to vendors for the one call it is sent in.
- `fraudFlag`, `kycFailed` and other internal fields cannot be set by a caller; only the listed intake answers are read.
- Bank account details are passed to the payout vendor and never echoed back.
- Request bodies are capped at 1 MB. Responses and logs never include request bodies. Logs carry method, path, status and timing only.
- This API is meant to be called by your own backend, dashboard or bot, not directly by customers' browsers; there is no per-customer authentication.

## Go-live checklist
1. Review and apply migrations `003` and `004` on a staging Supabase project; add a `loan_product` row and, if co-lending, `lender` and `colending_arrangement` rows.
2. Fill the vendor specs and set real `VENDOR_*` variables; run each slot against the vendor's sandbox.
3. Run the whole journey on staging with a test mobile number.
4. Have compliance review the agreement, key fact statement, penal charges, cooling-off and the adverse-action wording before a real customer sees it.
5. Review the scorecard and limit thresholds against real repayment data.
6. Only then point production env at the real project.

## Tests
`node --test test-payday-api.mjs`: auth, validation, PAN handling, the full journey (including a real-HTTP run), servicing endpoints, webhooks, error masking.
