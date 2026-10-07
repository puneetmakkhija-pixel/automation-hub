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

// Largest amount the customer may be offered, or null when it falls below the product minimum.
// Capped by: product max, grade share of net salary, the amount asked for, and any existing
// customer limit (repeat loans). Rounded DOWN to AMOUNT_STEP.
export function offerFor({ grade, product, requestedAmount, netSalary, customerLimit = null }) {
  const pct = MAX_PCT_OF_SALARY[grade] ?? 0;
  const caps = [Number(product.max_amount), requestedAmount];
  if (netSalary != null) caps.push(netSalary * pct);
  else return { reason: 'net salary unknown', amount: null };
  if (customerLimit != null) caps.push(customerLimit);

  const raw = Math.min(...caps);
  const amount = Math.floor(raw / AMOUNT_STEP) * AMOUNT_STEP;
  if (amount < Number(product.min_amount)) {
    return { reason: `offer ${amount} is below product minimum ${product.min_amount}`, amount: null };
  }
  return {
    amount,
    feeAmount: feeFor(product, amount),
    repaymentAmount: repaymentFor(product, amount),
    cappedBy: raw === requestedAmount ? 'requested' : raw === Number(product.max_amount) ? 'product_max'
      : customerLimit != null && raw === customerLimit ? 'customer_limit' : 'salary_share',
  };
}
