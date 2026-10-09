// Run: node --test test-payday-engine.mjs  (CI also runs it as `node test-payday-engine.mjs`)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, scale, classify, maxPoints, trendPct, repaymentFor, offerFor, aprFor,
  toScorecardRow, toApplicationPatch, config, DEFAULT_POLICY, NO_BANK_POLICY, validatePolicy, resolvePolicy, PolicyError,
} from './index.js';

const product = {
  code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30,
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
  assert.deepEqual(toApplicationPatch(ok), { status: 'offered', approved_amount: 15000, offered_apr_pct: aprFor(product, 15000, 30).aprEffectivePct, decision_reasons: [] });

  const rej = decide({ features: { ...perfect(), npaStatus: 'npa' }, product, requestedAmount: 15000 });
  const patch = toApplicationPatch(rej);
  assert.equal(patch.status, 'rejected');
  assert.equal(patch.approved_amount, null);
  assert.equal(patch.offered_apr_pct, null, 'no offer, no APR');

  const ref = decide({ features: { ...perfect(), maxDpd12m: 45 }, product, requestedAmount: 15000 });
  assert.equal(toApplicationPatch(ref).status, 'scored');
  assert.equal(toApplicationPatch(ref).approved_amount, null);
});

// ---------------------------------------------------------------- credit policy
const policy = () => structuredClone(DEFAULT_POLICY);
const errorsOf = (p) => validatePolicy(p).errors.join(' | ');

test('policy: the built-in default is valid, reproduces the old behaviour, and is stored as plain JSON', () => {
  const v = validatePolicy(DEFAULT_POLICY);
  assert.deepEqual([v.ok, v.maxPoints], [true, 122]);
  assert.equal(JSON.parse(JSON.stringify(DEFAULT_POLICY)).bands[4].min, null, 'the lowest band survives a JSON round trip');
  const r = decide({ features: perfect(), product, requestedAmount: 15000, policy: JSON.parse(JSON.stringify(DEFAULT_POLICY)) });
  assert.deepEqual([r.totalPoints, r.grade, r.decision, r.modelVersion], [122, 'A', 'approve', 'PAYDAY_V1']);
});

test('policy: a credit-team edit changes the decision and the version is recorded on the result', () => {
  const stricter = policy();
  stricter.version = 'PAYDAY_V2';
  stricter.bands[0].min = 121;                       // A now needs 121 of 122
  stricter.bands[1].min = 120;
  const f = { ...perfect(), cibil: 700 };            // a slightly weaker file
  const base = decide({ features: f, product, requestedAmount: 10000 });
  const strict = decide({ features: f, product, requestedAmount: 10000, policy: stricter });
  assert.equal(base.grade, 'A');
  assert.notEqual(strict.grade, 'A');
  assert.equal(strict.modelVersion, 'PAYDAY_V2');

  const lowerCap = policy();
  lowerCap.maxPctOfSalary.A = 0.1;                   // offers capped at 10% of salary
  assert.equal(decide({ features: perfect(), product, requestedAmount: 15000, policy: lowerCap }).offer.amount, 6000);

  const looseDpd = policy();
  looseDpd.flags.review.RF4.dpd = 60;                // DPD 45 no longer needs a person
  assert.equal(decide({ features: { ...perfect(), maxDpd12m: 45 }, product, requestedAmount: 10000, policy: looseDpd }).decision, 'approve');
  const flagOff = policy();
  flagOff.flags.review.RF4.enabled = false;
  assert.equal(decide({ features: { ...perfect(), maxDpd12m: 45 }, product, requestedAmount: 10000, policy: flagOff }).decision, 'approve');
});

test('policy: safety rules cannot be edited away', () => {
  const p = policy(); p.decisionByGrade.E = 'approve';
  assert.match(errorsOf(p), /grade E must decide "reject"/);
  const q = policy(); q.flags.hard = { RF1: { enabled: false } };
  assert.match(errorsOf(q), /hard declines are fixed in code/);
  // and a hard decline still rejects whatever the policy says
  const lenient = policy(); lenient.bands[4].min = null; lenient.bands[3].min = 0; lenient.bands[2].min = 1;
  assert.equal(decide({ features: { ...perfect(), npaStatus: 'npa' }, product, requestedAmount: 10000, policy: lenient }).decision, 'reject');
});

