// Run: node --test test-payday-journey.mjs  (CI also runs it as `node test-payday-journey.mjs`)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runUnderwriting, createRegistry, buildFeatures, memoryStore, supabaseStore,
  NotConfiguredError, createDigitapAdapters, contracts,
} from './index.js';

const product = {
  code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000,
  fee_type: 'percent_of_principal', fee_value: 8,
};
const intake = {
  declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long',
  purposeClarity: 'specific_documented', referencesVerified: 'both',
};
const customer = (lastDigit) => ({ id: 'cust-1', mobile: `99999999${lastDigit}0`.slice(0, 9) + lastDigit });
const application = { id: 'app-1', requested_amount: 10000 };

function run(lastDigit, registryOverrides = {}) {
  const store = memoryStore();
  const registry = createRegistry({ env: {}, overrides: registryOverrides });
  return runUnderwriting({
    registry, store, customer: customer(lastDigit), application, product, intake,
  }).then((out) => ({ out, store }));
}

test('happy path: clean customer is approved and everything is persisted', async () => {
  const { out, store } = await run(3);
  assert.equal(out.stage, 'decided');
  assert.equal(out.result.grade, 'A');
  assert.equal(out.result.decision, 'approve');
  assert.equal(out.result.offer.amount, 10000);
  assert.equal(store.db.kycChecks.length, 3);
  assert.deepEqual(store.db.enrichment.map((e) => e.source).sort(), ['bank_statement', 'bureau']);
  assert.equal(store.db.scorecards.length, 1);
  assert.equal(store.db.scorecards[0].application_id, 'app-1');
  assert.deepEqual(store.db.applicationPatches[0], {
    id: 'app-1', patch: { status: 'offered', approved_amount: 10000, decision_reasons: [] },
  });
});

test('KYC failure rejects and spends nothing on bureau or bank statement', async () => {
  let calls = 0;
  const spy = (name, method) => ({ name: 'spy', [method]: async () => { calls += 1; throw new Error('must not be called'); } });
  const { out, store } = await run(9, { bureau: spy('bureau', 'pull'), bankStatement: spy('bank', 'analyse') });
  assert.equal(calls, 0);
  assert.equal(out.result.decision, 'reject');
  assert.equal(out.result.grade, 'E');
  assert.ok(out.result.redFlags.hard.some((f) => f.code === 'RF5'));
  assert.equal(store.db.enrichment.length, 0);
  assert.equal(store.db.applicationPatches[0].patch.status, 'rejected');
});

test('NPA on bureau rejects even though everything else is clean', async () => {
  const { out } = await run(8);
  assert.equal(out.result.decision, 'reject');
  assert.ok(out.result.redFlags.hard.some((f) => f.code === 'RF1'));
});

test('thin file (no bureau, no bank data) is never approved', async () => {
  const { out } = await run(7);
  assert.notEqual(out.result.decision, 'approve');
  assert.ok(out.result.missingCount > 5);
});

test('a vendor outage is recorded as missing data, does not crash, and cannot help the customer', async () => {
  const broken = { name: 'broken', pull: async () => { throw new Error('timeout'); } };
  const { out, store } = await run(3, { bureau: broken });
  assert.equal(out.stage, 'decided');
  assert.equal(out.vendorErrors.length, 1);
  assert.ok(out.result.reasons.some((r) => r.includes('Vendor unavailable: bureau: timeout')));
  assert.notEqual(out.result.decision, 'approve');
  assert.deepEqual(store.db.enrichment.map((e) => e.source), ['bank_statement']);
});

test('pending KYC stops the pipeline without scoring', async () => {
  const pending = { name: 'p', verify: async () => ({ status: 'pending', checks: [{ type: 'aadhaar_otp', status: 'pending' }] }) };
  const { out, store } = await run(3, { kyc: pending });
  assert.equal(out.stage, 'kyc_pending');
  assert.equal(store.db.scorecards.length, 0);
  assert.deepEqual(store.db.applicationPatches[0].patch, { status: 'kyc_pending' });
});

