// runUnderwriting: onboarding checks -> enrichment -> decision -> persist.
// Stops at the decision. Agreement (e-sign) and disbursement (payout) come after an accepted offer.
import { decide, toScorecardRow, toApplicationPatch } from '../payday-engine/index.js';
import { buildFeatures } from './features.js';
import { emitPartnerEvent } from './partners.js';

const kycRows = (customer, vendor, kyc) => kyc.checks.map((c) => ({
  customer_id: customer.id,
  check_type: c.type,
  provider: vendor,
  status: c.status,
  provider_ref: c.providerRef ?? null,
  response: c.raw ?? null,
}));

export async function runUnderwriting({
  registry, store, customer, application, product, intake = {}, customerLimit = null, reuseKyc = false, policy = undefined,
}) {
  // 1. KYC first: do not spend on bureau or bank-statement pulls for someone who failed it.
  //    A repeat customer already verified may reuse that KYC (reuseKyc), skipping the vendor call.
  let kyc;
  if (reuseKyc && customer.kyc_status === 'verified') {
    kyc = { status: 'verified', checks: [] };
  } else {
    kyc = await registry.kyc.verify({ customer });
    await store.saveKycChecks(kycRows(customer, registry.names.kyc, kyc));
  }

  if (kyc.status === 'pending') {
    await store.patchApplication(application.id, { status: 'kyc_pending' });
    return { stage: 'kyc_pending', kyc };
  }

  // 2. Enrichment in parallel. A vendor failure is recorded and treated as missing data;
  //    it never crashes the decision and never counts in the customer's favour.
  const vendorErrors = [];
  let bureau = null;
  let bank = null;
  if (kyc.status === 'verified') {
    const [b, k] = await Promise.allSettled([
      registry.bureau.pull({ customer }),
      registry.bankStatement.analyse({ customer }),
    ]);
    if (b.status === 'fulfilled') {
      bureau = b.value;
      await store.saveEnrichment({ customer_id: customer.id, source: 'bureau', provider: registry.names.bureau, payload: bureau });
    } else vendorErrors.push(`bureau: ${b.reason.message}`);
    if (k.status === 'fulfilled') {
      bank = k.value;
      await store.saveEnrichment({ customer_id: customer.id, source: 'bank_statement', provider: registry.names.bankStatement, payload: bank });
    } else vendorErrors.push(`bank statement: ${k.reason.message}`);
  }

  // 3. Decide.
  const features = buildFeatures({ intake, kyc, bureau, bank });
  const result = decide({
    features, product, requestedAmount: application.requested_amount, customerLimit, ...(policy ? { policy } : {}),
  });
  if (vendorErrors.length) result.reasons.push(...vendorErrors.map((e) => `Vendor unavailable: ${e}`));

  // 4. Persist.
  await store.saveScorecard(toScorecardRow(application.id, result));
  await store.patchApplication(application.id, toApplicationPatch(result));
  // Partners hear the outcome and the offer, not the scoring detail.
  await emitPartnerEvent({
    store, applicationId: application.id, type: 'application.decided',
    data: {
      decision: result.decision,
      offer: result.offer ? {
        amount: result.offer.amount, fee: result.offer.feeAmount, repayment: result.offer.repaymentAmount,
        tenure_days: result.offer.tenureDays, apr_effective_pct: result.offer.aprEffectivePct, apr_simple_pct: result.offer.aprSimplePct,
      } : null,
    },
  });

  return { stage: 'decided', result, vendorErrors, kyc };
}
