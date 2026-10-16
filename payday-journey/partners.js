// Partners and the callbacks we send them. A partner that hosts its own customer journey needs to hear what
// happened to an application. Events go to an outbox first (payday.partner_event), so a partner outage never
// blocks lending, and a delivery job sends them with retries.
//
// Delivery is signed: header x-payday-signature = "sha256=" + HMAC-SHA256(secret, `${timestamp}.${body}`), with
// x-payday-timestamp, so a partner can reject forgeries and replays older than a few minutes. The secret is read
// from an env var whose NAME is stored on the partner; the secret itself is never in the database.
import { createHmac } from 'node:crypto';
import { ValidationError } from './errors.js';

// A callback must be https on a real host NAME. IP addresses are refused outright (IPv4 in any notation, which
// the URL parser normalises to dotted form, and every IPv6 form including IPv4-mapped ones): that closes the whole
// class of "points at an internal address" tricks instead of trying to list every private range. A host name could
// still resolve to a private address (DNS rebinding); this check cannot see that, so deliveries also refuse
// redirects and use a short timeout. Run delivery from a network that cannot reach your internal services.
export function validateCallbackUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new ValidationError('invalid callback url', ['not a valid URL']); }
  const errs = [];
  if (u.protocol !== 'https:') errs.push('must be https');
  if (u.username || u.password) errs.push('must not contain credentials');
  if (u.port && u.port !== '443') errs.push('only port 443 is allowed');
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) errs.push('must be a host name, not an IP address');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) errs.push('must be a public host');
  if (!host.includes('.')) errs.push('must be a fully qualified host name');
  if (errs.length) throw new ValidationError('invalid callback url', errs);
  return u.toString();
}

export async function createPartner({ store, name, callbackUrl = null, callbackSecretEnv = null }) {
  const errs = [];
  if (typeof name !== 'string' || !name.trim() || name.length > 80) errs.push('name must be 1-80 characters');
  if (callbackUrl && !callbackSecretEnv) errs.push('callback_secret_env is required with a callback_url');
  if (callbackSecretEnv && !/^[A-Z][A-Z0-9_]{2,60}$/.test(callbackSecretEnv)) errs.push('callback_secret_env must be an env var name such as PARTNER_ACME_SECRET');
  if (errs.length) throw new ValidationError('invalid partner', errs);
  const url = callbackUrl ? validateCallbackUrl(callbackUrl) : null;
  return store.insertPartner({ name: name.trim(), callback_url: url, callback_secret_env: callbackSecretEnv });
}

export const signPartnerPayload = (secret, timestamp, body) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

// Every event a partner can receive. This list is the contract: the API docs are built from it, and a test checks that
// the code never emits a type that is not here. `data` names the fields inside `data` in the delivered body.
export const EVENT_CATALOGUE = {
  'application.decided': { when: 'Underwriting finished. Tells the partner approve, refer or decline, and the offer if there is one.', data: ['decision', 'offer'] },
  'agreement.signed': { when: 'The borrower signed the agreement.', data: [] },
  'loan.disbursed': { when: 'The money was paid into the borrower\'s bank account and the loan started.', data: ['loan_id', 'amount', 'fee', 'due_date', 'apr_pct'] },
  'payout.failed': { when: 'The bank payout failed. No loan was started. The partner can offer the borrower another account.', data: ['reason'] },
  'payment.received': { when: 'A repayment was confirmed. One event per payment.', data: ['loan_id', 'payment_id', 'amount', 'applied', 'outstanding', 'closed'] },
  'loan.overdue': { when: 'The loan passed its due date unpaid. Sent once, when it first becomes overdue.', data: ['loan_id', 'due_date'] },
  'loan.rolled_over': { when: 'The loan was extended to a new due date.', data: ['loan_id', 'due_date', 'rollover_count'] },
  'loan.cooling_off_requested': { when: 'The borrower asked to exit inside the cooling-off window.', data: ['loan_id', 'amount_due', 'ends'] },
  'loan.closed': { when: 'The loan is fully repaid. reason is repaid or cooling_off_exit.', data: ['loan_id', 'reason'] },
  'loan.written_off': { when: 'The lender wrote the loan off.', data: ['loan_id'] },
  'limit.increase_granted': { when: 'The borrower asked for a higher limit and got it.', data: ['limit'] },
};

