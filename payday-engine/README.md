# payday-engine

Decision engine for the payday-loan LOS. Pure functions, no dependencies, no network. Step 2 of the payday LOS+LMS build; the tables it writes to are in `database/migrations/003_payday_los_lms_schema.sql`.

```js
import { decide, toScorecardRow, toApplicationPatch } from './index.js';

const result = decide({ features, product, requestedAmount, customerLimit });
// result.decision: 'approve' | 'refer' | 'reject'
// result.grade: A..E   result.totalPoints / result.maxPoints (122)
// result.offer: { amount, feeAmount, repaymentAmount, cappedBy } | null
// result.reasons: plain-language why (hard declines, review flags, biggest point losses)

toScorecardRow(applicationId, result);   // -> payday.scorecard_result row
toApplicationPatch(result);              // -> payday.application update
```

`product` has the shape of `payday.loan_product` (`min_amount`, `max_amount`, `fee_type`, `fee_value`). `customerLimit` is the repeat-loan cap from `payday.customer_limit` (step 4).

## What it is and is not
- **Not a business-loan BRE.** No GST parameters, no business-profile checks, no 14-lender BRE matrix. Co-lender split comes from `payday.colending_arrangement`, not from scoring.
- **Scorecard `PAYDAY_V1`:** 23 parameters, 122 points, same A-E point cut-offs as the BuddyLoan scorecard (98 / 79 / 61 / 43).
  - Bureau (55) and banking (28) follow the BuddyLoan scorecard, with one change: SC08 is average balance / repayment (1.0x full marks, 0.25x zero), since a payday loan is one bullet repayment.
  - Salary (26) and employment/profile (13) replace the GST and business-profile blocks, with the same weights.
- **Proposal, not calibrated.** The salaried parameters and every payday threshold in `config.js` are a first draft. Nothing here has been checked against payday repayment data.

## Decision rules
1. Score each parameter 0-10 (linear between the "worst" and "best" values in `config.js`, or a category map), then `points = weight x score / 10`.
2. **Missing data never helps:** a missing input scores 4/10. An unrecognised category value counts as missing. More than 5 missing parameters means the file is referred, not approved.
3. **Hard declines** force Grade E and reject, whatever the score: NPA (RF1), wilful defaulter (RF2), KYC failed (RF5), identity/device fraud flag (RF10). RF5 and RF10 replace the business scorecard's GSTIN and MCA checks.
4. **Review flags** turn an approve into a refer: write-off in 36 months, DPD above 30, salary mismatch above 30%, FOIR above 55%, more than 2 bank bounces in 6 months, more than 6 enquiries in 90 days, vague purpose.
5. Grade to decision: A, B approve; C refer; D, E reject.
6. **Offer size** is the smallest of: product max, amount requested, grade share of monthly net salary (A 50%, B 40%, C 30%), and any repeat-loan customer limit. It rounds down to the nearest 500. Below the product minimum means reject.
7. Scoring uses the amount requested to work out the repayment. The final offer can be lower.

## Tests
`node --test test-payday-engine.mjs` (also run by CI). 15 tests cover weights, scaling, grade boundaries, each hard flag, review flags, missing data, offer caps and rounding, fees, and the table mappers.

## Not here yet
Reading bureau, bank or salary data from vendors (step 3), writing to Supabase (step 3), repeat-loan limit step-up (step 4).
