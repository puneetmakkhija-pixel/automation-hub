// Persistence behind one interface, so the pipeline, servicing and API are testable without a database.
//   memoryStore()          tests and local runs. Enforces the same uniqueness rules as migration 004,
//                          so a double-loan or duplicate-payment bug shows up in tests.
//   supabaseStore(client)  the payday schema through an INJECTED supabase-js client (service role).
//                          This package has no dependency on supabase-js.
import { randomUUID } from 'node:crypto';

const OPEN = ['active', 'overdue'];

function dup(what) {
  const e = new Error(`duplicate key: ${what}`);
  e.code = '23505';
  return e;
}
const clone = (o) => (o === null || o === undefined ? o : structuredClone(o));

// ------------------------------------------------------------------ memory
export function memoryStore(seed = {}) {
  const t = {
    customers: [], products: [...(seed.products || [])], applications: [], agreements: [], loans: [], shares: [],
    disbursements: [], schedule: [], payments: [], ledger: [], limits: [], events: [],
    colending: [...(seed.colending || [])],
    lenders: seed.lenders || [{ id: 'lender-own-book', name: 'OWN_BOOK', lender_type: 'own_book' }],
    kycChecks: [], enrichment: [], scorecards: [], applicationPatches: [],
    partners: [], apiClients: [], audit: [], consents: [], policies: [], partnerEvents: [],
  };
  const find = (list, pred) => clone(list.find(pred) ?? null);
  const patch = (list, pred, p) => {
    const row = list.find(pred);
    if (!row) throw new Error('row not found');
    Object.assign(row, p);
    return clone(row);
  };
  const withId = (row) => ({ id: randomUUID(), created_at: new Date().toISOString(), ...row });

  return {
    db: t,
    // ---- onboarding / decision
    async saveKycChecks(rows) { t.kycChecks.push(...rows); },
    async saveEnrichment(row) { t.enrichment.push(row); },
    async saveScorecard(row) { t.scorecards.push(row); },
    async upsertCustomer(row) {
      const existing = t.customers.find((c) => c.mobile === row.mobile);
      if (existing) { Object.assign(existing, row); return clone(existing); }
      const c = withId({ kyc_status: 'pending', ...row });
      t.customers.push(c);
      return clone(c);
    },
    async getCustomer(id) { return find(t.customers, (c) => c.id === id); },
    async patchCustomer(id, p) { return patch(t.customers, (c) => c.id === id, p); },
    async getProduct(id) { return find(t.products, (p) => p.id === id); },
    async getProductByCode(code) { return find(t.products, (p) => p.code === code); },
    async insertApplication(row) {
      const a = withId({ status: 'draft', approved_amount: null, is_repeat: false, decision_reasons: null, ...row });
      t.applications.push(a);
      return clone(a);
    },
    async getApplication(id) { return find(t.applications, (a) => a.id === id); },
    async patchApplication(id, p) {
      t.applicationPatches.push({ id, patch: p });
      const a = t.applications.find((x) => x.id === id);
      if (a) Object.assign(a, p); // the pipeline tests run on application ids that were never inserted
    },
    // ---- agreement
    async saveAgreement(row) {
      if (t.agreements.some((a) => a.application_id === row.application_id)) throw dup('agreement.application_id');
      const a = withId(row);
      t.agreements.push(a);
      return clone(a);
    },
    async getAgreementByApplication(appId) { return find(t.agreements, (a) => a.application_id === appId); },
    async patchAgreementByApplication(appId, p) { return patch(t.agreements, (a) => a.application_id === appId, p); },
    // ---- loan
    async insertLoan(row) {
      if (OPEN.includes(row.status ?? 'active') && t.loans.some((l) => l.customer_id === row.customer_id && OPEN.includes(l.status))) {
        throw dup('loan_one_open_per_customer');
      }
      if (t.loans.some((l) => l.application_id === row.application_id)) throw dup('loan.application_id');
      const l = withId({ status: 'active', rollover_count: 0, disbursed_at: null, closed_at: null, ...row });
      t.loans.push(l);
      return clone(l);
    },
    async getLoan(id) { return find(t.loans, (l) => l.id === id); },
    async getLoanByApplication(appId) { return find(t.loans, (l) => l.application_id === appId); },
    async patchLoan(id, p) { return patch(t.loans, (l) => l.id === id, p); },
    async countApplicationsSince(customerId, sinceIso) { return t.applications.filter((a) => a.customer_id === customerId && a.created_at >= sinceIso).length; },
    async countLoans(customerId) { return t.loans.filter((l) => l.customer_id === customerId && l.disbursed_at).length; },
    async hasOpenLoan(customerId) { return t.loans.some((l) => l.customer_id === customerId && OPEN.includes(l.status)); },
    async listOpenLoans() { return clone(t.loans.filter((l) => OPEN.includes(l.status) && l.disbursed_at)); },
    // ---- co-lending
    async getColendingShares(productId, onDate) {
      return clone(t.colending.filter((c) => c.product_id === productId && c.effective_from <= onDate
        && (!c.effective_to || c.effective_to >= onDate)).map((c) => ({ lender_id: c.lender_id, share_pct: c.share_pct })));
    },
    async getOwnBookLender() { return find(t.lenders, (l) => l.lender_type === 'own_book'); },
    async insertLoanLenderShares(rows) { t.shares.push(...clone(rows)); },
    async getLoanShares(loanId) { return clone(t.shares.filter((s) => s.loan_id === loanId)); },
    // ---- disbursement
    async insertDisbursement(row) {
      if (row.idempotency_key && t.disbursements.some((d) => d.idempotency_key === row.idempotency_key)) throw dup('disbursement.idempotency_key');
      const d = withId({ status: 'pending', utr: null, ...row });
      t.disbursements.push(d);
      return clone(d);
    },
    async getDisbursement(id) { return find(t.disbursements, (d) => d.id === id); },
    async findDisbursementByKey(key) { return find(t.disbursements, (d) => d.idempotency_key === key); },
    async patchDisbursement(id, p) {
      if (p.utr && t.disbursements.some((d) => d.utr === p.utr && d.id !== id)) throw dup('disbursement.utr');
      // mirrors the database: one successful disbursement per loan (migration 008)
      if (p.status === 'success') {
        const cur = t.disbursements.find((d) => d.id === id);
        if (cur && t.disbursements.some((d) => d.loan_id === cur.loan_id && d.id !== id && d.status === 'success')) throw dup('disbursement.one_success_per_loan');
      }
      return patch(t.disbursements, (d) => d.id === id, p);
    },
    async listPendingDisbursements(beforeIso) { return clone(t.disbursements.filter((d) => d.status === 'pending' && d.created_at < beforeIso)); },
    async listDisbursementsForLoan(loanId) { return clone(t.disbursements.filter((d) => d.loan_id === loanId)); },
    // ---- schedule, payments, ledger
    async insertSchedule(row) {
      const s = withId({ installment_no: 1, penalty_due: 0, paid_amount: 0, status: 'due', ...row });
      t.schedule.push(s);
      return clone(s);
    },
    async getSchedule(loanId) { return clone(t.schedule.filter((s) => s.loan_id === loanId).sort((a, b) => a.installment_no - b.installment_no)); },
    async patchSchedule(id, p) { return patch(t.schedule, (s) => s.id === id, p); },
    async insertPayment(row) {
      if (row.utr && t.payments.some((p) => p.utr === row.utr)) throw dup('payment.utr');
      const p = withId(row);
      t.payments.push(p);
      return clone(p);
    },
    async findPaymentByUtr(utr) { return find(t.payments, (p) => p.utr === utr); },
    async listPayments(loanId) { return clone(t.payments.filter((p) => p.loan_id === loanId)); },
    async insertLedger(rows) { t.ledger.push(...rows.map((r) => ({ id: t.ledger.length + 1, created_at: new Date().toISOString(), ...clone(r) }))); },
    async getLedgerBalance(loanId) {
      return t.ledger.filter((e) => e.loan_id === loanId)
        .reduce((a, e) => Math.round((a + (e.direction === 'debit' ? e.amount : -e.amount)) * 100) / 100, 0);
    },
    // ---- repeat-loan limits
    async insertCustomerLimit(row) { const l = withId({ effective_from: new Date().toISOString(), ...row }); t.limits.push(l); return clone(l); },
    async getCurrentLimit(customerId) {
      const rows = t.limits.filter((l) => l.customer_id === customerId);
      return clone(rows.length ? rows[rows.length - 1] : null);
    },
    // ---- customers by mobile
    async getCustomerByMobile(mobile) { return find(t.customers, (c) => c.mobile === mobile); },
    // ---- partners and API clients
    async insertPartner(row) {
      if (t.partners.some((x) => x.name === row.name)) throw dup('partner.name');
      const x = withId({ active: true, callback_url: null, callback_secret_env: null, ...row });
      t.partners.push(x);
      return clone(x);
    },
    async getPartner(id) { return find(t.partners, (x) => x.id === id); },
    async patchPartner(id, p) { return patch(t.partners, (x) => x.id === id, p); },
    async listPartners() { return clone(t.partners); },
    async insertApiClient(row) {
      if ((row.role === 'partner') !== Boolean(row.partner_id)) { const e = new Error('check violation: a partner key names its partner; no other role does'); e.code = '23514'; throw e; }
      if (t.apiClients.some((x) => x.key_hash === row.key_hash)) throw dup('api_client.key_hash');
      const x = withId({ active: true, last_used_at: null, revoked_at: null, partner_id: null, ...row });
      t.apiClients.push(x);
      return clone(x);
    },
    async findApiClientByKeyHash(hash) { return find(t.apiClients, (x) => x.key_hash === hash); },
    async touchApiClient(id) { const x = t.apiClients.find((c) => c.id === id); if (x) x.last_used_at = new Date().toISOString(); },
    async revokeApiClient(id) { return patch(t.apiClients, (x) => x.id === id, { active: false, revoked_at: new Date().toISOString() }); },
    async listApiClients() { return clone(t.apiClients.map(({ key_hash, ...rest }) => rest)); },
    // ---- audit log (append only)
    async insertAudit(row) { t.audit.push({ id: t.audit.length + 1, at: new Date().toISOString(), ...clone(row) }); },
    async listAudit({ entityType = null, entityId = null, limit = 100 } = {}) {
      return clone(t.audit.filter((a) => (!entityType || a.entity_type === entityType) && (!entityId || a.entity_id === entityId)).slice(-limit).reverse());
    },
    // ---- consent
    async insertConsents(rows) { t.consents.push(...rows.map((r) => withId({ granted_at: new Date().toISOString(), revoked_at: null, evidence: null, ...clone(r) }))); },
    async getActiveConsents(customerId) {
      const seen = new Map();
      for (const c of t.consents) if (c.customer_id === customerId && !c.revoked_at) seen.set(c.purpose, c);
      return clone([...seen.values()]);
    },
    async revokeConsent(customerId, purpose, atIso) {
      const rows = t.consents.filter((c) => c.customer_id === customerId && c.purpose === purpose && !c.revoked_at);
      rows.forEach((c) => { c.revoked_at = atIso; });
      return rows.length;
    },
    // ---- credit policies (mirrors the database triggers: frozen once active, one active at a time)
    async insertPolicy(row) {
      if (t.policies.some((x) => x.version === row.version)) throw dup('credit_policy.version');
      const x = withId({ status: 'draft', note: null, activated_by: null, activated_at: null, ...clone(row) });
      t.policies.push(x);
      return clone(x);
    },
    async getPolicyById(id) { return find(t.policies, (x) => x.id === id); },
    async getPolicyByVersion(v) { return find(t.policies, (x) => x.version === v); },
    async getActivePolicy() { return find(t.policies, (x) => x.status === 'active'); },
    async listPolicies() { return clone(t.policies.map(({ config, ...rest }) => rest)); },
    async patchPolicy(id, p) {
      const x = t.policies.find((y) => y.id === id);
      if (!x) throw new Error('row not found');
      if (x.status !== 'draft' && p.config !== undefined && JSON.stringify(p.config) !== JSON.stringify(x.config)) throw new Error('an activated credit policy cannot be edited: create a new version');
      Object.assign(x, p);
      return clone(x);
    },
    async deletePolicy(id) {
      const x = t.policies.find((y) => y.id === id);
      if (x && x.status !== 'draft') throw new Error('only a draft credit policy can be deleted');
      t.policies = t.policies.filter((y) => y.id !== id);
    },
    async activatePolicy(id, by) {
      const x = t.policies.find((y) => y.id === id);
      if (!x || x.status !== 'draft') throw new Error('only a draft credit policy can be activated');
      t.policies.filter((y) => y.status === 'active').forEach((y) => { y.status = 'retired'; });
      Object.assign(x, { status: 'active', activated_by: by, activated_at: new Date().toISOString() });
      return clone(x);
    },
    // ---- partner callback outbox
    async insertPartnerEvent(row) {
      if (t.partnerEvents.some((e) => e.partner_id === row.partner_id && e.event_id === row.event_id)) throw dup('partner_event');
      const x = withId({ status: 'pending', attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null, delivered_at: null, ...clone(row) });
      t.partnerEvents.push(x);
      return clone(x);
    },
    async listDuePartnerEvents(nowIso, limit = 50) {
      return clone(t.partnerEvents.filter((e) => e.status === 'pending' && e.next_attempt_at <= nowIso).slice(0, limit));
    },
    async patchPartnerEvent(id, p) { return patch(t.partnerEvents, (e) => e.id === id, p); },
    // ---- vendor webhooks
    async recordVendorEvent(ev) {
      const existing = t.events.find((e) => e.provider === ev.provider && e.event_id === ev.event_id);
      if (existing) return { isNew: false, processed: Boolean(existing.processed_at) };
      t.events.push({ ...clone(ev), processed_at: null });
      return { isNew: true, processed: false };
    },
    async markVendorEventProcessed(provider, eventId) {
      const e = t.events.find((x) => x.provider === provider && x.event_id === eventId);
      if (e) e.processed_at = new Date().toISOString();
    },
  };
}

