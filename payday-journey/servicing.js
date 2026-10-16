// LMS servicing: payments, penalty accrual, rollover, write-off, daily job.
//
// Ledger convention (payday.ledger_entry): debit = amount the customer owes more (disbursal, fee,
// penalty); credit = owes less (repayment, write-off). Balance = debits - credits = outstanding.
// Every entry is split across the loan's lenders by share, so lender settlement can be read straight from it.
//
// Payment allocation order is penalty, then fee, then principal.
import { BusinessRuleError } from './errors.js';
import { feeFor } from '../payday-engine/index.js';
import {
  round2, istToday, toDate, addDays, daysBetween, splitAmount,
} from './dates.js';
import { onLoanClosed, blockCustomer } from './limits.js';
import { emitPartnerEvent } from './partners.js';

const OPEN = ['active', 'overdue'];
const EPS = 0.004;

// Cooling-off (RBI Digital Lending Directions, 2025): after the money is sent the borrower may exit by repaying the
// principal and the fee for the days the money was held, with no penalty. At least 1 day; a product may set more.
export const COOLING_OFF_DAYS = 1;
export const coolingOffDaysOf = (product) => Math.max(1, Number(product?.cooling_off_days ?? COOLING_OFF_DAYS));

const owedOf = (s) => round2(Number(s.principal_due) + Number(s.fee_due) + Number(s.penalty_due) - Number(s.paid_amount));
export const outstandingOf = (rows) => round2(rows.reduce((a, s) => a + owedOf(s), 0));

// How much of each component is paid, applying penalty -> fee -> principal.
export function breakdown(row) {
  let rem = Number(row.paid_amount);
  const penaltyPaid = Math.min(rem, Number(row.penalty_due)); rem -= penaltyPaid;
  const feePaid = Math.min(rem, Number(row.fee_due)); rem -= feePaid;
  const principalPaid = Math.min(rem, Number(row.principal_due));
  return {
    penaltyOutstanding: round2(row.penalty_due - penaltyPaid),
    feeOutstanding: round2(row.fee_due - feePaid),
    principalOutstanding: round2(row.principal_due - principalPaid),
  };
}

export const agingBucket = (days) => (days <= 0 ? 'current' : days <= 7 ? '1-7' : days <= 30 ? '8-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+');

async function ledger(store, loanId, entryType, direction, amount, refTable, refId) {
  if (amount <= 0) return;
  const shares = await store.getLoanShares(loanId);
  await store.insertLedger(splitAmount(amount, shares).filter((p) => p.amount > 0).map((p) => ({
    loan_id: loanId, lender_id: p.lender_id, entry_type: entryType, direction, amount: p.amount, ref_table: refTable, ref_id: refId,
  })));
}

export async function getLoanSummary({ store, loanId, asOf = istToday() }) {
  const loan = await store.getLoan(loanId);
  if (!loan) return null;
  const rows = await store.getSchedule(loanId);
  const outstanding = outstandingOf(rows);
  const daysOverdue = OPEN.includes(loan.status) ? Math.max(0, daysBetween(loan.due_date, asOf)) : 0;
  return { loan, schedule: rows, outstanding, daysOverdue, bucket: agingBucket(daysOverdue), ledgerBalance: await store.getLedgerBalance(loanId) };
}

// Penalty = principal x rate/day x days overdue, on the scheduled principal only (never on fees or
// earlier penalty, so it does not compound). Never decreases. Idempotent: recomputed from dates each run.
export async function accruePenalty({ store, loan, product, asOf = istToday() }) {
  const rows = await store.getSchedule(loan.id);
  let added = 0;
  let overdue = false;
  for (const row of rows) {
    if (row.due_date >= asOf || owedOf(row) <= EPS) continue;
    overdue = true;
    const days = daysBetween(row.due_date, asOf);
    const total = round2(Number(row.principal_due) * (Number(product.penalty_per_day_pct) / 100) * days);
    const delta = round2(Math.max(0, total - Number(row.penalty_due)));
    await store.patchSchedule(row.id, { penalty_due: round2(Number(row.penalty_due) + delta), status: 'overdue' });
    if (delta > 0) {
      await ledger(store, loan.id, 'penalty', 'debit', delta, 'repayment_schedule', row.id);
      added = round2(added + delta);
    }
  }
  if (overdue && loan.status === 'active') {
    await store.patchLoan(loan.id, { status: 'overdue' });
    await emitPartnerEvent({ store, applicationId: loan.application_id, type: 'loan.overdue', data: { loan_id: loan.id, due_date: loan.due_date } });
  }
  return { added, overdue };
}

