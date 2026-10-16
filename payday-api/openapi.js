// The partner API as an OpenAPI 3.1 document, built from the list below and from EVENT_CATALOGUE (the events we send).
// A test calls every operation listed here against the real handler and fails if one is not routed, so this file and
// app.js cannot drift apart silently. Internal and admin-only calls (policies, clients, jobs, write-off) are not listed.
import { EVENT_CATALOGUE } from '../payday-journey/index.js';

const ERR = { error: 'what went wrong, in words', code: 'MACHINE_READABLE_CODE (when there is one)' };
const CUSTOMER = { customer_id: 'c0a8...', };

// roles: who may call it. sandbox: only exists when PAYDAY_SANDBOX=1.
export const OPERATIONS = [
  { tag: 'Lender', method: 'GET', path: '/v1/lender', summary: 'Who the lender is', roles: 'partner, ops, admin',
    description: 'The NBFC name, registration, address and grievance officer, and the lending service provider (BuddyLoan). Show these in the app and on the website. `complete: false` means a lender detail is not set yet.',
    response: { name: 'Example Finance Ltd', registration: 'N-00.00000', address: '1 Road, City', support_email: 'help@example.com', support_phone: '1800...', grievance_officer: { name: 'A. Officer', email: 'g@example.com', phone: '...' }, lending_service_provider: { name: 'BuddyLoan' }, complete: true, missing: [] } },
  { tag: 'Customers', method: 'POST', path: '/v1/customers', summary: 'Create or update a customer by mobile number', roles: 'partner, ops, admin',
    request: { mobile: '9876543210', full_name: 'Asha Verma', salary_day: 1 }, response: CUSTOMER },
  { tag: 'Customers', method: 'POST', path: '/v1/customers/{customer_id}/consents', summary: 'Record the borrower\'s permission', roles: 'partner, ops, admin',
    description: 'Record each permission with the text version the borrower saw and the channel. No identity or credit check runs until `kyc`, `credit_bureau` and `terms` are on record.',
    request: { purposes: ['kyc', 'credit_bureau', 'terms'], text_version: 'v1', channel: 'app' }, response: { recorded: ['kyc', 'credit_bureau', 'terms'] } },
  { tag: 'Customers', method: 'POST', path: '/v1/customers/{customer_id}/consents/revoke', summary: 'Withdraw a permission', roles: 'partner, ops, admin', request: { purpose: 'credit_bureau' }, response: { revoked: 'credit_bureau' } },
  { tag: 'Customers', method: 'GET', path: '/v1/customers/{customer_id}/limit', summary: 'The limit offered, and what the customer qualifies for', roles: 'partner, ops, admin',
    description: 'Query `product` (the product code). The limit offered never rises on its own. When `can_request_increase` is true, show an "ask for a higher limit" option.',
    response: { eligible: true, limit: 10000, eligible_limit: 15000, can_request_increase: true, reason: null } },
  { tag: 'Customers', method: 'POST', path: '/v1/customers/{customer_id}/limit-increase', summary: 'The borrower asks for the higher limit they have earned', roles: 'partner, ops, admin', idempotent: true,
    request: { product_code: 'PAYDAY_30', amount: 15000 }, response: { limit: 15000, eligible_limit: 15000 } },
  { tag: 'Customers', method: 'GET', path: '/v1/customers/{customer_id}/rewards', summary: 'Spins and fee waivers the customer holds', roles: 'partner, ops, admin', response: { spins_available: 1, reward: null } },
  { tag: 'Customers', method: 'POST', path: '/v1/customers/{customer_id}/wheel/spin', summary: 'Spin the fee-waiver wheel', roles: 'partner, ops, admin', response: { slice: 3, waiver_pct: 20, expires_at: '2026-11-15T00:00:00Z' } },
  { tag: 'Applications', method: 'POST', path: '/v1/applications', summary: 'Apply: run the checks and get a decision', roles: 'partner, ops, admin', idempotent: true,
    description: 'Runs the identity check, pulls the credit report and decides. A partner key may open at most 3 applications per customer in 24 hours (429 `TOO_MANY_APPLICATIONS`). Send an `Idempotency-Key` so a retry never opens a second application.',
    request: { customer_id: 'c0a8...', product_code: 'PAYDAY_30', requested_amount: 10000, intake: { declaredSalary: 40000, tenureMonths: 24, employerCategory: 'listed_large', residence: 'rented_long', purposeClarity: 'generic', referencesVerified: 'none' }, pan: 'ABCDE1234F' },
    response: { application_id: 'a1b2...', decision: 'approve', offer: { amount: 10000, fee: 800, repayment: 10800, tenure_days: 30, aprEffectivePct: 155.07 } } },
  { tag: 'Applications', method: 'GET', path: '/v1/applications/{application_id}', summary: 'Application status', roles: 'partner, ops, admin', response: { application_id: 'a1b2...', status: 'approved', requested_amount: 10000, approved_amount: 10000, loan_id: null } },
  { tag: 'Applications', method: 'GET', path: '/v1/applications/{application_id}/kfs', summary: 'The key facts statement for the offer', roles: 'partner, ops, admin',
    description: 'Show this to the borrower before they accept. Includes the APR, fees, cooling-off terms and the grievance officer. Each statement issued is logged with its `sha256`. `complete: false` means a lender detail is missing: do not show it to customers yet.',
    response: { version: 1, complete: true, lender: { name: 'Example Finance Ltd' }, part1: { sanctioned_amount: 10000, total_to_repay: 10800, apr_pct: 155.07 }, part2: { cooling_off: { days: 1 } }, sha256: '9f2c...' } },
  { tag: 'Applications', method: 'POST', path: '/v1/applications/{application_id}/agreement', summary: 'Send the agreement for e-signing', roles: 'partner, ops, admin', response: { esign_status: 'sent', document_url: 'https://...', reused: false } },
  { tag: 'Applications', method: 'POST', path: '/v1/applications/{application_id}/disburse', summary: 'Pay the loan out', roles: 'ops, admin (partner in the sandbox)',
    description: 'The lender\'s act. The money goes only to the bank account sent here, which must be in the borrower\'s own name. Safe to repeat: a second call answers `already_disbursed`.',
    request: { account: { name: 'Asha Verma', number: '123456789012', ifsc: 'HDFC0000001' } }, response: { status: 'success', loan_id: 'l9f8...' } },
  { tag: 'Loans', method: 'GET', path: '/v1/loans/{loan_id}', summary: 'The loan: schedule, balance, cooling-off', roles: 'partner, ops, admin',
    description: 'Call this whenever My Loans opens. Keep no copy of the ledger. `cooling_off.open` is true during the window and `amount_due` is what an exit costs today.',
    response: { loan_id: 'l9f8...', status: 'active', principal: 10000, due_date: '2026-11-15', outstanding: 10800, days_overdue: 0, cooling_off: { open: true, amount_due: 10026.67 } } },
  { tag: 'Loans', method: 'POST', path: '/v1/loans/{loan_id}/collect', summary: 'Create a repayment link', roles: 'partner, ops, admin', idempotent: true,
    description: 'The link pays straight into the lender\'s account. The money never passes through BuddyLoan. The payment is confirmed to us by the payment vendor, which then sends you `payment.received`.',
    request: { amount: 10800 }, response: { provider_ref: 'pay_123', status: 'created', payment_url: 'https://...', amount: 10800 } },
  { tag: 'Loans', method: 'POST', path: '/v1/loans/{loan_id}/cooling-off', summary: 'The borrower asks to exit in the cooling-off window', roles: 'partner, ops, admin',
    description: 'Returns what to pay: the principal plus the fee for the days held. Pay with a repayment link inside the window. 409 once the window has ended.',
    response: { open: true, ends: '2026-10-17', days_held: 1, principal: 10000, fee: 26.67, fee_reversed: 773.33, amount_due: 10026.67, requested: true } },
  { tag: 'Events', method: 'GET', path: '/v1/events', summary: 'Read your events back', roles: 'partner (ops and admin add partner_id)',
    description: 'Everything we queued for you, oldest first. Use it to catch up after an outage: pass `since` (the `next_since` of your last read) and `status`.',
    response: { events: [{ id: 'e1...', event_id: 'a1b2...:application.decided', type: 'application.decided', status: 'delivered', attempts: 1, data: {} }], next_since: '2026-10-16T10:00:00Z' } },
  { tag: 'Events', method: 'POST', path: '/v1/events/{event_id}/redeliver', summary: 'Send an event again', roles: 'partner, ops, admin', response: { queued: true } },
  { tag: 'Events', method: 'GET', path: '/v1/event-types', summary: 'The list of event types', roles: 'partner, ops, admin', response: { event_types: [{ type: 'loan.closed', when: '...', data: ['loan_id', 'reason'] }] } },
  { tag: 'Sandbox', method: 'POST', path: '/v1/sandbox/applications/{application_id}/sign', summary: 'Pretend the borrower signed', roles: 'partner, ops, admin', sandbox: true, response: { status: 'signed' } },
  { tag: 'Sandbox', method: 'POST', path: '/v1/sandbox/loans/{loan_id}/pay', summary: 'Pretend the borrower paid in full', roles: 'partner, ops, admin', sandbox: true, response: { applied: 10800, closed: true } },
];