// ------------------------------------------------------------------ supabase
export function supabaseStore(client) {
  const from = (name) => client.schema('payday').from(name);
  const run = async (q, what) => {
    const { data, error } = await q;
    if (error) {
      const e = new Error(`payday.${what}: ${error.message}`);
      e.code = error.code;
      throw e;
    }
    return data;
  };
  const insertOne = (table, row) => run(from(table).insert(row).select().single(), `${table} insert`);
  const getBy = (table, col, val) => run(from(table).select('*').eq(col, val).maybeSingle(), `${table} select`);
  const patchBy = (table, col, val, p) => run(from(table).update(p).eq(col, val).select().single(), `${table} update`);

  return {
    saveKycChecks: (rows) => run(from('kyc_check').insert(rows), 'kyc_check insert'),
    saveEnrichment: (row) => run(from('enrichment_report').insert(row), 'enrichment_report insert'),
    saveScorecard: (row) => run(from('scorecard_result').insert(row), 'scorecard_result insert'),
    upsertCustomer: (row) => run(from('customer').upsert(row, { onConflict: 'mobile' }).select().single(), 'customer upsert'),
    getCustomer: (id) => getBy('customer', 'id', id),
    patchCustomer: (id, p) => patchBy('customer', 'id', id, p),
    getProduct: (id) => getBy('loan_product', 'id', id),
    getProductByCode: (code) => getBy('loan_product', 'code', code),
    insertApplication: (row) => insertOne('application', row),
    getApplication: (id) => getBy('application', 'id', id),
    patchApplication: (id, p) => run(from('application').update(p).eq('id', id), 'application update'),

    saveAgreement: (row) => insertOne('agreement', row),
    getAgreementByApplication: (appId) => getBy('agreement', 'application_id', appId),
    patchAgreementByApplication: (appId, p) => patchBy('agreement', 'application_id', appId, p),

    insertLoan: (row) => insertOne('loan', row),
    getLoan: (id) => getBy('loan', 'id', id),
    getLoanByApplication: (appId) => getBy('loan', 'application_id', appId),
    patchLoan: (id, p) => patchBy('loan', 'id', id, p),
    async countApplicationsSince(customerId, sinceIso) {
      const { count, error } = await from('application').select('id', { count: 'exact', head: true })
        .eq('customer_id', customerId).gte('created_at', sinceIso);
      if (error) throw new Error(`payday.application count: ${error.message}`);
      return count ?? 0;
    },
    async countLoans(customerId) {
      const { count, error } = await from('loan').select('id', { count: 'exact', head: true })
        .eq('customer_id', customerId).not('disbursed_at', 'is', null);
      if (error) throw new Error(`payday.loan count: ${error.message}`);
      return count ?? 0;
    },
    async hasOpenLoan(customerId) {
      const rows = await run(from('loan').select('id').eq('customer_id', customerId).in('status', OPEN).limit(1), 'loan open check');
      return rows.length > 0;
    },
    listOpenLoans: () => run(from('loan').select('*').in('status', OPEN).not('disbursed_at', 'is', null), 'loan list open'),

    async getColendingShares(productId, onDate) {
      const rows = await run(from('colending_arrangement').select('lender_id, share_pct')
        .eq('product_id', productId).lte('effective_from', onDate)
        .or(`effective_to.is.null,effective_to.gte.${onDate}`), 'colending_arrangement select');
      return rows.map((r) => ({ lender_id: r.lender_id, share_pct: Number(r.share_pct) }));
    },
    getOwnBookLender: () => run(from('lender').select('*').eq('lender_type', 'own_book').limit(1).maybeSingle(), 'lender select'),
    insertLoanLenderShares: (rows) => run(from('loan_lender_share').insert(rows), 'loan_lender_share insert'),
    getLoanShares: (loanId) => run(from('loan_lender_share').select('*').eq('loan_id', loanId), 'loan_lender_share select'),

    insertDisbursement: (row) => insertOne('disbursement', row),
    getDisbursement: (id) => getBy('disbursement', 'id', id),
    findDisbursementByKey: (key) => getBy('disbursement', 'idempotency_key', key),
    patchDisbursement: (id, p) => patchBy('disbursement', 'id', id, p),
    listPendingDisbursements: (beforeIso) => run(from('disbursement').select('*').eq('status', 'pending').lt('created_at', beforeIso), 'disbursement select pending'),
    listDisbursementsForLoan: (loanId) => run(from('disbursement').select('*').eq('loan_id', loanId), 'disbursement select'),

    insertSchedule: (row) => insertOne('repayment_schedule', row),
    getSchedule: (loanId) => run(from('repayment_schedule').select('*').eq('loan_id', loanId).order('installment_no'), 'repayment_schedule select'),
    patchSchedule: (id, p) => patchBy('repayment_schedule', 'id', id, p),
    insertPayment: (row) => insertOne('payment', row),
    findPaymentByUtr: (utr) => getBy('payment', 'utr', utr),
    listPayments: (loanId) => run(from('payment').select('*').eq('loan_id', loanId), 'payment select'),
    insertLedger: (rows) => run(from('ledger_entry').insert(rows), 'ledger_entry insert'),
    async getLedgerBalance(loanId) {
      const r = await getBy('loan_ledger_balance', 'loan_id', loanId);
      return r ? Number(r.balance) : 0;
    },

    insertCustomerLimit: (row) => insertOne('customer_limit', row),
    getCurrentLimit: (customerId) => run(from('customer_limit').select('*').eq('customer_id', customerId)
      .order('effective_from', { ascending: false }).limit(1).maybeSingle(), 'customer_limit select'),

    getCustomerByMobile: (mobile) => getBy('customer', 'mobile', mobile),
    insertPartner: (row) => insertOne('partner', row),
    getPartner: (id) => getBy('partner', 'id', id),
    patchPartner: (id, p) => patchBy('partner', 'id', id, p),
    listPartners: () => run(from('partner').select('*'), 'partner select'),
    insertApiClient: (row) => insertOne('api_client', row),
    findApiClientByKeyHash: (hash) => getBy('api_client', 'key_hash', hash),
    touchApiClient: (id) => run(from('api_client').update({ last_used_at: new Date().toISOString() }).eq('id', id), 'api_client touch'),
    revokeApiClient: (id) => patchBy('api_client', 'id', id, { active: false, revoked_at: new Date().toISOString() }),
    listApiClients: () => run(from('api_client').select('id, name, role, partner_id, active, created_at, last_used_at, revoked_at'), 'api_client select'),
    insertAudit: (row) => run(from('audit_log').insert(row), 'audit_log insert'),
    listAudit({ entityType = null, entityId = null, limit = 100 } = {}) {
      let q = from('audit_log').select('*');
      if (entityType) q = q.eq('entity_type', entityType);
      if (entityId) q = q.eq('entity_id', entityId);
      return run(q.order('id', { ascending: false }).limit(limit), 'audit_log select');
    },
    insertConsents: (rows) => run(from('consent').insert(rows), 'consent insert'),
    async getActiveConsents(customerId) {
      const rows = await run(from('consent').select('*').eq('customer_id', customerId).is('revoked_at', null), 'consent select');
      return [...new Map(rows.map((c) => [c.purpose, c])).values()];
    },
    async revokeConsent(customerId, purpose, atIso) {
      const rows = await run(from('consent').update({ revoked_at: atIso }).eq('customer_id', customerId).eq('purpose', purpose).is('revoked_at', null).select('id'), 'consent revoke');
      return rows.length;
    },
    insertPolicy: (row) => insertOne('credit_policy', row),
    getPolicyById: (id) => getBy('credit_policy', 'id', id),
    getPolicyByVersion: (v) => getBy('credit_policy', 'version', v),
    getActivePolicy: () => getBy('credit_policy', 'status', 'active'),
    listPolicies: () => run(from('credit_policy').select('id, version, status, note, created_by, created_at, activated_by, activated_at').order('created_at', { ascending: false }), 'credit_policy select'),
    patchPolicy: (id, p) => patchBy('credit_policy', 'id', id, p),
    deletePolicy: (id) => run(from('credit_policy').delete().eq('id', id), 'credit_policy delete'),
    activatePolicy: (id, by) => run(client.schema('payday').rpc('activate_credit_policy', { p_id: id, p_by: by }), 'activate_credit_policy'),
    insertPartnerEvent: (row) => insertOne('partner_event', row),
    listDuePartnerEvents: (nowIso, limit = 50) => run(from('partner_event').select('*').eq('status', 'pending').lte('next_attempt_at', nowIso).order('next_attempt_at').limit(limit), 'partner_event select'),
    patchPartnerEvent: (id, p) => patchBy('partner_event', 'id', id, p),

    async recordVendorEvent(ev) {
      const { error } = await from('vendor_event').insert(ev);
      if (!error) return { isNew: true, processed: false };
      if (error.code !== '23505') throw new Error(`payday.vendor_event insert: ${error.message}`);
      const row = await run(from('vendor_event').select('processed_at').eq('provider', ev.provider).eq('event_id', ev.event_id).single(), 'vendor_event select');
      return { isNew: false, processed: Boolean(row.processed_at) };
    },
    markVendorEventProcessed: (provider, eventId) => run(from('vendor_event')
      .update({ processed_at: new Date().toISOString() }).eq('provider', provider).eq('event_id', eventId), 'vendor_event update'),
  };
}
