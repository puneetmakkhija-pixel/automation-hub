// End-to-end test of the payday journey against a REAL Supabase project, through the payday-api handler,
// using mock vendors and a signed fake-vendor webhook (the fictional "acme" spec).
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_KEY=<service-role key> node payday-api/scripts/e2e-live.mjs
//
// It WRITES to the payday schema: a test product, two test lenders (80/20 co-lending), two customers,
// and everything their loans create. Every row is tagged with this run's id, and the script prints the
// exact SQL that removes it. The `payday` schema must be exposed in the project's Data API settings.
//
// Sandbox note: if the network proxy injects the service key itself (the key you pass is then only a
// placeholder for the apikey header), set E2E_STRIP_AUTH=1 so supabase-js does not send its own
// Authorization header over the injected one.
import { createHmac, randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createApp } from '../app.js';
import { createRegistry, supabaseStore, istToday } from '../../payday-journey/index.js';
import { acme } from '../../payday-journey/vendors/_example-acme.spec.js';

const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('SUPABASE_URL and SUPABASE_KEY are required'); process.exit(2); }

const RUN = Date.now().toString(36);
const CODE = `E2E_${RUN}`;
const LENDER_A = `E2E_A_${RUN}`;
const LENDER_B = `E2E_B_${RUN}`;
const mobile = () => `6${String(randomInt(0, 1e8)).padStart(8, '0')}3`; // 10 digits starting 6, ending 3 (the clean mock scenario)
const EVENT = (n) => `e2e-${RUN}-${n}`;

const stripAuth = process.env.E2E_STRIP_AUTH === '1'
  ? (input, init = {}) => { const h = new Headers(init.headers); h.delete('authorization'); return fetch(input, { ...init, headers: h }); }
  : undefined;
const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false }, global: stripAuth ? { fetch: stripAuth } : {} });
const db = (t) => client.schema('payday').from(t);

const ENV = { PAYDAY_API_KEY: 'e2e-key', ACME_WEBHOOK_SECRET: 'e2e-secret', PAN_PEPPER: 'e2e-pepper' };
const registry = createRegistry({ env: {}, specs: { acme } }); // mock vendors for every slot
const app = createApp({ store: supabaseStore(client), registry, env: ENV });
const call = (method, path, body, query) => app.handle({
  method, path, query, headers: { 'x-api-key': ENV.PAYDAY_API_KEY },
  rawBody: body === undefined ? '' : JSON.stringify(body),
});
const hook = (payload) => {
  const raw = JSON.stringify(payload);
  return app.handle({ method: 'POST', path: '/v1/webhooks/acme', rawBody: raw, headers: { 'x-acme-signature': createHmac('sha256', ENV.ACME_WEBHOOK_SECRET).update(raw).digest('hex') } });
};

const results = [];
function check(name, ok, detail = '') { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   <- ${detail}`}`); }
const must = async (q, what) => { const { data, error } = await q; if (error) throw new Error(`${what}: ${error.message}`); return data; };

