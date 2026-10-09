// Agreement -> disbursement -> servicing -> repeat loan, on mock vendors and the in-memory store.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistry, memoryStore, runUnderwriting, createApplication, ApplicationError, sendAgreement, recordAgreementSigned,
  disburseLoan, completeDisbursement, reconcilePendingPayouts, auditOpenLoans, BusinessRuleError, recordPayment, rollover, writeOff, runDailyServicing, getLoanSummary, breakdown, agingBucket,
  nextLimit, repeatEligibility, dueDateFor, nextSalaryDate, splitAmount, daysBetween, istToday, LADDER,
} from './index.js';

const product = {
  id: 'prod-1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30,
  fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, rollover_allowed: true, max_rollovers: 1, active: true,
};
const SPLIT = [
  { product_id: 'prod-1', lender_id: 'lender-A', share_pct: 80, effective_from: '2020-01-01', effective_to: null },
  { product_id: 'prod-1', lender_id: 'lender-B', share_pct: 20, effective_from: '2020-01-01', effective_to: null },
];
const account = { name: 'Test Customer', number: '123456789012', ifsc: 'HDFC0000001' };
const intake = {
  declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long',
  purposeClarity: 'specific_documented', referencesVerified: 'both',
};
let seq = 0;
const nextMobile = (d) => `98765${String(++seq).padStart(4, '0')}${d}`; // last digit picks the mock scenario

async function world({ colending = SPLIT, overrides = {} } = {}) {
  const store = memoryStore({ products: [product], colending });
  const registry = createRegistry({ env: {}, overrides });
  return { store, registry };
}

// customer -> application -> underwriting -> agreement signed
async function signedOffer(w, { digit = 3, requested = 10000 } = {}) {
  const customer = await w.store.upsertCustomer({ mobile: nextMobile(digit), salary_day: 1 });
  const { application, customerLimit } = await createApplication({ store: w.store, customer, product, requestedAmount: requested });
  const uw = await runUnderwriting({ registry: w.registry, store: w.store, customer, application, product, intake, customerLimit });
  assert.equal(uw.result.decision, 'approve');
  await sendAgreement({ registry: w.registry, store: w.store, customer, application });
  await recordAgreementSigned({ store: w.store, applicationId: application.id });
  return { customer, application, uw };
}
const disburse = (w, o, extra = {}) => disburseLoan({
  registry: w.registry, store: w.store, customer: o.customer, application: o.application, product, account, asOf: '2026-01-01', ...extra,
});

