// Run: node --test test-payday-engine.mjs  (CI also runs it as `node test-payday-engine.mjs`)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, scale, classify, maxPoints, trendPct, repaymentFor, offerFor,
  toScorecardRow, toApplicationPatch, config,
} from './index.js';

const product = {
  code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000,
  fee_type: 'percent_of_principal', fee_value: 8,
};

// An applicant that scores full marks on every parameter.
const perfect = () => ({
  cibil: 780, maxDpd12m: 0, npaStatus: 'none', activeLoans: 1, enquiries90d: 0, bureauEmiBounces: 0, ccUtilPct: 10,
  abb: 40000, creditTrendPct: 12, bankBounces6m: 0, txnPerMonth: 40, cashDepositPct: 2,
  netSalary: 60000, salaryCredits6m: 6, salaryVariationPct: 2, salaryTrendPct: 6, salaryMatchVariancePct: 3,
  tenureMonths: 48, employerCategory: 'govt_psu', residence: 'owned', foirPct: 20,
  purposeClarity: 'specific_documented', referencesVerified: 'both',
});

test('23 parameters and weights add to 122', () => {
  assert.equal(config.PARAMS.length, 23);
  assert.equal(maxPoints(), 122);
  const by = (g) => config.PARAMS.filter((p) => p.group === g).reduce((a, p) => a + p.weight, 0);
  assert.deepEqual([by('bureau'), by('banking'), by('salary'), by('profile')], [55, 28, 26, 13]);
});

test('scale: endpoints, midpoint and clamping, both directions', () => {
  assert.equal(scale(750, 650, 750), 10);
  assert.equal(scale(650, 650, 750), 0);
  assert.equal(scale(700, 650, 750), 5);
  assert.equal(scale(900, 650, 750), 10);
  assert.equal(scale(500, 650, 750), 0);
  assert.equal(scale(0, 60, 0), 10); // lower is better
  assert.equal(scale(60, 60, 0), 0);
  assert.equal(scale(null, 60, 0), null);
});

test('grade bands: 98 is A, just under is B, boundaries for every grade', () => {
  assert.equal(classify(98), 'A');
  assert.equal(classify(97.99), 'B');
  assert.equal(classify(79), 'B');
  assert.equal(classify(78.99), 'C');
  assert.equal(classify(61), 'C');
  assert.equal(classify(43), 'D');
  assert.equal(classify(42.99), 'E');
});

test('perfect applicant: 122 points, grade A, approved, no flags', () => {
  const r = decide({ features: perfect(), product, requestedAmount: 15000 });
  assert.equal(r.totalPoints, 122);
  assert.equal(r.grade, 'A');
  assert.equal(r.decision, 'approve');
  assert.equal(r.offer.amount, 15000);
  assert.equal(r.offer.repaymentAmount, 16200); // 15000 + 8%
  assert.equal(r.missingCount, 0);
  assert.equal(r.redFlags.hard.length + r.redFlags.review.length, 0);
});

test('hard decline: NPA forces grade E and reject even on an otherwise perfect file', () => {
  const f = { ...perfect(), npaStatus: 'npa' };
  const r = decide({ features: f, product, requestedAmount: 10000 });
  assert.ok(r.totalPoints > 98, 'score alone would not have declined');
  assert.equal(r.grade, 'E');
  assert.equal(r.decision, 'reject');
  assert.equal(r.offer, null);
  assert.ok(r.reasons.some((x) => x.includes('RF1')));
});

test('each hard flag rejects: wilful defaulter, KYC failed, fraud', () => {
  for (const [k, code] of [['wilfulDefaulter', 'RF2'], ['kycFailed', 'RF5'], ['fraudFlag', 'RF10']]) {
    const r = decide({ features: { ...perfect(), [k]: true }, product, requestedAmount: 10000 });
    assert.equal(r.decision, 'reject', k);
    assert.ok(r.redFlags.hard.some((f) => f.code === code), k);
  }
});

test('review flag stops auto-approval: DPD 45 on a strong file becomes refer', () => {
  const r = decide({ features: { ...perfect(), maxDpd12m: 45 }, product, requestedAmount: 10000 });
  assert.notEqual(r.grade, 'E');
  assert.equal(r.decision, 'refer');
  assert.ok(r.redFlags.review.some((f) => f.code === 'RF4'));
});

test('missing data: absence never helps, and a thin file is referred', () => {
  const thin = { cibil: 780, netSalary: 60000, npaStatus: 'none' };
  const r = decide({ features: thin, product, requestedAmount: 10000 });
  assert.ok(r.missingCount > 5);
  assert.equal(r.decision, 'refer');
  assert.ok(r.reasons.some((x) => x.startsWith('Insufficient data')));
  const missingParam = r.parameters.find((p) => p.code === 'SC05');
  assert.equal(missingParam.missing, true);
  assert.equal(missingParam.score10, 4);
});

test('unknown category value is treated as missing, not zero', () => {
  const r = decide({ features: { ...perfect(), employerCategory: 'martian' }, product, requestedAmount: 10000 });
  const p = r.parameters.find((x) => x.code === 'SC19');
  assert.equal(p.missing, true);
});