export function coolingOffWindow({ loan, product, asOf = istToday() }) {
  if (!loan?.disbursed_at) return null;
  const starts = toDate(loan.disbursed_at);
  const ends = addDays(starts, coolingOffDaysOf(product));
  return { starts, ends, open: OPEN.includes(loan.status) && Number(loan.rollover_count) === 0 && asOf <= ends };
}

// What an exit costs today: the principal plus the fee for the days held (never less than one day). Read-only.
export async function coolingOffQuote({ store, loan: loanRef, product, asOf = istToday() }) {
  const loan = await store.getLoan(loanRef.id);
  const w = loan && coolingOffWindow({ loan, product, asOf });
  if (!w || !w.open) return { open: false, ends: w?.ends ?? null };
  const rows = await store.getSchedule(loan.id);
  if (rows.length !== 1) return { open: false, ends: w.ends };
  const tenure = Math.max(1, daysBetween(w.starts, rows[0].due_date));
  const days = Math.max(1, daysBetween(w.starts, asOf));
  const fee = round2(Math.min(Number(loan.fee_amount), (Number(loan.fee_amount) * days) / tenure));
  const paid = Number(rows[0].paid_amount);
  return {
    open: true, ends: w.ends, days_held: days, principal: Number(rows[0].principal_due), fee, fee_reversed: round2(Number(loan.fee_amount) - fee),
    amount_due: round2(Math.max(0, Number(rows[0].principal_due) + fee - paid)), requested: Boolean(loan.cooling_off_exit_at),
  };
}

// The borrower says they want to exit. Nothing changes in the ledger yet: the fee is reduced when the payment arrives
// inside the window (see recordPayment), so asking and then not paying costs nothing and gains nothing.
export async function requestCoolingOffExit({ store, loan: loanRef, product, asOf = istToday() }) {
  const loan = await store.getLoan(loanRef.id);
  if (!loan || !loan.disbursed_at || !OPEN.includes(loan.status)) throw new BusinessRuleError('loan is not open');
  const q = await coolingOffQuote({ store, loan, product, asOf });
  if (!q.open) throw new BusinessRuleError(q.ends ? `the cooling-off period ended on ${q.ends}` : 'the cooling-off exit is not available for this loan');
  if (!loan.cooling_off_exit_at) {
    await store.patchLoan(loan.id, { cooling_off_exit_at: new Date().toISOString() });
    await emitPartnerEvent({ store, applicationId: loan.application_id, type: 'loan.cooling_off_requested', data: { loan_id: loan.id, amount_due: q.amount_due, ends: q.ends } });
  }
  return { ...q, requested: true };
}

// Called with a confirmed payment, inside the window, for a loan whose borrower asked to exit: cut the fee to the days
// held. Safe to run twice: it works from the original fee on the loan and never raises a fee.
async function applyCoolingOffFee({ store, loan, product, asOf }) {
  const q = await coolingOffQuote({ store, loan, product, asOf });
  if (!q.open) return false;
  const [row] = await store.getSchedule(loan.id);
  if (Number(row.fee_due) <= q.fee + EPS) return true;
  const reversal = round2(Number(row.fee_due) - q.fee);
  await store.patchSchedule(row.id, { fee_due: q.fee });
  await ledger(store, loan.id, 'fee_reversal', 'credit', reversal, 'loan', loan.id);
  return true;
}

