// Creating an application: product, amount and eligibility checks. Throws ApplicationError with a code
// the API maps to an HTTP status.
import { repeatEligibility } from './limits.js';
import { missingConsents } from './consent.js';

export class ApplicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
  }
}

// requiredConsents: purposes that must already be on record (see consent.js REQUIRED_CONSENTS); the library default
// is none so it stays usable on its own, and payday-api turns it on. partnerId records which partner sent the application.
export async function createApplication({
  store, customer, product, requestedAmount, requiredConsents = [], partnerId = null,
}) {
  if (!product || product.active === false) throw new ApplicationError('PRODUCT_INACTIVE', 'product is not available');
  const amt = Number(requestedAmount);
  if (!(amt >= Number(product.min_amount) && amt <= Number(product.max_amount))) {
    throw new ApplicationError('AMOUNT_OUT_OF_RANGE', `amount must be between ${product.min_amount} and ${product.max_amount}`);
  }
  if (requiredConsents.length) {
    const missing = await missingConsents({ store, customerId: customer.id, required: requiredConsents });
    if (missing.length) throw new ApplicationError('CONSENT_REQUIRED', `consent not recorded for: ${missing.join(', ')}`);
  }
  const elig = await repeatEligibility({ store, customer, product });
  if (!elig.eligible) throw new ApplicationError(elig.code, elig.reason);
  const application = await store.insertApplication({
    customer_id: customer.id, product_id: product.id, requested_amount: amt, is_repeat: elig.isRepeat,
    ...(partnerId ? { partner_id: partnerId } : {}),
  });
  return { application, customerLimit: elig.limit, isRepeat: elig.isRepeat };
}
