// Repeat-loan limits. A customer's limit moves along a ladder after each loan closes:
//   repaid on time, no rollover          -> up one rung
//   late within the grace period, or any rollover -> hold
//   late beyond grace                    -> down one rung
//   late beyond BLOCK_AFTER_DAYS, or written off -> 0 (blocked; a person must reinstate)
// PROPOSED values: not calibrated on repayment data. The decision engine still applies its own
// grade-based cap on every application, so the limit can only ever LOWER an offer, never raise it.
//
// RBI (Digital Lending) Directions, 2025: a credit limit must not be increased unless the borrower asks. So the ladder
// only decides what a customer is ELIGIBLE for (customer_limit.eligible_amount). The limit offered stays where it was
// until the customer asks for the increase (requestLimitIncrease). Reductions and blocks apply at once.
import { daysBetween, toDate } from './dates.js';
import { BusinessRuleError } from './errors.js';
import { emitPartnerEvent } from './partners.js';

export const LADDER = [5000, 8000, 10000, 15000, 20000, 25000, 30000, 40000, 50000];
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

// Called when a loan closes. Records the limit for the customer's NEXT cycle. The ladder may find the customer eligible
// for more, but the limit offered never rises here: that needs the customer's own request.
export async function onLoanClosed({ store, loan, product, closedAt, coolingOff = false }) {
  const daysLate = Math.max(0, daysBetween(loan.due_date, toDate(closedAt)));
  const cur = await store.getCurrentLimit(loan.customer_id);
  const offered = Number(cur?.limit_amount ?? loan.principal);
  const eligible = Number(cur?.eligible_amount ?? offered);
  // Using the cooling-off exit is the customer's right, so it never counts for or against the limit.
  const n = nextLimit({
    currentLimit: eligible, daysLate, rolloverCount: coolingOff ? 1 : loan.rollover_count, productMax: Number(product.max_amount),
  });
  const limit = Math.min(offered, n.limit);
  return store.insertCustomerLimit({
    customer_id: loan.customer_id, limit_amount: limit, eligible_amount: n.limit > limit ? n.limit : null,
    cycle_number: loan.cycle_number + 1,
    reason: coolingOff ? 'cooling_off_exit' : n.action === 'increase' ? 'on_time_repay_eligible_for_increase' : n.reason, created_by: 'system',
  });
}

// The customer asks for a higher limit. Allowed only up to what the ladder says they are eligible for, and only with
// no open loan. Without an amount the full eligible limit is taken.
export async function requestLimitIncrease({ store, customer, product, requestedAmount = null }) {
  if (await store.hasOpenLoan(customer.id)) throw new BusinessRuleError('repay the open loan before asking for a higher limit');
  const cur = await store.getCurrentLimit(customer.id);
  if (!cur || Number(cur.limit_amount) <= 0) throw new BusinessRuleError('a higher limit is not available');
  const offered = Number(cur.limit_amount);
  const eligible = Math.min(Number(cur.eligible_amount ?? offered), Number(product.max_amount));
  if (eligible <= offered) throw new BusinessRuleError('a higher limit is not available right now');
  let target = eligible;
  if (requestedAmount !== null && requestedAmount !== undefined) {
    target = Number(requestedAmount);
    if (!(target > offered)) throw new BusinessRuleError('the amount asked for must be above the current limit');
    if (target > eligible) throw new BusinessRuleError(`the most available right now is ${eligible}`);
  }
  const row = await store.insertCustomerLimit({
    customer_id: customer.id, limit_amount: target, eligible_amount: eligible > target ? eligible : null,
    cycle_number: cur.cycle_number, reason: 'borrower_requested_increase', created_by: 'customer',
  });
  await emitPartnerEvent({ store, customerId: customer.id, type: 'limit.increase_granted', key: `${cur.cycle_number}:${target}`, data: { limit: target } });
  return row;
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
  const limit = Math.min(Number(cur.limit_amount), Number(product.max_amount));
  const eligibleLimit = Math.min(Number(cur.eligible_amount ?? cur.limit_amount), Number(product.max_amount));
  return {
    eligible: true, isRepeat: true, cycleNumber: cur.cycle_number, limit,
    eligibleLimit: Math.max(limit, eligibleLimit), canRequestIncrease: eligibleLimit > limit,
  };
}