test('dates: salary-day snapping, month-end clamping, exact splits, IST', () => {
  assert.equal(nextSalaryDate('2026-01-20', 5, 7), '2026-02-05');
  assert.equal(nextSalaryDate('2026-02-01', 31, 0), '2026-02-28');
  assert.equal(dueDateFor({ asOf: '2026-01-01', product }), '2026-01-31');
  assert.equal(dueDateFor({ asOf: '2026-01-01', product, salaryDay: 5, snapToSalaryDay: true }), '2026-01-31', 'a salary date past the tenure falls back to the tenure');
  assert.equal(dueDateFor({ asOf: '2026-01-01', product, salaryDay: 15, snapToSalaryDay: true }), '2026-01-15');
  const parts = splitAmount(100, [{ lender_id: 'a', share_pct: 33.33 }, { lender_id: 'b', share_pct: 33.33 }, { lender_id: 'c', share_pct: 33.34 }]);
  assert.equal(parts.reduce((a, p) => a + p.amount, 0), 100);
  assert.equal(daysBetween('2026-01-31', '2026-02-10'), 10);
  assert.match(istToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test('limits: the ladder moves one rung, holds, drops, and blocks', () => {
  const n = (o) => nextLimit({ currentLimit: 10000, daysLate: 0, ...o });
  assert.deepEqual([n({}).limit, n({}).action], [15000, 'increase']);
  assert.equal(n({ daysLate: 2 }).action, 'hold');
  assert.equal(n({ rolloverCount: 1 }).action, 'hold');
  assert.deepEqual([n({ daysLate: 10 }).limit, n({ daysLate: 10 }).action], [8000, 'reduce']);
  assert.deepEqual([n({ daysLate: 31 }).limit, n({ daysLate: 31 }).action], [0, 'block']);
  assert.equal(n({ writtenOff: true }).limit, 0);
  assert.equal(nextLimit({ currentLimit: 25000, daysLate: 0 }).action, 'hold');           // top of ladder
  assert.equal(nextLimit({ currentLimit: 5000, daysLate: 10 }).limit, 5000);              // nothing lower
  assert.equal(nextLimit({ currentLimit: 12000, daysLate: 0 }).limit, 15000);             // off-ladder limit
  assert.equal(nextLimit({ currentLimit: 20000, daysLate: 0, productMax: 20000 }).limit, 20000, 'never above the product maximum');
  assert.deepEqual(LADDER, [5000, 8000, 10000, 15000, 20000, 25000]);
});

test('createApplication: product, amount and eligibility guards', async () => {
  const w = await world();
  const c = await w.store.upsertCustomer({ mobile: nextMobile(3) });
  const code = async (fn) => { try { await fn(); } catch (e) { return e instanceof ApplicationError ? e.code : `other:${e.message}`; } return 'none'; };
  assert.equal(await code(() => createApplication({ store: w.store, customer: c, product: { ...product, active: false }, requestedAmount: 10000 })), 'PRODUCT_INACTIVE');
  assert.equal(await code(() => createApplication({ store: w.store, customer: c, product, requestedAmount: 100 })), 'AMOUNT_OUT_OF_RANGE');
  assert.equal(await code(() => createApplication({ store: w.store, customer: c, product, requestedAmount: 99999 })), 'AMOUNT_OUT_OF_RANGE');
  assert.equal(await code(() => createApplication({ store: w.store, customer: c, product, requestedAmount: 10000 })), 'none');
});

test('disbursement: 80/20 co-lending split, fee split, ledger, schedule, first limit', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const r = await disburse(w, o);
  assert.equal(r.status, 'success');
  const loan = await w.store.getLoan(r.loan.id);
  assert.equal(loan.principal, 10000);
  assert.equal(loan.fee_amount, 800);
  assert.equal(loan.due_date, '2026-01-31');
  assert.equal(loan.cycle_number, 1);
  assert.ok(loan.disbursed_at);

  const shares = await w.store.getLoanShares(loan.id);
  assert.deepEqual(shares.map((s) => [s.lender_id, s.share_pct, s.principal_share]), [['lender-A', 80, 8000], ['lender-B', 20, 2000]]);
  const ledger = w.store.db.ledger.filter((e) => e.loan_id === loan.id);
  assert.deepEqual(ledger.map((e) => [e.entry_type, e.lender_id, e.amount]),
    [['disbursal', 'lender-A', 8000], ['disbursal', 'lender-B', 2000], ['fee', 'lender-A', 640], ['fee', 'lender-B', 160]]);
  assert.equal(await w.store.getLedgerBalance(loan.id), 10800);
  assert.equal((await w.store.getSchedule(loan.id))[0].fee_due, 800);
  assert.equal((await w.store.getApplication(o.application.id)).status, 'disbursed');
  const lim = await w.store.getCurrentLimit(o.customer.id);
  assert.deepEqual([lim.limit_amount, lim.cycle_number, lim.reason], [10000, 1, 'first_loan']);
});

test('disbursement: no co-lender configured means own book at 100%', async () => {
  const w = await world({ colending: [] });
  const o = await signedOffer(w);
  const r = await disburse(w, o);
  const shares = await w.store.getLoanShares(r.loan.id);
  assert.deepEqual(shares.map((s) => [s.lender_id, s.share_pct]), [['lender-own-book', 100]]);
  const bad = await world({ colending: [{ ...SPLIT[0], share_pct: 70 }, { ...SPLIT[1], share_pct: 20 }] });
  const o2 = await signedOffer(bad);
  await assert.rejects(() => disburse(bad, o2), /add to 90, expected 100/);
});

test('disbursement: safety checks (must be signed, one open loan, account details, no double pay)', async () => {
  const w = await world();
  const customer = await w.store.upsertCustomer({ mobile: nextMobile(3) });
  const { application } = await createApplication({ store: w.store, customer, product, requestedAmount: 10000 });
  await assert.rejects(() => disburse(w, { customer, application }), /expected "signed"/);

  const o = await signedOffer(w);
  await assert.rejects(() => disburse(w, o, { account: { name: 'x' } }), /account needs name, number and ifsc/);
  const first = await disburse(w, o);
  assert.equal(first.status, 'success');
  const again = await disburse(w, o);
  assert.equal(again.status, 'already_disbursed');
  assert.equal(w.store.db.disbursements.length, 1, 'a second call does not create a second payout');
  assert.equal(w.store.db.ledger.filter((e) => e.entry_type === 'disbursal').length, 2, 'ledger written once');

  const code = async () => { try { await createApplication({ store: w.store, customer: o.customer, product, requestedAmount: 5000 }); } catch (e) { return e.code; } };
  assert.equal(await code(), 'OPEN_LOAN', 'a customer with an open loan cannot apply again');
});

test('disbursement: an unknown payout outcome stays pending and a webhook-style completion finishes it', async () => {
  const timeout = { name: 'flaky', disburse: async () => { throw new Error('socket hang up'); } };
  const w = await world({ overrides: { payout: timeout } });
  const o = await signedOffer(w);
  const r = await disburse(w, o);
  assert.equal(r.status, 'unknown');
  assert.equal(r.disbursement.status, 'pending', 'never marked failed: the money may have moved');
  assert.equal((await w.store.getLoan(r.loan.id)).disbursed_at, null);
  assert.equal((await w.store.getApplication(o.application.id)).status, 'signed');

  const done = await completeDisbursement({ store: w.store, disbursementId: r.disbursement.id, result: { status: 'success', utr: 'UTR-LATE' } });
  assert.equal(done.status, 'success');
  assert.ok((await w.store.getLoan(r.loan.id)).disbursed_at);
  assert.equal((await w.store.getApplication(o.application.id)).status, 'disbursed');
  const twice = await completeDisbursement({ store: w.store, disbursementId: r.disbursement.id, result: { status: 'success', utr: 'UTR-LATE' } });
  assert.equal(twice.alreadyDone, true);
  assert.equal(w.store.db.ledger.filter((e) => e.entry_type === 'disbursal').length, 2, 'finalising twice does not double the ledger');
});

test('disbursement: a failed payout can be retried with a new attempt and reuses the same loan', async () => {
  const failing = { name: 'f', disburse: async () => ({ status: 'failed' }) };
  const w = await world({ overrides: { payout: failing } });
  const o = await signedOffer(w);
  const r1 = await disburse(w, o);
  assert.equal(r1.status, 'failed');
  w.registry.payout = createRegistry({ env: {} }).payout; // vendor fixed
  const r2 = await disburse(w, o, { attempt: 2 });
  assert.equal(r2.status, 'success');
  assert.equal(r2.loan.id, r1.loan.id, 'same loan, not a second one');
  assert.equal(w.store.db.loans.length, 1);
  assert.equal(w.store.db.disbursements.length, 2);
});

test('disbursement: a new attempt cannot open while an earlier payout is pending (no double payout)', async () => {
  const timeout = { name: 'flaky', disburse: async () => { throw new Error('socket hang up'); } };
  const w = await world({ overrides: { payout: timeout } });
  const o = await signedOffer(w);
  const r1 = await disburse(w, o);
  assert.equal(r1.status, 'unknown');
  // the operator retries with the next attempt number: refused, nothing is sent
  w.registry.payout = createRegistry({ env: {} }).payout;
  await assert.rejects(() => disburse(w, o, { attempt: 2 }), /earlier payout \(disb-.*-1\) for this loan is pending/);
  assert.equal(w.store.db.disbursements.length, 1, 'no second payout row was created');
  // the same attempt number is still the idempotent retry
  const same = await disburse(w, o, { attempt: 1 });
  assert.equal(same.status, 'success');
  assert.equal(w.store.db.disbursements.length, 1);
});

test('disbursement: a second payout reporting success is refused, not booked as another success', async () => {
  const failing = { name: 'f', disburse: async () => ({ status: 'failed' }) };
  const w = await world({ overrides: { payout: failing } });
  const o = await signedOffer(w);
  const r1 = await disburse(w, o); // attempt 1: failed
  w.registry.payout = createRegistry({ env: {} }).payout;
  const r2 = await disburse(w, o, { attempt: 2 }); // attempt 2: paid
  assert.equal(r2.status, 'success');
  // the vendor later says attempt 1 ALSO paid (it overrides 'failed'): that is a double payout
  await assert.rejects(
    () => completeDisbursement({ store: w.store, disbursementId: r1.disbursement.id, result: { status: 'success', utr: 'UTR-DOUBLE' } }),
    (e) => e instanceof BusinessRuleError && e.bad === true && /DUPLICATE PAYOUT/.test(e.message),
  );
  assert.equal((await w.store.getDisbursement(r1.disbursement.id)).status, 'failed', 'left as it was, for a person to refund');
  assert.equal(w.store.db.ledger.filter((e) => e.entry_type === 'disbursal').length, 2, 'ledger written once');
});

test('servicing: on-time payment closes the loan and steps the limit up the ladder', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const today = istToday();
  const { loan } = await disburse(w, o, { asOf: today });
  const r = await recordPayment({ store: w.store, loan, product, amount: 10800, mode: 'upi', utr: 'U-ON-TIME', paidAt: new Date().toISOString() });
  assert.deepEqual([r.applied, r.unapplied, r.closed, r.outstanding], [10800, 0, true, 0]);
  assert.equal((await w.store.getLoan(loan.id)).status, 'closed');
  assert.equal(await w.store.getLedgerBalance(loan.id), 0);
  const lim = await w.store.getCurrentLimit(o.customer.id);
  assert.deepEqual([lim.limit_amount, lim.cycle_number, lim.reason], [15000, 2, 'on_time_repay']);

  const e = await repeatEligibility({ store: w.store, customer: o.customer, product });
  assert.deepEqual([e.eligible, e.isRepeat, e.limit, e.cycleNumber], [true, true, 15000, 2]);
});

test('servicing: repeat loan is capped by the limit, flagged repeat, and reuses KYC', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const { loan } = await disburse(w, o, { asOf: istToday() });
  await recordPayment({ store: w.store, loan, product, amount: 10800, mode: 'upi', utr: 'U-R1' });

  const customer = await w.store.patchCustomer(o.customer.id, { kyc_status: 'verified' });
  const { application, customerLimit, isRepeat } = await createApplication({ store: w.store, customer, product, requestedAmount: 20000 });
  assert.equal(isRepeat, true);
  assert.equal(customerLimit, 15000);
  let kycCalls = 0;
  const spy = { name: 'spy', verify: async () => { kycCalls += 1; return { status: 'verified', checks: [] }; } };
  const registry = createRegistry({ env: {}, overrides: { kyc: spy } });
  const uw = await runUnderwriting({ registry, store: w.store, customer, application, product, intake, customerLimit, reuseKyc: true });
  assert.equal(kycCalls, 0, 'a verified repeat customer is not re-KYCd');
  assert.equal(uw.result.decision, 'approve');
  assert.equal(uw.result.offer.amount, 15000);
  assert.equal(uw.result.offer.cappedBy, 'customer_limit');
  assert.equal((await w.store.getApplication(application.id)).is_repeat, true);

  // a new loan is cycle 2
  await sendAgreement({ registry: w.registry, store: w.store, customer, application });
  await recordAgreementSigned({ store: w.store, applicationId: application.id });
  const second = await disburse(w, { customer, application }, { asOf: istToday() });
  assert.equal(second.loan.cycle_number, 2);
  assert.equal(second.loan.principal, 15000);
});

