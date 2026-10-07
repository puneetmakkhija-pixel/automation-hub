// Plug-and-play proof: a fictional vendor ("acme") is added using ONLY its spec file, no new code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  render, extract, createHttpAdapter, createRegistry, runUnderwriting, memoryStore, createWebhookHandler,
  NotConfiguredError, VendorHttpError, createApplication, sendAgreement, recordAgreementSigned, disburseLoan,
} from './index.js';
import { acme } from './vendors/_example-acme.spec.js';

const ENV = {
  ACME_BASE_URL: 'https://acme.invalid', ACME_API_KEY: 'k-123', ACME_USER: 'u', ACME_PASS: 'p', ACME_WEBHOOK_SECRET: 's3cret',
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// A fake Acme server: routes by path, records every request.
function acmeServer(calls = []) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, headers: init.headers, body, method: init.method });
    if (path === '/v1/kyc') return res(200, { result: { state: 'OK', checks: [{ name: 'pan', state: 'OK', id: 'p1' }, { name: 'liveness', state: 'OK', id: 'l1' }] } });
    if (path === '/v1/bureau') return res(200, { score: 731, dpd: { max12m: 0 }, flags: { status: 'CLEAN', wilful: false }, tradelines: { active: 2 }, enquiries: { d90: 1 }, bounces: 0, cc: { utilisation: 25 }, obligations: { monthly_paise: 300000 } });
    if (path === '/v1/bank/analyse') return res(200, { summary: { avg_balance: 22000, credit_trend_pct: 4, bounces_6m: 0, txn_per_month: 28, cash_pct: 5 }, salary: { months_credited: 6, variation_pct: 3, trend_pct: 2, latest: 40000 } });
    if (path === '/v1/esign') return res(200, { envelope_id: 'env-1', state: 'SENT', document_url: 'https://acme.invalid/doc', kfs_url: 'https://acme.invalid/kfs' });
    if (path === '/v1/collect') return res(200, { collect_id: 'col-1', state: 'CREATED', pay_url: 'https://acme.invalid/pay/col-1' });
    if (path.startsWith('/v1/payout/')) return res(200, { state: 'PAID', utr: `UTR-${path.split('/').pop()}` });
    if (path === '/v1/payout') return res(200, { state: 'PAID', utr: `UTR-${init.headers['idempotency-key']}` });
    return res(404, {});
  };
}

test('mapping.render: typed whole placeholders, inline placeholders, missing becomes null', () => {
  const ctx = { customer: { mobile: '9999999991', n: 5 }, flag: true };
  assert.equal(render('{{customer.n}}', ctx), 5);
  assert.equal(render('{{flag}}', ctx), true);
  assert.equal(render('/x/{{customer.mobile}}/y', ctx), '/x/9999999991/y');
  assert.equal(render('{{customer.nope}}', ctx), null);
  assert.deepEqual(render({ a: ['{{customer.n}}', 'k'] }, ctx), { a: [5, 'k'] });
});

test('mapping.extract: path, map with default, number coercion, divideBy, const, array, missing stays null', () => {
  const src = { a: { n: '42', s: 'OK', paise: 250000 }, list: [{ k: 'x', v: 'WAIT' }], zero: 0 };
  assert.equal(extract({ path: 'a.n', type: 'number' }, src), 42);
  assert.equal(extract({ path: 'a.s', map: { OK: 'verified' }, default: 'pending' }, src), 'verified');
  assert.equal(extract({ path: 'a.s', map: { NO: 'x' }, default: 'pending' }, src), 'pending');
  assert.equal(extract({ path: 'a.paise', type: 'number', divideBy: 100 }, src), 2500);
  assert.equal(extract({ const: 7 }, src), 7);
  assert.equal(extract('a.missing', src), null);
  assert.equal(extract({ path: 'a.missing', type: 'number' }, src), null);
  assert.equal(extract('zero', src), 0); // a real zero is kept, not treated as missing
  assert.equal(extract({ path: 'a.n', type: 'number', map: undefined }, src), 42);
  assert.deepEqual(extract({ array: { path: 'list', item: { name: 'k', state: { path: 'v', map: { WAIT: 'pending' } } } } }, src), [{ name: 'x', state: 'pending' }]);
  assert.deepEqual(extract({ array: { path: 'nope', item: {} } }, src), []);
  assert.equal(extract({ path: 'a.n', type: 'number' }, { a: { n: 'abc' } }), null); // junk is null, never NaN
});