const intake = { declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long', purposeClarity: 'specific_documented', referencesVerified: 'both' };
const account = { name: 'E2E Test', number: '123456789012', ifsc: 'HDFC0000001' };
const mobiles = [];

async function journey(label) {
  const m = mobile(); mobiles.push(m);
  const c = await call('POST', '/v1/customers', { mobile: m, salary_day: 1, source: `e2e-${RUN}` });
  check(`${label}: customer created`, c.status === 200 && c.body.customer_id, JSON.stringify(c));
  const a = await call('POST', '/v1/applications', { customer_id: c.body.customer_id, product_code: CODE, requested_amount: 10000, intake });
  check(`${label}: application approved at grade A with a 10,000 offer`, a.status === 200 && a.body.decision === 'approve' && a.body.offer?.amount === 10000, JSON.stringify(a.body));
  const appId = a.body.application_id;
  const ag = await call('POST', `/v1/applications/${appId}/agreement`);
  check(`${label}: agreement sent`, ag.status === 201, JSON.stringify(ag));
  const sig = await hook({ event_id: EVENT(`${label}-sign`), type: 'esign.signed', data: { application_ref: appId } });
  check(`${label}: e-sign webhook applied`, sig.status === 200 && sig.body.ok, JSON.stringify(sig));
  const replay = await hook({ event_id: EVENT(`${label}-sign`), type: 'esign.signed', data: { application_ref: appId } });
  check(`${label}: webhook replay is ignored (vendor_event unique)`, replay.status === 200 && replay.body.duplicate === true, JSON.stringify(replay));
  const d = await call('POST', `/v1/applications/${appId}/disburse`, { account });
  check(`${label}: disbursed`, d.status === 200 && d.body.status === 'success', JSON.stringify(d));
  return { customerId: c.body.customer_id, appId, loanId: d.body.loan_id, mobile: m };
}

let failed = false;
try {
  // ---- setup: a test product and two co-lenders (80/20)
  const product = (await must(db('loan_product').insert({
    code: CODE, name: 'E2E test product', min_amount: 5000, max_amount: 25000, tenure_days: 30,
    fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, rollover_allowed: true, max_rollovers: 1,
  }).select(), 'insert product'))[0];
  const lenders = await must(db('lender').insert([{ name: LENDER_A }, { name: LENDER_B }]).select(), 'insert lenders');
  const la = lenders.find((l) => l.name === LENDER_A); const lb = lenders.find((l) => l.name === LENDER_B);
  await must(db('colending_arrangement').insert([
    { product_id: product.id, lender_id: la.id, share_pct: 80, effective_from: '2020-01-01' },
    { product_id: product.id, lender_id: lb.id, share_pct: 20, effective_from: '2020-01-01' },
  ]), 'insert arrangements');
  check('setup: product and 80/20 co-lenders created through the live API', true);

  // ---- customer A: the full happy path and a repeat loan
  const A = await journey('A');
  const loan = (await must(db('loan').select('*').eq('id', A.loanId), 'read loan'))[0];
  check('A: loan row correct (principal 10000, fee 800, cycle 1, due in 30 days)', loan.principal === 10000 && loan.fee_amount === 800 && loan.cycle_number === 1 && loan.due_date > istToday() && loan.disbursed_at, JSON.stringify(loan));
  const shares = await must(db('loan_lender_share').select('*').eq('loan_id', A.loanId), 'read shares');
  const byLender = Object.fromEntries(shares.map((s) => [s.lender_id, Number(s.principal_share)]));
  check('A: co-lender split is 8000 / 2000', byLender[la.id] === 8000 && byLender[lb.id] === 2000, JSON.stringify(byLender));
  const ledger = await must(db('ledger_entry').select('*').eq('loan_id', A.loanId), 'read ledger');
  check('A: ledger has 4 entries (2 disbursal, 2 fee) totalling 10800', ledger.length === 4 && ledger.reduce((s, e) => s + Number(e.amount), 0) === 10800, JSON.stringify(ledger.map((e) => [e.entry_type, e.amount])));
  const g1 = await call('GET', `/v1/loans/${A.loanId}`);
  check('A: schedule outstanding equals ledger balance (10800)', g1.body.outstanding === 10800 && g1.body.ledger_balance === 10800, JSON.stringify(g1.body));
  const blocked = await call('POST', '/v1/applications', { customer_id: A.customerId, product_code: CODE, requested_amount: 5000, intake });
  check('A: a second application while a loan is open is refused', blocked.status === 409 && blocked.body.code === 'OPEN_LOAN', JSON.stringify(blocked));
  const link = await call('POST', `/v1/loans/${A.loanId}/collect`, {});
  check('A: repayment link created for the full outstanding amount', link.status === 201 && link.body.amount === 10800, JSON.stringify(link));
  const pay = await hook({ event_id: EVENT('A-pay'), type: 'collect.received', data: { loan_ref: A.loanId, amount: 10800, utr: `E2E-UTR-${RUN}`, mode: 'upi' } });
  check('A: payment webhook applied', pay.status === 200 && pay.body.ok, JSON.stringify(pay));
  const g2 = await call('GET', `/v1/loans/${A.loanId}`);
  check('A: loan closed with a zero ledger balance', g2.body.status === 'closed' && g2.body.ledger_balance === 0 && g2.body.outstanding === 0, JSON.stringify(g2.body));
  const dup = await call('POST', `/v1/loans/${A.loanId}/payments`, { amount: 10800, mode: 'upi', utr: `E2E-UTR-${RUN}` });
  check('A: the same UTR sent again by hand is a harmless duplicate', dup.status === 200 && dup.body.duplicate === true, JSON.stringify(dup));
  const dbDup = await client.schema('payday').from('payment').insert({ loan_id: A.loanId, amount: 1, mode: 'upi', utr: `E2E-UTR-${RUN}`, status: 'success' });
  check('A: the database itself refuses a duplicate payment UTR', dbDup.error?.code === '23505', JSON.stringify(dbDup.error));
  const el = await call('GET', `/v1/customers/${A.customerId}/eligibility`, undefined, { product: CODE });
  check('A: eligible for a repeat loan, limit stepped up to 15000, cycle 2', el.body.eligible && el.body.is_repeat && el.body.limit === 15000 && el.body.cycle_number === 2, JSON.stringify(el.body));
  const kycBefore = (await must(db('kyc_check').select('id').eq('customer_id', A.customerId), 'kyc count')).length;
  const rep = await call('POST', '/v1/applications', { customer_id: A.customerId, product_code: CODE, requested_amount: 20000, intake });
  check('A: repeat application capped at the 15000 limit', rep.body.is_repeat === true && rep.body.offer?.amount === 15000 && rep.body.offer?.cappedBy === 'customer_limit', JSON.stringify(rep.body));
  const kycAfter = (await must(db('kyc_check').select('id').eq('customer_id', A.customerId), 'kyc count')).length;
  check('A: a verified repeat customer is not re-KYCd', kycAfter === kycBefore, `${kycBefore} -> ${kycAfter}`);

  // ---- customer B: overdue, penalty, integrity audit, write-off, blocked
  const B = await journey('B');
  await must(db('loan').update({ due_date: '2020-01-01' }).eq('id', B.loanId), 'backdate loan');
  await must(db('repayment_schedule').update({ due_date: '2020-01-01' }).eq('loan_id', B.loanId), 'backdate schedule');
  const job = await call('POST', '/v1/jobs/daily-servicing', {});
  check('daily job ran with no errors and no integrity issues', job.status === 200 && job.body.errors.length === 0 && job.body.integrityIssues.length === 0, JSON.stringify(job.body));
  const gb = await call('GET', `/v1/loans/${B.loanId}`);
  check('B: overdue with penalty added, schedule equals ledger', gb.body.status === 'overdue' && gb.body.outstanding > 10800 && gb.body.outstanding === gb.body.ledger_balance && gb.body.bucket === '90+', JSON.stringify(gb.body));
  const wo = await call('POST', `/v1/loans/${B.loanId}/write-off`, { reason: 'e2e_test' });
  const gb2 = await call('GET', `/v1/loans/${B.loanId}`);
  check('B: written off, ledger back to zero', wo.status === 200 && gb2.body.status === 'written_off' && gb2.body.ledger_balance === 0, JSON.stringify([wo.body, gb2.body]));
  const bl = await call('POST', '/v1/applications', { customer_id: B.customerId, product_code: CODE, requested_amount: 5000, intake });
  check('B: written-off customer is blocked from a new loan', bl.status === 409 && bl.body.code === 'BLOCKED', JSON.stringify(bl));
  const rec = await call('POST', '/v1/jobs/reconcile-payouts', {});
  check('reconcile job runs and finds nothing pending', rec.status === 200 && rec.body.checked === 0, JSON.stringify(rec));
} catch (e) {
  failed = true;
  console.error(`\nABORTED: ${e.message}`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length} passed, ${bad.length} failed${failed ? ', run aborted early' : ''}`);

// ---- exact cleanup for this run's rows
const list = mobiles.map((m) => `'${m}'`).join(',') || "''";
console.log(`\n-- CLEANUP for run ${RUN} (review, then run in the SQL editor):
delete from payday.ledger_entry where loan_id in (select l.id from payday.loan l join payday.customer c on c.id = l.customer_id where c.mobile in (${list}));
delete from payday.payment where loan_id in (select l.id from payday.loan l join payday.customer c on c.id = l.customer_id where c.mobile in (${list}));
delete from payday.disbursement where loan_id in (select l.id from payday.loan l join payday.customer c on c.id = l.customer_id where c.mobile in (${list}));
delete from payday.loan where customer_id in (select id from payday.customer where mobile in (${list}));
delete from payday.application where customer_id in (select id from payday.customer where mobile in (${list}));
delete from payday.customer where mobile in (${list});
delete from payday.vendor_event where provider = 'acme' and event_id like 'e2e-${RUN}-%';
delete from payday.colending_arrangement where product_id in (select id from payday.loan_product where code = '${CODE}');
delete from payday.loan_product where code = '${CODE}';
delete from payday.lender where name in ('${LENDER_A}', '${LENDER_B}');`);
process.exit(bad.length || failed ? 1 : 0);