// Record a CONFIRMED payment. Idempotent on utr. The payment row is written first, so a duplicate
// utr is refused by the database before anything else changes.
export async function recordPayment({ store, loan: loanRef, product, amount, mode, utr = null, paidAt = new Date().toISOString() }) {
  if (!(amount > 0)) throw new BusinessRuleError('payment amount must be positive');
  if (utr) {
    const existing = await store.findPaymentByUtr(utr);
    if (existing) return { duplicate: true, payment: existing };
  }
  let loan = await store.getLoan(loanRef.id);
  if (!loan || !loan.disbursed_at) throw new BusinessRuleError('loan not found or not disbursed');

  const payment = await store.insertPayment({ loan_id: loan.id, amount, mode, utr, status: 'success', paid_at: paidAt });
  if (!OPEN.includes(loan.status)) {
    // Paid after the loan closed: recorded for refund handling, applied to nothing.
    return { duplicate: false, payment, applied: 0, unapplied: round2(amount), closed: false, outstanding: 0 };
  }

  const payDate = toDate(paidAt);
  const coolingOff = Boolean(loan.cooling_off_exit_at) && await applyCoolingOffFee({ store, loan, product, asOf: payDate });
  await accruePenalty({ store, loan, product, asOf: payDate });
  const rows = await store.getSchedule(loan.id);

  let remaining = round2(amount);
  let applied = 0;
  for (const row of rows) {
    const owed = owedOf(row);
    if (owed <= EPS || remaining <= 0) continue;
    const add = round2(Math.min(remaining, owed));
    const newPaid = round2(Number(row.paid_amount) + add);
    const left = round2(owed - add);
    await store.patchSchedule(row.id, { paid_amount: newPaid, status: left <= EPS ? 'paid' : row.due_date < payDate ? 'overdue' : 'part_paid' });
    remaining = round2(remaining - add);
    applied = round2(applied + add);
  }
  await ledger(store, loan.id, 'repayment', 'credit', applied, 'payment', payment.id);

  const after = await store.getSchedule(loan.id);
  const outstanding = outstandingOf(after);
  await emitPartnerEvent({
    store, applicationId: loan.application_id, type: 'payment.received', key: payment.id,
    data: { loan_id: loan.id, payment_id: payment.id, amount: Number(amount), applied, outstanding, closed: outstanding <= EPS },
  });
  let closed = false;
  if (outstanding <= EPS) {
    loan = await store.patchLoan(loan.id, { status: 'closed', closed_at: paidAt });
    await onLoanClosed({ store, loan, product, closedAt: payDate, coolingOff });
    await emitPartnerEvent({ store, applicationId: loan.application_id, type: 'loan.closed', data: { loan_id: loan.id, reason: coolingOff ? 'cooling_off_exit' : 'repaid' } });
    closed = true;
  }
  return { duplicate: false, payment, applied, unapplied: round2(amount - applied), closed, outstanding };
}

