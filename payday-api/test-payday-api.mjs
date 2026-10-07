// API tests: the handler directly, plus one real-HTTP journey. In-memory store and mock vendors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from './app.js';
import { makeHttpServer } from './server.js';
import { createRegistry, memoryStore } from '../payday-journey/index.js';
import { acme } from '../payday-journey/vendors/_example-acme.spec.js';

const KEY = 'test-api-key';
const ENV = { PAYDAY_API_KEY: KEY, PAN_PEPPER: 'pepper', ACME_WEBHOOK_SECRET: 's3cret' };
const product = {
  id: 'prod-1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30,
  fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, rollover_allowed: true, max_rollovers: 1, active: true,
};
const SPLIT = [
  { product_id: 'prod-1', lender_id: 'lender-A', share_pct: 80, effective_from: '2020-01-01', effective_to: null },
  { product_id: 'prod-1', lender_id: 'lender-B', share_pct: 20, effective_from: '2020-01-01', effective_to: null },
];
const intake = { declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long', purposeClarity: 'specific_documented', referencesVerified: 'both' };
const account = { name: 'Test Customer', number: '123456789012', ifsc: 'HDFC0000001' };
let seq = 0;
const mobile = (d) => `98765${String(++seq).padStart(4, '0')}${d}`;

function setup({ env = ENV, overrides = {}, store = memoryStore({ products: [product], colending: SPLIT }) } = {}) {
  const registry = createRegistry({ env: {}, overrides, specs: { acme } });
  const app = createApp({ store, registry, env });
  const call = (method, path, body, { key = KEY, headers = {}, query } = {}) => app.handle({
    method, path, query, rawBody: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
    headers: { ...(key ? { 'x-api-key': key } : {}), ...headers },
  });
  return { store, registry, app, call };
}

async function onboard(w, digit = 3) {
  const c = await w.call('POST', '/v1/customers', { mobile: mobile(digit), salary_day: 1 });
  assert.equal(c.status, 200);
  const a = await w.call('POST', '/v1/applications', { customer_id: c.body.customer_id, product_code: 'PAYDAY_30', requested_amount: 10000, intake });
  return { customerId: c.body.customer_id, app: a };
}

test('auth: no key configured is 503, wrong or missing key is 401, healthz is open', async () => {
  const none = setup({ env: {} });
  assert.equal((await none.call('GET', '/v1/loans/abc')).status, 503);
  assert.equal((await none.call('GET', '/healthz', undefined, { key: null })).status, 200);

  const w = setup();
  assert.equal((await w.call('GET', '/v1/loans/abc', undefined, { key: null })).status, 401);
  assert.equal((await w.call('GET', '/v1/loans/abc', undefined, { key: 'wrong' })).status, 401);
  assert.equal((await w.call('GET', '/v1/loans/00000000-0000')).status, 404, 'authorised but unknown loan');
  assert.equal((await w.call('GET', '/v1/nope')).status, 404);
});

test('request validation', async () => {
  const w = setup();
  assert.equal((await w.call('POST', '/v1/customers', { mobile: '12345' })).status, 400);
  assert.equal((await w.call('POST', '/v1/customers', '{not json')).status, 400);
  assert.equal((await w.call('POST', '/v1/customers', '[1,2]')).status, 400);
  assert.equal((await w.call('POST', '/v1/applications', {})).status, 400);

  const c = await w.call('POST', '/v1/customers', { mobile: mobile(3) });
  const post = (b) => w.call('POST', '/v1/applications', { customer_id: c.body.customer_id, product_code: 'PAYDAY_30', intake, ...b });
  assert.equal((await post({ requested_amount: 100 })).status, 422);
  assert.equal((await post({ requested_amount: 99999 })).status, 422);
  assert.equal((await post({ requested_amount: 10000, product_code: 'NOPE' })).status, 404);
  assert.equal((await w.call('POST', '/v1/applications', { customer_id: 'ffffffff-ffff', product_code: 'PAYDAY_30', requested_amount: 10000 })).status, 404);
  assert.equal((await w.call('POST', '/v1/jobs/daily-servicing', { as_of: 'yesterday' })).status, 400);
});

test('PAN is never stored raw; it reaches vendors for the call only; a bad PAN is refused', async () => {
  let seen;
  const spyBureau = { name: 'spy', pull: async ({ customer }) => { seen = customer.pan; return { cibil: 740, maxDpd12m: 0, npaStatus: 'none', activeLoans: 1, enquiries90d: 0, bureauEmiBounces: 0, ccUtilPct: 10, monthlyObligations: 0, wilfulDefaulter: false }; } };
  const w = setup({ overrides: { bureau: spyBureau } });
  assert.equal((await w.call('POST', '/v1/customers', { mobile: mobile(3), pan: 'abcde1234f' })).status, 400);
  const c = await w.call('POST', '/v1/customers', { mobile: mobile(3), pan: 'ABCDE1234F' });
  assert.equal(c.status, 200);
  const row = w.store.db.customers[0];
  assert.equal(row.pan_last4, '234F');
  assert.match(row.pan_hash, /^[0-9a-f]{64}$/);

  const a = await w.call('POST', '/v1/applications', { customer_id: c.body.customer_id, product_code: 'PAYDAY_30', requested_amount: 10000, intake, pan: 'ABCDE1234F' });
  assert.equal(a.status, 200);
  assert.equal(seen, 'ABCDE1234F', 'the bureau vendor got the PAN');
  assert.ok(!JSON.stringify(w.store.db).includes('ABCDE1234F'), 'the PAN appears nowhere in what was stored');

  const noPepper = setup({ env: { PAYDAY_API_KEY: KEY } });
  assert.equal((await noPepper.call('POST', '/v1/customers', { mobile: mobile(3), pan: 'ABCDE1234F' })).status, 503);
});

test('a client cannot set the fraud flag or other internal fields through intake', async () => {
  const w = setup();
  const c = await w.call('POST', '/v1/customers', { mobile: mobile(3) });
  const a = await w.call('POST', '/v1/applications', { customer_id: c.body.customer_id, product_code: 'PAYDAY_30', requested_amount: 10000, intake: { ...intake, fraudFlag: true, kycFailed: true, npaStatus: 'npa' } });
  assert.equal(a.body.decision, 'approve', 'fraudFlag, kycFailed and npaStatus from the client are ignored');
});

test('hard declines reach the caller: KYC failure rejects, with reasons', async () => {
  const w = setup();
  const { app } = await onboard(w, 9);
  assert.equal(app.status, 200);
  assert.equal(app.body.decision, 'reject');
  assert.equal(app.body.grade, 'E');
  assert.ok(app.body.reasons.some((r) => r.includes('RF5')));
  assert.equal(app.body.offer, null);
});

test('FULL JOURNEY: apply, agreement, signed webhook, disburse, repay, eligible, repeat loan', async () => {
  const w = setup();
  const { customerId, app } = await onboard(w, 3);
  assert.deepEqual([app.status, app.body.decision, app.body.grade, app.body.offer.amount, app.body.is_repeat], [200, 'approve', 'A', 10000, false]);
  const appId = app.body.application_id;
  assert.equal((await w.store.getCustomer(customerId)).kyc_status, 'verified');

  const early = await w.call('POST', `/v1/applications/${appId}/disburse`, { account });
  assert.equal(early.status, 409, 'cannot disburse before the agreement is signed');

  const ag = await w.call('POST', `/v1/applications/${appId}/agreement`);
  assert.deepEqual([ag.status, ag.body.esign_status, ag.body.reused], [201, 'sent', false]);
  assert.equal((await w.call('POST', `/v1/applications/${appId}/agreement`)).body.reused, true, 'a second call does not send a second agreement');

  // the e-sign vendor calls back (no API key: webhooks are authenticated by signature instead)
  const raw = JSON.stringify({ event_id: 'ev-1', type: 'esign.signed', data: { application_ref: appId } });
  const sig = createHmac('sha256', 's3cret').update(raw).digest('hex');
  const hook = await w.call('POST', '/v1/webhooks/acme', raw, { key: null, headers: { 'x-acme-signature': sig } });
  assert.equal(hook.status, 200);
  assert.equal((await w.store.getApplication(appId)).status, 'signed');

  const missingAcct = await w.call('POST', `/v1/applications/${appId}/disburse`, { account: { name: 'x' } });
  assert.equal(missingAcct.status, 409);
  const d = await w.call('POST', `/v1/applications/${appId}/disburse`, { account });
  assert.equal(d.status, 200);
  assert.equal(d.body.status, 'success');
  assert.ok(!JSON.stringify(d.body).includes('123456789012'), 'the bank account number is never echoed back');
  const loanId = d.body.loan_id;
  assert.equal((await w.call('POST', `/v1/applications/${appId}/disburse`, { account })).body.status, 'already_disbursed');

  const blocked = await w.call('POST', '/v1/applications', { customer_id: customerId, product_code: 'PAYDAY_30', requested_amount: 5000, intake });
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'OPEN_LOAN']);

  const loan = await w.call('GET', `/v1/loans/${loanId}`);
  assert.deepEqual([loan.body.status, loan.body.outstanding, loan.body.ledger_balance, loan.body.bucket], ['active', 10800, 10800, 'current']);

  assert.equal((await w.call('POST', `/v1/loans/${loanId}/payments`, { amount: -5, mode: 'upi' })).status, 400);
  assert.equal((await w.call('POST', `/v1/loans/${loanId}/payments`, { amount: 100 })).status, 400);
  const link = await w.call('POST', `/v1/loans/${loanId}/collect`, {});
  assert.deepEqual([link.status, link.body.amount, link.body.status], [201, 10800, 'created'], 'defaults to the full outstanding amount');
  assert.ok(link.body.payment_url);
  assert.equal((await w.call('POST', `/v1/loans/${loanId}/collect`, { amount: 99999 })).status, 400, 'cannot ask for more than is owed');
  assert.equal((await w.call('POST', `/v1/loans/${loanId}/collect`, { amount: 0 })).status, 400);
  // the customer pays through the link; the vendor confirms by webhook, which is what records the money
  const payRaw = JSON.stringify({ event_id: 'ev-pay-1', type: 'collect.received', data: { loan_ref: loanId, amount: 10800, utr: 'API-U1', mode: 'upi' } });
  const payHook = await w.call('POST', '/v1/webhooks/acme', payRaw, { key: null, headers: { 'x-acme-signature': createHmac('sha256', 's3cret').update(payRaw).digest('hex') } });
  assert.equal(payHook.status, 200);
  assert.equal((await w.call('GET', `/v1/loans/${loanId}`)).body.status, 'closed', 'a payment webhook closes the loan');
  const pay = await w.call('POST', `/v1/loans/${loanId}/payments`, { amount: 10800, mode: 'upi', utr: 'API-U1' });
  assert.deepEqual([pay.status, pay.body.duplicate], [200, true], 'the manual payment with the same utr is a harmless duplicate of the webhook one');
  assert.equal((await w.call('POST', `/v1/loans/${loanId}/collect`, {})).status, 409, 'no collection link for a closed loan');

  const el = await w.call('GET', `/v1/customers/${customerId}/eligibility`, undefined, { query: { product: 'PAYDAY_30' } });
  assert.deepEqual([el.body.eligible, el.body.is_repeat, el.body.limit, el.body.cycle_number], [true, true, 15000, 2]);

  const again = await w.call('POST', '/v1/applications', { customer_id: customerId, product_code: 'PAYDAY_30', requested_amount: 20000, intake });
  assert.deepEqual([again.body.is_repeat, again.body.offer.amount, again.body.offer.cappedBy], [true, 15000, 'customer_limit']);
});

