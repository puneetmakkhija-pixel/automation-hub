// Framework-agnostic request handler: { method, path, headers, rawBody, query } -> { status, body }.
// server.js wires it to node:http; the tests call it directly. All business logic lives in payday-journey.
//
// Who can do what (a request is checked against its API key's role before anything runs):
//   admin    everything, including credit policies, API clients, partners, write-off and the audit log
//   ops      day-to-day operations: customers, applications, disbursement, payments, rollover, jobs, read policies
//   partner  only its own customers and applications: create customers, record consent, apply, read status,
//            send the agreement, request a repayment link. It never sees scoring detail or other partners' data.
// The key in PAYDAY_API_KEY is a bootstrap admin so a new deployment can create real clients; then unset it (the server
// starts without it as soon as an active admin client exists, see server.js).
import { createHash } from 'node:crypto';
import { openApiSpec } from './openapi.js';
import { NO_BANK_POLICY, DEFAULT_POLICY } from '../payday-engine/index.js';
import {
  createApplication, ApplicationError, runUnderwriting, sendAgreement, disburseLoan, recordPayment, rollover, writeOff,
  runDailyServicing, reconcilePendingPayouts, deliverPartnerEvents, getLoanSummary, repeatEligibility, createWebhookHandler,
  recordConsents, revokeConsent, REQUIRED_CONSENTS, createApiClient, authenticate, createPartner, audit,
  createPolicyDraft, updatePolicyDraft, activatePolicy, loadActivePolicy, simulatePolicy, ROLES,
  WHEEL, wheelOdds, getRewardState, spinWheel, applyReward,
  requestLimitIncrease, coolingOffQuote, requestCoolingOffExit, lenderProfile, buildKfs, EVENT_CATALOGUE, recordAgreementSigned,
  BusinessRuleError, NotConfiguredError, VendorHttpError, ValidationError,
} from '../payday-journey/index.js';