// Queue an event for the partner that owns this application (or this customer, for events not tied to one application).
// Never throws: a failure to queue must not break a loan operation (it is logged by message only).
// One event per (subject, type), or per (subject, type, key) when the same type can happen many times, such as payments.
export async function emitPartnerEvent({ store, applicationId = null, customerId = null, type, key = null, data = {} }) {
  try {
    if (!EVENT_CATALOGUE[type]) throw new Error(`unknown event type ${type}`);
    let partnerId = null;
    let subject;
    if (applicationId) {
      partnerId = (await store.getApplication(applicationId))?.partner_id ?? null;
      subject = applicationId;
    } else if (customerId) {
      const source = (await store.getCustomer(customerId))?.source ?? '';
      partnerId = source.startsWith('partner:') ? source.slice('partner:'.length) : null;
      subject = `customer:${customerId}`;
    }
    if (!partnerId) return null;
    const partner = await store.getPartner(partnerId);
    if (!partner?.active || !partner.callback_url) return null;
    return await store.insertPartnerEvent({
      partner_id: partner.id, event_id: `${subject}:${type}${key ? `:${key}` : ''}`, event_type: type,
      payload: { ...(applicationId ? { application_id: applicationId } : {}), ...(customerId ? { customer_id: customerId } : {}), ...data },
    });
  } catch (e) {
    if (e.code !== '23505') console.error(`partner event not queued (${type}): ${e.message}`); // 23505 = already queued
    return null;
  }
}

const backoffMinutes = (attempts) => Math.min(2 ** attempts, 360); // 2, 4, 8 ... capped at 6 hours

export async function deliverPartnerEvents({
  store, env = process.env, fetchImpl = globalThis.fetch, now = new Date(), limit = 50, maxAttempts = 8, timeoutMs = 10000,
}) {
  const due = await store.listDuePartnerEvents(now.toISOString(), limit);
  const out = { due: due.length, delivered: 0, retrying: 0, failed: 0 };
  const partners = new Map();
  const fail = async (ev, error, final) => {
    const attempts = ev.attempts + 1;
    const dead = final || attempts >= maxAttempts;
    await store.patchPartnerEvent(ev.id, {
      attempts, last_error: error, status: dead ? 'failed' : 'pending',
      next_attempt_at: new Date(now.getTime() + backoffMinutes(attempts) * 60000).toISOString(),
    });
    if (dead) out.failed += 1; else out.retrying += 1;
  };

  for (const ev of due) {
    if (!partners.has(ev.partner_id)) partners.set(ev.partner_id, await store.getPartner(ev.partner_id));
    const partner = partners.get(ev.partner_id);
    if (!partner?.active || !partner.callback_url) { await fail(ev, 'partner inactive or has no callback url', true); continue; }
    const secret = env[partner.callback_secret_env];
    if (!secret) { await fail(ev, `env var ${partner.callback_secret_env} is not set`, false); continue; }
    let url;
    try { url = validateCallbackUrl(partner.callback_url); } catch (e) { await fail(ev, e.message, true); continue; }

    const body = JSON.stringify({ event_id: ev.event_id, type: ev.event_type, created_at: ev.created_at, data: ev.payload });
    const ts = String(Math.floor(now.getTime() / 1000));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error', // never follow a redirect to somewhere we did not validate
        signal: ctl.signal,
        headers: {
          'content-type': 'application/json', 'x-payday-event-id': ev.event_id, 'x-payday-timestamp': ts,
          'x-payday-signature': signPartnerPayload(secret, ts, body),
        },
        body,
      });
      if (res.status >= 200 && res.status < 300) {
        await store.patchPartnerEvent(ev.id, { status: 'delivered', attempts: ev.attempts + 1, delivered_at: now.toISOString(), last_error: null });
        out.delivered += 1;
      } else {
        await fail(ev, `HTTP ${res.status}`, false);
      }
    } catch (e) {
      await fail(ev, e.name === 'AbortError' ? 'timed out' : 'network error', false);
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}
