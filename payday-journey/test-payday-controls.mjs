// Consent, API clients, audit, partners and callbacks, credit policies, and APR in the agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DEFAULT_POLICY, aprFor } from '../payday-engine/index.js';
import {
  createRegistry, memoryStore, runUnderwriting, createApplication, ApplicationError, sendAgreement, recordAgreementSigned,
  disburseLoan, recordPayment, recordConsents, missingConsents, revokeConsent, REQUIRED_CONSENTS, createApiClient, authenticate,
  hashKey, audit, redact, createPartner, validateCallbackUrl, emitPartnerEvent, deliverPartnerEvents, signPartnerPayload,
  createPolicyDraft, updatePolicyDraft, activatePolicy, loadActivePolicy, simulatePolicy, ValidationError, BusinessRuleError,
} from './index.js';

const product = {
  id: 'prod-1', code: 'PAYDAY_30', min_amount: 5000, max_amount: 25000, tenure_days: 30,
  fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, rollover_allowed: true, max_rollovers: 1, active: true,
};
const intake = {
  declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long',
  purposeClarity: 'specific_documented', referencesVerified: 'both',
};
const account = { name: 'Test Customer', number: '123456789012', ifsc: 'HDFC0000001' };
let seq = 0;
const mobile = (d = 3) => `97654${String(++seq).padStart(4, '0')}${d}`;
const rejects = (p, cls, re) => assert.rejects(p, (e) => e instanceof cls && (!re || re.test(e.message)));

// ---------------------------------------------------------------- consent
test('consent: recorded per purpose, validated, revocable, and required before an application', async () => {
  const store = memoryStore({ products: [product] });
  const c = await store.upsertCustomer({ mobile: mobile() });
  assert.deepEqual(await missingConsents({ store, customerId: c.id }), REQUIRED_CONSENTS);
  await rejects(createApplication({ store, customer: c, product, requestedAmount: 10000, requiredConsents: REQUIRED_CONSENTS }), ApplicationError, /consent not recorded for: kyc, credit_bureau, terms/);

  await rejects(recordConsents({ store, customerId: c.id, purposes: ['kyc', 'sell_my_data'], textVersion: 'v1', channel: 'app' }), ValidationError, /unknown purpose/);
  await rejects(recordConsents({ store, customerId: c.id, purposes: [], textVersion: 'v1', channel: 'app' }), ValidationError, /non-empty/);
  await rejects(recordConsents({ store, customerId: c.id, purposes: ['kyc'], textVersion: 'v 1!', channel: 'app' }), ValidationError, /textVersion/);
  await rejects(recordConsents({ store, customerId: c.id, purposes: ['kyc'], textVersion: 'v1', channel: 'carrier-pigeon' }), ValidationError, /channel/);
  await rejects(recordConsents({ store, customerId: c.id, purposes: ['kyc'], textVersion: 'v1', channel: 'app', evidence: { blob: 'x'.repeat(5000) } }), ValidationError, /4 KB/);

  const r = await recordConsents({ store, customerId: c.id, purposes: ['kyc', 'credit_bureau', 'terms', 'kyc'], textVersion: 'v1', channel: 'partner', evidence: { otp_ref: 'o-1' } });
  assert.deepEqual(r.recorded, ['kyc', 'credit_bureau', 'terms'], 'duplicates collapse');
  assert.deepEqual(await missingConsents({ store, customerId: c.id }), []);
  const { application } = await createApplication({ store, customer: c, product, requestedAmount: 10000, requiredConsents: REQUIRED_CONSENTS });
  assert.ok(application.id);

  assert.deepEqual(await revokeConsent({ store, customerId: c.id, purpose: 'credit_bureau' }), { revoked: 1 });
  assert.deepEqual(await missingConsents({ store, customerId: c.id }), ['credit_bureau']);
  await rejects(revokeConsent({ store, customerId: c.id, purpose: 'nonsense' }), ValidationError);
  await recordConsents({ store, customerId: c.id, purposes: ['credit_bureau'], textVersion: 'v2', channel: 'app' });
  assert.deepEqual(await missingConsents({ store, customerId: c.id }), [], 'a fresh grant after revocation counts');
  assert.equal(store.db.consents.filter((x) => x.revoked_at).length, 1, 'the revoked row is kept, not deleted');
});

