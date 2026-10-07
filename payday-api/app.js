// Framework-agnostic request handler: { method, path, headers, rawBody, query } -> { status, body }.
// server.js wires it to node:http; the tests call it directly. All business logic lives in payday-journey.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createApplication, ApplicationError, runUnderwriting, sendAgreement, disburseLoan, recordPayment, rollover, writeOff,
  runDailyServicing, getLoanSummary, repeatEligibility, createWebhookHandler,
  BusinessRuleError, NotConfiguredError, VendorHttpError,
} from '../payday-journey/index.js';

const CUSTOMER_FIELDS = ['mobile', 'full_name', 'dob', 'employer_name', 'monthly_salary', 'salary_day', 'source'];
// Only these intake answers come from the caller. fraudFlag is deliberately NOT here: it is
// decided by us, and a client must never be able to set (or clear) it.
const INTAKE_FIELDS = ['declaredSalary', 'tenureMonths', 'employerCategory', 'residence', 'purposeClarity', 'referencesVerified'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const UUID = /^[0-9a-f-]{8,64}$/i;

const json = (status, body) => ({ status, body });
const bad = (msg) => json(400, { error: msg });

function keyOk(given, want) {
  if (!given || !want) return false;
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(want)).digest();
  return timingSafeEqual(a, b); // equal-length digests, constant time
}