test('http adapter: builds the request from the spec and normalises the response', async () => {
  const calls = [];
  const kyc = createHttpAdapter({ ...acme.kyc, vendor: 'acme', slot: 'kyc' }, { env: ENV, fetchImpl: acmeServer(calls) });
  const out = await kyc({ customer: { id: 'c1', mobile: '9999999991' } });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/v1/kyc');
  assert.equal(calls[0].headers['x-api-key'], 'k-123');
  assert.deepEqual(calls[0].body, { mobile: '9999999991', ref: 'c1' });
  assert.equal(out.status, 'verified');
  assert.deepEqual(out.checks.map((c) => [c.type, c.status, c.providerRef]), [['pan', 'verified', 'p1'], ['liveness', 'verified', 'l1']]);
  assert.ok(out.raw.result, 'raw vendor payload is kept for the audit table');
});

test('http adapter: basic auth, and a missing secret names the env var instead of calling out', async () => {
  const calls = [];
  const bureau = createHttpAdapter({ ...acme.bureau, vendor: 'acme', slot: 'bureau' }, { env: ENV, fetchImpl: acmeServer(calls) });
  const out = await bureau({ customer: { mobile: '9999999991' } });
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(out.monthlyObligations, 3000); // paise -> rupees
  assert.equal(out.npaStatus, 'none');

  const noKey = createHttpAdapter({ ...acme.kyc, vendor: 'acme', slot: 'kyc' }, { env: { ACME_BASE_URL: 'https://x' }, fetchImpl: async () => { throw new Error('must not call'); } });
  await assert.rejects(() => noKey({ customer: {} }), (e) => e instanceof NotConfiguredError && e.message.includes('ACME_API_KEY'));
  const noBase = createHttpAdapter({ ...acme.kyc, vendor: 'acme', slot: 'kyc' }, { env: {}, fetchImpl: async () => { throw new Error('no'); } });
  await assert.rejects(() => noBase({ customer: {} }), (e) => e.message.includes('ACME_BASE_URL'));
});

test('http adapter: HTTP errors never leak the response body; timeouts are reported', async () => {
  const bad = createHttpAdapter({ ...acme.kyc, vendor: 'acme', slot: 'kyc' }, { env: ENV, fetchImpl: async () => res(403, { secret: 'PAN-ABCDE1234F' }) });
  await assert.rejects(() => bad({ customer: {} }), (e) => e instanceof VendorHttpError && e.status === 403 && !e.message.includes('PAN-'));

  const notJson = createHttpAdapter({ ...acme.kyc, vendor: 'acme', slot: 'kyc' }, { env: ENV, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }) });
  await assert.rejects(() => notJson({ customer: {} }), /not valid JSON/);

  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  const slow = createHttpAdapter({ ...acme.kyc, vendor: 'acme', slot: 'kyc', timeoutMs: 20 }, { env: ENV, fetchImpl: hang });
  await assert.rejects(() => slow({ customer: {} }), /timed out/);
});

test('http adapter: only idempotent reads are retried; a payout is never retried', async () => {
  let n = 0;
  const flaky = async () => { n += 1; return n === 1 ? res(503, {}) : acmeServer()('https://a/v1/bank/analyse', { headers: {}, body: '{}' }); };
  const bank = createHttpAdapter({ ...acme.bankStatement, vendor: 'acme', slot: 'bankStatement' }, { env: ENV, fetchImpl: flaky });
  const out = await bank({ customer: { mobile: '9' } });
  assert.equal(n, 2);
  assert.equal(out.observedSalary, 40000);

  let p = 0;
  const payout = createHttpAdapter({ ...acme.payout, vendor: 'acme', slot: 'payout' }, { env: ENV, fetchImpl: async () => { p += 1; return res(503, {}); } });
  await assert.rejects(() => payout({ idempotencyKey: 'k', amount: 1, account: {}, reference: 'r' }), VendorHttpError);
  assert.equal(p, 1, 'a failed payout request is not blindly repeated');
});

test('unconfigured spec refuses to run', async () => {
  const a = createHttpAdapter({ configured: false, vendor: 'digitap', slot: 'kyc' }, { env: ENV, fetchImpl: async () => { throw new Error('no'); } });
  await assert.rejects(() => a({}), NotConfiguredError);
});

