# zenin-web

The customer website and app for **Zenin Credit**: a public site (home, how it works, rates and charges with a
calculator, eligibility, FAQ, about, contact, grievance, fair practices, privacy, terms) and an installable app (PWA)
at `/app` with the full borrower journey in English and Hindi.

One small Node 22 server, no npm dependencies, no build step.

## Run it

```
node zenin-web/server.js          # http://localhost:3000, demo mode
node --test zenin-web             # 24 tests
```

## Two modes

| | demo (default) | live |
|---|---|---|
| Data | in memory, lost on restart | the real loan system (not built yet) |
| Loan engine | the real engine and journey, mock vendors | the payday-api over HTTP |
| OTP | fixed code `123456` | an SMS provider (not built yet) |
| Search engines | blocked (`noindex`, `Disallow: /`) | allowed, except `/app` |
| Banner | on every page | none |

**Live mode refuses to start** until every item in its checklist is fixed, and prints the list. Today that always
includes "the live gateway is not built" and "no SMS OTP provider", on purpose: a public lending site must not run on
mock KYC and a fixed OTP.

## What the customer sees, and what the server enforces

- The browser holds only a signed session cookie (HttpOnly, SameSite=Lax, Secure on https). No keys, no loan data.
- Every request is checked against the session's own customer; another customer's application or loan returns 404.
- Every POST needs the `x-zenin: 1` header and JSON, so a form on another site cannot trigger it.
- Rate limits: 3 codes per mobile and 10 per address per 10 minutes, 5 wrong codes lock a code, 3 applications per
  customer per day, 120 requests a minute per address.
- Permission (KYC, credit report, terms) is recorded before any check. Without it the application is refused.
- The customer never sees scores, grades, reasons or policy names. A decline says only that it is a decline.
- Bank account numbers are validated, passed once to the payout step, never echoed and not kept by this site.
- CSP forbids inline scripts and any outside host except Google Fonts. No third-party scripts.

## Returning customers and the wheel

A customer who has borrowed before sees one of these, worked out on the server each time:

| State | When | Screen |
|---|---|---|
| Pre-approved | all checks still fresh | Welcome back: amount, saved details, purpose, bill. No re-typing, no PAN |
| Saved offer | offer made, not accepted, under `OFFER_VALID_DAYS` | The offer with the date it lapses |
| Refresh | permission withdrawn, identity older than `KYC_VALID_DAYS`, job details older than `DATA_VALID_DAYS` | "A quick check first": only the stale items are asked |
| No offer | under review, declined (with the date to try again), not available, identity check pending | A plain reason; never a score |

From the third repaid loan, each repaid loan earns one spin of a ten-slice wheel. It waives 10 to 50 percent of the
processing fee (a share of the fee, not percentage points) on the next loan. The draw is on the server, the odds are
shown on the wheel screen, the reward is valid 30 days and is used up only when the money is paid. Needs migration
`database/migrations/009_payday_fee_waiver_wheel.sql` before it runs against Supabase. Compliance must sign off the
wheel before live: it is a chance-based promotion on repeat borrowing.

`node zenin-web/prototype/build.mjs` writes `prototype/zenin-prototype.html`: the real app with an in-browser mock of
the API and a scenario switcher. One file, no server.

## Configuration

| Variable | Meaning |
|---|---|
| `ZENIN_MODE` | `demo` (default) or `live` |
| `SITE_URL` | public address, default `https://zenincredit.com` |
| `SESSION_SECRET` | 32+ random characters; required in live |
| `PORT` | default 3000 |
| `FIRST_LOAN_MAX` | most a first-time customer may ask for (default 10000) |
| `KYC_VALID_DAYS`, `DATA_VALID_DAYS`, `BUREAU_VALID_DAYS`, `OFFER_VALID_DAYS` | how long identity (365), job details (90), credit report (30) and an offer (7) stay valid |
| `REAPPLY_AFTER_DAYS` | wait after a decline (live default 30, demo 0) |
| `SESSION_HOURS` | session length (default 2) |
| `LEGAL_REVIEWED` | set to `1` only after compliance signs off the legal pages |
| `LEGAL_ENTITY_NAME`, `LENDER_NAME`, `LENDER_REGISTRATION`, `REGISTERED_ADDRESS`, `SUPPORT_EMAIL`, `SUPPORT_PHONE`, `GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_OFFICER_EMAIL`, `GRIEVANCE_OFFICER_PHONE`, `DATA_PROTECTION_CONTACT` | shown in the footer and legal pages. While missing they show as visible `[... to be added]` markers. Nothing is invented. |

## Trying the demo

Numbers ending 0 to 6 are approved. 7 (no credit history), 8 (defaulted loan) and 9 (identity check fails) are
declined. Choosing "Other personal use" as the purpose sends an approved file to review. OTP code `123456`, signing
code `246810`.

## Deploy

Build context is the repository root (the demo runs the sibling packages): `zenin-web/Dockerfile`, health check
`/healthz`. On Railway set the service's Dockerfile path to `zenin-web/Dockerfile`.

## What is still needed before real customers (see the status page)

1. A live gateway to payday-api (`createGateway` in `demo.js` lists the interface), including a way to find a returning
   customer's applications and loans, which the API does not offer to partner keys today.
2. An SMS OTP provider behind `createOtp`.
3. A real e-sign hand-off (the demo signs with a code) and a payment link for repayment (live path is wired, untested).
4. Bank account name verification before payout (penny-drop or equivalent): without it, anyone with a session can pay
   out to any account.
5. A first-loan cap enforced in the credit policy, not only here (`FIRST_LOAN_MAX`).
6. The lender's details, signed-off legal text, consent wording and key fact statement, and a native-speaker review of
   the Hindi.
7. Real vendors behind payday-api, and the domain `zenincredit.com` (not registered at the time of writing).