export function createApp({ store, registry, env = process.env, log = () => {} }) {
  const webhooks = createWebhookHandler({ store, registry, env });

  const need = async (loader, label) => {
    const v = await loader();
    if (!v) throw Object.assign(new Error(`${label} not found`), { notFound: true });
    return v;
  };

  const routes = [
    ['POST', /^\/v1\/customers$/, async ({ body }) => {
      const mobile = String(body.mobile ?? '');
      if (!/^[6-9]\d{9}$/.test(mobile)) return bad('mobile must be a 10-digit Indian mobile number');
      const row = pick(body, CUSTOMER_FIELDS);
      if (body.pan !== undefined) {
        // Raw PAN is never stored: only a peppered hash and the last 4 characters.
        if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(String(body.pan))) return bad('pan format is invalid');
        if (!env.PAN_PEPPER) return json(503, { error: 'PAN_PEPPER is not configured' });
        row.pan_hash = createHash('sha256').update(`${body.pan}${env.PAN_PEPPER}`).digest('hex');
        row.pan_last4 = String(body.pan).slice(-4);
      }
      const c = await store.upsertCustomer(row);
      return json(200, { customer_id: c.id, kyc_status: c.kyc_status });
    }],

    ['POST', /^\/v1\/applications$/, async ({ body }) => {
      if (!body.customer_id || !body.product_code) return bad('customer_id and product_code are required');
      const customer = await need(() => store.getCustomer(body.customer_id), 'customer');
      const product = await need(() => store.getProductByCode(body.product_code), 'product');
      const { application, customerLimit, isRepeat } = await createApplication({ store, customer, product, requestedAmount: body.requested_amount });
      // PAN, if supplied, goes to the vendors for this call only; it is not stored.
      const forVendors = body.pan ? { ...customer, pan: body.pan } : customer;
      const out = await runUnderwriting({
        registry, store, customer: forVendors, application, product, intake: pick(body.intake, INTAKE_FIELDS),
        customerLimit, reuseKyc: isRepeat && customer.kyc_status === 'verified',
      });
      if (out.kyc.checks.length) await store.patchCustomer(customer.id, { kyc_status: out.kyc.status });
      if (out.stage === 'kyc_pending') return json(202, { application_id: application.id, stage: 'kyc_pending' });
      const r = out.result;
      return json(200, {
        application_id: application.id, stage: 'decided', is_repeat: isRepeat, decision: r.decision, grade: r.grade,
        points: r.totalPoints, max_points: r.maxPoints, offer: r.offer, reasons: r.reasons, vendor_errors: out.vendorErrors,
      });
    }],

    ['POST', /^\/v1\/applications\/([^/]+)\/agreement$/, async ({ params }) => {
      const application = await need(() => store.getApplication(params[0]), 'application');
      const customer = await store.getCustomer(application.customer_id);
      const { agreement, reused } = await sendAgreement({ registry, store, customer, application });
      return json(reused ? 200 : 201, { esign_status: agreement.esign_status, document_url: agreement.document_url, kfs_url: agreement.kfs_url, reused });
    }],

    ['POST', /^\/v1\/applications\/([^/]+)\/disburse$/, async ({ params, body }) => {
      const application = await need(() => store.getApplication(params[0]), 'application');
      const customer = await store.getCustomer(application.customer_id);
      const product = await store.getProduct(application.product_id);
      const r = await disburseLoan({
        registry, store, customer, application, product, account: body.account,
        snapToSalaryDay: body.snap_to_salary_day === true, attempt: Number(body.attempt) || 1,
      });
      const status = { success: 200, already_disbursed: 200, pending: 202, unknown: 202, failed: 502 }[r.status];
      return json(status, { status: r.status, loan_id: r.loan?.id, due_date: r.loan?.due_date, utr: r.disbursement?.utr ?? null });
    }],

    ['POST', /^\/v1\/loans\/([^/]+)\/payments$/, async ({ params, body }) => {
      const loan = await need(() => store.getLoan(params[0]), 'loan');
      const product = await store.getProduct(loan.product_id);
      const amount = Number(body.amount);
      if (!(amount > 0)) return bad('amount must be a positive number');
      if (!body.mode) return bad('mode is required');
      const r = await recordPayment({ store, loan, product, amount, mode: String(body.mode), utr: body.utr || null, paidAt: body.paid_at || new Date().toISOString() });
      return json(200, { duplicate: r.duplicate, applied: r.applied ?? null, unapplied: r.unapplied ?? null, closed: r.closed ?? null, outstanding: r.outstanding ?? null });
    }],

    ['POST', /^\/v1\/loans\/([^/]+)\/collect$/, async ({ params, body }) => {
      const s = await getLoanSummary({ store, loanId: params[0] });
      if (!s) return json(404, { error: 'loan not found' });
      if (!['active', 'overdue'].includes(s.loan.status) || !s.loan.disbursed_at) return json(409, { error: 'loan is not open' });
      const amount = body.amount === undefined ? s.outstanding : Number(body.amount);
      if (!(amount > 0) || amount > s.outstanding) return bad(`amount must be between 0 and the outstanding ${s.outstanding}`);
      const customer = await store.getCustomer(s.loan.customer_id);
      const r = await registry.collect.request({ loan: s.loan, customer, amount, reference: s.loan.id });
      return json(r.status === 'failed' ? 502 : 201, { provider_ref: r.providerRef, status: r.status, payment_url: r.paymentUrl ?? null, amount });
    }],

    ['POST', /^\/v1\/loans\/([^/]+)\/rollover$/, async ({ params }) => {
      const loan = await need(() => store.getLoan(params[0]), 'loan');
      const product = await store.getProduct(loan.product_id);
      const r = await rollover({ store, loan, product });
      return json(200, { due_date: r.newDue, new_fee: r.newFee, principal: r.principalLeft, rollover_count: r.loan.rollover_count });
    }],

    ['POST', /^\/v1\/loans\/([^/]+)\/write-off$/, async ({ params, body }) => {
      const loan = await need(() => store.getLoan(params[0]), 'loan');
      const r = await writeOff({ store, loan, reason: body.reason || 'written_off' });
      return json(200, { written_off: r.writtenOff });
    }],

    ['GET', /^\/v1\/loans\/([^/]+)$/, async ({ params }) => {
      const s = await getLoanSummary({ store, loanId: params[0] });
      if (!s) return json(404, { error: 'loan not found' });
      return json(200, {
        loan_id: s.loan.id, status: s.loan.status, principal: s.loan.principal, due_date: s.loan.due_date, cycle_number: s.loan.cycle_number,
        rollover_count: s.loan.rollover_count, outstanding: s.outstanding, days_overdue: s.daysOverdue, bucket: s.bucket, ledger_balance: s.ledgerBalance,
        schedule: s.schedule.map((r) => ({ installment_no: r.installment_no, due_date: r.due_date, principal_due: r.principal_due, fee_due: r.fee_due, penalty_due: r.penalty_due, paid_amount: r.paid_amount, status: r.status })),
      });
    }],

    ['GET', /^\/v1\/customers\/([^/]+)\/eligibility$/, async ({ params, query }) => {
      const customer = await need(() => store.getCustomer(params[0]), 'customer');
      const product = await need(() => store.getProductByCode(query.product), 'product');
      const e = await repeatEligibility({ store, customer, product });
      return json(200, { eligible: e.eligible, is_repeat: e.isRepeat ?? null, limit: e.limit ?? null, cycle_number: e.cycleNumber ?? null, reason: e.reason ?? null });
    }],

    ['POST', /^\/v1\/jobs\/daily-servicing$/, async ({ body }) => {
      if (body.as_of !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.as_of))) return bad('as_of must be YYYY-MM-DD');
      return json(200, await runDailyServicing({ store, asOf: body.as_of }));
    }],
  ];

  return {
    async handle({ method, path, headers = {}, rawBody = '', query = {} }) {
      const started = Date.now();
      const done = (res) => { log(`${method} ${path} ${res.status} ${Date.now() - started}ms`); return res; };
      try {
        if (method === 'GET' && path === '/healthz') return done(json(200, { ok: true }));

        const hook = path.match(/^\/v1\/webhooks\/([\w-]+)$/);
        if (hook) {
          if (method !== 'POST') return done(json(405, { error: 'method not allowed' }));
          return done(await webhooks({ provider: hook[1], rawBody, headers }));
        }

        if (!env.PAYDAY_API_KEY) return done(json(503, { error: 'PAYDAY_API_KEY is not configured' }));
        if (!keyOk(headers['x-api-key'], env.PAYDAY_API_KEY)) return done(json(401, { error: 'unauthorized' }));

        for (const [m, re, fn] of routes) {
          const match = path.match(re);
          if (!match || m !== method) continue;
          if (match.slice(1).some((p) => !UUID.test(p) && !/^[\w-]+$/.test(p))) return done(bad('invalid id'));
          let body = {};
          if (method === 'POST' && rawBody) {
            try { body = JSON.parse(rawBody); } catch { return done(bad('invalid JSON')); }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) return done(bad('body must be a JSON object'));
          }
          return done(await fn({ params: match.slice(1), body, query }));
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