test('PLUG AND PLAY: a whole underwriting run on a vendor added by spec only', async () => {
  const calls = [];
  const env = { ...ENV, VENDOR_KYC: 'acme', VENDOR_BUREAU: 'acme', VENDOR_BANK_STATEMENT: 'acme', VENDOR_ESIGN: 'acme', VENDOR_PAYOUT: 'acme', VENDOR_COLLECT: 'acme' };
  const registry = createRegistry({ env, specs: { acme }, fetchImpl: acmeServer(calls) });
  assert.deepEqual(Object.values(registry.names), Array(6).fill('acme'));

  const product = { id: 'p1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30, fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, active: true };
  const store = memoryStore({ products: [product] });
  const customer = await store.upsertCustomer({ mobile: '9999999991', salary_day: 1 });
  const { application } = await createApplication({ store, customer, product, requestedAmount: 10000 });
  const intake = { declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long', purposeClarity: 'specific_documented', referencesVerified: 'both' };
  const out = await runUnderwriting({ registry, store, customer, application, product, intake });
  assert.equal(out.result.decision, 'approve');
  assert.equal(out.result.offer.amount, 10000);

  await sendAgreement({ registry, store, customer, application });
  const ag = await store.getAgreementByApplication(application.id);
  assert.equal(ag.provider_ref, 'env-1');
  assert.equal(ag.document_url, 'https://acme.invalid/doc');
  await recordAgreementSigned({ store, applicationId: application.id });

  const r = await disburseLoan({ registry, store, customer, application, product, account: { name: 'A B', number: '123456789', ifsc: 'HDFC0000001' }, asOf: '2026-01-01' });
  assert.equal(r.status, 'success');
  const payoutCall = calls.find((c) => c.path === '/v1/payout');
  assert.equal(payoutCall.body.amount, 10000);
  assert.equal(payoutCall.body.reference, application.id);
  assert.match(payoutCall.headers['idempotency-key'], /^disb-/);
  assert.ok(r.disbursement.utr.startsWith('UTR-disb-'));

  const c = await registry.collect.request({ loan: r.loan, customer, amount: 5000, reference: r.loan.id });
  assert.deepEqual([c.providerRef, c.status, c.paymentUrl], ['col-1', 'created', 'https://acme.invalid/pay/col-1']);
  const collectCall = calls.find((x) => x.path === '/v1/collect');
  assert.deepEqual([collectCall.body.amount, collectCall.body.mobile], [5000, '9999999991']);
});

test('contract guard still protects a vendor added by spec (wrong mapping fails at the boundary)', async () => {
  const broken = { ...acme, bankStatement: { ...acme.bankStatement, response: { fields: { abb: { path: 'summary.avg_balance', type: 'string' } } } } };
  const registry = createRegistry({ env: { ...ENV, VENDOR_BANK_STATEMENT: 'acme' }, specs: { acme: broken }, fetchImpl: acmeServer() });
  await assert.rejects(() => registry.bankStatement.analyse({ customer: { mobile: '9' } }), /bank\.abb must be a number or null/);
});

// ---------------------------------------------------------------- webhooks
const sign = (body, secret = 's3cret') => createHmac('sha256', secret).update(body).digest('hex');

async function webhookWorld() {
  const registry = createRegistry({ env: {}, specs: { acme } });
  const product = { id: 'p1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30, fee_type: 'flat', fee_value: 500, penalty_per_day_pct: 1, active: true };
  const store = memoryStore({ products: [product] });
  const customer = await store.upsertCustomer({ mobile: '9999999993' });
  const app = await store.insertApplication({ customer_id: customer.id, product_id: product.id, requested_amount: 10000, status: 'offered', approved_amount: 10000 });
  await sendAgreement({ registry, store, customer, application: app });
  const handler = createWebhookHandler({ store, registry, env: ENV });
  const post = (payload, { secret, drop } = {}) => {
    const raw = JSON.stringify(payload);
    return handler({ provider: 'acme', rawBody: raw, headers: drop ? {} : { 'x-acme-signature': sign(raw, secret) } });
  };
  return { store, customer, app, handler, post, registry, product };
}

test('webhook: signature is required and verified', async () => {
  const w = await webhookWorld();
  const ev = { event_id: 'e1', type: 'esign.signed', data: { application_ref: w.app.id } };
  assert.equal((await w.post(ev, { drop: true })).status, 401);
  assert.equal((await w.post(ev, { secret: 'wrong' })).status, 401);
  assert.equal((await w.store.getAgreementByApplication(w.app.id)).esign_status, 'sent', 'nothing applied on a bad signature');
  assert.equal((await w.post(ev)).status, 200);
  assert.equal((await w.store.getAgreementByApplication(w.app.id)).esign_status, 'signed');
  assert.equal((await w.store.getApplication(w.app.id)).status, 'signed');

  const noSecret = createWebhookHandler({ store: w.store, registry: w.registry, env: {} });
  const raw = JSON.stringify(ev);
  assert.equal((await noSecret({ provider: 'acme', rawBody: raw, headers: { 'x-acme-signature': sign(raw) } })).status, 503, 'no secret configured means refused, never accepted');
  assert.equal((await w.handler({ provider: 'nobody', rawBody: '{}', headers: {} })).status, 404);
});

test('webhook: replays are ignored; malformed events are 400; unknown types are acknowledged', async () => {
  const w = await webhookWorld();
  const ev = { event_id: 'e2', type: 'esign.signed', data: { application_ref: w.app.id } };
  assert.deepEqual((await w.post(ev)).body.ok, true);
  assert.deepEqual((await w.post(ev)).body, { duplicate: true });
  assert.equal((await w.post({ event_id: 'e3', type: 'esign.signed', data: {} })).status, 400); // missing applicationId
  assert.equal((await w.post({ type: 'esign.signed', data: {} })).status, 400); // no event id
  assert.deepEqual((await w.post({ event_id: 'e4', type: 'something.new', data: {} })).body, { ignored: true });
  const raw = 'not json';
  assert.equal((await w.handler({ provider: 'acme', rawBody: raw, headers: { 'x-acme-signature': sign(raw) } })).status, 400);
});

test('webhook: a failed apply stays unprocessed so the vendor retry succeeds', async () => {
  const w = await webhookWorld();
  const ev = { event_id: 'e5', type: 'payout.paid', data: { idempotency_key: 'disb-nope-1', utr: 'U9' } };
  assert.equal((await w.post(ev)).status, 400, 'unknown disbursement is rejected');

  let boom = true;
  const flakyStore = new Proxy(w.store, { get: (t, k) => (k === 'getAgreementByApplication' ? async (...a) => { if (boom) throw new Error('db down'); return t[k](...a); } : t[k]) });
  const h = createWebhookHandler({ store: flakyStore, registry: w.registry, env: ENV });
  const raw = JSON.stringify({ event_id: 'e6', type: 'esign.signed', data: { application_ref: w.app.id } });
  const hdr = { 'x-acme-signature': sign(raw) };
  assert.equal((await h({ provider: 'acme', rawBody: raw, headers: hdr })).status, 500);
  boom = false;
  const retry = await h({ provider: 'acme', rawBody: raw, headers: hdr });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.ok, true, 'the retry is applied, not dismissed as a duplicate');
});

test('payout.status plugs in through the spec: GET, retried, inherits auth; absent when the vendor has none', async () => {
  const calls = [];
  const registry = createRegistry({ env: { ...ENV, VENDOR_PAYOUT: 'acme' }, specs: { acme }, fetchImpl: acmeServer(calls) });
  const r = await registry.payout.status({ idempotencyKey: 'disb-L1-1', loanId: 'L1' });
  assert.deepEqual([r.status, r.utr], ['success', 'UTR-disb-L1-1']);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/v1/payout/disb-L1-1');
  assert.equal(calls[0].headers['x-api-key'], 'k-123', 'auth is inherited from the parent payout spec');
  assert.equal(calls[0].body, null);

  const noStatus = { ...acme, payout: { ...acme.payout, status: undefined } };
  const r2 = createRegistry({ env: { ...ENV, VENDOR_PAYOUT: 'acme' }, specs: { acme: noStatus }, fetchImpl: acmeServer() });
  assert.equal(r2.payout.status, undefined);
  assert.equal(typeof createRegistry({ env: {} }).payout.status, 'function', 'the mock has one');
});
