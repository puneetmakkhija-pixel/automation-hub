// Inbound vendor webhooks (e-sign result, payout result, payment received), driven by the vendor's
// `webhook` spec so a new vendor needs no code. Every event is:
//   1. signature-checked (HMAC) against a secret from env: no secret configured means REFUSED, never accepted
//   2. recorded once per (provider, event_id); a replay of a processed event is acknowledged and ignored
//   3. mapped to a normalised event and applied through the same functions the API uses
// If applying fails, the event stays unprocessed and we answer 500 so the vendor retries.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPath, extract } from './mapping.js';
import { recordAgreementSigned, failAgreement, completeDisbursement } from './originate.js';
import { recordPayment } from './servicing.js';

export function verifySignature({ rawBody, headers, signature, env }) {
  if (!signature) return { ok: false, reason: 'no signature rule in the vendor spec' };
  const secret = env[signature.secretEnv];
  if (!secret) return { ok: false, reason: `${signature.secretEnv} is not set` };
  const given = headers[String(signature.header).toLowerCase()];
  if (!given) return { ok: false, reason: 'signature header missing' };
  const want = createHmac('sha256', secret).update(rawBody).digest(signature.encoding || 'hex');
  const got = signature.prefix && given.startsWith(signature.prefix) ? given.slice(signature.prefix.length) : given;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return { ok: a.length === b.length && timingSafeEqual(a, b), reason: 'signature mismatch' };
}

function need(fields, ...names) {
  for (const n of names) {
    if (fields[n] === null || fields[n] === undefined || fields[n] === '') {
      const e = new Error(`webhook missing field "${n}"`);
      e.bad = true;
      throw e;
    }
  }
}

async function apply({ store, event, f, now }) {
  switch (event) {
    case 'esign.signed':
      need(f, 'applicationId');
      return recordAgreementSigned({ store, applicationId: f.applicationId, signedAt: now });
    case 'esign.failed':
      need(f, 'applicationId');
      return failAgreement({ store, applicationId: f.applicationId });
    case 'payout.success':
    case 'payout.failed': {
      need(f, 'idempotencyKey');
      const d = await store.findDisbursementByKey(f.idempotencyKey);
      if (!d) { const e = new Error('unknown disbursement'); e.bad = true; throw e; }
      if (event === 'payout.success') need(f, 'utr');
      return completeDisbursement({ store, disbursementId: d.id, result: { status: event === 'payout.success' ? 'success' : 'failed', utr: f.utr } });
    }
    case 'payment.received': {
      need(f, 'loanId', 'amount');
      const loan = await store.getLoan(f.loanId);
      if (!loan) { const e = new Error('unknown loan'); e.bad = true; throw e; }
      const product = await store.getProduct(loan.product_id);
      return recordPayment({ store, loan, product, amount: f.amount, mode: f.mode || 'upi', utr: f.utr || null, paidAt: now });
    }
    default: {
      const e = new Error(`unhandled event ${event}`);
      e.bad = true;
      throw e;
    }
  }
}

export function createWebhookHandler({ store, registry, env = process.env, nowFn = () => new Date().toISOString() }) {
  return async function handle({ provider, rawBody, headers = {} }) {
    const spec = registry.specs?.[provider]?.webhook;
    if (!spec) return { status: 404, body: { error: 'unknown provider' } };

    const sig = verifySignature({ rawBody, headers, signature: spec.signature, env });
    if (!sig.ok) return { status: sig.reason.endsWith('is not set') ? 503 : 401, body: { error: sig.reason } };

    let payload;
    try { payload = JSON.parse(rawBody); } catch { return { status: 400, body: { error: 'invalid JSON' } }; }
    const eventId = getPath(payload, spec.eventIdPath);
    if (eventId === undefined || eventId === null) return { status: 400, body: { error: 'event id missing' } };
    const vendorType = getPath(payload, spec.typePath);
    const event = spec.map?.[vendorType] ?? null;

    const rec = await store.recordVendorEvent({ provider, event_id: String(eventId), event_type: event || String(vendorType), payload });
    if (!rec.isNew && rec.processed) return { status: 200, body: { duplicate: true } };
    if (!event) {
      await store.markVendorEventProcessed(provider, String(eventId));
      return { status: 200, body: { ignored: true } };
    }

    try {
      await apply({ store, event, f: extract(spec.fields, payload), now: nowFn() });
      await store.markVendorEventProcessed(provider, String(eventId));
      return { status: 200, body: { ok: true, event } };
    } catch (e) {
      // A malformed event is not retryable (400); anything else is (500), and stays unprocessed.
      return { status: e.bad ? 400 : 500, body: { error: e.message } };
    }
  };
}