// ---------------------------------------------------------------- API clients
test('clients: keys are random, only the hash is stored, and revoked or deactivated keys stop working', async () => {
  const store = memoryStore();
  const { client, key } = await createApiClient({ store, name: 'Ops team', role: 'ops' });
  assert.match(key, /^pk_[\w-]{43}$/);
  assert.equal(JSON.stringify(store.db.apiClients).includes(key), false, 'the key itself is never stored');
  assert.equal(store.db.apiClients[0].key_hash, hashKey(key));
  const a = await createApiClient({ store, name: 'Another', role: 'admin' });
  assert.notEqual(a.key, key);

  assert.deepEqual(await authenticate({ store, key }), { id: client.id, name: 'Ops team', role: 'ops', partner_id: null });
  assert.equal(await authenticate({ store, key: `${key}x` }), null);
  assert.equal(await authenticate({ store, key: '' }), null);
  assert.equal(await authenticate({ store, key: undefined }), null);
  assert.equal(await authenticate({ store, key: 'a'.repeat(500) }), null);
  assert.deepEqual(await authenticate({ store, key: 'boot', bootstrapKey: 'boot' }), { id: null, name: 'bootstrap', role: 'admin', partner_id: null });
  assert.equal(await authenticate({ store, key: 'boot', bootstrapKey: 'other' }), null);
  assert.ok(store.db.apiClients[0].last_used_at, 'last use is recorded');

  await store.revokeApiClient(client.id);
  assert.equal(await authenticate({ store, key }), null, 'a revoked key stops working');
  assert.equal((await store.listApiClients())[0].key_hash, undefined, 'listing never exposes hashes');
});

test('clients: partner keys must name a live partner; other roles must not', async () => {
  const store = memoryStore();
  await rejects(createApiClient({ store, name: 'x', role: 'partner' }), ValidationError, /needs a partner_id/);
  await rejects(createApiClient({ store, name: 'x', role: 'admin', partnerId: 'p' }), ValidationError, /only a partner key/);
  await rejects(createApiClient({ store, name: 'x', role: 'king' }), ValidationError, /role must be one of/);
  await rejects(createApiClient({ store, name: '', role: 'ops' }), ValidationError, /name/);
  await rejects(createApiClient({ store, name: 'x', role: 'partner', partnerId: 'missing' }), ValidationError, /partner not found/);
  const p = await createPartner({ store, name: 'Acme Lending' });
  const { key } = await createApiClient({ store, name: 'Acme prod', role: 'partner', partnerId: p.id });
  assert.equal((await authenticate({ store, key })).partner_id, p.id);
  store.db.partners[0].active = false;
  assert.equal(await authenticate({ store, key }), null, 'deactivating a partner disables its keys at once');
});

// ---------------------------------------------------------------- audit
test('audit: rows carry the actor; secrets and account details are redacted', async () => {
  const store = memoryStore();
  await audit({ store, actor: { id: 'c1', name: 'Asha', role: 'ops' }, action: 'loan.disburse', entityType: 'application', entityId: 'a1', details: { account: { number: '123456789012', ifsc: 'HDFC0000001' }, pan: 'ABCDE1234F', amount: 10000, nested: { api_key: 'sekret', note: 'ok' } } });
  await audit({ store, actor: null, action: 'job.daily-servicing' });
  const [a, b] = store.db.audit;
  assert.deepEqual([a.actor_name, a.actor_role, a.entity_id, a.details.amount], ['Asha', 'ops', 'a1', 10000]);
  assert.equal(JSON.stringify(a).includes('123456789012'), false);
  assert.equal(JSON.stringify(a).includes('ABCDE1234F'), false);
  assert.equal(JSON.stringify(a).includes('sekret'), false);
  assert.equal(a.details.nested.note, 'ok', 'harmless fields survive');
  assert.deepEqual([b.actor_name, b.actor_role, b.actor_client_id], ['system', 'system', null]);
  assert.deepEqual(redact({ a: [{ token: 'x', ok: 1 }] }), { a: [{ token: '[redacted]', ok: 1 }] });
});