test('servicing: penalty accrues per day, never twice, and shows in the ledger and the aging bucket', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const { loan } = await disburse(w, o); // due 2026-01-31
  let s = await runDailyServicing({ store: w.store, asOf: '2026-01-31' });
  assert.deepEqual([s.processed, s.overdue, s.penaltyAdded], [1, 0, 0], 'due today is not overdue');

  s = await runDailyServicing({ store: w.store, asOf: '2026-02-10' }); // 10 days late: 10000 x 1% x 10
  assert.deepEqual([s.overdue, s.penaltyAdded], [1, 1000]);
  assert.equal((await w.store.getLoan(loan.id)).status, 'overdue');
  assert.equal(await w.store.getLedgerBalance(loan.id), 11800);

  s = await runDailyServicing({ store: w.store, asOf: '2026-02-10' });
  assert.equal(s.penaltyAdded, 0, 'running the job twice on one day adds nothing');
  s = await runDailyServicing({ store: w.store, asOf: '2026-02-11' });
  assert.equal(s.penaltyAdded, 100);

  const sum = await getLoanSummary({ store: w.store, loanId: loan.id, asOf: '2026-02-11' });
  assert.deepEqual([sum.outstanding, sum.daysOverdue, sum.bucket, sum.ledgerBalance], [11900, 11, '8-30', 11900]);
  assert.equal(sum.outstanding, sum.ledgerBalance, 'schedule and ledger agree');
  assert.deepEqual(['current', '1-7', '8-30', '31-60', '61-90', '90+'].map((b, i) => agingBucket([0, 7, 30, 60, 90, 91][i]) === b), Array(6).fill(true));
});