const CUSTOMER_FIELDS = ['mobile', 'full_name', 'dob', 'employer_name', 'monthly_salary', 'salary_day', 'source'];
// Only these intake answers come from the caller. fraudFlag is deliberately NOT here: it is
// decided by us, and a client must never be able to set (or clear) it.
const INTAKE_FIELDS = ['declaredSalary', 'tenureMonths', 'employerCategory', 'residence', 'purposeClarity', 'referencesVerified'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const ID = /^[\w-]{1,64}$/;

const json = (status, body) => ({ status, body });
const bad = (msg) => json(400, { error: msg });

// POST calls that create something and so accept an Idempotency-Key.
const IDEMPOTENT = [/^\/v1\/applications$/, /^\/v1\/customers\/[^/]+\/limit-increase$/, /^\/v1\/loans\/[^/]+\/collect$/];

const ADMIN = ['admin'];
const INTERNAL = ['admin', 'ops'];
const ALL = ['admin', 'ops', 'partner'];

export function createApp({ store, registry, env = process.env, log = () => {}, fetchImpl = globalThis.fetch }) {
  const webhooks = createWebhookHandler({ store, registry, env });
  // Consent before any vendor pull is the default. PAYDAY_REQUIRE_CONSENT=0 switches it off (tests, migrations only).
  const requiredConsents = env.PAYDAY_REQUIRE_CONSENT === '0' ? [] : REQUIRED_CONSENTS;
  // Optional maker-checker: a policy must be activated by someone other than who created it.
  const makerChecker = env.PAYDAY_POLICY_MAKER_CHECKER === '1';
  // Small tickets do not pull a bank statement. PAYDAY_BANK_STATEMENT_ABOVE=<amount> pulls one for requests above that
  // amount; unset means never. With no policy activated, the scorecard without bank data applies unless a bank pull is on.
  const bankStatementAbove = env.PAYDAY_BANK_STATEMENT_ABOVE === undefined || env.PAYDAY_BANK_STATEMENT_ABOVE === '' ? Infinity : Number(env.PAYDAY_BANK_STATEMENT_ABOVE);
  // A partner key may open at most this many applications per customer in any 24 hours (each one triggers paid vendor
  // pulls: KYC, bureau, bank statement). PAYDAY_PARTNER_APPS_PER_DAY=0 switches the limit off. Ops and admin are not limited.
  const partnerAppsPerDay = env.PAYDAY_PARTNER_APPS_PER_DAY === undefined || env.PAYDAY_PARTNER_APPS_PER_DAY === '' ? 3 : Number(env.PAYDAY_PARTNER_APPS_PER_DAY);
  const fallback = bankStatementAbove === Infinity ? NO_BANK_POLICY : DEFAULT_POLICY;
  // Sandbox: a deployment on mock vendors where a partner's developers can finish a loan on their own. It adds two helpers
  // that stand in for the e-sign vendor and the payment vendor. Never switch this on next to real vendors.
  const sandbox = env.PAYDAY_SANDBOX === '1';

  const missing = (label) => Object.assign(new Error(`${label} not found`), { notFound: true });
  const need = async (loader, label) => {
    const v = await loader();
    if (!v) throw missing(label);
    return v;
  };
  const note = (actor, action, entityType, entityId, details) => audit({ store, actor, action, entityType, entityId, details });
  const who = (actor) => actor.id ?? 'bootstrap';

  // A partner reaches only what it created or was sent. Anything else answers "not found", not "forbidden",
  // so a partner cannot probe which ids exist.
  const partnerOwnsCustomer = (actor, c) => actor.role !== 'partner' || c.source === `partner:${actor.partner_id}`;
  const partnerOwnsApplication = (actor, a) => actor.role !== 'partner' || a.partner_id === actor.partner_id;
  const ownedCustomer = async (actor, id) => {
    const c = await need(() => store.getCustomer(id), 'customer');
    if (!partnerOwnsCustomer(actor, c)) throw missing('customer');
    return c;
  };
  const ownedApplication = async (actor, id) => {
    const a = await need(() => store.getApplication(id), 'application');
    if (!partnerOwnsApplication(actor, a)) throw missing('application');
    return a;
  };
  const ownedLoan = async (actor, id) => {
    const l = await need(() => store.getLoan(id), 'loan');
    if (actor.role === 'partner') {
      const a = await store.getApplication(l.application_id);
      if (!a || !partnerOwnsApplication(actor, a)) throw missing('loan');
    }
    return l;
  };

  // [method, path, roles allowed, handler]
  const routes = [
    // ------------------------------------------------------------ customers and consent
    ['POST', /^\/v1\/customers$/, ALL, async ({ actor, body }) => {
      const mobile = String(body.mobile ?? '');
      if (!/^[6-9]\d{9}$/.test(mobile)) return bad('mobile must be a 10-digit Indian mobile number');
      const row = pick(body, CUSTOMER_FIELDS);
      if (actor.role === 'partner') {
        // A partner creates its own customers. It cannot overwrite or take over one that came from elsewhere.
        row.source = `partner:${actor.partner_id}`;
        const existing = await store.getCustomerByMobile(mobile);
        if (existing && existing.source !== row.source) return json(409, { error: 'customer already exists', code: 'CUSTOMER_EXISTS' });
      }
      if (body.pan !== undefined) {
        // Raw PAN is never stored: only a peppered hash and the last 4 characters.
        if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(String(body.pan))) return bad('pan format is invalid');
        if (!env.PAN_PEPPER) return json(503, { error: 'PAN_PEPPER is not configured' });
        row.pan_hash = createHash('sha256').update(`${body.pan}${env.PAN_PEPPER}`).digest('hex');
        row.pan_last4 = String(body.pan).slice(-4);
      }
      const c = await store.upsertCustomer(row);
      await note(actor, 'customer.upsert', 'customer', c.id, { fields: Object.keys(row).filter((k) => k !== 'mobile') });
      return json(200, { customer_id: c.id, kyc_status: c.kyc_status });
    }],

    ['POST', /^\/v1\/customers\/([^/]+)\/consents$/, ALL, async ({ actor, params, body }) => {
      const c = await ownedCustomer(actor, params[0]);
      const r = await recordConsents({
        store, customerId: c.id, purposes: body.purposes, textVersion: body.text_version,
        channel: actor.role === 'partner' ? 'partner' : body.channel, evidence: body.evidence ?? null,
      });
      await note(actor, 'consent.record', 'customer', c.id, { purposes: r.recorded, text_version: body.text_version });
      return json(201, r);
    }],

    ['POST', /^\/v1\/customers\/([^/]+)\/consents\/revoke$/, ALL, async ({ actor, params, body }) => {
      const c = await ownedCustomer(actor, params[0]);
      await note(actor, 'consent.revoke', 'customer', c.id, { purpose: body.purpose });
      return json(200, await revokeConsent({ store, customerId: c.id, purpose: body.purpose }));
    }],

    ['GET', /^\/v1\/customers\/([^/]+)\/rewards$/, ALL, async ({ actor, params }) => {
      const c = await ownedCustomer(actor, params[0]);
      return json(200, { ...(await getRewardState({ store, customerId: c.id })), wheel: { slices: WHEEL, odds: wheelOdds() } });
    }],
    ['POST', /^\/v1\/customers\/([^/]+)\/wheel\/spin$/, ALL, async ({ actor, params }) => {
      const c = await ownedCustomer(actor, params[0]);
      await note(actor, 'reward.spin', 'customer', c.id, {});
      const r = await spinWheel({ store, customerId: c.id });
      await note(actor, 'reward.spin.result', 'customer', c.id, { waiver_pct: r.waiver_pct, slice: r.slice });
      return json(200, { slice: r.slice, waiver_pct: r.waiver_pct, expires_at: r.expires_at });
    }],

    ['GET', /^\/v1\/customers\/([^/]+)\/eligibility$/, INTERNAL, async ({ params, query }) => {
      const customer = await need(() => store.getCustomer(params[0]), 'customer');
      const product = await need(() => store.getProductByCode(query.product), 'product');
      const e = await repeatEligibility({ store, customer, product });
      return json(200, { eligible: e.eligible, is_repeat: e.isRepeat ?? null, limit: e.limit ?? null, eligible_limit: e.eligibleLimit ?? null, can_request_increase: e.canRequestIncrease ?? false, cycle_number: e.cycleNumber ?? null, reason: e.reason ?? null });
    }],

    // The limit offered to a customer rises only when the customer asks (RBI Digital Lending Directions, 2025).
    ['GET', /^\/v1\/customers\/([^/]+)\/limit$/, ALL, async ({ actor, params, query }) => {
      const customer = await ownedCustomer(actor, params[0]);
      const product = await need(() => store.getProductByCode(query.product), 'product');
      const e = await repeatEligibility({ store, customer, product });
      return json(200, { eligible: e.eligible, limit: e.limit ?? null, eligible_limit: e.eligibleLimit ?? null, can_request_increase: e.canRequestIncrease ?? false, reason: e.reason ?? null });
    }],
    ['POST', /^\/v1\/customers\/([^/]+)\/limit-increase$/, ALL, async ({ actor, params, body }) => {
      const customer = await ownedCustomer(actor, params[0]);
      const product = await need(() => store.getProductByCode(body.product_code), 'product');
      if (body.amount !== undefined && !Number.isInteger(Number(body.amount))) return bad('amount must be a whole number');
      await note(actor, 'limit.increase.request', 'customer', customer.id, { amount: body.amount ?? null });
      const row = await requestLimitIncrease({ store, customer, product, requestedAmount: body.amount ?? null });
      await note(actor, 'limit.increase.granted', 'customer', customer.id, { limit: Number(row.limit_amount) });
      return json(200, { limit: Number(row.limit_amount), eligible_limit: Number(row.eligible_amount ?? row.limit_amount) });
    }],

    // Who the lender is, for the app, the website and the key facts statement.
    ['GET', /^\/v1\/lender$/, ALL, async () => json(200, lenderProfile(env))],

    // ------------------------------------------------------------ applications
    ['POST', /^\/v1\/applications$/, ALL, async ({ actor, body }) => {
      if (!body.customer_id || !body.product_code) return bad('customer_id and product_code are required');
      const customer = await ownedCustomer(actor, body.customer_id);
      if (actor.role === 'partner' && partnerAppsPerDay > 0) {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        if ((await store.countApplicationsSince(customer.id, since)) >= partnerAppsPerDay) {
          return json(429, { error: `at most ${partnerAppsPerDay} applications per customer in 24 hours`, code: 'TOO_MANY_APPLICATIONS' });
        }
      }
      const product = await need(() => store.getProductByCode(body.product_code), 'product');
      const policy = await loadActivePolicy({ store, fallback }); // an error here stops the decision: never fall back silently
      await note(actor, 'application.create', 'customer', customer.id, {
        product_code: product.code, requested_amount: body.requested_amount, policy_version: policy.version,
      });
      const { application, customerLimit, isRepeat } = await createApplication({
        store, customer, product, requestedAmount: body.requested_amount, requiredConsents,
        partnerId: actor.role === 'partner' ? actor.partner_id : null,
      });
      // PAN, if supplied, goes to the vendors for this call only; it is not stored.
      const forVendors = body.pan ? { ...customer, pan: body.pan } : customer;
      // A fee waiver won on the loyalty wheel lowers the fee in this offer. It comes from the database, never from the request.
      const { product: pricedProduct } = await applyReward({ store, application, product });
      const out = await runUnderwriting({
        registry, store, customer: forVendors, application, product: pricedProduct, intake: pick(body.intake, INTAKE_FIELDS),
        customerLimit, reuseKyc: isRepeat && customer.kyc_status === 'verified', policy, bankStatementAbove,
      });
      if (out.kyc.checks.length) await store.patchCustomer(customer.id, { kyc_status: out.kyc.status });
      if (out.stage === 'kyc_pending') return json(202, { application_id: application.id, stage: 'kyc_pending' });
      const r = out.result;
      // A partner sees the outcome and the offer, never the scoring detail.
      if (actor.role === 'partner') {
        return json(200, { application_id: application.id, stage: 'decided', is_repeat: isRepeat, decision: r.decision, offer: r.offer });
      }
      return json(200, {
        application_id: application.id, stage: 'decided', is_repeat: isRepeat, decision: r.decision, grade: r.grade,
        points: r.totalPoints, max_points: r.maxPoints, policy_version: r.modelVersion, offer: r.offer, reasons: r.reasons,
        vendor_errors: out.vendorErrors,
      });
    }],

    ['GET', /^\/v1\/applications\/([^/]+)$/, ALL, async ({ actor, params }) => {
      const a = await ownedApplication(actor, params[0]);
      const loan = await store.getLoanByApplication(a.id);
      return json(200, {
        application_id: a.id, status: a.status, is_repeat: a.is_repeat, requested_amount: a.requested_amount,
        approved_amount: a.approved_amount, offered_apr_pct: a.offered_apr_pct ?? null, fee_waiver_pct: Number(a.fee_waiver_pct ?? 0), loan_id: loan?.id ?? null,
        ...(actor.role !== 'partner' ? { partner_id: a.partner_id ?? null, decision_reasons: a.decision_reasons ?? null } : {}),
      });
    }],

    ['POST', /^\/v1\/applications\/([^/]+)\/agreement$/, ALL, async ({ actor, params }) => {
      const application = await ownedApplication(actor, params[0]);
      const customer = await store.getCustomer(application.customer_id);
      await note(actor, 'application.agreement', 'application', application.id, { approved_amount: application.approved_amount });
      const { agreement, reused } = await sendAgreement({ registry, store, customer, application });
      return json(reused ? 200 : 201, { esign_status: agreement.esign_status, document_url: agreement.document_url, kfs_url: agreement.kfs_url, reused });
    }],

    // Disbursal is the lender's act: ops and admin only. In the sandbox a partner may start it so its developers can finish a loan.
    ['POST', /^\/v1\/applications\/([^/]+)\/disburse$/, sandbox ? ALL : INTERNAL, async ({ actor, params, body }) => {
      const application = await ownedApplication(actor, params[0]);
      const customer = await store.getCustomer(application.customer_id);
      const product = await store.getProduct(application.product_id);
      // Audited BEFORE the money moves: if the audit row cannot be written, nothing is paid.
      await note(actor, 'loan.disburse', 'application', application.id, { amount: application.approved_amount, account: body.account });
      const r = await disburseLoan({
        registry, store, customer, application, product, account: body.account,
        snapToSalaryDay: body.snap_to_salary_day === true, attempt: Number(body.attempt) || 1,
      });
      const status = { success: 200, already_disbursed: 200, pending: 202, unknown: 202, failed: 502 }[r.status];
      return json(status, { status: r.status, loan_id: r.loan?.id, due_date: r.loan?.due_date, utr: r.disbursement?.utr ?? null });
    }],

    // ------------------------------------------------------------ loans
    ['POST', /^\/v1\/loans\/([^/]+)\/payments$/, INTERNAL, async ({ actor, params, body }) => {
      const loan = await need(() => store.getLoan(params[0]), 'loan');
      const product = await store.getProduct(loan.product_id);
      const amount = Number(body.amount);
      if (!(amount > 0)) return bad('amount must be a positive number');
      if (!body.mode) return bad('mode is required');
      await note(actor, 'payment.manual', 'loan', loan.id, { amount, mode: body.mode, utr: body.utr ?? null });
      const r = await recordPayment({ store, loan, product, amount, mode: String(body.mode), utr: body.utr || null, paidAt: body.paid_at || new Date().toISOString() });
      return json(200, { duplicate: r.duplicate, applied: r.applied ?? null, unapplied: r.unapplied ?? null, closed: r.closed ?? null, outstanding: r.outstanding ?? null });
    }],

    ['POST', /^\/v1\/loans\/([^/]+)\/collect$/, ALL, async ({ actor, params, body }) => {
      await ownedLoan(actor, params[0]);
      const s = await getLoanSummary({ store, loanId: params[0] });
      if (!['active', 'overdue'].includes(s.loan.status) || !s.loan.disbursed_at) return json(409, { error: 'loan is not open' });
      const amount = body.amount === undefined ? s.outstanding : Number(body.amount);
      if (!(amount > 0) || amount > s.outstanding) return bad(`amount must be between 0 and the outstanding ${s.outstanding}`);
      const customer = await store.getCustomer(s.loan.customer_id);
      await note(actor, 'collect.request', 'loan', s.loan.id, { amount });
      const r = await registry.collect.request({ loan: s.loan, customer, amount, reference: s.loan.id });
      return json(r.status === 'failed' ? 502 : 201, { provider_ref: r.providerRef, status: r.status, payment_url: r.paymentUrl ?? null, amount });
    }],

    ['POST', /^\/v1\/loans\/([^/]+)\/rollover$/, INTERNAL, async ({ actor, params }) => {
      const loan = await need(() => store.getLoan(params[0]), 'loan');
      const product = await store.getProduct(loan.product_id);
      await note(actor, 'loan.rollover', 'loan', loan.id, {});
      const r = await rollover({ store, loan, product });
      return json(200, { due_date: r.newDue, new_fee: r.newFee, principal: r.principalLeft, rollover_count: r.loan.rollover_count });
    }],

    ['POST', /^\/v1\/loans\/([^/]+)\/write-off$/, ADMIN, async ({ actor, params, body }) => {
      const loan = await need(() => store.getLoan(params[0]), 'loan');
      await note(actor, 'loan.write-off', 'loan', loan.id, { reason: body.reason || 'written_off' });
      const r = await writeOff({ store, loan, reason: body.reason || 'written_off' });
      return json(200, { written_off: r.writtenOff });
    }],

    // The key facts statement for an application that has an offer. Each one handed out is logged with its fingerprint.
    ['GET', /^\/v1\/applications\/([^/]+)\/kfs$/, ALL, async ({ actor, params }) => {
      const application = await ownedApplication(actor, params[0]);
      if (!application.approved_amount) return json(409, { error: 'there is no offer yet', code: 'NO_OFFER' });
      const product = await need(() => store.getProduct(application.product_id), 'product');
      const kfs = buildKfs({ lender: lenderProfile(env), product, application });
      await note(actor, 'kfs.issued', 'application', application.id, { sha256: kfs.sha256, complete: kfs.complete });
      return json(200, kfs);
    }],

    // Cooling-off: the borrower exits by repaying the principal and the fee for the days held. This records the request and
    // returns what to pay; the fee is cut when that payment arrives inside the window.
    ['POST', /^\/v1\/loans\/([^/]+)\/cooling-off$/, ALL, async ({ actor, params }) => {
      const loan = await ownedLoan(actor, params[0]);
      const product = await store.getProduct(loan.product_id);
      await note(actor, 'loan.cooling-off.request', 'loan', loan.id, {});
      return json(200, await requestCoolingOffExit({ store, loan, product }));
    }],

    ['GET', /^\/v1\/loans\/([^/]+)$/, ALL, async ({ actor, params }) => {
      await ownedLoan(actor, params[0]);
      const s = await getLoanSummary({ store, loanId: params[0] });
      const view = {
        loan_id: s.loan.id, status: s.loan.status, principal: s.loan.principal, due_date: s.loan.due_date, apr_pct: s.loan.apr_pct ?? null,
        outstanding: s.outstanding, days_overdue: s.daysOverdue,
        cooling_off: await coolingOffQuote({ store, loan: s.loan, product: await store.getProduct(s.loan.product_id) }),
        schedule: s.schedule.map((r) => ({ installment_no: r.installment_no, due_date: r.due_date, principal_due: r.principal_due, fee_due: r.fee_due, penalty_due: r.penalty_due, paid_amount: r.paid_amount, status: r.status })),
      };
      if (actor.role === 'partner') return json(200, view);
      return json(200, { ...view, cycle_number: s.loan.cycle_number, rollover_count: s.loan.rollover_count, bucket: s.bucket, ledger_balance: s.ledgerBalance });
    }],

    // ------------------------------------------------------------ jobs (run from a scheduler)
    ['POST', /^\/v1\/jobs\/daily-servicing$/, INTERNAL, async ({ actor, body }) => {
      if (body.as_of !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.as_of))) return bad('as_of must be YYYY-MM-DD');
      await note(actor, 'job.daily-servicing', 'job', null, { as_of: body.as_of ?? null });
      return json(200, await runDailyServicing({ store, asOf: body.as_of }));
    }],
    ['POST', /^\/v1\/jobs\/reconcile-payouts$/, INTERNAL, async ({ actor, body }) => {
      const mins = body.older_than_minutes === undefined ? 15 : Number(body.older_than_minutes);
      if (!(mins >= 0)) return bad('older_than_minutes must be a number');
      await note(actor, 'job.reconcile-payouts', 'job', null, { older_than_minutes: mins });
      return json(200, await reconcilePendingPayouts({ registry, store, olderThanMinutes: mins }));
    }],
    ['POST', /^\/v1\/jobs\/deliver-partner-events$/, INTERNAL, async ({ actor }) => {
      await note(actor, 'job.deliver-partner-events', 'job', null, {});
      return json(200, await deliverPartnerEvents({ store, env, fetchImpl }));
    }],

    // ------------------------------------------------------------ events (what we tell a partner, and what it can read back)
    // A partner reads its own outbox to catch up after an outage or to check what was sent. Ops and admin pass partner_id.
    ['GET', /^\/v1\/events$/, ALL, async ({ actor, query }) => {
      const partnerId = actor.role === 'partner' ? actor.partner_id : (query.partner_id || null);
      if (actor.role !== 'partner' && !partnerId) return bad('partner_id is required');
      if (query.status !== undefined && !['pending', 'delivered', 'failed'].includes(query.status)) return bad('status must be pending, delivered or failed');
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
      const events = await store.listPartnerEvents({ partnerId, status: query.status ?? null, since: query.since ?? null, limit });
      return json(200, { events: events.map((e) => ({ id: e.id, event_id: e.event_id, type: e.event_type, status: e.status, attempts: e.attempts, created_at: e.created_at, delivered_at: e.delivered_at, last_error: e.last_error, data: e.payload })), next_since: events.length ? events[events.length - 1].created_at : (query.since ?? null) });
    }],
    // Send an event again: one that failed for good, or one the partner lost.
    ['POST', /^\/v1\/events\/([^/]+)\/redeliver$/, ALL, async ({ actor, params }) => {
      const ev = await need(() => store.getPartnerEvent(params[0]), 'event');
      if (actor.role === 'partner' && ev.partner_id !== actor.partner_id) throw missing('event');
      await note(actor, 'event.redeliver', 'partner_event', ev.id, { type: ev.event_type });
      await store.patchPartnerEvent(ev.id, { status: 'pending', next_attempt_at: new Date().toISOString(), last_error: null });
      return json(200, { queued: true });
    }],
    ['GET', /^\/v1\/event-types$/, ALL, async () => json(200, { event_types: Object.entries(EVENT_CATALOGUE).map(([type, v]) => ({ type, when: v.when, data: v.data })) })],

    // ------------------------------------------------------------ sandbox helpers (only when PAYDAY_SANDBOX=1)
    ['POST', /^\/v1\/sandbox\/applications\/([^/]+)\/sign$/, ALL, async ({ actor, params }) => {
      if (!sandbox) throw missing('route');
      const application = await ownedApplication(actor, params[0]);
      const r = await recordAgreementSigned({ store, applicationId: application.id });
      return json(200, { status: (await store.getApplication(application.id)).status, ignored: Boolean(r.ignored) });
    }],
    ['POST', /^\/v1\/sandbox\/loans\/([^/]+)\/pay$/, ALL, async ({ actor, params }) => {
      if (!sandbox) throw missing('route');
      const loan = await ownedLoan(actor, params[0]);
      const product = await store.getProduct(loan.product_id);
      const s = await getLoanSummary({ store, loanId: loan.id });
      if (!(s.outstanding > 0)) throw new BusinessRuleError('nothing is owed on this loan');
      const r = await recordPayment({ store, loan, product, amount: s.outstanding, mode: 'sandbox', utr: `SANDBOX-${loan.id}-${Date.now()}` });
      return json(200, { applied: r.applied, closed: r.closed });
    }],

    // ------------------------------------------------------------ credit policies
    ['GET', /^\/v1\/policies$/, INTERNAL, async () => json(200, { policies: await store.listPolicies() })],
    ['GET', /^\/v1\/policies\/active$/, INTERNAL, async () => {
      const row = await store.getActivePolicy();
      return json(200, row ? { source: 'database', version: row.version, config: row.config } : { source: 'built-in default', version: (await loadActivePolicy({ store, fallback })).version, config: await loadActivePolicy({ store, fallback }) });
    }],
    ['GET', /^\/v1\/policies\/([^/]+)$/, INTERNAL, async ({ params }) => json(200, await need(() => store.getPolicyById(params[0]), 'policy'))],
    ['POST', /^\/v1\/policies\/simulate$/, INTERNAL, async ({ body }) => {
      if (!body.features || typeof body.features !== 'object') return bad('features is required');
      const product = await need(() => store.getProductByCode(body.product_code), 'product');
      const policy = body.config ?? (body.policy_id ? (await need(() => store.getPolicyById(body.policy_id), 'policy')).config : await loadActivePolicy({ store, fallback }));
      // read-only: nothing is saved
      return json(200, { result: simulatePolicy({ policy, features: body.features, product, requestedAmount: Number(body.requested_amount), customerLimit: body.customer_limit ?? null }) });
    }],
    ['POST', /^\/v1\/policies$/, ADMIN, async ({ actor, body }) => {
      await note(actor, 'policy.create', 'policy', body.version ?? null, { note: body.note ?? null });
      const row = await createPolicyDraft({ store, version: body.version, config: body.config, by: who(actor), note: body.note ?? null });
      return json(201, { id: row.id, version: row.version, status: row.status });
    }],
    ['PUT', /^\/v1\/policies\/([^/]+)$/, ADMIN, async ({ actor, params, body }) => {
      await note(actor, 'policy.update', 'policy', params[0], {});
      const row = await updatePolicyDraft({ store, id: params[0], config: body.config, note: body.note });
      return json(200, { id: row.id, version: row.version, status: row.status });
    }],
    ['POST', /^\/v1\/policies\/([^/]+)\/activate$/, ADMIN, async ({ actor, params }) => {
      const p = await need(() => store.getPolicyById(params[0]), 'policy');
      if (makerChecker && p.created_by === who(actor)) {
        throw new BusinessRuleError('a different admin must activate this policy (maker-checker is on)');
      }
      await note(actor, 'policy.activate', 'policy', p.id, { version: p.version });
      const row = await activatePolicy({ store, id: p.id, by: who(actor) });
      return json(200, { id: row.id, version: row.version, status: row.status });
    }],

    // ------------------------------------------------------------ API clients, partners, audit (admin)
    ['POST', /^\/v1\/clients$/, ADMIN, async ({ actor, body }) => {
      const { client, key } = await createApiClient({ store, name: body.name, role: body.role, partnerId: body.partner_id ?? null });
      await note(actor, 'client.create', 'client', client.id, { name: client.name, role: client.role, partner_id: client.partner_id });
      return json(201, { client, api_key: key, warning: 'Store this key now. It is not kept and cannot be shown again.' });
    }],
    ['GET', /^\/v1\/clients$/, ADMIN, async () => json(200, { clients: await store.listApiClients(), roles: ROLES })],
    ['POST', /^\/v1\/clients\/([^/]+)\/revoke$/, ADMIN, async ({ actor, params }) => {
      await note(actor, 'client.revoke', 'client', params[0], {});
      await store.revokeApiClient(params[0]);
      return json(200, { revoked: true });
    }],
    ['POST', /^\/v1\/partners$/, ADMIN, async ({ actor, body }) => {
      const p = await createPartner({ store, name: body.name, callbackUrl: body.callback_url ?? null, callbackSecretEnv: body.callback_secret_env ?? null });
      await note(actor, 'partner.create', 'partner', p.id, { name: p.name, callback_url: p.callback_url });
      return json(201, { id: p.id, name: p.name, callback_url: p.callback_url, callback_secret_env: p.callback_secret_env });
    }],
    ['GET', /^\/v1\/partners$/, ADMIN, async () => json(200, { partners: await store.listPartners() })],
    ['POST', /^\/v1\/partners\/([^/]+)\/deactivate$/, ADMIN, async ({ actor, params }) => {
      await note(actor, 'partner.deactivate', 'partner', params[0], {});
      await need(() => store.getPartner(params[0]), 'partner');
      await store.patchPartner(params[0], { active: false });
      return json(200, { deactivated: true });
    }],
    ['GET', /^\/v1\/audit$/, ADMIN, async ({ query }) => {
      const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
      return json(200, { entries: await store.listAudit({ entityType: query.entity_type || null, entityId: query.entity_id || null, limit }) });
    }],
  ];

  return {
    async handle({ method, path, headers = {}, rawBody = '', query = {} }) {
      const started = Date.now();
      const done = (res) => { log(`${method} ${path} ${res.status} ${Date.now() - started}ms`); return res; };
      try {
        if (method === 'GET' && path === '/healthz') return done(json(200, { ok: true }));

        if (method === 'GET' && path === '/openapi.json') return done(json(200, openApiSpec({ sandbox })));

        const hook = path.match(/^\/v1\/webhooks\/([\w-]+)$/);
        if (hook) {
          if (method !== 'POST') return done(json(405, { error: 'method not allowed' }));
          return done(await webhooks({ provider: hook[1], rawBody, headers }));
        }

        const actor = await authenticate({ store, key: headers['x-api-key'], bootstrapKey: env.PAYDAY_API_KEY || null });
        if (!actor) return done(json(401, { error: 'unauthorized' }));

        for (const [m, re, roles, fn] of routes) {
          const match = path.match(re);
          if (!match || m !== method) continue;
          if (!roles.includes(actor.role)) return done(json(403, { error: 'forbidden for this role' }));
          if (match.slice(1).some((p) => !ID.test(p))) return done(bad('invalid id'));
          let body = {};
          if ((method === 'POST' || method === 'PUT') && rawBody) {
            try { body = JSON.parse(rawBody); } catch { return done(bad('invalid JSON')); }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return done(bad('body must be a JSON object'));
          }
          // Idempotency: a retry with the same key and the same request gets the first answer, so a dropped connection
          // never creates a second application or a second payment link.
          const idemKey = headers['idempotency-key'];
          if (method === 'POST' && idemKey !== undefined && IDEMPOTENT.some((r) => r.test(path))) {
            if (!/^[\w.:-]{8,128}$/.test(idemKey)) return done(bad('Idempotency-Key must be 8 to 128 characters: letters, digits and . _ : -'));
            const requestHash = createHash('sha256').update(`${method} ${path} ${rawBody}`).digest('hex');
            const claim = await store.claimIdempotencyKey({ clientKey: actor.id ?? 'bootstrap', key: idemKey, requestHash });
            if (!claim.created) {
              if (claim.row.request_hash !== requestHash) return done(json(422, { error: 'this Idempotency-Key was already used for a different request', code: 'IDEMPOTENCY_KEY_REUSED' }));
              if (claim.row.status !== 'done') return done(json(409, { error: 'the first request with this key is still running', code: 'REQUEST_IN_PROGRESS' }));
              return done({ status: claim.row.response_status, body: claim.row.response_body, headers: { 'idempotent-replayed': 'true' } });
            }
            let res;
            try { res = await fn({ actor, params: match.slice(1), body, query }); } catch (e) { await store.releaseIdempotencyKey(claim.row.id); throw e; }
            // Only a success is kept. A refusal (too many applications, a rule) may be fine on a later try with the same key.
            if (res.status >= 200 && res.status < 300) await store.completeIdempotencyKey(claim.row.id, { status: res.status, body: res.body });
            else await store.releaseIdempotencyKey(claim.row.id);
            return done(res);
          }
          return done(await fn({ actor, params: match.slice(1), body, query }));
        }
        return done(json(404, { error: 'not found' }));
      } catch (e) {
        return done(mapError(e));
      }
    },
  };
}

function mapError(e) {
  if (e.notFound) return json(404, { error: e.message });
  if (e instanceof ValidationError) return json(400, { error: e.message, details: e.details });
  if (e instanceof ApplicationError) {
    return json(e.code === 'AMOUNT_OUT_OF_RANGE' || e.code === 'PRODUCT_INACTIVE' ? 422 : 409, { error: e.message, code: e.code });
  }
  if (e instanceof BusinessRuleError) return json(409, { error: e.message });
  if (e.code === '23505') return json(409, { error: 'duplicate request' });
  if (e instanceof NotConfiguredError) return json(503, { error: e.message });
  if (e instanceof VendorHttpError) return json(502, { error: e.message });
  // Unexpected: log the message only (never the stack, which could carry request data), tell the caller nothing.
  console.error(`payday-api internal error: ${e.message}`);
  return json(500, { error: 'internal error' });
}