test('servicing endpoints: daily job, overdue loan, rollover and its rule errors', async () => {
  const w = setup();
  const { app } = await onboard(w, 3);
  const appId = app.body.application_id;
  await w.call('POST', `/v1/applications/${appId}/agreement`);
  const raw = JSON.stringify({ event_id: 'ev-2', type: 'esign.signed', data: { application_ref: appId } });
  await w.call('POST', '/v1/webhooks/acme', raw, { key: null, headers: { 'x-acme-signature': createHmac('sha256', 's3cret').update(raw).digest('hex') } });
  const d = await w.call('POST', `/v1/applications/${appId}/disburse`, { account });
  const loanId = d.body.loan_id;

  const early = await w.call('POST', `/v1/loans/${loanId}/rollover`);
  assert.equal(early.status, 409, 'rollover before fee and penalty are paid is a rule error, not a crash');
  const wo = await w.call('POST', `/v1/loans/${loanId}/write-off`, {});
  assert.equal(wo.status, 409);

  // Backdate the loan (as if disbursed long ago) so the real-time daily job finds it 100+ days overdue.
  await w.store.patchLoan(loanId, { due_date: '2020-01-01' });
  const sched = (await w.store.getSchedule(loanId))[0];
  await w.store.patchSchedule(sched.id, { due_date: '2020-01-01' });
  const job = await w.call('POST', '/v1/jobs/daily-servicing', {});
  assert.equal(job.status, 200);
  assert.deepEqual([job.body.processed, job.body.overdue], [1, 1]);
  const loan = await w.call('GET', `/v1/loans/${loanId}`);
  assert.deepEqual([loan.body.status, loan.body.bucket], ['overdue', '90+']);
  assert.ok(loan.body.outstanding > 10800, 'penalty has been added');
  assert.equal(loan.body.outstanding, loan.body.ledger_balance, 'schedule and ledger agree');
  const wo2 = await w.call('POST', `/v1/loans/${loanId}/write-off`, { reason: 'fraud_suspected' });
  assert.equal(wo2.status, 200);
  const after = await w.call('GET', `/v1/loans/${loanId}`);
  assert.equal(after.body.ledger_balance, 0);
});