test('servicing: payments allocate penalty, then fee, then principal; duplicates and overpayment are safe', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const { loan } = await disburse(w, o);
  const at = '2026-02-11T10:00:00+05:30';
  const r = await recordPayment({ store: w.store, loan, product, amount: 1900, mode: 'upi', utr: 'U1', paidAt: at });
  assert.deepEqual([r.applied, r.closed, r.outstanding], [1900, false, 10000]);
  const row = (await w.store.getSchedule(loan.id))[0];
  assert.deepEqual(breakdown(row), { penaltyOutstanding: 0, feeOutstanding: 0, principalOutstanding: 10000 });
  assert.equal(await w.store.getLedgerBalance(loan.id), 10000);

  const dup = await recordPayment({ store: w.store, loan, product, amount: 1900, mode: 'upi', utr: 'U1', paidAt: at });
  assert.equal(dup.duplicate, true);
  assert.equal(await w.store.getLedgerBalance(loan.id), 10000, 'a replayed payment changes nothing');

  const over = await recordPayment({ store: w.store, loan, product, amount: 12000, mode: 'upi', utr: 'U2', paidAt: '2026-02-11T12:00:00+05:30' });
  assert.deepEqual([over.applied, over.unapplied, over.closed], [10000, 2000, true]);
  assert.equal((await w.store.getLoan(loan.id)).status, 'closed');
  assert.equal(await w.store.getLedgerBalance(loan.id), 0);
  const late = await recordPayment({ store: w.store, loan, product, amount: 500, mode: 'upi', utr: 'U3', paidAt: '2026-02-12T09:00:00+05:30' });
  assert.deepEqual([late.applied, late.unapplied], [0, 500], 'a payment after closure is recorded for refund, applied to nothing');
  await assert.rejects(() => recordPayment({ store: w.store, loan, product, amount: 0, mode: 'upi' }), /positive/);

  // closed 11 days late: beyond the 3-day grace, so the limit steps DOWN from 10000 to 8000
  const lim = await w.store.getCurrentLimit(o.customer.id);
  assert.deepEqual([lim.limit_amount, lim.reason], [8000, 'late_11d']);
});

