// Demo gateway: the real payday-api handler, decision engine and journey running in this process on an in-memory
// store with mock vendors. Nothing here touches the live database or any vendor, and everything is lost on restart.
//
// The site talks to the loan system only through the gateway interface below, so a live gateway (HTTP to payday-api)
// can replace this file without changing the site:
//   product()                          -> the loan product row
//   upsertCustomer(mobile)             -> customerId
//   snapshot(customerId)               -> { kycStatus, consents[], limit, applications[] (newest first), loans[] }
//   recordConsents / revokeConsent
//   apply(customerId, {amount, pan, intake}) -> { status, body }  (the payday-api response)
//   sendAgreement(applicationId)       -> { status, body }
//   disburse(applicationId, account)   -> { status, body }
//   loanView(loanId)                   -> { status, body }
//   collect(loanId, amount)            -> { status, body }
//   owns(customerId, 'application' | 'loan', id) -> boolean
//   demo-only: signAgreement(applicationId), pay(loanId)
import { randomBytes } from 'node:crypto';
import { createApp } from '../payday-api/app.js';
import {
  createRegistry, memoryStore, recordAgreementSigned, recordPayment, getLoanSummary,
} from '../payday-journey/index.js';

export const DEMO_PRODUCT = Object.freeze({
  id: 'prod-zenin-30', code: 'ZENIN_30', min_amount: 5000, max_amount: 50000, tenure_days: 30,
  fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1,
  rollover_allowed: false, max_rollovers: 0, active: true,
});

// The demo keeps everything in memory, so it refuses new customers past this many instead of growing without limit.
export const DEMO_MAX_CUSTOMERS = 5000;

export function createDemoGateway({ now = () => new Date(), maxCustomers = DEMO_MAX_CUSTOMERS } = {}) {
  const store = memoryStore({ products: [{ ...DEMO_PRODUCT }] });
  const key = `demo-${randomBytes(16).toString('hex')}`;
  const registry = createRegistry({ env: {} }); // every slot is a mock
  const app = createApp({ store, registry, env: { PAYDAY_API_KEY: key, PAN_PEPPER: 'demo-pepper' } });
  const call = (method, path, body, query) => app.handle({
    method, path, query, headers: { 'x-api-key': key },
    rawBody: body === undefined ? '' : JSON.stringify(body),
  });
  const byNewest = (a, b) => String(b.created_at).localeCompare(String(a.created_at));

  return {
    name: 'demo',
    store, // exposed for tests only

    async product() { return store.getProductByCode(DEMO_PRODUCT.code); },

    async upsertCustomer(mobile) {
      if (store.db.customers.length >= maxCustomers && !(await store.getCustomerByMobile(mobile))) {
        throw Object.assign(new Error('demo is full'), { demoFull: true });
      }
      const r = await call('POST', '/v1/customers', { mobile, source: 'zenin-web' });
      if (r.status !== 200) throw new Error(`customer upsert failed: ${r.status}`);
      return r.body.customer_id;
    },

    async snapshot(customerId) {
      const c = await store.getCustomer(customerId);
      if (!c) return null;
      const consents = (await store.getActiveConsents(customerId)).map((x) => x.purpose);
      const limitRow = await store.getCurrentLimit(customerId);
      const applications = store.db.applications.filter((a) => a.customer_id === customerId).sort(byNewest).map((a) => ({ ...a }));
      const loans = store.db.loans.filter((l) => l.customer_id === customerId).sort(byNewest).map((l) => ({ ...l }));
      // What we last knew about their job, read from the last scorecard (employer type, months, home) and the customer row (salary)
      const lastApp = applications[0];
      const sc = lastApp ? store.db.scorecards.find((s) => s.application_id === lastApp.id) : null;
      const val = (code) => sc?.parameters?.params?.find((p) => p.code === code)?.value ?? null;
      const profile = c.monthly_salary ? {
        monthly_salary: Number(c.monthly_salary), employer_type: val('SC19'), months_with_employer: val('SC18'), residence: val('SC20'),
      } : null;
      return {
        kycStatus: c.kyc_status, consents, applications, loans, profile,
        limit: limitRow ? { amount: Number(limitRow.limit_amount), cycle: limitRow.cycle_number } : null,
        panLast4: c.pan_last4 ?? null,
        firstApplicationAt: applications.length ? applications[applications.length - 1].created_at : null,
      };
    },

    async recordConsents(customerId, purposes, textVersion) {
      return call('POST', `/v1/customers/${customerId}/consents`, { purposes, text_version: textVersion, channel: 'app' });
    },
    async revokeConsent(customerId, purpose) {
      return call('POST', `/v1/customers/${customerId}/consents/revoke`, { purpose });
    },

    async apply(customerId, { amount, pan, intake }) {
      return call('POST', '/v1/applications', {
        customer_id: customerId, product_code: DEMO_PRODUCT.code, requested_amount: amount, pan, intake,
      });
    },
    // The offer ran out of time: it can no longer be accepted.
    async expireOffer(applicationId) { return store.patchApplication(applicationId, { status: 'expired' }); },
    // Identity is out of date: mark it unverified so the next application runs the identity check again.
    async expireKyc(customerId) { return store.patchCustomer(customerId, { kyc_status: 'pending' }); },
    async saveProfile(customerId, { monthly_salary: salary }) { return store.patchCustomer(customerId, { monthly_salary: salary }); },

    async rewards(customerId) { return (await call('GET', `/v1/customers/${customerId}/rewards`)).body; },
    async spin(customerId) { return call('POST', `/v1/customers/${customerId}/wheel/spin`, {}); },

    async sendAgreement(applicationId) { return call('POST', `/v1/applications/${applicationId}/agreement`, {}); },
    async disburse(applicationId, account) { return call('POST', `/v1/applications/${applicationId}/disburse`, { account }); },
    async loanView(loanId) { return call('GET', `/v1/loans/${loanId}`); },
    async collect(loanId, amount) { return call('POST', `/v1/loans/${loanId}/collect`, amount === undefined ? {} : { amount }); },

    async owns(customerId, kind, id) {
      if (kind === 'application') return (await store.getApplication(id))?.customer_id === customerId;
      if (kind === 'loan') return (await store.getLoan(id))?.customer_id === customerId;
      return false;
    },

    // ---- demo only: stand in for the e-sign vendor and the payment vendor calling back
    async signAgreement(applicationId) {
      return recordAgreementSigned({ store, applicationId, signedAt: now().toISOString() });
    },
    async pay(loanId) {
      const s = await getLoanSummary({ store, loanId });
      if (!s || s.outstanding <= 0) return null;
      const product = await store.getProduct(s.loan.product_id);
      return recordPayment({
        store, loan: s.loan, product, amount: s.outstanding, mode: 'upi', utr: `DEMO-${loanId}`,
        paidAt: new Date().toISOString(), // the loan system dates the loan by the real calendar, so the simulated payment does too
      });
    },
  };
}

export function createGateway({ cfg, now }) {
  if (cfg.mode === 'demo') return createDemoGateway({ now });
  throw new Error('the live gateway to the loan system is not built yet');
}