test('registry: defaults to mock, refuses mock in production, rejects unknown vendors', () => {
  const r = createRegistry({ env: {} });
  assert.deepEqual(Object.values(r.names), ['mock', 'mock', 'mock', 'mock', 'mock']);
  assert.throws(() => createRegistry({ env: { NODE_ENV: 'production' } }), /"mock" in production/);
  assert.doesNotThrow(() => createRegistry({ env: { NODE_ENV: 'production', ALLOW_MOCK_VENDORS: '1' } }));
  assert.throws(() => createRegistry({ env: { VENDOR_KYC: 'nonesuch' } }), /Unknown or unsupported vendor/);
  // Digitap has no bureau, e-sign or payout adapter, so selecting it there must fail loudly
  assert.throws(() => createRegistry({ env: { VENDOR_BUREAU: 'digitap' } }), /unsupported vendor "digitap" for slot "bureau"/);
});

test('digitap: selectable for kyc and bank statement, but refuses to run until configured', async () => {
  const r = createRegistry({ env: { VENDOR_KYC: 'digitap', VENDOR_BANK_STATEMENT: 'digitap', DIGITAP_BASE_URL: 'https://example.invalid' },
    fetchImpl: async () => { throw new Error('network must not be touched'); } });
  assert.equal(r.names.kyc, 'digitap');
  await assert.rejects(() => r.kyc.verify({ customer: customer(1) }), NotConfiguredError);
  const bare = createDigitapAdapters({ env: {}, fetchImpl: async () => { throw new Error('no'); } });
  await assert.rejects(() => bare.kyc.verify({ customer: customer(1) }), /DIGITAP_BASE_URL/);
});

test('contract guard: a vendor returning the wrong shape fails at the boundary', async () => {
  const bad = { name: 'bad', analyse: async () => ({ abb: 'lots' }) };
  const r = createRegistry({ env: {}, overrides: { bankStatement: bad } });
  await assert.rejects(() => r.bankStatement.analyse({ customer: customer(1) }), /bank\.abb must be a number or null/);
  assert.throws(() => contracts.assertKyc({ status: 'maybe', checks: [] }), /kyc\.status/);
  assert.throws(() => contracts.assertPayout({ status: 'success' }), /needs a utr/);
});

test('features: salary for sizing is the lower of declared and observed; mismatch and FOIR derived', () => {
  const f = buildFeatures({
    intake: { declaredSalary: 50000 },
    kyc: { status: 'verified' },
    bureau: { monthlyObligations: 5000 },
    bank: { observedSalary: 40000 },
  });
  assert.equal(f.netSalary, 40000);
  assert.equal(f.salaryMatchVariancePct, 20); // |50000-40000| / 50000
  assert.equal(f.foirPct, 12.5);              // 5000 / 40000
  assert.equal(f.kycFailed, false);
  // nothing available -> everything null, never a made-up value
  const empty = buildFeatures({});
  assert.equal(empty.netSalary, null);
  assert.equal(empty.cibil, null);
  assert.equal(empty.kycFailed, null);
});

test('supabaseStore: writes go to the payday schema with the right tables', async () => {
  const calls = [];
  const client = {
    schema: (s) => ({
      from: (table) => ({
        insert: (rows) => { calls.push({ s, table, op: 'insert', rows }); return Promise.resolve({ error: null }); },
        update: (patch) => ({ eq: (col, val) => { calls.push({ s, table, op: 'update', patch, col, val }); return Promise.resolve({ error: null }); } }),
      }),
    }),
  };
  const store = supabaseStore(client);
  const registry = createRegistry({ env: {} });
  await runUnderwriting({ registry, store, customer: customer(3), application, product, intake });
  assert.ok(calls.every((c) => c.s === 'payday'));
  assert.deepEqual(calls.map((c) => `${c.op}:${c.table}`),
    ['insert:kyc_check', 'insert:enrichment_report', 'insert:enrichment_report', 'insert:scorecard_result', 'update:application']);
  const upd = calls.at(-1);
  assert.equal(upd.col, 'id');
  assert.equal(upd.val, 'app-1');

  const failing = { schema: () => ({ from: () => ({ insert: () => Promise.resolve({ error: { message: 'rls denied' } }) }) }) };
  await assert.rejects(() => supabaseStore(failing).saveScorecard({}), /payday\.scorecard_result insert: rls denied/);
});
