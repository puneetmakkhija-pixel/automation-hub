// Consent records. A consent is a row per purpose with the wording version the customer agreed to, the channel
// and any evidence (OTP reference, IP, a partner-supplied timestamp). Revoking marks the rows; it never deletes.
import { ValidationError } from './errors.js';

export const CONSENT_PURPOSES = ['kyc', 'credit_bureau', 'bank_data', 'terms', 'communication', 'data_sharing'];
export const CONSENT_CHANNELS = ['app', 'web', 'partner', 'ivr', 'whatsapp', 'branch'];
// Needed before any vendor pull or decision. Bank-data consent is added by the caller when a bank pull is used.
export const REQUIRED_CONSENTS = ['kyc', 'credit_bureau', 'terms'];

export async function recordConsents({ store, customerId, purposes, textVersion, channel, evidence = null, grantedAt = undefined }) {
  const errs = [];
  if (!Array.isArray(purposes) || !purposes.length) errs.push('purposes must be a non-empty list');
  else for (const p of purposes) if (!CONSENT_PURPOSES.includes(p)) errs.push(`unknown purpose "${p}"`);
  if (typeof textVersion !== 'string' || !/^[\w.-]{1,40}$/.test(textVersion)) errs.push('textVersion must be 1-40 letters, digits, _ . -');
  if (!CONSENT_CHANNELS.includes(channel)) errs.push(`channel must be one of ${CONSENT_CHANNELS.join(', ')}`);
  if (evidence !== null && (typeof evidence !== 'object' || Array.isArray(evidence) || JSON.stringify(evidence).length > 4000)) errs.push('evidence must be an object under 4 KB');
  if (errs.length) throw new ValidationError('invalid consent', errs);
  const rows = [...new Set(purposes)].map((purpose) => ({
    customer_id: customerId, purpose, text_version: textVersion, channel, evidence, ...(grantedAt ? { granted_at: grantedAt } : {}),
  }));
  await store.insertConsents(rows);
  return { recorded: rows.map((r) => r.purpose) };
}

export async function missingConsents({ store, customerId, required = REQUIRED_CONSENTS }) {
  const active = new Set((await store.getActiveConsents(customerId)).map((c) => c.purpose));
  return required.filter((p) => !active.has(p));
}

export async function revokeConsent({ store, customerId, purpose, at = new Date().toISOString() }) {
  if (!CONSENT_PURPOSES.includes(purpose)) throw new ValidationError('invalid consent', [`unknown purpose "${purpose}"`]);
  return { revoked: await store.revokeConsent(customerId, purpose, at) };
}