test('policy: bad edits are caught with a plain-language reason', () => {
  const cases = [
    [(p) => { p.params[0].field = 'creditScoreFromTheMoon'; }, /not a feature the system produces/],
    [(p) => { p.params[0].weight = -3; }, /weight must be a number above 0/],
    [(p) => { p.params[1].code = p.params[0].code; }, /is duplicated/],
    [(p) => { p.params[0].worst = p.params[0].best; }, /worst and best must differ/],
    [(p) => { p.params[2].map.none = 11; }, /must be 0 to 10/],
    [(p) => { p.bands[0].min = 5; }, /must be above band B min/],
    [(p) => { p.bands[0].min = 500; p.bands[1].min = 400; p.bands[2].min = 300; p.bands[3].min = 200; }, /no one could reach it/],
    [(p) => { p.bands[4].min = 0; }, /band E must have min null/],
    [(p) => { p.bands.splice(2, 1); }, /exactly A, B, C, D, E/],
    [(p) => { p.maxPctOfSalary.A = 1.5; }, /maxPctOfSalary needs a number from 0 to 1/],
    [(p) => { p.amountStep = 0; }, /amountStep must be a whole number/],
    [(p) => { p.flags.review.RF8.pct = 250; }, /RF8\.pct must be 0 to 100/],
    [(p) => { delete p.flags.review.RF12; }, /RF12 needs enabled/],
    [(p) => { p.surprise = true; }, /unknown key "surprise"/],
    [(p) => { p.version = 'has spaces!'; }, /version must be/],
    [(p) => { p.maxMissingForAuto = 99; }, /maxMissingForAuto/],
  ];
  for (const [mutate, want] of cases) {
    const p = policy(); mutate(p);
    assert.match(errorsOf(p), want);
  }
  assert.equal(validatePolicy(null).ok, false);
  assert.equal(validatePolicy([]).ok, false);
});

test('policy: an invalid policy never decides (fail closed)', () => {
  const p = policy(); p.bands[0].min = 5;
  assert.throws(() => decide({ features: perfect(), product, requestedAmount: 10000, policy: p }), PolicyError);
  assert.throws(() => resolvePolicy({}), PolicyError);
});

test('policy: a policy may drop a parameter; the maximum score follows its weights', () => {
  const p = policy();
  p.params = p.params.filter((q) => q.code !== 'SC12');  // drop cash deposits (weight 3)
  p.version = 'NO_CASH';
  p.bands[0].min = 95;
  const r = decide({ features: perfect(), product, requestedAmount: 10000, policy: p });
  assert.deepEqual([r.maxPoints, r.totalPoints, r.parameters.length], [119, 119, 22]);
});

// ---------------------------------------------------------------- APR
test('APR: effective (compounded) and simple readings for a single-repayment loan', () => {
  const a = aprFor(product, 10000, 30);
  assert.equal(a.aprSimplePct, 97.33);                                        // 8% x 365 / 30
  assert.equal(a.aprEffectivePct, Math.round((Math.pow(1.08, 365 / 30) - 1) * 10000) / 100);
  assert.deepEqual(aprFor(product, 0, 30), { aprEffectivePct: null, aprSimplePct: null });
  assert.deepEqual(aprFor(product, 10000, 0), { aprEffectivePct: null, aprSimplePct: null });
  const flat = aprFor({ fee_type: 'flat', fee_value: 500 }, 10000, 15);
  assert.equal(flat.aprSimplePct, 121.67);                                    // 5% x 365 / 15
});

test('APR travels with the offer and into the application row', () => {
  const r = decide({ features: perfect(), product, requestedAmount: 10000 });
  assert.equal(r.offer.tenureDays, 30);
  assert.equal(r.offer.aprSimplePct, 97.33);
  assert.equal(toApplicationPatch(r).offered_apr_pct, r.offer.aprEffectivePct);
});

test('no-bank policy: valid, 14 parameters, none of them reads bank data', () => {
  const v = validatePolicy(NO_BANK_POLICY);
  assert.deepEqual([v.ok, v.errors, v.maxPoints, NO_BANK_POLICY.params.length], [true, [], 75, 14]);
  const bankFields = ['abbToRepayment', 'abb', 'creditTrendPct', 'bankBounces6m', 'txnPerMonth', 'cashDepositPct', 'salaryCredits6m', 'salaryVariationPct', 'salaryTrendPct', 'salaryMatchVariancePct'];
  assert.ok(NO_BANK_POLICY.params.every((p) => !bankFields.includes(p.field)));
  assert.equal(NO_BANK_POLICY.flags.review.RF9.enabled, false);
});

test('no-bank policy: a clean file with no bank data is approved; the full scorecard would refer it', () => {
  const f = perfect();
  for (const k of ['abb', 'creditTrendPct', 'bankBounces6m', 'txnPerMonth', 'cashDepositPct', 'salaryCredits6m', 'salaryVariationPct', 'salaryTrendPct', 'salaryMatchVariancePct']) f[k] = null;
  const lite = decide({ features: f, product, requestedAmount: 10000, policy: NO_BANK_POLICY });
  assert.deepEqual([lite.grade, lite.decision, lite.missingCount, lite.modelVersion], ['A', 'approve', 0, 'PAYDAY_LITE_V1']);
  const full = decide({ features: f, product, requestedAmount: 10000 });
  assert.equal(full.decision, 'refer');
  assert.match(full.reasons.join(' '), /Insufficient data/);
});

test('no-bank policy: missing bureau data is never approved, and hard declines still apply', () => {
  const f = { ...perfect(), cibil: null, maxDpd12m: null, activeLoans: null, enquiries90d: null, bureauEmiBounces: null, ccUtilPct: null };
  assert.notEqual(decide({ features: f, product, requestedAmount: 10000, policy: NO_BANK_POLICY }).decision, 'approve');
  const npa = decide({ features: { ...perfect(), npaStatus: 'npa' }, product, requestedAmount: 10000, policy: NO_BANK_POLICY });
  assert.deepEqual([npa.grade, npa.decision], ['E', 'reject']);
});