test('webhook route: signature required, unknown provider 404, GET refused', async () => {
  const w = setup();
  const raw = JSON.stringify({ event_id: 'x', type: 'esign.signed', data: { application_ref: 'a' } });
  assert.equal((await w.call('POST', '/v1/webhooks/acme', raw, { key: null })).status, 401);
  assert.equal((await w.call('POST', '/v1/webhooks/nobody', raw, { key: null })).status, 404);
  assert.equal((await w.call('GET', '/v1/webhooks/acme', undefined, { key: null })).status, 405);
});

test('unexpected failures return 500 without leaking details', async () => {
  const store = memoryStore({ products: [product] });
  store.getLoan = async () => { throw new Error('connection string postgres://user:SECRET@db/x'); };
  const w = setup({ store });
  const origError = console.error;
  console.error = () => {};
  try {
    const r = await w.call('GET', '/v1/loans/abc');
    assert.deepEqual([r.status, r.body], [500, { error: 'internal error' }]);
  } finally { console.error = origError; }
});

test('over real HTTP: JSON responses, query strings, API key, and the body size limit', async () => {
  const w = setup();
  const server = makeHttpServer(w.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = { 'x-api-key': KEY, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/v1/loans/abc`)).status, 401);

    const c = await (await fetch(`${base}/v1/customers`, { method: 'POST', headers: h, body: JSON.stringify({ mobile: mobile(3) }) })).json();
    assert.ok(c.customer_id);
    const e = await fetch(`${base}/v1/customers/${c.customer_id}/eligibility?product=PAYDAY_30`, { headers: h });
    assert.equal(e.status, 200);
    assert.match(e.headers.get('content-type'), /application\/json/);
    assert.equal((await e.json()).eligible, true);

    const big = await fetch(`${base}/v1/customers`, { method: 'POST', headers: h, body: 'x'.repeat(1_100_000) });
    assert.equal(big.status, 413);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('reconcile job and the daily job report on payouts and integrity', async () => {
  const w = setup();
  assert.equal((await w.call('POST', '/v1/jobs/reconcile-payouts', { older_than_minutes: 'soon' })).status, 400);
  const r = await w.call('POST', '/v1/jobs/reconcile-payouts', {});
  assert.deepEqual([r.status, r.body.checked, r.body.settled, r.body.errors], [200, 0, 0, []]);
  const d = await w.call('POST', '/v1/jobs/daily-servicing', {});
  assert.deepEqual([d.status, d.body.integrityIssues], [200, []]);

  const noStatus = setup({ overrides: { payout: { name: 'p', disburse: async () => ({ status: 'pending' }) } } });
  assert.equal((await noStatus.call('POST', '/v1/jobs/reconcile-payouts', {})).status, 409, 'a vendor without a status check is a clear 409, not a crash');
  assert.equal((await noStatus.call('POST', '/v1/jobs/reconcile-payouts', {}, { key: null })).status, 401);
});
