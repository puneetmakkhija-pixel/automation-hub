// The partner API: spec matches the routes, events, idempotency keys, and a partner finishing a whole loan in the sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { OPERATIONS, openApiSpec } from './openapi.js';
import { createRegistry, memoryStore, EVENT_CATALOGUE, deliverPartnerEvents, signPartnerPayload } from '../payday-journey/index.js';
import { acme } from '../payday-journey/vendors/_example-acme.spec.js';

const BOOT = 'bootstrap-admin-key';
const product = {
  id: 'prod-1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30,
  fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, rollover_allowed: true, max_rollovers: 1, active: true,
};
const intake = { declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long', purposeClarity: 'specific_documented', referencesVerified: 'both' };
const account = { name: 'Test Customer', number: '123456789012', ifsc: 'HDFC0000001' };
let seq = 0;
const mobile = (d = 3) => `97654${String(++seq).padStart(4, '0')}${d}`;

function world({ sandbox = false, env = {} } = {}) {
  const store = memoryStore({ products: [product] });
  const fullEnv = { PAYDAY_API_KEY: BOOT, ACME_WEBHOOK_SECRET: 's3cret', PARTNER_ACME_SECRET: 'partner-secret', ...(sandbox ? { PAYDAY_SANDBOX: '1' } : {}), ...env };
  const app = createApp({ store, registry: createRegistry({ env: {}, specs: { acme } }), env: fullEnv });
  const as = (key) => (method, path, body, { query, headers = {} } = {}) => app.handle({
    method, path, query, headers: { ...(key ? { 'x-api-key': key } : {}), ...headers }, rawBody: body === undefined ? '' : JSON.stringify(body),
  });
  return { store, app, as, admin: as(BOOT), env: fullEnv };
}
async function partner(w, name = 'BuddyLoan') {
  const p = await w.admin('POST', '/v1/partners', { name, callback_url: 'https://hooks.buddyloan.example/payday', callback_secret_env: 'PARTNER_ACME_SECRET' });
  const c = await w.admin('POST', '/v1/clients', { name: `${name} key`, role: 'partner', partner_id: p.body.id });
  return { partnerId: p.body.id, call: w.as(c.body.api_key) };
}
const onboard = async (call) => {
  const c = await call('POST', '/v1/customers', { mobile: mobile(), salary_day: 1 });
  await call('POST', `/v1/customers/${c.body.customer_id}/consents`, { purposes: ['kyc', 'credit_bureau', 'terms'], text_version: 'v1', channel: 'app' });
  return c.body.customer_id;
};
const apply = (call, customerId, headers) => call('POST', '/v1/applications', { customer_id: customerId, product_code: 'PAYDAY_30', requested_amount: 10000, intake }, { headers });

test('spec: every documented call is routed, the spec is served, and sandbox calls exist only in the sandbox', async () => {
  const w = world({ sandbox: true });
  for (const op of OPERATIONS) {
    const path = op.path.replace(/\{\w+\}/g, 'x');
    const r = await w.admin(op.method, path, op.request ? { ...op.request } : undefined, { query: { product: 'PAYDAY_30', partner_id: 'x' } });
    assert.notEqual(r.body?.error, 'not found', `${op.method} ${op.path} is in the spec but not routed`);
    assert.notEqual(r.status, 405);
  }
  const served = await world().app.handle({ method: 'GET', path: '/openapi.json', headers: {} });
  assert.deepEqual([served.status, served.body.openapi], [200, '3.1.0'], 'public, no key needed');
  assert.equal(Object.keys(served.body.paths).some((p) => p.includes('/sandbox/')), false, 'sandbox calls are hidden when the sandbox is off');
  assert.equal(Object.keys(openApiSpec({ sandbox: true }).paths).some((p) => p.includes('/sandbox/')), true);
  assert.deepEqual(Object.keys(served.body.webhooks).sort(), Object.keys(EVENT_CATALOGUE).sort(), 'every event type we send is documented');
  const off = world();
  const p = await partner(off);
  assert.equal((await p.call('POST', '/v1/sandbox/loans/x/pay')).status, 404, 'no sandbox helpers outside the sandbox');
});

test('sandbox: a partner finishes a whole loan alone and receives every milestone, in order, once', async () => {
  const w = world({ sandbox: true });
  const p = await partner(w);
  const customerId = await onboard(p.call);
  const a = await apply(p.call, customerId);
  assert.equal(a.body.decision, 'approve');
  const appId = a.body.application_id;
  assert.equal((await p.call('POST', `/v1/applications/${appId}/agreement`)).status, 201);
  assert.equal((await p.call('POST', `/v1/sandbox/applications/${appId}/sign`)).body.status, 'signed');
  const d = await p.call('POST', `/v1/applications/${appId}/disburse`, { account });
  assert.deepEqual([d.status, d.body.status], [200, 'success']);
  const loanId = d.body.loan_id;
  const quote = await p.call('POST', `/v1/loans/${loanId}/cooling-off`);
  assert.deepEqual([quote.status, quote.body.requested], [200, true]);
  const paid = await p.call('POST', `/v1/sandbox/loans/${loanId}/pay`);
  assert.deepEqual([paid.status, paid.body.closed], [200, true]);
  assert.equal((await p.call('GET', `/v1/loans/${loanId}`)).body.status, 'closed');

  const ev = await p.call('GET', '/v1/events');
  assert.deepEqual(ev.body.events.map((e) => e.type), ['application.decided', 'agreement.signed', 'loan.disbursed', 'loan.cooling_off_requested', 'payment.received', 'loan.closed']);
  assert.equal(ev.body.events.every((e) => EVENT_CATALOGUE[e.type]), true, 'only documented event types are ever sent');
  assert.equal(ev.body.events.find((e) => e.type === 'loan.closed').data.reason, 'cooling_off_exit');
  assert.equal(ev.body.events.find((e) => e.type === 'payment.received').data.closed, true);
  // reading back with a cursor
  const later = await p.call('GET', '/v1/events', undefined, { query: { since: ev.body.events[2].created_at } });
  assert.ok(later.body.events.length < ev.body.events.length);
  assert.equal((await p.call('GET', '/v1/events', undefined, { query: { status: 'bogus' } })).status, 400);
});

test('events: a partner reads and redelivers only its own; a delivered event is signed; a failed one can be sent again', async () => {
  const w = world({ sandbox: true });
  const p = await partner(w, 'BuddyLoan');
  const q = await partner(w, 'Other');
  const customerId = await onboard(p.call);
  await apply(p.call, customerId);
  const mine = (await p.call('GET', '/v1/events')).body.events;
  assert.equal(mine.length, 1);
  assert.equal((await q.call('GET', '/v1/events')).body.events.length, 0, 'another partner sees none of them');
  assert.equal((await q.call('POST', `/v1/events/${mine[0].id}/redeliver`)).status, 404);
  assert.equal((await w.admin('GET', '/v1/events')).status, 400, 'ops and admin must say which partner');

  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return { status: 200 }; };
  const r = await deliverPartnerEvents({ store: w.store, env: w.env, fetchImpl });
  assert.equal(r.delivered, 1);
  const { init } = sent[0];
  const ts = init.headers['x-payday-timestamp'];
  assert.equal(init.headers['x-payday-signature'], signPartnerPayload('partner-secret', ts, init.body), 'the body is signed with the shared secret');
  assert.equal(JSON.parse(init.body).type, 'application.decided');
  assert.equal((await p.call('GET', '/v1/events', undefined, { query: { status: 'delivered' } })).body.events.length, 1);
  assert.equal((await p.call('POST', `/v1/events/${mine[0].id}/redeliver`)).status, 200);
  assert.equal((await p.call('GET', '/v1/events', undefined, { query: { status: 'pending' } })).body.events.length, 1, 'queued to go again');
});

