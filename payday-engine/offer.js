// Fee, repayment and offer-size maths. Pure; amounts are rupees.
import { MAX_PCT_OF_SALARY, AMOUNT_STEP } from './config.js';

const round2 = (n) => Math.round(n * 100) / 100;

// product mirrors payday.loan_product: { fee_type: 'flat'|'percent_of_principal', fee_value }
export function feeFor(product, amount) {
  const fee = product.fee_type === 'flat' ? Number(product.fee_value) : (amount * Number(product.fee_value)) / 100;
  return round2(fee);
}

export function repaymentFor(product, amount) {
  return round2(amount + feeFor(product, amount));
}

// A fee waiver gives back a share of the fee: 50 means the customer pays half of it. It scales the fee value of a COPY of
// the product, so the fee, the repayment and both APR figures all follow from the one number. The product is never changed.
export function withFeeWaiver(product, waiverPct) {
  const w = Number(waiverPct) || 0;
  if (w === 0) return product;
  if (!(w > 0 && w <= 100)) throw new RangeError(`fee waiver must be from 0 to 100, got ${waiverPct}`);
  return { ...product, fee_value: round2(Number(product.fee_value) * ((100 - w) / 100)) };
}

// Annual percentage rate for a single-repayment loan: pay out `amount`, repay amount + fee after `days`.
// Two common readings are returned because which one the key fact statement must show is a compliance
// decision, not a code one:
//   aprEffectivePct  compounded (the IRR of the cash flows, annualised on a 365-day year)
//   aprSimplePct     fee / principal annualised without compounding
export function aprFor(product, amount, days) {
  if (!(amount > 0) || !(days > 0)) return { aprEffectivePct: null, aprSimplePct: null };
  const fee = feeFor(product, amount);
  return {
    aprEffectivePct: round2((Math.pow((amount + fee) / amount, 365 / days) - 1) * 100),
    aprSimplePct: round2((fee / amount) * (365 / days) * 100),
  };
}

// Largest amount the customer may be offered, or null when it falls below the product minimum.
// Capped by: product max, grade share of net salary, the amount asked for, and any existing
// customer limit (repeat loans). Rounded DOWN to AMOUNT_STEP.
export function offerFor({
  grade, product, requestedAmount, netSalary, customerLimit = null, maxPctOfSalary = MAX_PCT_OF_SALARY, amountStep = AMOUNT_STEP,
}) {
  const pct = maxPctOfSalary[grade] ?? 0;
  const caps = [Number(product.max_amount), requestedAmount];
  if (netSalary != null) caps.push(netSalary * pct);
  else return { reason: 'net salary unknown', amount: null };
  if (customerLimit != null) caps.push(customerLimit);

  const raw = Math.min(...caps);
  const amount = Math.floor(raw / amountStep) * amountStep;
  if (amount < Number(product.min_amount)) {
    return { reason: `offer ${amount} is below product minimum ${product.min_amount}`, amount: null };
  }
  return {
    amount,
    feeAmount: feeFor(product, amount),
    repaymentAmount: repaymentFor(product, amount),
    tenureDays: Number.isFinite(Number(product.tenure_days)) ? Number(product.tenure_days) : null,
    ...aprFor(product, amount, Number(product.tenure_days)),
    cappedBy: raw === requestedAmount ? 'requested' : raw === Number(product.max_amount) ? 'product_max'
      : customerLimit != null && raw === customerLimit ? 'customer_limit' : 'salary_share',
  };
}
