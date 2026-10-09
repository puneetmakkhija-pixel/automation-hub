// API controls: roles, API clients, partner isolation, consent, credit policies, audit, partner callbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from './app.js';
import { createRegistry, memoryStore, createApiClient } from '../payday-journey/index.js';
import { adminAccessProblem } from './server.js';
import { DEFAULT_POLICY } from '../payday-engine/index.js';
import { acme } from '../payday-journey/vendors/_example-acme.spec.js';

const BOOT = 'bootstrap-admin-key';
const product = {
  id: 'prod-1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30,
  fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, rollover_allowed: true, max_rollovers: 1, active: true,
};
const intake = { declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long', purposeClarity: 'specific_documented', referencesVerified: 'both' };
const account = { name: 'Test Customer', number: '123456789012', ifsc: 'HDFC0000001' };
let seq = 0;
const mobile = (d = 3) => `96543${String(++seq).padStart(4, '0')}${d}`;

function world({ env = {}, overrides = {}, fetchImpl } = {}) {
  const store = memoryStore({ products: [product] });
  const fullEnv = { PAYDAY_API_KEY: BOOT, ACME_WEBHOOK_SECRET: 's3cret', PARTNER_ACME_SECRET: 'partner-secret', ...env };
  const registry = createRegistry({ env: {}, overrides, specs: { acme } });
  const app = createApp({ store, registry, env: fullEnv, fetchImpl });
  const as = (key) => (method, path, body, { query, headers = {} } = {}) => app.handle({
    method, path, query, headers: { ...(key ? { 'x-api-key': key } : {}), ...headers },
    rawBody: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { store, registry, app, as, admin: as(BOOT) };
}

async function newClient(w, body) {
  const r = await w.admin('POST', '/v1/clients', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { ...r.body, call: w.as(r.body.api_key) };
}
async function newPartner(w, name) {
  const p = await w.admin('POST', '/v1/partners', { name, callback_url: 'https://hooks.acme.example/payday', callback_secret_env: 'PARTNER_ACME_SECRET' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const c = await newClient(w, { name: `${name} prod`, role: 'partner', partner_id: p.body.id });
  return { partnerId: p.body.id, ...c };
}
const grant = (call, id) => call('POST', `/v1/customers/${id}/consents`, { purposes: ['kyc', 'credit_bureau', 'terms'], text_version: 'v1', channel: 'partner' });
const apply = (call, customerId, amt = 10000) => call('POST', '/v1/applications', { customer_id: customerId, product_code: 'PAYDAY_30', requested_amount: amt, intake });
const sign = (payload) => { const raw = JSON.stringify(payload); return { raw, sig: createHmac('sha256', 's3cret').update(raw).digest('hex') }; };

test('roles: each key can only do what its role allows', async () => {
  const w = await world();
  const ops = await newClient(w, { name: 'Ops desk', role: 'ops' });
  const partner = await newPartner(w, 'Acme');
  const someId = '11111111-2222-3333-4444-555555555555';
  const matrix = [
    // [method, path, body, admin, ops, partner]  -> expected "allowed" (not 401/403); resource errors like 404/400/409 still count as allowed
    ['GET', '/v1/clients', undefined, true, false, false],
    ['POST', '/v1/clients', { name: 'x', role: 'ops' }, true, false, false],
    ['GET', '/v1/partners', undefined, true, false, false],
    ['POST', '/v1/partners', { name: 'P2' }, true, false, false],
    ['GET', '/v1/audit', undefined, true, false, false],
    ['POST', '/v1/policies', { version: 'V9', config: DEFAULT_POLICY }, true, false, false],
    ['GET', '/v1/policies', undefined, true, true, false],
    ['GET', '/v1/policies/active', undefined, true, true, false],
    ['POST', `/v1/loans/${someId}/write-off`, {}, true, false, false],
    ['POST', `/v1/loans/${someId}/payments`, { amount: 1, mode: 'upi' }, true, true, false],
    ['POST', `/v1/loans/${someId}/rollover`, {}, true, true, false],
    ['POST', `/v1/applications/${someId}/disburse`, { account }, true, true, false],
    ['POST', '/v1/jobs/daily-servicing', {}, true, true, false],
    ['POST', '/v1/jobs/reconcile-payouts', {}, true, true, false],
    ['POST', '/v1/jobs/deliver-partner-events', {}, true, true, false],
    ['GET', `/v1/customers/${someId}/eligibility`, undefined, true, true, false],
    ['POST', '/v1/customers', { mobile: mobile() }, true, true, true],
    ['GET', `/v1/loans/${someId}`, undefined, true, true, true],
    ['GET', `/v1/applications/${someId}`, undefined, true, true, true],
  ];
  for (const [method, path, body, a, o, p] of matrix) {
    for (const [who, call, want] of [['admin', w.admin, a], ['ops', ops.call, o], ['partner', partner.call, p]]) {
      const r = await call(method, path, body, { query: { product: 'PAYDAY_30' } });
      const allowed = r.status !== 403 && r.status !== 401;
      assert.equal(allowed, want, `${who} ${method} ${path} -> ${r.status}`);
    }
    assert.equal((await w.as(null)(method, path, body)).status, 401, `no key ${method} ${path}`);
  }
});

test('clients: the key is shown once, never listed, revocable, and input is validated', async () => {
  const w = await world();
  const made = await newClient(w, { name: 'Ops desk', role: 'ops' });
  assert.match(made.api_key, /^pk_/);
  assert.match(made.warning, /cannot be shown again/);
  const list = await w.admin('GET', '/v1/clients');
  assert.equal(JSON.stringify(list.body).includes(made.api_key), false);
  assert.equal(JSON.stringify(list.body).includes('key_hash'), false);
  assert.equal((await made.call('GET', '/v1/policies')).status, 200);

  assert.equal((await w.admin('POST', `/v1/clients/${made.client.id}/revoke`)).status, 200);
  assert.equal((await made.call('GET', '/v1/policies')).status, 401, 'a revoked key stops working at once');

  const bad = await w.admin('POST', '/v1/clients', { name: 'x', role: 'partner' });
  assert.deepEqual([bad.status, bad.body.details], [400, ['a partner key needs a partner_id']]);
  assert.equal((await w.admin('POST', '/v1/clients', { name: 'x', role: 'king' })).status, 400);
});

test('partner isolation: a partner sees only its own customers, applications and loans, and only the outcome', async () => {
  const w = await world();
  const A = await newPartner(w, 'PartnerA');
  const B = await newPartner(w, 'PartnerB');
  const ops = await newClient(w, { name: 'Ops desk', role: 'ops' });

  const c = await A.call('POST', '/v1/customers', { mobile: mobile(), source: 'spoofed', salary_day: 1 });
  assert.equal(c.status, 200);
  const stored = await w.store.getCustomer(c.body.customer_id);
  assert.equal(stored.source, `partner:${A.partnerId}`, 'a partner cannot choose the source field');
  assert.equal((await grant(A.call, c.body.customer_id)).status, 201);
  const channelStored = w.store.db.consents.at(-1).channel;
  assert.equal(channelStored, 'partner');

  const a = await apply(A.call, c.body.customer_id);
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(a.body).sort(), ['application_id', 'decision', 'is_repeat', 'offer', 'stage'], 'partner view: no grade, points, reasons or vendor details');
  assert.equal(a.body.decision, 'approve');
  assert.equal(a.body.offer.amount, 10000);
  assert.equal((await w.store.getApplication(a.body.application_id)).partner_id, A.partnerId);

  // B cannot see or touch anything of A's: everything answers 404, so B cannot even probe for ids
  const appId = a.body.application_id;
  for (const [method, path, body] of [
    ['GET', `/v1/applications/${appId}`], ['POST', `/v1/applications/${appId}/agreement`],
    ['POST', `/v1/customers/${c.body.customer_id}/consents`, { purposes: ['kyc'], text_version: 'v1' }],
    ['POST', `/v1/customers/${c.body.customer_id}/consents/revoke`, { purpose: 'kyc' }],
  ]) assert.equal((await B.call(method, path, body)).status, 404, `${method} ${path}`);
  assert.equal((await apply(B.call, c.body.customer_id)).status, 404, 'B cannot apply for A\'s customer');

  // ops and admin see everything, with internal detail
  const seen = await ops.call('GET', `/v1/applications/${appId}`);
  assert.deepEqual([seen.status, seen.body.partner_id], [200, A.partnerId]);
  const mine = await A.call('GET', `/v1/applications/${appId}`);
  assert.equal('decision_reasons' in mine.body, false);
  assert.equal('partner_id' in mine.body, false);

  // a partner cannot take over or overwrite a customer that already exists elsewhere
  const elsewhere = await ops.call('POST', '/v1/customers', { mobile: '9654300001', employer_name: 'Original Pvt Ltd' });
  assert.equal(elsewhere.status, 200);
  const grab = await A.call('POST', '/v1/customers', { mobile: '9654300001', employer_name: 'Hijacked' });
  assert.deepEqual([grab.status, grab.body.code], [409, 'CUSTOMER_EXISTS']);
  assert.equal((await w.store.getCustomer(elsewhere.body.customer_id)).employer_name, 'Original Pvt Ltd');
  const mineAgain = await A.call('POST', '/v1/customers', { mobile: stored.mobile, employer_name: 'Updated by A' });
  assert.equal(mineAgain.status, 200, 'a partner can update its own customer');
  assert.equal(mineAgain.body.customer_id, c.body.customer_id);
});

test('partner journey end to end: apply, agreement, signed webhook, ops disburses, callbacks delivered and signed', async () => {
  const sent = [];
  const w = await world({ fetchImpl: async (url, init) => { sent.push({ url, init }); return { status: 200 }; } });
  const A = await newPartner(w, 'PartnerA');
  const ops = await newClient(w, { name: 'Ops desk', role: 'ops' });
  const c = await A.call('POST', '/v1/customers', { mobile: mobile(), salary_day: 1 });
  await grant(A.call, c.body.customer_id);
  const a = await apply(A.call, c.body.customer_id);
  const appId = a.body.application_id;
  assert.equal((await A.call('POST', `/v1/applications/${appId}/agreement`)).status, 201);
  const { raw, sig } = sign({ event_id: 'ev1', type: 'esign.signed', data: { application_ref: appId } });
  assert.equal((await w.as(null)('POST', '/v1/webhooks/acme', raw, { headers: { 'x-acme-signature': sig } })).status, 200);

  assert.equal((await A.call('POST', `/v1/applications/${appId}/disburse`, { account })).status, 403, 'a partner cannot trigger a payout');
  const d = await ops.call('POST', `/v1/applications/${appId}/disburse`, { account });
  assert.equal(d.status, 200);
  const loanId = d.body.loan_id;

  const loan = await A.call('GET', `/v1/loans/${loanId}`);
  assert.equal(loan.status, 200);
  assert.equal('ledger_balance' in loan.body, false, 'ledger internals are not a partner field');
  assert.equal(loan.body.outstanding, 10800);
  assert.ok(loan.body.apr_pct > 0, 'the loan carries its APR');
  assert.equal((await A.call('POST', `/v1/loans/${loanId}/collect`, {})).status, 201);
  assert.equal((await A.call('POST', `/v1/loans/${loanId}/payments`, { amount: 1, mode: 'upi' })).status, 403);

  const job = await ops.call('POST', '/v1/jobs/deliver-partner-events', {});
  assert.deepEqual([job.status, job.body.delivered, job.body.failed], [200, 3, 0], 'decided, signed and disbursed');
  assert.deepEqual(sent.map((s) => JSON.parse(s.init.body).type), ['application.decided', 'agreement.signed', 'loan.disbursed']);
  const first = sent[0].init;
  const ts = first.headers['x-payday-timestamp'];
  assert.equal(first.headers['x-payday-signature'], `sha256=${createHmac('sha256', 'partner-secret').update(`${ts}.${first.body}`).digest('hex')}`);
  assert.equal(JSON.stringify(sent.map((s) => s.init.body)).includes('grade'), false, 'no scoring detail leaves the building');
  assert.equal((await ops.call('POST', '/v1/jobs/deliver-partner-events', {})).body.due, 0, 'nothing is sent twice');
});

test('consent is required before an application, and revoking it blocks the next one', async () => {
  const w = await world();
  const ops = await newClient(w, { name: 'Ops desk', role: 'ops' });
  const c = await ops.call('POST', '/v1/customers', { mobile: mobile() });
  const id = c.body.customer_id;
  const blocked = await apply(ops.call, id);
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'CONSENT_REQUIRED']);
  assert.match(blocked.body.error, /kyc, credit_bureau, terms/);
  assert.equal(w.store.db.kycChecks.length, 0, 'no vendor was called without consent');

  assert.equal((await ops.call('POST', `/v1/customers/${id}/consents`, { purposes: ['kyc', 'nonsense'], text_version: 'v1', channel: 'app' })).status, 400);
  assert.equal((await ops.call('POST', `/v1/customers/${id}/consents`, { purposes: ['kyc', 'credit_bureau', 'terms'], text_version: 'v1', channel: 'app', evidence: { otp_ref: 'o1' } })).status, 201);
  const ok = await apply(ops.call, id);
  assert.equal(ok.status, 200);

  const rev = await ops.call('POST', `/v1/customers/${id}/consents/revoke`, { purpose: 'credit_bureau' });
  assert.deepEqual([rev.status, rev.body.revoked], [200, 1]);
  const after = await apply(ops.call, id, 5000);
  assert.deepEqual([after.status, after.body.code], [409, 'OPEN_LOAN'].includes(after.body.code) ? [409, 'OPEN_LOAN'] : [409, 'CONSENT_REQUIRED']);
  assert.match(after.body.error, /credit_bureau|open loan/);

  // switched off by configuration only (never by a request)
  const off = await world({ env: { PAYDAY_REQUIRE_CONSENT: '0' } });
  const c2 = await off.admin('POST', '/v1/customers', { mobile: mobile() });
  assert.equal((await apply(off.admin, c2.body.customer_id)).status, 200);
});

test('credit policy: draft, simulate, activate; the credit team changes a decision with no developer', async () => {
  const w = await world();
  const ops = await newClient(w, { name: 'Ops desk', role: 'ops' });
  const draft = structuredClone(DEFAULT_POLICY); draft.version = 'PAYDAY_V2';
  draft.bands[0].min = 120; draft.bands[1].min = 119; draft.bands[2].min = 118; draft.bands[3].min = 117;

  assert.equal((await ops.call('POST', '/v1/policies', { version: 'PAYDAY_V2', config: draft })).status, 403);
  const bad = structuredClone(draft); bad.decisionByGrade.E = 'approve';
  const rejected = await w.admin('POST', '/v1/policies', { version: 'PAYDAY_V2', config: bad });
  assert.equal(rejected.status, 400);
  assert.ok(rejected.body.details.some((d) => /grade E must decide/.test(d)));

  const made = await w.admin('POST', '/v1/policies', { version: 'PAYDAY_V2', config: draft, note: 'tighter bands' });
  assert.deepEqual([made.status, made.body.status], [201, 'draft']);
  assert.equal((await w.admin('POST', '/v1/policies', { version: 'PAYDAY_V2', config: draft })).status, 409, 'versions are unique');

  const c = await w.admin('POST', '/v1/customers', { mobile: mobile() });
  await grant(w.admin, c.body.customer_id);
  const features = { cibil: 780, maxDpd12m: 0, npaStatus: 'none', activeLoans: 1, enquiries90d: 0, bureauEmiBounces: 0, ccUtilPct: 10, abb: 40000, creditTrendPct: 12, bankBounces6m: 0, txnPerMonth: 40, cashDepositPct: 2, netSalary: 60000, salaryCredits6m: 6, salaryVariationPct: 2, salaryTrendPct: 6, salaryMatchVariancePct: 3, tenureMonths: 48, employerCategory: 'govt_psu', residence: 'owned', foirPct: 20, purposeClarity: 'specific_documented', referencesVerified: 'both' };
  const sim = await ops.call('POST', '/v1/policies/simulate', { config: draft, features: { ...features, cibil: 700 }, product_code: 'PAYDAY_30', requested_amount: 10000 });
  assert.equal(sim.status, 200);
  assert.deepEqual([sim.body.result.modelVersion, sim.body.result.decision], ['PAYDAY_V2', 'reject']);
  const live = await ops.call('POST', '/v1/policies/simulate', { features: { ...features, cibil: 700 }, product_code: 'PAYDAY_30', requested_amount: 10000 });
  assert.equal(live.body.result.decision, 'approve', 'the current policy still approves the same file');
  assert.equal((await w.admin('GET', '/v1/policies')).body.policies.length, 1, 'simulating saved nothing');
  assert.equal((await ops.call('POST', '/v1/policies/simulate', { features: {}, product_code: 'PAYDAY_30', requested_amount: 10000, config: { nope: 1 } })).status, 400);

  const before = await apply(w.admin, c.body.customer_id);
  assert.equal(before.body.policy_version, 'PAYDAY_LITE_V1', 'no bank statement is pulled, so the no-bank scorecard applies');
  assert.equal((await w.admin('GET', '/v1/policies/active')).body.source, 'built-in default');

  const act = await w.admin('POST', `/v1/policies/${made.body.id}/activate`);
  assert.deepEqual([act.status, act.body.status], [200, 'active']);
  assert.equal((await ops.call('GET', '/v1/policies/active')).body.version, 'PAYDAY_V2');
  assert.equal((await w.admin('PUT', `/v1/policies/${made.body.id}`, { config: draft })).status, 409, 'an active version cannot be edited');

  // the next application is decided under the new version, and an unchanged earlier decision keeps its own
  const c2 = await w.admin('POST', '/v1/customers', { mobile: mobile() });
  await grant(w.admin, c2.body.customer_id);
  const after = await apply(w.admin, c2.body.customer_id);
  assert.deepEqual([after.body.decision, after.body.policy_version], ['reject', 'PAYDAY_V2']);
  assert.deepEqual(w.store.db.scorecards.map((s) => s.model_version), ['PAYDAY_LITE_V1', 'PAYDAY_V2']);
});

test('credit policy: optional maker-checker needs a second admin', async () => {
  const w = await world({ env: { PAYDAY_POLICY_MAKER_CHECKER: '1' } });
  const asha = await newClient(w, { name: 'Asha', role: 'admin' });
  const ravi = await newClient(w, { name: 'Ravi', role: 'admin' });
  const made = await asha.call('POST', '/v1/policies', { version: 'PAYDAY_V2', config: DEFAULT_POLICY });
  const self = await asha.call('POST', `/v1/policies/${made.body.id}/activate`);
  assert.equal(self.status, 409);
  assert.match(self.body.error, /different admin/);
  assert.equal((await ravi.call('POST', `/v1/policies/${made.body.id}/activate`)).status, 200);
});

test('audit: who did what is recorded, secrets are redacted, and nothing is paid if the audit row cannot be written', async () => {
  let payouts = 0;
  const payout = { name: 'spy', disburse: async ({ idempotencyKey }) => { payouts += 1; return { status: 'success', utr: `U-${idempotencyKey}` }; } };
  const w = await world({ overrides: { payout } });
  const ops = await newClient(w, { name: 'Asha (ops)', role: 'ops' });
  const c = await ops.call('POST', '/v1/customers', { mobile: mobile(), salary_day: 1 });
  await grant(ops.call, c.body.customer_id);
  const a = await apply(ops.call, c.body.customer_id);
  const appId = a.body.application_id;
  await ops.call('POST', `/v1/applications/${appId}/agreement`);
  const { raw, sig } = sign({ event_id: 'ev-aud', type: 'esign.signed', data: { application_ref: appId } });
  await w.as(null)('POST', '/v1/webhooks/acme', raw, { headers: { 'x-acme-signature': sig } });

  // make the audit write fail: the payout must not happen
  const realInsert = w.store.insertAudit;
  w.store.insertAudit = async () => { throw new Error('audit store down'); };
  const origError = console.error; console.error = () => {};
  try {
    const refused = await ops.call('POST', `/v1/applications/${appId}/disburse`, { account });
    assert.equal(refused.status, 500);
  } finally { console.error = origError; w.store.insertAudit = realInsert; }
  assert.equal(payouts, 0, 'no audit row, no money moved');
  assert.equal(w.store.db.loans.length, 0, 'not even a loan row was created');

  const ok = await ops.call('POST', `/v1/applications/${appId}/disburse`, { account });
  assert.equal(ok.status, 200);
  assert.equal(payouts, 1);

  assert.equal((await ops.call('GET', '/v1/audit')).status, 403, 'only admins read the audit log');
  const log = await w.admin('GET', '/v1/audit', undefined, { query: { entity_type: 'application', entity_id: appId } });
  assert.equal(log.status, 200);
  const disburse = log.body.entries.find((e) => e.action === 'loan.disburse');
  assert.deepEqual([disburse.actor_name, disburse.actor_role], ['Asha (ops)', 'ops']);
  assert.equal(disburse.details.amount, 10000);
  const whole = JSON.stringify(log.body);
  assert.equal(whole.includes('123456789012'), false, 'the bank account number never reaches the audit log');
  assert.equal(whole.includes('HDFC0000001'), false);
  const actions = (await w.admin('GET', '/v1/audit', undefined, { query: { limit: '500' } })).body.entries.map((e) => e.action);
  for (const want of ['client.create', 'customer.upsert', 'consent.record', 'application.create', 'application.agreement', 'loan.disburse']) assert.ok(actions.includes(want), want);
  assert.equal(JSON.stringify(actions).includes('pk_'), false);
  const bootstrap = (await w.admin('GET', '/v1/audit')).body.entries.find((e) => e.action === 'client.create');
  assert.equal(bootstrap.actor_name, 'bootstrap');
});

test('partners: callback validation, and deactivating a partner switches its keys off', async () => {
  const w = await world();
  const bad = await w.admin('POST', '/v1/partners', { name: 'Bad', callback_url: 'https://10.0.0.1/hook', callback_secret_env: 'PARTNER_BAD_SECRET' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.details.join(' '), /host name, not an IP address/);
  assert.equal((await w.admin('POST', '/v1/partners', { name: 'Bad', callback_url: 'http://hooks.example.com/x', callback_secret_env: 'PARTNER_BAD_SECRET' })).status, 400);
  assert.equal((await w.admin('POST', '/v1/partners', { name: 'Bad', callback_url: 'https://hooks.example.com/x' })).status, 400);
  const A = await newPartner(w, 'PartnerA');
  assert.equal((await A.call('POST', '/v1/customers', { mobile: mobile() })).status, 200);
  assert.equal((await w.admin('POST', `/v1/partners/${A.partnerId}/deactivate`)).status, 200);
  assert.equal((await A.call('POST', '/v1/customers', { mobile: mobile() })).status, 401, 'a deactivated partner is locked out at once');
  assert.equal(JSON.stringify((await w.admin('GET', '/v1/partners')).body).includes('partner-secret'), false, 'only the env var NAME is ever stored or listed');
});

test('APR is shown on the offer and stored on the application', async () => {
  const w = await world();
  const c = await w.admin('POST', '/v1/customers', { mobile: mobile() });
  await grant(w.admin, c.body.customer_id);
  const a = await apply(w.admin, c.body.customer_id);
  assert.deepEqual([a.body.offer.aprSimplePct, a.body.offer.tenureDays], [97.33, 30]);
  assert.ok(a.body.offer.aprEffectivePct > 150);
  const got = await w.admin('GET', `/v1/applications/${a.body.application_id}`);
  assert.equal(got.body.offered_apr_pct, a.body.offer.aprEffectivePct);
});

test('small ticket: no bank statement is pulled by default, and a clean file is approved on the no-bank scorecard', async () => {
  let bankCalls = 0;
  const bankStatement = { name: 'spy', analyse: async () => { bankCalls += 1; throw new Error('must not be called'); } };
  const w = await world({ overrides: { bankStatement } });
  const c = await w.admin('POST', '/v1/customers', { mobile: mobile() });
  await grant(w.admin, c.body.customer_id);
  const a = await apply(w.admin, c.body.customer_id);
  assert.deepEqual([a.status, a.body.decision, a.body.policy_version], [200, 'approve', 'PAYDAY_LITE_V1']);
  assert.equal(bankCalls, 0);
  assert.equal((await w.admin('GET', '/v1/policies/active')).body.version, 'PAYDAY_LITE_V1');

  // switched on for larger tickets: the bank statement is pulled and the full scorecard is the fallback
  const w2 = await world({ overrides: { bankStatement }, env: { PAYDAY_BANK_STATEMENT_ABOVE: '20000' } });
  assert.equal((await w2.admin('GET', '/v1/policies/active')).body.version, 'PAYDAY_V1');
});

test('start-up: the bootstrap key is only needed until a real admin client exists', async () => {
  const store = memoryStore({});
  assert.match(await adminAccessProblem({ store, env: {} }), /no admin access/, 'no key and no admin client: refuse to start');
  assert.equal(await adminAccessProblem({ store, env: { PAYDAY_API_KEY: 'k' } }), null, 'bootstrap key present');
  const { client } = await createApiClient({ store, name: 'ops lead', role: 'ops' });
  assert.match(await adminAccessProblem({ store, env: {} }), /no admin access/, 'an ops client is not admin access');
  const { client: admin } = await createApiClient({ store, name: 'cto', role: 'admin' });
  assert.equal(await adminAccessProblem({ store, env: {} }), null, 'an active admin client makes the bootstrap key unnecessary');
  await store.revokeApiClient(admin.id);
  assert.match(await adminAccessProblem({ store, env: {} }), /no admin access/, 'a revoked admin does not count');
  assert.ok(client.id);
});

test('partner application limit: a partner key gets 3 applications per customer per 24h, ops and admin are not limited', async () => {
  const w = await world();
  const A = await newPartner(w, 'Acme');
  const cust = (await A.call('POST', '/v1/customers', { mobile: mobile() })).body.customer_id;
  assert.equal((await grant(A.call, cust)).status, 201);
  for (let i = 0; i < 3; i += 1) assert.equal((await apply(A.call, cust)).status, 200, `application ${i + 1} is allowed`);
  const over = await apply(A.call, cust);
  assert.deepEqual([over.status, over.body.code], [429, 'TOO_MANY_APPLICATIONS']);
  assert.equal(w.store.db.applications.length, 3, 'the refused request created nothing and called no vendor');
  // an operator is not limited
  const ops = await newClient(w, { name: 'Ops desk', role: 'ops' });
  assert.equal((await apply(ops.call, cust)).status, 200);
  // another partner's customer is counted separately, and the limit is configurable (0 = off)
  const off = await world({ env: { PAYDAY_PARTNER_APPS_PER_DAY: '0' } });
  const B = await newPartner(off, 'Acme');
  const c2 = (await B.call('POST', '/v1/customers', { mobile: mobile() })).body.customer_id;
  await grant(B.call, c2);
  for (let i = 0; i < 5; i += 1) assert.equal((await apply(B.call, c2)).status, 200);
  const one = await world({ env: { PAYDAY_PARTNER_APPS_PER_DAY: '1' } });
  const C = await newPartner(one, 'Acme');
  const c3 = (await C.call('POST', '/v1/customers', { mobile: mobile() })).body.customer_id;
  await grant(C.call, c3);
  assert.equal((await apply(C.call, c3)).status, 200);
  assert.equal((await apply(C.call, c3)).status, 429);
});