const pathParams = (path) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
const jsonBody = (example) => ({ content: { 'application/json': { schema: { type: 'object' }, example } } });

export function openApiSpec({ sandbox = false } = {}) {
  const paths = {};
  for (const op of OPERATIONS) {
    if (op.sandbox && !sandbox) continue;
    const parameters = pathParams(op.path);
    if (op.idempotent) parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: '8 to 128 characters. A retry with the same key and the same request gets the first answer.', schema: { type: 'string' } });
    if (op.path.endsWith('/limit')) parameters.push({ name: 'product', in: 'query', required: true, schema: { type: 'string' } });
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = {
      tags: [op.tag], summary: op.summary, description: `${op.description ? `${op.description}\n\n` : ''}Who may call it: ${op.roles}.`,
      ...(parameters.length ? { parameters } : {}),
      ...(op.request ? { requestBody: { required: true, ...jsonBody(op.request) } } : {}),
      responses: {
        200: { description: 'Success', ...jsonBody(op.response) },
        400: { description: 'The request is not valid', ...jsonBody(ERR) },
        401: { description: 'Missing or wrong API key', ...jsonBody({ error: 'unauthorized' }) },
        404: { description: 'Not found (also what you get for something that belongs to another partner)', ...jsonBody(ERR) },
        409: { description: 'Not allowed right now: wrong status, a rule, an open loan', ...jsonBody(ERR) },
      },
      security: [{ ApiKey: [] }],
    };
  }
  const webhooks = Object.fromEntries(Object.entries(EVENT_CATALOGUE).map(([type, v]) => [type, {
    post: {
      summary: type, description: `${v.when}\n\nFields in \`data\`: ${v.data.length ? v.data.join(', ') : 'none beyond application_id'}.`,
      requestBody: { content: { 'application/json': { schema: { type: 'object' }, example: { event_id: `a1b2...:${type}`, type, created_at: '2026-10-16T10:00:00Z', data: Object.fromEntries(['application_id', ...v.data].map((k) => [k, '...'])) } } } },
      responses: { 200: { description: 'Any 2xx means delivered. Anything else is retried with growing gaps, up to 8 times.' } },
    },
  }]));
  return {
    openapi: '3.1.0',
    info: {
      title: 'PaydayOS partner API',
      version: '1.0.0',
      description: 'The NBFC\'s loan system as a back end for a partner app. The partner shows the screens. PaydayOS holds the loan record, pays the borrower directly and collects repayments directly. Events we send are listed under webhooks and signed: `x-payday-signature` is `sha256=` plus the HMAC-SHA256 of `{x-payday-timestamp}.{raw body}` with your shared secret.',
    },
    servers: [{ url: 'https://payday-api-production.up.railway.app', description: 'Current deployment' }],
    tags: [...new Set(OPERATIONS.filter((o) => sandbox || !o.sandbox).map((o) => o.tag))].map((name) => ({ name })),
    paths,
    webhooks,
    components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
  };
}