// ---------------------------------------------------------------- partner callbacks
test('callback URLs: https on a host name only, never an IP address in any notation', () => {
  assert.equal(validateCallbackUrl('https://hooks.partner.example/payday'), 'https://hooks.partner.example/payday');
  for (const bad of [
    'http://hooks.partner.example/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.1/x',
    'https://172.20.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:10.0.0.1]/x',
    'https://user:pw@hooks.partner.example/x', 'https://hooks.partner.example:8443/x', 'https://intranet/x', 'https://db.internal/x',
    'https://printer.local/x', 'not a url', 'ftp://hooks.partner.example/x', 'https://0.0.0.0/x', 'https://100.64.0.1/x',
    'https://8.8.8.8/x',                       // even a public IP: host names only
    'https://2130706433/x', 'https://0x7f.1/x', 'https://017700000001/x', // other notations of 127.0.0.1
    'https://[::ffff:7f00:1]/x', 'https://[0:0:0:0:0:ffff:a00:1]/x', 'https://[64:ff9b::a00:1]/x', 'https://[2001:db8::1]/x',
  ]) assert.throws(() => validateCallbackUrl(bad), ValidationError, bad);
});

test('partners: created with validation; the signing secret is a variable NAME, never stored', async () => {
  const store = memoryStore();
  await rejects(createPartner({ store, name: 'A', callbackUrl: 'https://a.example/x' }), ValidationError, /callback_secret_env is required/);
  await rejects(createPartner({ store, name: 'A', callbackUrl: 'https://a.example/x', callbackSecretEnv: 'lowercase' }), ValidationError, /env var name/);
  await rejects(createPartner({ store, name: 'A', callbackUrl: 'http://a.example/x', callbackSecretEnv: 'PARTNER_A_SECRET' }), ValidationError, /https/);
  const p = await createPartner({ store, name: 'A', callbackUrl: 'https://a.example/x', callbackSecretEnv: 'PARTNER_A_SECRET' });
  assert.equal(p.callback_secret_env, 'PARTNER_A_SECRET');
  await assert.rejects(() => createPartner({ store, name: 'A' }), (e) => e.code === '23505', 'names are unique');
});

async function partnerWorld() {
  const store = memoryStore({ products: [product] });
  const partner = await createPartner({ store, name: 'Acme', callbackUrl: 'https://hooks.acme.example/payday', callbackSecretEnv: 'ACME_CALLBACK_SECRET' });
  const customer = await store.upsertCustomer({ mobile: mobile() });
  const app = await store.insertApplication({ customer_id: customer.id, product_id: product.id, requested_amount: 10000, partner_id: partner.id });
  return { store, partner, customer, app };
}

test('partner events: queued only for partner applications, once per type, with no scoring detail', async () => {
  const w = await partnerWorld();
  const plain = await w.store.insertApplication({ customer_id: w.customer.id, product_id: product.id, requested_amount: 5000 });
  assert.equal(await emitPartnerEvent({ store: w.store, applicationId: plain.id, type: 'x' }), null, 'no partner, no event');
  assert.equal(await emitPartnerEvent({ store: w.store, applicationId: 'missing', type: 'x' }), null);
  const e = await emitPartnerEvent({ store: w.store, applicationId: w.app.id, type: 'agreement.signed' });
  assert.deepEqual([e.event_id, e.status], [`${w.app.id}:agreement.signed`, 'pending']);
  assert.equal(await emitPartnerEvent({ store: w.store, applicationId: w.app.id, type: 'agreement.signed' }), null, 'the same event is not queued twice');
  w.store.db.partners[0].callback_url = null;
  assert.equal(await emitPartnerEvent({ store: w.store, applicationId: w.app.id, type: 'loan.closed' }), null, 'a partner without a callback url gets nothing queued');
});

test('partner delivery: signed, timestamped, and marked delivered', async () => {
  const w = await partnerWorld();
  await emitPartnerEvent({ store: w.store, applicationId: w.app.id, type: 'loan.disbursed', data: { amount: 10000 } });
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200 }; };
  const now = new Date('2026-10-09T10:00:00Z');
  const out = await deliverPartnerEvents({ store: w.store, env: { ACME_CALLBACK_SECRET: 's3cret' }, fetchImpl, now });
  assert.deepEqual([out.due, out.delivered, out.retrying, out.failed], [1, 1, 0, 0]);
  const { url, init } = calls[0];
  assert.equal(url, 'https://hooks.acme.example/payday');
  assert.equal(init.redirect, 'error', 'redirects are never followed');
  const ts = init.headers['x-payday-timestamp'];
  assert.equal(ts, String(Math.floor(now.getTime() / 1000)));
  assert.equal(init.headers['x-payday-signature'], `sha256=${createHmac('sha256', 's3cret').update(`${ts}.${init.body}`).digest('hex')}`);
  assert.equal(init.headers['x-payday-signature'], signPartnerPayload('s3cret', ts, init.body));
  const body = JSON.parse(init.body);
  assert.deepEqual([body.type, body.data.application_id, body.data.amount], ['loan.disbursed', w.app.id, 10000]);
  assert.equal(w.store.db.partnerEvents[0].status, 'delivered');
  assert.equal((await deliverPartnerEvents({ store: w.store, env: { ACME_CALLBACK_SECRET: 's3cret' }, fetchImpl, now })).due, 0, 'delivered events are not sent again');
});

