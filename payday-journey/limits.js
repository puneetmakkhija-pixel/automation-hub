// Repeat-loan limits. A customer's limit moves along a ladder after each loan closes:
//   repaid on time, no rollover          -> up one rung
//   late within the grace period, or any rollover -> hold
//   late beyond grace                    -> down one rung
//   late beyond BLOCK_AFTER_DAYS, or written off -> 0 (blocked; a person must reinstate)
// PROPOSED values: not calibrated on repayment data. The decision engine still applies its own
// grade-based cap on every application, so the limit can only ever LOWER an offer, never raise it.
import { daysBetween, toDate } from './dates.js';

export const LADDER = [5000, 8000, 10000, 15000, 20000, 25000];
export const GRACE_DAYS = 3;
export const BLOCK_AFTER_DAYS = 30;

export function nextLimit({
  currentLimit, daysLate, rolloverCount = 0, writtenOff = false, productMax = Infinity, ladder = LADDER,
}) {
  const rungs = ladder.filter((r) => r <= productMax);
  const capped = Math.min(currentLimit, productMax);
  if (writtenOff) return { limit: 0, action: 'block', reason: 'written_off' };
  if (daysLate > BLOCK_AFTER_DAYS) return { limit: 0, action: 'block', reason: `late_${daysLate}d` };
  if (daysLate > GRACE_DAYS) {
    const lower = rungs.filter((r) => r < currentLimit);
    return lower.length
      ? { limit: Math.max(...lower), action: 'reduce', reason: `late_${daysLate}d` }
      : { limit: capped, action: 'hold', reason: `late_${daysLate}d_at_lowest_rung` };
  }
  if (rolloverCount > 0) return { limit: capped, action: 'hold', reason: 'rolled_over' };
  if (daysLate > 0) return { limit: capped, action: 'hold', reason: `late_${daysLate}d_within_grace` };
  const higher = rungs.filter((r) => r > currentLimit);
  return higher.length
    ? { limit: Math.min(...higher), action: 'increase', reason: 'on_time_repay' }
    : { limit: capped, action: 'hold', reason: 'at_top_of_ladder' };
}

// Called when a loan closes. Records the limit for the customer's NEXT cycle.
export async function onLoanClosed({ store, loan, product, closedAt }) {
  const daysLate = Math.max(0, daysBetween(loan.due_date, toDate(closedAt)));
  const current = (await store.getCurrentLimit(loan.customer_id))?.limit_amount ?? loan.principal;
  const n = nextLimit({
    currentLimit: Number(current), daysLate, rolloverCount: loan.rollover_count, productMax: Number(product.max_amount),
  });
  return store.insertCustomerLimit({
    customer_id: loan.customer_id, limit_amount: n.limit, cycle_number: loan.cycle_number + 1,
    reason: n.reason, created_by: 'system',
  });
}

export async function blockCustomer({ store, loan, reason }) {
  return store.insertCustomerLimit({
    customer_id: loan.customer_id, limit_amount: 0, cycle_number: loan.cycle_number + 1, reason, created_by: 'system',
  });
}

// Can this customer apply, and up to what limit? (No limit row yet = first-time customer.)
export async function repeatEligibility({ store, customer, product }) {
  if (await store.hasOpenLoan(customer.id)) return { eligible: false, code: 'OPEN_LOAN', reason: 'customer has an open loan' };
  const cur = await store.getCurrentLimit(customer.id);
  if (!cur) return { eligible: true, isRepeat: false, limit: null, cycleNumber: 1 };
  if (Number(cur.limit_amount) <= 0) return { eligible: false, code: 'BLOCKED', reason: `blocked (${cur.reason})` };
  return {
    eligible: true, isRepeat: true, cycleNumber: cur.cycle_number,
    limit: Math.min(Number(cur.limit_amount), Number(product.max_amount)),
  };
}