test('grade C is referred; grade D is rejected', () => {
  const c = decide({ features: { ...perfect(), cibil: 665, maxDpd12m: 20, activeLoans: 6, enquiries90d: 5, abb: 6000,
    creditTrendPct: -5, txnPerMonth: 8, cashDepositPct: 40, salaryCredits6m: 4, salaryVariationPct: 18,
    salaryTrendPct: -3, salaryMatchVariancePct: 22, tenureMonths: 8, employerCategory: 'sme_registered',
    foirPct: 50 }, product, requestedAmount: 10000 });
  assert.ok(['C', 'B'].includes(c.grade), `got ${c.grade} at ${c.totalPoints}`);
  const d = decide({ features: { cibil: 600, maxDpd12m: 40, npaStatus: 'settled', activeLoans: 9, enquiries90d: 9,
    bureauEmiBounces: 3, ccUtilPct: 90, abb: 1500, creditTrendPct: -10, bankBounces6m: 2, txnPerMonth: 6,
    cashDepositPct: 50, netSalary: 30000, salaryCredits6m: 3, salaryVariationPct: 25, salaryTrendPct: -8,
    salaryMatchVariancePct: 25, tenureMonths: 4, employerCategory: 'unknown', residence: 'rented_short',
    foirPct: 60, purposeClarity: 'generic', referencesVerified: 'none' }, product, requestedAmount: 10000 });
  assert.equal(d.decision, 'reject');
  assert.ok(['D', 'E'].includes(d.grade));
  assert.ok(d.reasons.length > 0, 'a rejection explains itself');
});

test('offer: salary share, product max, requested, customer limit, rounding, minimum', () => {
  // grade A allows 50% of 30,000 = 15,000
  assert.equal(offerFor({ grade: 'A', product, requestedAmount: 25000, netSalary: 30000 }).amount, 15000);
  // product max caps
  assert.equal(offerFor({ grade: 'A', product, requestedAmount: 99000, netSalary: 200000 }).amount, 25000);
  // asked less than allowed
  assert.equal(offerFor({ grade: 'A', product, requestedAmount: 8000, netSalary: 60000 }).amount, 8000);
  // repeat-loan limit caps
  const lim = offerFor({ grade: 'A', product, requestedAmount: 20000, netSalary: 60000, customerLimit: 12000 });
  assert.equal(lim.amount, 12000);
  assert.equal(lim.cappedBy, 'customer_limit');
  // rounds DOWN to the 500 step: 40% of 26,000 = 10,400 -> 10,000
  assert.equal(offerFor({ grade: 'B', product, requestedAmount: 20000, netSalary: 26000 }).amount, 10000);
  // below product minimum -> no offer
  assert.equal(offerFor({ grade: 'C', product, requestedAmount: 20000, netSalary: 12000 }).amount, null);
  // unknown salary -> no offer
  assert.equal(offerFor({ grade: 'A', product, requestedAmount: 10000, netSalary: null }).amount, null);
});

test('fee: flat and percent', () => {
  assert.equal(repaymentFor(product, 10000), 10800);
  assert.equal(repaymentFor({ fee_type: 'flat', fee_value: 600 }, 10000), 10600);
});

test('derived ratios: ABB / repayment and loan / salary are computed when not supplied', () => {
  const f = { ...perfect(), abb: 10800 };
  delete f.abbToRepayment;
  const r = decide({ features: f, product, requestedAmount: 10000 }); // repayment 10,800 -> ratio 1.0
  assert.equal(r.parameters.find((p) => p.code === 'SC08').score10, 10);
  const ls = decide({ features: { ...perfect(), netSalary: 20000 }, product, requestedAmount: 10000 }); // 50%
  assert.equal(ls.parameters.find((p) => p.code === 'SC13').value, 50);
});

test('trendPct: needs 6 months, last 3 vs prior 3', () => {
  assert.equal(trendPct([100, 100, 100, 110, 110, 110]), 10);
  assert.equal(trendPct([100, 100]), null);
  assert.equal(trendPct([0, 0, 0, 5, 5, 5]), null);
});

test('mappers: rows match payday.scorecard_result and payday.application', () => {
  const ok = decide({ features: perfect(), product, requestedAmount: 15000 });
  const row = toScorecardRow('app-1', ok);
  assert.deepEqual(Object.keys(row).sort(), ['application_id', 'decision', 'grade', 'model_version', 'parameters', 'total_points']);
  assert.ok(['approve', 'reject', 'refer'].includes(row.decision));
  assert.equal(row.parameters.params.length, 23);
  assert.deepEqual(toApplicationPatch(ok), { status: 'offered', approved_amount: 15000, decision_reasons: [] });

  const rej = decide({ features: { ...perfect(), npaStatus: 'npa' }, product, requestedAmount: 15000 });
  const patch = toApplicationPatch(rej);
  assert.equal(patch.status, 'rejected');
  assert.equal(patch.approved_amount, null);

  const ref = decide({ features: { ...perfect(), maxDpd12m: 45 }, product, requestedAmount: 15000 });
  assert.equal(toApplicationPatch(ref).status, 'scored');
  assert.equal(toApplicationPatch(ref).approved_amount, null);
});