test('servicing: rollover needs fee and penalty paid, charges a fresh fee, and is limited', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const { loan } = await disburse(w, o);
  await assert.rejects(() => rollover({ store: w.store, loan, product, asOf: '2026-02-11' }), /fee and penalty to be paid first: 1900 due, 0 paid/);
  await recordPayment({ store: w.store, loan, product, amount: 1900, mode: 'upi', utr: 'R1', paidAt: '2026-02-11T10:00:00+05:30' });

  const r = await rollover({ store: w.store, loan, product, asOf: '2026-02-11' });
  assert.deepEqual([r.principalLeft, r.newFee, r.newDue], [10000, 800, '2026-03-13']);
  const l = await w.store.getLoan(loan.id);
  assert.deepEqual([l.status, l.rollover_count, l.due_date], ['active', 1, '2026-03-13']);
  assert.equal(await w.store.getLedgerBalance(loan.id), 10800, 'ledger equals the new obligation');
  await assert.rejects(() => rollover({ store: w.store, loan, product, asOf: '2026-02-12' }), /rollover limit reached/);
  await assert.rejects(() => rollover({ store: w.store, loan, product: { ...product, rollover_allowed: false } }), /not allowed/);

  await recordPayment({ store: w.store, loan, product, amount: 10800, mode: 'upi', utr: 'R2', paidAt: '2026-03-01T12:00:00+05:30' });
  assert.equal((await w.store.getLoan(loan.id)).status, 'closed');
  const lim = await w.store.getCurrentLimit(o.customer.id);
  assert.deepEqual([lim.limit_amount, lim.reason], [10000, 'rolled_over'], 'a rolled-over loan holds the limit, it does not raise it');
});

test('servicing: write-off needs 90 days, zeroes the ledger and blocks the customer', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const { loan } = await disburse(w, o);
  await assert.rejects(() => writeOff({ store: w.store, loan, asOf: '2026-03-15' }), /at least 90 days overdue, loan is 43/);
  await runDailyServicing({ store: w.store, asOf: '2026-05-11' }); // 100 days late
  const r = await writeOff({ store: w.store, loan, asOf: '2026-05-11' });
  assert.equal(r.writtenOff, 10000 + 800 + 10000 * 0.01 * 100);
  assert.equal(await w.store.getLedgerBalance(loan.id), 0);
  assert.equal((await w.store.getLoan(loan.id)).status, 'written_off');
  const e = await repeatEligibility({ store: w.store, customer: o.customer, product });
  assert.deepEqual([e.eligible, e.code], [false, 'BLOCKED']);
});