test('partner delivery: failures back off, then give up; a missing secret or inactive partner is handled', async () => {
  const w = await partnerWorld();
  await emitPartnerEvent({ store: w.store, applicationId: w.app.id, type: 'loan.closed' });
  const env = { ACME_CALLBACK_SECRET: 's3cret' };
  let now = new Date('2026-10-09T10:00:00Z');
  const down = async () => ({ status: 503 });
  let out = await deliverPartnerEvents({ store: w.store, env, fetchImpl: down, now });
  assert.deepEqual([out.retrying, out.failed], [1, 0]);
  let ev = w.store.db.partnerEvents[0];
  assert.deepEqual([ev.status, ev.attempts, ev.last_error], ['pending', 1, 'HTTP 503']);
  assert.equal(ev.next_attempt_at, new Date(now.getTime() + 2 * 60000).toISOString(), 'first retry in 2 minutes');
  assert.equal((await deliverPartnerEvents({ store: w.store, env, fetchImpl: down, now })).due, 0, 'not due again yet');

  for (let i = 0; i < 10; i += 1) { now = new Date(now.getTime() + 7 * 3600000); await deliverPartnerEvents({ store: w.store, env, fetchImpl: down, now, maxAttempts: 4 }); }
  ev = w.store.db.partnerEvents[0];
  assert.deepEqual([ev.status, ev.attempts], ['failed', 4], 'gives up after the maximum attempts');
  assert.ok(!ev.last_error.includes('hooks.acme'), 'error text never includes the url or any body');

  // network error and timeout produce plain messages
  const w2 = await partnerWorld();
  await emitPartnerEvent({ store: w2.store, applicationId: w2.app.id, type: 'loan.closed' });
  await deliverPartnerEvents({ store: w2.store, env, now, fetchImpl: async () => { throw new Error('ECONNRESET to 10.1.2.3 with token abc'); } });
  assert.equal(w2.store.db.partnerEvents[0].last_error, 'network error', 'raw error text (which could carry secrets) is not stored');
  const hang = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  const w3 = await partnerWorld();
  await emitPartnerEvent({ store: w3.store, applicationId: w3.app.id, type: 'loan.closed' });
  await deliverPartnerEvents({ store: w3.store, env, now, fetchImpl: hang, timeoutMs: 20 });
  assert.equal(w3.store.db.partnerEvents[0].last_error, 'timed out');

  // no secret configured: retried later, never sent unsigned
  const w4 = await partnerWorld();
  await emitPartnerEvent({ store: w4.store, applicationId: w4.app.id, type: 'loan.closed' });
  let sent = 0;
  await deliverPartnerEvents({ store: w4.store, env: {}, now, fetchImpl: async () => { sent += 1; return { status: 200 }; } });
  assert.equal(sent, 0);
  assert.match(w4.store.db.partnerEvents[0].last_error, /ACME_CALLBACK_SECRET is not set/);

  // partner switched off: event is failed, nothing sent
  const w5 = await partnerWorld();
  await emitPartnerEvent({ store: w5.store, applicationId: w5.app.id, type: 'loan.closed' });
  w5.store.db.partners[0].active = false;
  const o5 = await deliverPartnerEvents({ store: w5.store, env, now, fetchImpl: async () => { sent += 1; return { status: 200 }; } });
  assert.deepEqual([o5.failed, sent], [1, 0]);
});

// ---------------------------------------------------------------- credit policies
const draftConfig = () => structuredClone(DEFAULT_POLICY);