test('idempotency: a retry with the same key gets the first answer; another request on the same key is refused; refusals are not kept', async () => {
  const w = world();
  const p = await partner(w);
  const customerId = await onboard(p.call);
  const key = { 'idempotency-key': 'order-0001-apply' };
  const first = await apply(p.call, customerId, key);
  assert.equal(first.status, 200);
  const retry = await apply(p.call, customerId, key);
  assert.deepEqual([retry.status, retry.body.application_id, retry.headers?.['idempotent-replayed']], [200, first.body.application_id, 'true']);
  assert.equal(await w.store.countApplicationsSince(customerId, '2000-01-01T00:00:00Z'), 1, 'only one application was opened');

  const other = await p.call('POST', '/v1/applications', { customer_id: customerId, product_code: 'PAYDAY_30', requested_amount: 5000, intake }, { headers: key });
  assert.deepEqual([other.status, other.body.code], [422, 'IDEMPOTENCY_KEY_REUSED']);
  assert.equal((await apply(p.call, customerId, { 'idempotency-key': 'short' })).status, 400, 'a key must be 8 to 128 safe characters');

  // a first call still running: the claim exists but is not done
  const hash = (await w.store.claimIdempotencyKey({ clientKey: 'k', key: 'busy-key-0001', requestHash: 'h' })).row;
  const again = await w.store.claimIdempotencyKey({ clientKey: 'k', key: 'busy-key-0001', requestHash: 'h' });
  assert.deepEqual([again.created, again.row.status], [false, 'in_progress']);
  await w.store.releaseIdempotencyKey(hash.id);
  assert.equal((await w.store.claimIdempotencyKey({ clientKey: 'k', key: 'busy-key-0001', requestHash: 'h' })).created, true, 'a released key can be used again');

  // a refusal is not remembered: the same key works once the reason is gone
  const c2 = await p.call('POST', '/v1/customers', { mobile: mobile(), salary_day: 1 });
  const noConsent = await apply(p.call, c2.body.customer_id, { 'idempotency-key': 'order-0002-apply' });
  assert.equal(noConsent.status, 409);
  await p.call('POST', `/v1/customers/${c2.body.customer_id}/consents`, { purposes: ['kyc', 'credit_bureau', 'terms'], text_version: 'v1', channel: 'app' });
  assert.equal((await apply(p.call, c2.body.customer_id, { 'idempotency-key': 'order-0002-apply' })).status, 200);
});