test('database rules are mirrored by the memory store (one open loan, unique utr)', async () => {
  const w = await world();
  const o = await signedOffer(w);
  await disburse(w, o);
  await assert.rejects(() => w.store.insertLoan({ application_id: 'other-app', customer_id: o.customer.id, product_id: product.id, principal: 1, fee_amount: 0, due_date: '2026-03-01' }), /duplicate key/);
  await w.store.insertPayment({ loan_id: 'x', amount: 1, mode: 'upi', utr: 'DUP', status: 'success' });
  await assert.rejects(() => w.store.insertPayment({ loan_id: 'x', amount: 1, mode: 'upi', utr: 'DUP', status: 'success' }), /duplicate key/);
});

const later = () => new Date(Date.now() + 3600e3); // an hour from now, so a just-created payout counts as old

test('reconcile: an unknown payout is settled by asking the vendor, and only once', async () => {
  const flaky = { name: 'flaky', disburse: async () => { throw new Error('socket hang up'); }, status: async () => ({ status: 'success', utr: 'UTR-RECON' }) };
  const w = await world({ overrides: { payout: flaky } });
  const o = await signedOffer(w);
  const r = await disburse(w, o);
  assert.equal(r.status, 'unknown');

  const fresh = await reconcilePendingPayouts({ registry: w.registry, store: w.store });
  assert.equal(fresh.checked, 0, 'a payout younger than the cutoff is left alone');
  const out = await reconcilePendingPayouts({ registry: w.registry, store: w.store, olderThanMinutes: 15, now: later() });
  assert.deepEqual([out.checked, out.settled, out.failed, out.stillPending, out.errors.length], [1, 1, 0, 0, 0]);
  assert.ok((await w.store.getLoan(r.loan.id)).disbursed_at);
  assert.equal((await w.store.getApplication(o.application.id)).status, 'disbursed');
  assert.equal(await w.store.getLedgerBalance(r.loan.id), 10800);
  const again = await reconcilePendingPayouts({ registry: w.registry, store: w.store, now: later() });
  assert.equal(again.checked, 0, 'nothing pending any more');
});

test('reconcile: vendor says failed, still pending, or the lookup errors', async () => {
  for (const [vendorSays, want] of [
    [async () => ({ status: 'failed' }), { failed: 1, stillPending: 0, errors: 0, dStatus: 'failed' }],
    [async () => ({ status: 'pending' }), { failed: 0, stillPending: 1, errors: 0, dStatus: 'pending' }],
    [async () => { throw new Error('vendor 404'); }, { failed: 0, stillPending: 0, errors: 1, dStatus: 'pending' }],
  ]) {
    const w = await world({ overrides: { payout: { name: 'p', disburse: async () => { throw new Error('timeout'); }, status: vendorSays } } });
    const o = await signedOffer(w);
    const r = await disburse(w, o);
    const out = await reconcilePendingPayouts({ registry: w.registry, store: w.store, now: later() });
    assert.deepEqual([out.failed, out.stillPending, out.errors.length], [want.failed, want.stillPending, want.errors]);
    assert.equal((await w.store.getDisbursement(r.disbursement.id)).status, want.dStatus, 'an error never settles the payout either way');
    assert.equal((await w.store.getLoan(r.loan.id)).disbursed_at, null);
  }
  const noStatus = await world({ overrides: { payout: { name: 'p', disburse: async () => ({ status: 'pending' }) } } });
  await assert.rejects(() => reconcilePendingPayouts({ registry: noStatus.registry, store: noStatus.store }), (e) => e instanceof BusinessRuleError && /no status check/.test(e.message));
});

test('audit: schedule and ledger agree on a healthy loan; a stray ledger entry is reported by the daily job', async () => {
  const w = await world();
  const o = await signedOffer(w);
  const { loan } = await disburse(w, o);
  assert.deepEqual(await auditOpenLoans({ store: w.store }), []);
  const clean = await runDailyServicing({ store: w.store, asOf: '2026-01-15' });
  assert.deepEqual(clean.integrityIssues, []);

  // simulate the crash window: money booked in the ledger but never applied to the schedule
  await w.store.insertLedger([{ loan_id: loan.id, lender_id: 'lender-A', entry_type: 'repayment', direction: 'credit', amount: 100 }]);
  const dirty = await runDailyServicing({ store: w.store, asOf: '2026-01-15' });
  assert.equal(dirty.integrityIssues.length, 1);
  assert.deepEqual([dirty.integrityIssues[0].loan_id, dirty.integrityIssues[0].difference], [loan.id, 100]);
});
