# payday-journey

The payday-loan business logic: vendor slots, underwriting pipeline, agreement and disbursement, servicing, repeat-loan limits, vendor webhooks. No dependencies. It uses `../payday-engine` for the scorecard decision and writes to the `payday` tables from `database/migrations/003` and `004`. The HTTP service on top of it is `../payday-api`.

```
 customer -> application -> KYC -> bureau + bank statement -> decision (payday-engine)
    -> offer -> agreement (e-sign) -> signed -> payout (co-lender split) -> loan active
    -> collect link -> payment webhook -> repayment allocated -> closed -> limit steps up -> repeat loan
                                   \-> overdue: daily penalty -> rollover or write-off
```

## Vendor slots (all plug-and-play)

| Slot | Method | Env var | Purpose |
|---|---|---|---|
| `kyc` | `verify` | `VENDOR_KYC` | PAN, Aadhaar OTP, liveness |
| `bureau` | `pull` | `VENDOR_BUREAU` | CIBIL, DPD, NPA, obligations |
| `bankStatement` | `analyse` | `VENDOR_BANK_STATEMENT` | balance, salary credits, bounces |
| `esign` | `createRequest` | `VENDOR_ESIGN` | agreement and key fact statement |
| `payout` | `disburse` | `VENDOR_PAYOUT` | send the loan amount, return a UTR |
| `collect` | `request` | `VENDOR_COLLECT` | repayment link; money arrives by webhook |

Each env var is `mock` (default) or the name of a vendor in `vendors/index.js`. Every vendor output is checked against `contracts.js` at the boundary.

## Plugging in a vendor (no code, about 15 minutes)

You need the vendor's API document. For each slot the vendor offers:

1. Copy `vendors/_example-acme.spec.js` to `vendors/<name>.spec.js` (it is fictional but complete, every slot and the webhook).
2. For each slot, set `baseUrlEnv`, `auth` (`header`, `basic` or `none`), `request.path` and `request.body` (use `{{customer.mobile}}`-style placeholders), and `response.fields`, which says where each normalised field sits in the vendor's response. `mapping.js` documents the forms: a path, `{ path, type, map, default, divideBy }`, `{ const }`, `{ array }`.
3. Set `configured: true`. Until then the slot refuses to run.
4. Register it in `vendors/index.js`: `import { <name> } from './<name>.spec.js'` and add it to `DEFAULT_SPECS`.
5. Put credentials in the host's env vars (never the repo), then set `VENDOR_<SLOT>=<name>`.
6. If the vendor calls back (e-sign result, payout result, payment received), fill in its `webhook` block: signature rule, event id and type paths, how vendor event names map to ours, and the field paths. Point the vendor at `POST /v1/webhooks/<name>`.
7. Test it: copy the "PLUG AND PLAY" test in `test-payday-vendors.mjs` and replace the fake server with the vendor's sandbox, or a captured sample response.

Safety built in: HTTP errors never put response bodies in messages (they carry PII); a missing secret names the env var instead of calling out; only idempotent reads are retried, never a payout; a wrong-shaped response fails at the boundary.

### Digitap
`vendors/digitap.spec.js` is a shell, **not configured**: Digitap's API reference is partner-only, so nothing in it is guessed. Their site lists Digital/Video KYC (kyc slot), bank-statement and alternate-data scoring (bankStatement slot) and an Account Aggregator module. It lists no bureau, e-sign, payout or collection product. Fill the spec from their document and follow the steps above.

## Money rules
- **Co-lending:** the split comes from `payday.colending_arrangement` on the disbursal date (own book at 100% if none). Shares must add to 100. Principal, fee, penalty and repayments are all split across lenders in the ledger, with the last lender taking the paise remainder.
- **Ledger:** debit = customer owes more (disbursal, fee, penalty); credit = owes less (repayment, write-off). Balance = outstanding. The schedule and the ledger agree, and the tests assert it.
- **Payout safety:** the loan row is created before the payout (one open loan per customer is a database rule); the payout uses an idempotency key; an unknown outcome (timeout) stays `pending` and is settled by the webhook, never marked failed.
- **Payments:** idempotent on UTR; allocated penalty, then fee, then principal; an overpayment or a payment after closure is recorded and flagged `unapplied` for refund.
- **Penalty:** principal x daily rate x days overdue, on the scheduled principal only (no compounding), never decreases, recomputed from dates so the daily job is idempotent.
- **Rollover:** only if the product allows it, fee and penalty paid first, then the unpaid principal gets a fresh fee and a new due date.
- **Write-off:** at least 90 days overdue; zeroes the ledger and blocks the customer until a person reinstates them.
- **Limits:** repaid on time raises the limit one rung of `LADDER`; rolled over or late within 3 days holds; later lowers it; 30+ days late or written off blocks. The limit only ever caps an offer, never raises it above the engine's grade-based cap. The values are proposals.

## Not done / known limits
- **`supabaseStore` has not been run against a live Supabase project.** It is tested against a recording fake (tables, filters, errors), and the SQL against a scratch Postgres. Do a staging run before production.
- **A payment is recorded, then the schedule and ledger are updated in separate calls, not one transaction.** A crash in between leaves a payment with no allocation. Wrapping this in a Postgres function is the proper fix.
- **No status-poll for pending payouts:** settlement relies on the vendor's webhook. Find stuck ones with `select * from payday.disbursement where status = 'pending' and created_at < now() - interval '15 minutes'`.
- **No auto-debit mandate (e-NACH) registration.** `collect` creates a payment request; recurring mandates would be another slot.
- Penalty is on the scheduled principal even after a partial principal payment (a simplification). Regulatory treatment of penal charges, KFS content and cooling-off should be reviewed by compliance before launch.
- The scorecard and limit thresholds are uncalibrated (see `../payday-engine/README.md`).

## Tests
`node --test test-*.mjs` (CI runs each file): pipeline, vendor plug-in and webhooks, lifecycle (split, payouts, penalty, rollover, write-off, repeat), Supabase store.
