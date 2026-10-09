// Loyalty reward: a wheel of fortune for customers who keep coming back and repay.
//
// Rules, all enforced here and never by the browser:
//   * one spin is earned for every repaid loan from the third on (3 repaid loans = 1 spin, 4 = 2, and so on)
//   * the wheel has ten EQUAL slices, so the odds are exactly what the slices show; the slice is drawn on the server
//   * every slice is a waiver of the fee on the customer's NEXT loan (10 to 50 percent of the fee); nothing is ever lost
//   * the waiver is stored with the spin, valid for REWARD_VALID_DAYS, used once, and lowers the fee, the repayment and
//     the APR shown in the offer and the agreement, so the key facts are always true
// The promotion is a chance-based draw: it needs the lender's compliance sign-off before it runs for real customers.
import { randomInt } from 'node:crypto';
import { withFeeWaiver } from '../payday-engine/index.js';
import { BusinessRuleError } from './errors.js';

export const WHEEL = Object.freeze([10, 20, 10, 30, 10, 20, 40, 10, 20, 50]); // percent of the fee waived, per slice
export const MIN_REPAID_LOANS = 3;
export const REWARD_VALID_DAYS = 30;

// How many slices give each waiver, so the odds can be shown to the customer.
export function wheelOdds() {
  const out = {};
  for (const w of WHEEL) out[w] = (out[w] ?? 0) + 1;
  return Object.entries(out).map(([waiver, slices]) => ({ waiver: Number(waiver), slices, of: WHEEL.length }));
}

export async function spinsAvailable({ store, customerId }) {
  const repaid = await store.countClosedLoans(customerId);
  const spun = await store.countRewards(customerId);
  return { repaid, spun, available: Math.max(0, repaid - (MIN_REPAID_LOANS - 1) - spun), needed: MIN_REPAID_LOANS };
}

export async function getRewardState({ store, customerId, now = new Date() }) {
  const s = await spinsAvailable({ store, customerId });
  const reward = await store.getUsableReward(customerId, now.toISOString());
  return {
    spins_available: s.available, repaid_loans: s.repaid, loans_needed: s.needed,
    reward: reward ? { waiver_pct: Number(reward.waiver_pct), expires_at: reward.expires_at } : null,
  };
}

// rng(n) must return a whole number from 0 to n-1; the default is the platform's cryptographic generator.
export async function spinWheel({ store, customerId, now = new Date(), rng = randomInt }) {
  const s = await spinsAvailable({ store, customerId });
  if (s.available < 1) throw new BusinessRuleError('no spin available');
  const slice = rng(WHEEL.length);
  if (!Number.isInteger(slice) || slice < 0 || slice >= WHEEL.length) throw new Error('wheel: random draw out of range');
  const expires = new Date(now.getTime() + REWARD_VALID_DAYS * 86_400_000).toISOString();
  try {
    const reward = await store.insertReward({
      customer_id: customerId, kind: 'fee_waiver', waiver_pct: WHEEL[slice], slice, spin_no: s.spun + 1, expires_at: expires,
    });
    return { slice, waiver_pct: WHEEL[slice], expires_at: reward.expires_at, reward };
  } catch (e) {
    // two spins at once: the database allows one row per (customer, spin number)
    if (e.code === '23505') throw new BusinessRuleError('that spin was already taken');
    throw e;
  }
}

// At application time: the reward to apply (oldest first, so none runs out unused) and the product with the fee lowered.
export async function applyReward({ store, application, product, now = new Date() }) {
  const reward = await store.getUsableReward(application.customer_id, now.toISOString());
  if (!reward) return { product, waiverPct: 0, reward: null };
  await store.patchApplication(application.id, { fee_waiver_pct: Number(reward.waiver_pct) });
  await store.attachReward(reward.id, application.id);
  return { product: withFeeWaiver(product, reward.waiver_pct), waiverPct: Number(reward.waiver_pct), reward };
}

// When the money has been paid out: the reward is used up. Before that, an application that lapses gives it back.
export const consumeReward = ({ store, applicationId, now = new Date() }) => store.markRewardUsed(applicationId, now.toISOString());
