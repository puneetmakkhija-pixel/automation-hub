// PAYDAY_V1 scorecard configuration. Every number here is a tunable.
//
// ORIGIN: bureau (SC01-SC07) and banking (SC08-SC12) follow the BuddyLoan business-loan
// scorecard. That scorecard's GST (SC13-SC17) and business-profile (SC18-SC23) parameters
// do not exist for a salaried borrower, so they are replaced below by salary and
// employment equivalents with the SAME weights (26 + 13) so the total stays 122 and the
// existing grade bands carry over unchanged.
//
// STATUS: the salaried parameters and all payday thresholds are a PROPOSAL. They have not
// been calibrated on payday repayment data. Treat the first live month as a pilot.

export const MODEL_VERSION = 'PAYDAY_V1';

// kind 'scale': linear 0-10 between `worst` (0 pts) and `best` (10 pts); works for
//               higher-is-better and lower-is-better. `field` is read from features.
// kind 'category': `map` gives the 0-10 score per allowed value.
export const PARAMS = [
  // ---- Bureau (55)
  { code: 'SC01', name: 'CIBIL score', group: 'bureau', weight: 15, field: 'cibil', kind: 'scale', worst: 650, best: 750 },
  { code: 'SC02', name: 'Max DPD, 12 months', group: 'bureau', weight: 12, field: 'maxDpd12m', kind: 'scale', worst: 60, best: 0 },
  { code: 'SC03', name: 'NPA / write-off / settlement', group: 'bureau', weight: 10, field: 'npaStatus', kind: 'category',
    map: { none: 10, settled: 4, writeoff: 1, npa: 0 } },
  { code: 'SC04', name: 'Active loan count', group: 'bureau', weight: 6, field: 'activeLoans', kind: 'scale', worst: 8, best: 3 },
  { code: 'SC05', name: 'Hard enquiries, 90 days', group: 'bureau', weight: 5, field: 'enquiries90d', kind: 'scale', worst: 8, best: 2 },
  { code: 'SC06', name: 'EMI bounces (bureau)', group: 'bureau', weight: 4, field: 'bureauEmiBounces', kind: 'scale', worst: 4, best: 0 },
  { code: 'SC07', name: 'Credit-card utilisation %', group: 'bureau', weight: 3, field: 'ccUtilPct', kind: 'scale', worst: 85, best: 30 },

  // ---- Banking (28)
  // Business scorecard uses ABB >= 3x EMI. A payday loan is one bullet repayment and
  // salaried balances are lower, so the proposed band is ABB / repayment: 1.0x full, 0.25x zero.
  { code: 'SC08', name: 'Avg bank balance / repayment', group: 'banking', weight: 8, field: 'abbToRepayment', kind: 'scale', worst: 0.25, best: 1.0 },
  { code: 'SC09', name: 'Monthly credit trend % (last 3 vs prior 3)', group: 'banking', weight: 7, field: 'creditTrendPct', kind: 'scale', worst: -10, best: 10 },
  { code: 'SC10', name: 'EMI bounces (bank, 6m)', group: 'banking', weight: 6, field: 'bankBounces6m', kind: 'scale', worst: 4, best: 0 },
  { code: 'SC11', name: 'Transactions per month', group: 'banking', weight: 4, field: 'txnPerMonth', kind: 'scale', worst: 5, best: 20 },
  { code: 'SC12', name: 'Cash deposits %', group: 'banking', weight: 3, field: 'cashDepositPct', kind: 'scale', worst: 60, best: 10 },

  // ---- Salary (26) - replaces GST block
  { code: 'SC13', name: 'Loan / monthly net salary %', group: 'salary', weight: 7, field: 'loanToNetSalaryPct', kind: 'scale', worst: 80, best: 30 },
  { code: 'SC14', name: 'Salary credits in last 6 months', group: 'salary', weight: 5, field: 'salaryCredits6m', kind: 'scale', worst: 3, best: 6 },
  { code: 'SC15', name: 'Salary variation % (spread of credits)', group: 'salary', weight: 5, field: 'salaryVariationPct', kind: 'scale', worst: 30, best: 5 },
  { code: 'SC16', name: 'Salary trend % (last 3 vs prior 3)', group: 'salary', weight: 4, field: 'salaryTrendPct', kind: 'scale', worst: -10, best: 5 },
  { code: 'SC17', name: 'Declared vs observed salary variance %', group: 'salary', weight: 5, field: 'salaryMatchVariancePct', kind: 'scale', worst: 40, best: 10 },

  // ---- Employment & profile (13) - replaces business-profile block
  { code: 'SC18', name: 'Months with current employer', group: 'profile', weight: 3, field: 'tenureMonths', kind: 'scale', worst: 3, best: 24 },
  { code: 'SC19', name: 'Employer category', group: 'profile', weight: 3, field: 'employerCategory', kind: 'category',
    map: { govt_psu: 10, listed_large: 9, mnc: 9, sme_registered: 6, startup: 5, unknown: 2, informal: 0 } },
  { code: 'SC20', name: 'Residence', group: 'profile', weight: 1, field: 'residence', kind: 'category',
    map: { owned: 10, family: 8, rented_long: 6, rented_short: 3, none: 0 } },
  { code: 'SC21', name: 'FOIR %', group: 'profile', weight: 4, field: 'foirPct', kind: 'scale', worst: 65, best: 35 },
  { code: 'SC22', name: 'Loan purpose clarity', group: 'profile', weight: 1, field: 'purposeClarity', kind: 'category',
    map: { specific_documented: 10, generic: 5, vague_personal: 0 } },
  { code: 'SC23', name: 'References verified', group: 'profile', weight: 1, field: 'referencesVerified', kind: 'category',
    map: { both: 10, one: 5, none: 0 } },
];