test('policies: draft, edit, activate, one active at a time, frozen once active', async () => {
  const store = memoryStore();
  await rejects(createPolicyDraft({ store, version: 'V2', config: { nope: 1 }, by: 'asha' }), ValidationError, /unknown key/);
  await rejects(createPolicyDraft({ store, version: 'V2', config: null, by: 'asha' }), ValidationError, /config must be an object/);
  const bad = draftConfig(); bad.decisionByGrade.E = 'approve';
  await rejects(createPolicyDraft({ store, version: 'V2', config: bad, by: 'asha' }), ValidationError, /grade E must decide/);

  const v2 = await createPolicyDraft({ store, version: 'PAYDAY_V2', config: { ...draftConfig(), version: 'ignored' }, by: 'asha', note: 'tighter A' });
  assert.deepEqual([v2.status, v2.version, v2.config.version], ['draft', 'PAYDAY_V2', 'PAYDAY_V2'], 'the version argument wins');
  await assert.rejects(() => createPolicyDraft({ store, version: 'PAYDAY_V2', config: draftConfig(), by: 'asha' }), (e) => e.code === '23505', 'versions are unique');

  const edited = draftConfig(); edited.bands[0].min = 100;
  assert.equal((await updatePolicyDraft({ store, id: v2.id, config: edited })).config.bands[0].min, 100);
  const worse = draftConfig(); worse.bands[0].min = 5;
  await rejects(updatePolicyDraft({ store, id: v2.id, config: worse }), ValidationError, /must be above band B/);

  assert.deepEqual(await loadActivePolicy({ store }), DEFAULT_POLICY, 'with nothing active, the built-in default applies');
  const act = await activatePolicy({ store, id: v2.id, by: 'ravi' });
  assert.deepEqual([act.status, act.activated_by], ['active', 'ravi']);
  assert.equal((await loadActivePolicy({ store })).version, 'PAYDAY_V2');

  await rejects(updatePolicyDraft({ store, id: v2.id, config: draftConfig() }), BusinessRuleError, /only a draft can be edited/);
  await assert.rejects(() => store.patchPolicy(v2.id, { config: draftConfig() }), /cannot be edited/, 'frozen at the store as well');
  await rejects(activatePolicy({ store, id: v2.id, by: 'ravi' }), BusinessRuleError, /only a draft can be activated/);
  await rejects(activatePolicy({ store, id: 'missing', by: 'ravi' }), BusinessRuleError, /not found/);

  const v3 = await createPolicyDraft({ store, version: 'PAYDAY_V3', config: draftConfig(), by: 'asha' });
  await activatePolicy({ store, id: v3.id, by: 'ravi' });
  const states = Object.fromEntries((await store.listPolicies()).map((p) => [p.version, p.status]));
  assert.deepEqual(states, { PAYDAY_V2: 'retired', PAYDAY_V3: 'active' }, 'exactly one active; the previous is retired');
  await assert.rejects(() => store.deletePolicy(v3.id), /only a draft/);
});

test('policies: simulate shows the effect of a change and saves nothing', async () => {
  const store = memoryStore();
  const f = { cibil: 700, maxDpd12m: 0, npaStatus: 'none', activeLoans: 1, enquiries90d: 0, bureauEmiBounces: 0, ccUtilPct: 10, abb: 40000, creditTrendPct: 12, bankBounces6m: 0, txnPerMonth: 40, cashDepositPct: 2, netSalary: 60000, salaryCredits6m: 6, salaryVariationPct: 2, salaryTrendPct: 6, salaryMatchVariancePct: 3, tenureMonths: 48, employerCategory: 'govt_psu', residence: 'owned', foirPct: 20, purposeClarity: 'specific_documented', referencesVerified: 'both' };
  const base = simulatePolicy({ policy: DEFAULT_POLICY, features: f, product, requestedAmount: 10000 });
  const strict = draftConfig(); strict.version = 'TRY'; strict.bands[0].min = 121; strict.bands[1].min = 120;
  const after = simulatePolicy({ policy: strict, features: f, product, requestedAmount: 10000 });
  assert.deepEqual([base.grade, after.grade === 'A'], ['A', false]);
  assert.equal(after.modelVersion, 'TRY');
  assert.equal((await store.listPolicies()).length, 0, 'nothing was saved');
  const invalid = draftConfig(); invalid.amountStep = 0;
  assert.throws(() => simulatePolicy({ policy: invalid, features: f, product, requestedAmount: 10000 }), ValidationError);
});

