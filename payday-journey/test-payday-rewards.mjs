// Run: node --test test-payday-rewards.mjs  (CI also runs it as `node test-payday-rewards.mjs`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore, WHEEL, wheelOdds, spinsAvailable, getRewardState, spinWheel, applyReward, consumeReward, BusinessRuleError, REWARD_VALID_DAYS } from './index.js';

const product = { id: 'p1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 50000, tenure_days: 30, fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, active: true };
const NOW = new Date('2026-10-09T10:00:00Z');

async function world() {
  const store = memoryStore({ products: [product] });
  const c = await store.upsertCustomer({ mobile: '9876500003' });
  const closeLoans = async (n) => {
    for (let i = 0; i < n; i += 1) {
      await store.insertLoan({ application_id: `a${Math.random()}`, customer_id: c.id, product_id: 'p1', cycle_number: 1, principal: 10000, fee_amount: 800, due_date: '2026-09-01', status: 'closed', disbursed_at: '2026-08-01T00:00:00Z' });
    }
  };
  return { store, customerId: c.id, closeLoans };
}

test('the wheel: ten equal slices, every one a waiver of 10 to 50 percent, odds that add up and are disclosed', () => {
  assert.equal(WHEEL.length, 10);
  assert.ok(WHEEL.every((w) => w >= 10 && w <= 50 && w % 10 === 0));
  assert.deepEqual([Math.min(...WHEEL), Math.max(...WHEEL)], [10, 50], 'both ends are on the wheel');
  const odds = wheelOdds();
  assert.equal(odds.reduce((a, o) => a + o.slices, 0), 10);
  assert.deepEqual(odds.map((o) => [o.waiver, o.slices]), [[10, 4], [20, 3], [30, 1], [40, 1], [50, 1]]);
  assert.equal(WHEEL.reduce((a, b) => a + b, 0) / WHEEL.length, 22, 'on average the waiver is 22 percent of the fee');
});

test('spins: none before the third repaid loan, then one for each repaid loan from the third on', async () => {
  const w = await world();
  assert.equal((await spinsAvailable(w)).available, 0);
  await w.closeLoans(2);
  assert.equal((await spinsAvailable(w)).available, 0, 'two repaid loans earn nothing');
  await assert.rejects(() => spinWheel(w), (e) => e instanceof BusinessRuleError && /no spin/.test(e.message));
  await w.closeLoans(1);
  assert.equal((await spinsAvailable(w)).available, 1, 'the third repaid loan earns the first spin');
  const r = await spinWheel({ ...w, now: NOW, rng: () => 9 });
  assert.deepEqual([r.slice, r.waiver_pct], [9, 50]);
  assert.equal(r.expires_at, new Date(NOW.getTime() + REWARD_VALID_DAYS * 86_400_000).toISOString());
  assert.equal((await spinsAvailable(w)).available, 0, 'the spin is used');
  await assert.rejects(() => spinWheel(w), BusinessRuleError);
  await w.closeLoans(1);
  assert.equal((await spinsAvailable(w)).available, 1, 'the fourth repaid loan earns the second spin');
});

test('spins: loans that are open or written off do not count, and a bad random draw is refused', async () => {
  const w = await world();
  for (const status of ['active', 'written_off', 'rolled_over']) {
    await w.store.insertLoan({ application_id: `x${status}`, customer_id: w.customerId, product_id: 'p1', cycle_number: 1, principal: 1, fee_amount: 0, due_date: '2026-09-01', status, disbursed_at: '2026-08-01T00:00:00Z' });
  }
  assert.equal((await spinsAvailable(w)).repaid, 0);
  await w.closeLoans(3);
  for (const bad of [-1, 10, 1.5, NaN, undefined]) await assert.rejects(() => spinWheel({ ...w, rng: () => bad }), /out of range/, `rng ${bad}`);
  assert.equal((await w.store.countRewards(w.customerId)), 0, 'a refused draw leaves no reward');
});

test('spins: two at the same moment cannot both win; the database allows one reward per spin number', async () => {
  const w = await world();
  await w.closeLoans(3);
  const out = await Promise.allSettled([spinWheel({ ...w, rng: () => 0 }), spinWheel({ ...w, rng: () => 0 })]);
  assert.deepEqual(out.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
  assert.match(out.find((o) => o.status === 'rejected').reason.message, /already taken/);
  assert.equal(await w.store.countRewards(w.customerId), 1);
});

test('the default draw is the platform generator and gives every slice over many spins', async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const w = await world();
    await w.closeLoans(3);
    seen.add((await spinWheel(w)).waiver_pct);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [10, 20, 30, 40, 50]);
});

test('applying a reward: the application carries it, the fee drops, and it is only used when the money is paid', async () => {
  const w = await world();
  await w.closeLoans(3);
  await spinWheel({ ...w, now: NOW, rng: () => 6 }); // slice 6 = 40 percent
  const state = await getRewardState({ ...w, now: NOW });
  assert.deepEqual([state.spins_available, state.reward.waiver_pct], [0, 40]);

  const app1 = await w.store.insertApplication({ customer_id: w.customerId, product_id: 'p1', requested_amount: 10000 });
  const a1 = await applyReward({ store: w.store, application: app1, product, now: NOW });
  assert.deepEqual([a1.waiverPct, a1.product.fee_value, product.fee_value], [40, 4.8, 8]);
  assert.equal((await w.store.getApplication(app1.id)).fee_waiver_pct, 40);
  // that application lapses: the reward is still there and goes to the next one
  const app2 = await w.store.insertApplication({ customer_id: w.customerId, product_id: 'p1', requested_amount: 10000 });
  const a2 = await applyReward({ store: w.store, application: app2, product, now: NOW });
  assert.equal(a2.waiverPct, 40, 'a lapsed application gives the reward back');
  assert.equal((await w.store.listRewards(w.customerId))[0].application_id, app2.id);

  await consumeReward({ store: w.store, applicationId: app2.id, now: NOW });
  const a3 = await applyReward({ store: w.store, application: await w.store.insertApplication({ customer_id: w.customerId, product_id: 'p1', requested_amount: 10000 }), product, now: NOW });
  assert.deepEqual([a3.waiverPct, a3.product], [0, product], 'used once, then the full fee applies');
});

test('a reward expires after 30 days and an expired one is never applied', async () => {
  const w = await world();
  await w.closeLoans(3);
  await spinWheel({ ...w, now: NOW, rng: () => 9 });
  const later = new Date(NOW.getTime() + 31 * 86_400_000);
  assert.equal((await getRewardState({ ...w, now: later })).reward, null);
  const app = await w.store.insertApplication({ customer_id: w.customerId, product_id: 'p1', requested_amount: 10000 });
  assert.equal((await applyReward({ store: w.store, application: app, product, now: later })).waiverPct, 0);
  const justBefore = new Date(NOW.getTime() + 29 * 86_400_000);
  assert.equal((await getRewardState({ ...w, now: justBefore })).reward.waiver_pct, 50);
});

test('the oldest reward is used first, so none runs out unused', async () => {
  const w = await world();
  await w.closeLoans(4);
  await spinWheel({ ...w, now: NOW, rng: () => 0 });                                   // 10 percent, expires first
  await spinWheel({ ...w, now: new Date(NOW.getTime() + 86_400_000), rng: () => 9 });  // 50 percent, expires a day later
  const app = await w.store.insertApplication({ customer_id: w.customerId, product_id: 'p1', requested_amount: 10000 });
  assert.equal((await applyReward({ store: w.store, application: app, product, now: NOW })).waiverPct, 10);
});
