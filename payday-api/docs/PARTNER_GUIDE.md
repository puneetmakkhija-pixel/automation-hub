# PaydayOS partner guide

For the team building the BuddyLoan app and website on top of the NBFC's loan system.

The customer only ever uses your screens. PaydayOS holds the loan record, decides, pays the borrower, collects repayments and
keeps the audit trail. You never hold the ledger, and you never touch the money.

Reference: `GET /openapi.json` (OpenAPI 3.1, no key needed) and `docs/partner-api.html`, built from it with
`node payday-api/docs/build-docs.mjs`. This guide explains how the pieces fit.

## 1. Keys and environments

- Send your key in the `x-api-key` header. Keys are issued to a partner, and a partner key sees only its own customers, applications and loans. Anything else answers `404`, not `403`.
- **Sandbox** is a separate deployment on mock vendors and an in-memory store. It resets whenever it restarts, so do not keep anything in it. A product `PAYDAY_30` is ready, and you can finish a whole loan alone (section 5). Your sandbox key and URL come from the NBFC.
- **Production** uses real vendors and a real key. Ask the NBFC for both.

## 2. The loan journey, call by call

| # | Customer sees | You call |
|---|---|---|
| 1 | Who the lender is | `GET /v1/lender` |
| 2 | Permissions | `POST /v1/customers`, then `POST /v1/customers/{id}/consents` |
| 3 | Checking | `POST /v1/applications` (send an `Idempotency-Key`) |
| 4 | The offer and key facts | `GET /v1/applications/{id}/kfs` |
| 5 | Signing | `POST /v1/applications/{id}/agreement`, then wait for `agreement.signed` |
| 6 | Money on its way | The NBFC side starts payout. Wait for `loan.disbursed` (or `payout.failed`) |
| 7 | My Loans | `GET /v1/loans/{id}` every time the screen opens |
| 8 | Changed my mind (first day) | `POST /v1/loans/{id}/cooling-off`, then a repayment link for the amount it returns |
| 9 | Repay | `POST /v1/loans/{id}/collect` (send an `Idempotency-Key`), then wait for `payment.received` and `loan.closed` |
| 10 | Higher limit | `GET /v1/customers/{id}/limit?product=CODE`; if `can_request_increase`, offer it; `POST /v1/customers/{id}/limit-increase` only when the customer asks |

Rules that come from the RBI Digital Lending Directions, 2025. Please build them in, not around:

- Show the lender's name and the grievance officer in the app, on the website and in the key facts. Take them from `GET /v1/lender`; do not hard-code them.
- Show the key facts statement before the customer accepts. If it says `complete: false`, do not show it to customers yet.
- Never raise a limit on your own. Only call `limit-increase` after the customer asks.
- Never let the customer enter a bank account that is not theirs, and never route money through your own account. Payout and repayment go between the borrower and the NBFC directly.
- Never show a score, grade or reason code. We do not return them to partners, and a decline is only a decline.

## 3. Events we send you

You register a callback URL and a shared secret with the NBFC. Each event is a `POST` of JSON:

```json
{ "event_id": "a1b2...:loan.closed", "type": "loan.closed", "created_at": "2026-10-16T10:00:00Z", "data": { "application_id": "a1b2...", "loan_id": "l9f8...", "reason": "repaid" } }
```

Headers: `x-payday-event-id`, `x-payday-timestamp` (seconds), `x-payday-signature` (`sha256=` plus the HMAC-SHA256 of `{timestamp}.{raw body}` with your secret).

Verify before you trust it, and reject a timestamp older than five minutes:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(rawBody, headers, secret) {
  const ts = headers['x-payday-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = headers['x-payday-signature'] ?? '';
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
```

- Answer any `2xx` once you have saved the event. Anything else, or no answer in 10 seconds, is retried with growing gaps (2, 4, 8 minutes, up to 6 hours), up to 8 times.
- **Events can arrive twice or out of order.** Use `event_id` to ignore a repeat. Treat an event as a hint to call `GET /v1/loans/{id}` or `GET /v1/applications/{id}`, which always tell the truth.
- If your endpoint was down, read what you missed: `GET /v1/events?since=<next_since of your last read>`. One that failed for good can be sent again with `POST /v1/events/{id}/redeliver`.
- The full list, with when each is sent and its fields, is at `GET /v1/event-types` and under `webhooks` in the OpenAPI document.

## 4. Safe retries

Send an `Idempotency-Key` header (8 to 128 characters: letters, digits and `. _ : -`) on `POST /v1/applications`, `POST /v1/loans/{id}/collect` and `POST /v1/customers/{id}/limit-increase`.

- The same key with the same request returns the first answer, with the header `idempotent-replayed: true`.
- The same key with a different request is `422 IDEMPOTENCY_KEY_REUSED`.
- The first call still running is `409 REQUEST_IN_PROGRESS`: wait and retry.
- Only a success is kept. A refusal (a rule, the daily limit) can be retried with the same key once the reason is gone.

Other calls are safe to repeat by design: sending the agreement twice sends one, a second payout call answers `already_disbursed`, and a payment with the same bank reference is recorded once.

## 5. Finishing a loan in the sandbox

In the sandbox two helpers stand in for the vendors, and a partner key may start payout:

1. `POST /v1/sandbox/applications/{id}/sign` pretends the borrower signed.
2. `POST /v1/applications/{id}/disburse` with `{ "account": { "name", "number", "ifsc" } }` pays out on a mock bank.
3. `POST /v1/sandbox/loans/{id}/pay` pretends the borrower paid in full.

Mobile numbers ending 0 to 6 are approved. 7 has no credit history and 8 has a defaulted loan; both are declined. 9 fails the identity check.

## 6. Errors

`400` bad input. `401` missing or wrong key. `404` not found (or not yours). `409` not allowed right now (wrong status, a rule, an open loan). `422` idempotency key misuse. `429` too many applications for one customer in 24 hours (`TOO_MANY_APPLICATIONS`). `5xx` our side: retry with the same `Idempotency-Key`.

## 7. Open design point: who starts payout in production

Today only the NBFC side (ops and admin keys) can start payout; a partner can in the sandbox only. The RBI rules say the flow of funds must not be controlled directly or indirectly by the app provider. The planned design is: the borrower gives bank details to PaydayOS, PaydayOS checks the name matches the borrower, and payout starts from the NBFC side once the agreement is signed. Compliance should confirm this before the production flow is built.