test('limit event: it is tied to the customer, and a cooling-off exit earns no higher limit', async () => {
  const w = world({ sandbox: true });
  const p = await partner(w);
  const finish = async (coolingOff) => {
    const customerId = await onboard(p.call);
    const appId = (await apply(p.call, customerId)).body.application_id;
    await p.call('POST', `/v1/applications/${appId}/agreement`);
    await p.call('POST', `/v1/sandbox/applications/${appId}/sign`);
    const loanId = (await p.call('POST', `/v1/applications/${appId}/disburse`, { account })).body.loan_id;
    if (coolingOff) await p.call('POST', `/v1/loans/${loanId}/cooling-off`);
    await p.call('POST', `/v1/sandbox/loans/${loanId}/pay`);
    return customerId;
  };
  const exited = await finish(true);
  assert.equal((await p.call('POST', `/v1/customers/${exited}/limit-increase`, { product_code: 'PAYDAY_30' })).status, 409, 'using the cooling-off exit does not make a customer eligible for more');
  const normal = await finish(false);
  const up = await p.call('POST', `/v1/customers/${normal}/limit-increase`, { product_code: 'PAYDAY_30' });
  assert.equal(up.status, 200);
  const lim = (await p.call('GET', '/v1/events')).body.events.find((e) => e.type === 'limit.increase_granted');
  assert.deepEqual([lim.data.customer_id, lim.data.limit, lim.data.application_id], [normal, up.body.limit, undefined]);
});