// Extend a single-installment loan. Fee and penalty must be fully paid first; the unpaid principal
// then carries a fresh fee and a new due date. Allowed only if the product permits rollover.
export async function rollover({ store, loan: loanRef, product, asOf = istToday() }) {
  const loan = await store.getLoan(loanRef.id);
  if (!product.rollover_allowed) throw new BusinessRuleError('rollover is not allowed for this product');
  if (!loan || !loan.disbursed_at || !OPEN.includes(loan.status)) throw new BusinessRuleError('loan is not open');
  if (loan.rollover_count >= product.max_rollovers) throw new BusinessRuleError(`rollover limit reached (${product.max_rollovers})`);

  await accruePenalty({ store, loan, product, asOf });
  const rows = await store.getSchedule(loan.id);
  if (rows.length !== 1) throw new BusinessRuleError('rollover supports single-installment loans only');
  const row = rows[0];

  const need = round2(Number(row.fee_due) + Number(row.penalty_due));
  if (Number(row.paid_amount) + EPS < need) {
    throw new BusinessRuleError(`rollover requires fee and penalty to be paid first: ${need} due, ${row.paid_amount} paid`);
  }
  const principalLeft = round2(Number(row.principal_due) - (Number(row.paid_amount) - need));
  if (principalLeft <= EPS) throw new BusinessRuleError('nothing left to roll over');

  const newFee = feeFor(product, principalLeft);
  const base = row.due_date > asOf ? row.due_date : asOf;
  const newDue = addDays(base, product.tenure_days);
  await store.patchSchedule(row.id, { principal_due: principalLeft, fee_due: newFee, penalty_due: 0, paid_amount: 0, due_date: newDue, status: 'due' });
  const updated = await store.patchLoan(loan.id, { due_date: newDue, rollover_count: loan.rollover_count + 1, status: 'active' });
  await ledger(store, loan.id, 'fee', 'debit', newFee, 'loan', loan.id);
  await emitPartnerEvent({ store, applicationId: loan.application_id, type: 'loan.rolled_over', key: String(updated.rollover_count), data: { loan_id: loan.id, due_date: newDue, rollover_count: updated.rollover_count } });
  return { loan: updated, principalLeft, newFee, newDue };
}

export async function writeOff({ store, loan: loanRef, asOf = istToday(), reason = 'written_off', minDaysOverdue = 90 }) {
  const loan = await store.getLoan(loanRef.id);
  if (!loan || !OPEN.includes(loan.status)) throw new BusinessRuleError('loan is not open');
  const days = daysBetween(loan.due_date, asOf);
  if (days < minDaysOverdue) throw new BusinessRuleError(`write-off needs at least ${minDaysOverdue} days overdue, loan is ${Math.max(0, days)}`);
  const rows = await store.getSchedule(loan.id);
  const amount = outstandingOf(rows);
  await ledger(store, loan.id, 'writeoff', 'credit', amount, 'loan', loan.id);
  for (const r of rows) await store.patchSchedule(r.id, { status: 'written_off' });
  const updated = await store.patchLoan(loan.id, { status: 'written_off', closed_at: new Date().toISOString() });
  await blockCustomer({ store, loan: updated, reason });
  await emitPartnerEvent({ store, applicationId: loan.application_id, type: 'loan.written_off', data: { loan_id: loan.id } });
  return { loan: updated, writtenOff: amount };
}

// Integrity check: for every open loan, what the schedule says is owed must equal the ledger balance.
// A payment is recorded, then the schedule and ledger are updated in separate calls (not one database
// transaction), so a crash in between would show up here as a difference. Detects; does not repair.
export async function auditOpenLoans({ store }) {
  const issues = [];
  for (const loan of await store.listOpenLoans()) {
    const outstanding = outstandingOf(await store.getSchedule(loan.id));
    const ledgerBalance = round2(await store.getLedgerBalance(loan.id));
    if (Math.abs(outstanding - ledgerBalance) > 0.01) {
      issues.push({ loan_id: loan.id, schedule_outstanding: outstanding, ledger_balance: ledgerBalance, difference: round2(outstanding - ledgerBalance) });
    }
  }
  return issues;
}

// Daily job (cron): accrue penalty and flag overdue on every open loan, then audit.
export async function runDailyServicing({ store, asOf = istToday() }) {
  const loans = await store.listOpenLoans();
  const products = new Map();
  const summary = { processed: 0, overdue: 0, penaltyAdded: 0, errors: [] };
  for (const loan of loans) {
    try {
      if (!products.has(loan.product_id)) products.set(loan.product_id, await store.getProduct(loan.product_id));
      const r = await accruePenalty({ store, loan, product: products.get(loan.product_id), asOf });
      summary.processed += 1;
      if (r.overdue) summary.overdue += 1;
      summary.penaltyAdded = round2(summary.penaltyAdded + r.added);
    } catch (e) {
      summary.errors.push(`${loan.id}: ${e.message}`); // one bad loan must not stop the run
    }
  }
  summary.integrityIssues = await auditOpenLoans({ store });
  return summary;
}