test('END TO END: a credit-team policy change alters a live decision, and the version is recorded on it', async () => {
  const store = memoryStore({ products: [product] });
  const registry = createRegistry({ env: {} });
  const run = async (policy) => {
    const customer = await store.upsertCustomer({ mobile: mobile(3) });
    const { application } = await createApplication({ store, customer, product, requestedAmount: 10000 });
    return runUnderwriting({ registry, store, customer, application, product, intake, policy });
  };
  const before = await run(await loadActivePolicy({ store }));
  assert.deepEqual([before.result.grade, before.result.decision, before.result.modelVersion], ['A', 'approve', 'PAYDAY_V1']);

  const strict = draftConfig();
  strict.bands[0].min = 120; strict.bands[1].min = 119; strict.bands[2].min = 118; strict.bands[3].min = 117; // nearly everyone falls to E
  const draft = await createPolicyDraft({ store, version: 'PAYDAY_STRICT', config: strict, by: 'asha' });
  await activatePolicy({ store, id: draft.id, by: 'ravi' });
  const after = await run(await loadActivePolicy({ store }));
  assert.equal(after.result.decision, 'reject');
  assert.equal(after.result.modelVersion, 'PAYDAY_STRICT');
  assert.equal(store.db.scorecards.at(-1).model_version, 'PAYDAY_STRICT', 'the stored scorecard names the exact policy version');
  assert.equal(store.db.scorecards[0].model_version, 'PAYDAY_V1', 'earlier decisions keep the version they were made under');
});

// ---------------------------------------------------------------- APR and partner events through the flow
test('APR reaches the e-sign request and the loan; a partner receives the milestones', async () => {
  const store = memoryStore({ products: [product] });
  let seen;
  const spyEsign = { name: 'spy', createRequest: async (a) => { seen = a.offer; return { providerRef: 'e1', status: 'sent' }; } };
  const registry = createRegistry({ env: {}, overrides: { esign: spyEsign } });
  const partner = await createPartner({ store, name: 'Acme', callbackUrl: 'https://hooks.acme.example/payday', callbackSecretEnv: 'ACME_CALLBACK_SECRET' });
  const customer = await store.upsertCustomer({ mobile: mobile(3) });
  const { application } = await createApplication({ store, customer, product, requestedAmount: 10000, partnerId: partner.id });
  assert.equal((await store.getApplication(application.id)).partner_id, partner.id);
  const uw = await runUnderwriting({ registry, store, customer, application, product, intake });
  assert.equal(uw.result.decision, 'approve');
  assert.equal((await store.getApplication(application.id)).offered_apr_pct, aprFor(product, 10000, 30).aprEffectivePct);

  await sendAgreement({ registry, store, customer, application });
  assert.deepEqual([seen.amount, seen.fee, seen.repayment, seen.tenureDays], [10000, 800, 10800, 30]);
  assert.deepEqual([seen.aprEffectivePct, seen.aprSimplePct], [aprFor(product, 10000, 30).aprEffectivePct, 97.33]);
  await recordAgreementSigned({ store, applicationId: application.id });
  const d = await disburseLoan({ registry, store, customer, application, product, account, asOf: '2026-01-01' });
  assert.equal(d.status, 'success');
  assert.equal((await store.getLoan(d.loan.id)).apr_pct, aprFor(product, 10000, 30).aprEffectivePct, 'APR is stored on the loan for the actual days');
  await recordPayment({ store, loan: d.loan, product, amount: 10800, mode: 'upi', utr: 'P1', paidAt: '2026-01-10T10:00:00+05:30' });

  const types = store.db.partnerEvents.map((e) => e.event_type);
  assert.deepEqual(types, ['application.decided', 'agreement.signed', 'loan.disbursed', 'loan.closed']);
  const decided = store.db.partnerEvents[0].payload;
  assert.equal(decided.decision, 'approve');
  assert.deepEqual([decided.offer.amount, decided.offer.repayment, decided.offer.apr_simple_pct], [10000, 10800, 97.33]);
  assert.equal(JSON.stringify(store.db.partnerEvents).includes('grade'), false, 'no scoring detail goes to partners');
  assert.equal(JSON.stringify(store.db.partnerEvents).includes('reasons'), false);
});

test('APR on the loan follows the actual days when the due date snaps to a salary day', async () => {
  const store = memoryStore({ products: [product] });
  const registry = createRegistry({ env: {} });
  const customer = await store.upsertCustomer({ mobile: mobile(3), salary_day: 15 });
  const { application } = await createApplication({ store, customer, product, requestedAmount: 10000 });
  await runUnderwriting({ registry, store, customer, application, product, intake });
  await sendAgreement({ registry, store, customer, application });
  await recordAgreementSigned({ store, applicationId: application.id });
  const d = await disburseLoan({ registry, store, customer, application, product, account, asOf: '2026-01-01', snapToSalaryDay: true });
  assert.equal(d.loan.due_date, '2026-01-15');
  assert.equal(d.loan.apr_pct, aprFor(product, 10000, 14).aprEffectivePct, '14 days, not the 30-day tenure');
});
