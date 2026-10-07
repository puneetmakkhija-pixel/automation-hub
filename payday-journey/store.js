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
      return patch(t.disbursements, (d) => d.id === id, p);
    },
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
