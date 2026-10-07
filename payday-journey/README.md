# payday-journey

Step 3 of the payday LOS+LMS build: vendor adapter slots and the underwriting pipeline. Uses `../payday-engine` for the decision and writes to the `payday` tables from `database/migrations/003_payday_los_lms_schema.sql`. No dependencies.

```
runUnderwriting({ registry, store, customer, application, product, intake, customerLimit })

 KYC -> (pending? stop)  -> bureau + bank statement in parallel -> payday-engine decide() -> persist
```

It stops at the decision. Agreement (e-sign) and disbursement (payout) run after the customer accepts an offer; their slots and mocks exist, the orchestration is the next sub-step.

## Slots

| Slot | Method | Purpose | Vendors |
|---|---|---|---|
| `kyc` | `verify` | PAN, Aadhaar OTP, liveness | `mock`, `digitap` (not wired) |
| `bureau` | `pull` | CIBIL, DPD, NPA, obligations | `mock` |
| `bankStatement` | `analyse` | balance, salary credits, bounces | `mock`, `digitap` (not wired) |
| `esign` | `createRequest` | agreement signing | `mock` |
| `payout` | `disburse` | send money, return UTR | `mock` |

Pick vendors with env vars: `VENDOR_KYC`, `VENDOR_BUREAU`, `VENDOR_BANK_STATEMENT`, `VENDOR_ESIGN`, `VENDOR_PAYOUT`. Default is `mock`.

- **Mocks are refused in production** (`NODE_ENV=production`) unless `ALLOW_MOCK_VENDORS=1`, so a missing env var can never approve a real loan on fake KYC or bureau data.
- **Every adapter's output is checked** against `contracts.js`, so a vendor changing its response fails at the boundary instead of silently skewing a score.
- A **vendor outage** is recorded in the decision reasons and treated as missing data. It never crashes the pipeline and never helps the customer.
- **KYC runs first**; a customer who fails it costs no bureau or bank-statement pull.
- The **offer salary** is the lower of declared and observed salary, so an inflated declaration cannot raise the offer.

## Mock scenarios (last digit of the mobile number)
`9` KYC fails, `8` bureau shows NPA, `7` thin file (no bureau or bank data), `0-6` clean (CIBIL = 700 + 8 x digit).

## Digitap: what is and is not done
Digitap's site lists Digital KYC / Video KYC (Onboarding Suite), bank-statement and alternate-data scoring, and an Account Aggregator TSP module. It does not list a bureau pull, e-sign or payout.

Their API reference is not public, so `digitap-adapter.js` is a deliberately empty shell: it throws `NotConfiguredError` until three things are filled in from Digitap's partner API document:
1. `authHeaders(env)`: how Digitap authenticates.
2. `endpoints`: the path for KYC and for bank statement.
3. `normalize`: a function per slot that maps Digitap's response to the shape in `contracts.js`.

Credentials go in env (`DIGITAP_BASE_URL`, `DIGITAP_CLIENT_ID`, `DIGITAP_CLIENT_SECRET`) on the host, never in the repo. Then set `VENDOR_KYC=digitap` and/or `VENDOR_BANK_STATEMENT=digitap`.

## Persistence
`memoryStore()` for tests; `supabaseStore(client)` writes to the `payday` schema through an injected supabase-js client. The service role is required, since the tables have row-level security with no policies.

## Tests
`node --test test-payday-journey.mjs` (also run by CI): happy path, KYC fail, NPA, thin file, vendor outage, pending KYC, registry and production guard, Digitap refusal, contract guard, feature derivation, Supabase writes.