// A missing input scores this (0-10): below the midpoint, so absence never helps.
export const MISSING_SCORE_10 = 4;
// More than this many missing parameters means the file is too thin to auto-approve.
export const MAX_MISSING_FOR_AUTO = 5;

// Same points cut-offs as the business scorecard (80 / 65 / 50 / 35 % of 122).
export const BANDS = [
  { grade: 'A', min: 98 },
  { grade: 'B', min: 79 },
  { grade: 'C', min: 61 },
  { grade: 'D', min: 43 },
  { grade: 'E', min: -Infinity },
];

export const DECISION_BY_GRADE = { A: 'approve', B: 'approve', C: 'refer', D: 'reject', E: 'reject' };

// Max loan as a share of monthly net salary, by grade.
export const MAX_PCT_OF_SALARY = { A: 0.5, B: 0.4, C: 0.3, D: 0, E: 0 };
export const AMOUNT_STEP = 500;

// Hard declines force Grade E whatever the score. The first two follow the business
// scorecard. RF5 and RF10 there are GSTIN and MCA checks, which do not apply to a
// salaried borrower; they are replaced by KYC failure and an identity/device fraud flag.
export const HARD_FLAGS = {
  RF1: { label: 'NPA on any account' },
  RF2: { label: 'Wilful defaulter' },
  RF5: { label: 'KYC failed (PAN / Aadhaar / liveness)' },
  RF10: { label: 'Identity or device fraud flag' },
};

// Review flags cannot auto-approve: an 'approve' becomes 'refer'.
export const REVIEW_FLAGS = {
  RF3: { label: 'Write-off in last 36 months' },
  RF4: { label: 'DPD above 30 days in last 12 months' },
  RF7: { label: 'Declared vs observed salary mismatch above 30%' },
  RF8: { label: 'FOIR above 55%' },
  RF9: { label: 'More than 2 EMI bounces in 6 months' },
  RF11: { label: 'More than 6 hard enquiries in 90 days' },
  RF12: { label: 'Loan purpose vague / personal use' },
};
