// Agreement -> disbursement. Money-moving code, so it is defensive:
//  * payout is keyed by an idempotency key, so a retry cannot pay twice
//  * a payout whose outcome is UNKNOWN (timeout / network error) is left 'pending', never marked failed,
//    because the money may have moved; the vendor webhook or a status check settles it
//  * the loan row is created BEFORE the payout, and the database allows only one open loan per customer
import { BusinessRuleError } from './errors.js';
import { feeFor, repaymentFor, aprFor } from '../payday-engine/index.js';
import { emitPartnerEvent } from './partners.js';
import {
  istToday, addDays, nextSalaryDate, splitAmount, daysBetween,
} from './dates.js';

export async function sendAgreement({ registry, store, customer, application }) {
  const app = await store.getApplication(application.id);
  if (!app) throw new BusinessRuleError('application not found');
  // Idempotent: a repeated request returns the agreement already sent, whatever the status has moved on to.
  const existing = await store.getAgreementByApplication(app.id);
  if (existing) return { agreement: existing, reused: true };
  if (app.status !== 'offered') {
    throw new BusinessRuleError(`cannot send agreement: application status is "${app.status}", expected "offered"`);
  }

  // The key fact statement needs the amount, fee, repayment, tenure and APR: pass them all to the e-sign vendor.
  const product = await store.getProduct(app.product_id);
  const amount = Number(app.approved_amount);
  const offer = product ? {
    amount, fee: feeFor(product, amount), repayment: repaymentFor(product, amount), tenureDays: Number(product.tenure_days),
    ...aprFor(product, amount, Number(product.tenure_days)),
  } : { amount };
  const r = await registry.esign.createRequest({ application: app, customer, offer });
  const agreement = await store.saveAgreement({
    application_id: app.id,
    kfs_url: r.kfsUrl ?? null,
    document_url: r.documentUrl ?? null,
    esign_provider: registry.names.esign,
    provider_ref: r.providerRef,
    esign_status: r.status === 'pending' ? 'sent' : r.status,
  });
  await store.patchApplication(app.id, { status: 'agreement_sent' });
  if (r.status === 'signed') await recordAgreementSigned({ store, applicationId: app.id });
  return { agreement, reused: false };
}

export async function recordAgreementSigned({ store, applicationId, signedAt = new Date().toISOString() }) {
  const agreement = await store.getAgreementByApplication(applicationId);
  if (!agreement) throw new BusinessRuleError(`no agreement for application ${applicationId}`);
  if (agreement.esign_status === 'signed') return { agreement, alreadySigned: true };
  const updated = await store.patchAgreementByApplication(applicationId, { esign_status: 'signed', signed_at: signedAt });
  const app = await store.getApplication(applicationId);
  if (app && app.status === 'agreement_sent') await store.patchApplication(applicationId, { status: 'signed' });
  await emitPartnerEvent({ store, applicationId, type: 'agreement.signed' });
  return { agreement: updated, alreadySigned: false };
}

export async function failAgreement({ store, applicationId }) {
  const agreement = await store.getAgreementByApplication(applicationId);
  if (!agreement) throw new BusinessRuleError(`no agreement for application ${applicationId}`);
  if (agreement.esign_status === 'signed') return { agreement, ignored: true }; // a signed agreement is never un-signed
  return { agreement: await store.patchAgreementByApplication(applicationId, { esign_status: 'failed' }), ignored: false };
}

// Co-lender split for a product on a date; own book (100%) when none is configured.
export async function resolveShares(store, product, onDate) {
  let shares = await store.getColendingShares(product.id, onDate);
  if (!shares.length) {
    const own = await store.getOwnBookLender();
    if (!own) throw new BusinessRuleError('no co-lending arrangement for this product and no OWN_BOOK lender row (migration 004 seeds it)');
    shares = [{ lender_id: own.id, share_pct: 100 }];
  }
  const total = shares.reduce((a, s) => a + Number(s.share_pct), 0);
  if (Math.abs(total - 100) > 0.01) throw new BusinessRuleError(`co-lending shares for ${product.code} add to ${total}, expected 100`);
  return shares;
}

// Due date: product tenure by default. With snapToSalaryDay, the first salary date at least
// `minDays` out, but never later than the product tenure allows.
export function dueDateFor({ asOf, product, salaryDay = null, snapToSalaryDay = false, minDays = 7 }) {
  const latest = addDays(asOf, product.tenure_days);
  if (!snapToSalaryDay || !salaryDay) return latest;
  const salary = nextSalaryDate(asOf, salaryDay, minDays);
  return salary < latest ? salary : latest;
}

export async function disburseLoan({
  registry, store, customer, application, product, account, asOf = istToday(), snapToSalaryDay = false, attempt = 1,
}) {
  const app = await store.getApplication(application.id);
  if (!app) throw new BusinessRuleError('application not found');
  let loan = await store.getLoanByApplication(app.id);
  if (loan?.disbursed_at) return { status: 'already_disbursed', loan };
  if (app.status !== 'signed') throw new BusinessRuleError(`cannot disburse: application status is "${app.status}", expected "signed"`);
  if (!loan && (await store.hasOpenLoan(customer.id))) throw new BusinessRuleError('customer already has an open loan');
  const principal = Number(app.approved_amount);
  if (!(principal > 0)) throw new BusinessRuleError('application has no approved amount');
  if (!account?.number || !account?.ifsc || !account?.name) throw new BusinessRuleError('payout account needs name, number and ifsc');

  if (!loan) {
    const shares = await resolveShares(store, product, asOf);
    const fee = feeFor(product, principal);
    const due = dueDateFor({ asOf, product, salaryDay: customer.salary_day, snapToSalaryDay });
    const cycle = (await store.countLoans(customer.id)) + 1;
    loan = await store.insertLoan({
      application_id: app.id, customer_id: customer.id, product_id: product.id,
      cycle_number: cycle, principal, fee_amount: fee, due_date: due,
      // APR on the ACTUAL number of days to the due date (it differs from the product tenure when snapped to a salary day)
      apr_pct: aprFor(product, principal, daysBetween(asOf, due)).aprEffectivePct,
    });
    await store.insertLoanLenderShares(splitAmount(principal, shares).map((p, i) => ({
      loan_id: loan.id, lender_id: p.lender_id, share_pct: shares[i].share_pct, principal_share: p.amount,
    })));
    await store.insertSchedule({ loan_id: loan.id, installment_no: 1, due_date: due, principal_due: principal, fee_due: fee });
  }

  const key = `disb-${loan.id}-${attempt}`;
  let disbursement = await store.findDisbursementByKey(key);
  if (!disbursement) {
    disbursement = await store.insertDisbursement({
      loan_id: loan.id, lender_id: null, amount: principal, provider: registry.names.payout,
      status: 'pending', idempotency_key: key,
    });
  }

  let result;
  try {
    result = await registry.payout.disburse({
      loanId: loan.id, amount: principal, account, idempotencyKey: key, reference: app.id,
    });
  } catch (e) {
    // Outcome unknown. Do NOT mark failed: money may have moved.
    return { status: 'unknown', loan, disbursement, error: e.message };
  }
  return completeDisbursement({ store, disbursementId: disbursement.id, result });
}

// Settles a disbursement from the payout call or a vendor webhook. Safe to call more than once.
export async function completeDisbursement({ store, disbursementId, result }) {
  const d = await store.getDisbursement(disbursementId);
  if (!d) throw new BusinessRuleError(`disbursement ${disbursementId} not found`);
  if (d.status === 'success') return { status: 'success', alreadyDone: true, disbursement: d, loan: await store.getLoan(d.loan_id) };
  if (result.status === 'pending') return { status: 'pending', disbursement: d, loan: await store.getLoan(d.loan_id) };
  if (result.status === 'failed') {
    return { status: 'failed', disbursement: await store.patchDisbursement(d.id, { status: 'failed' }), loan: await store.getLoan(d.loan_id) };
  }

  // success (also overrides an earlier 'failed': if the vendor says it paid, the money moved)
  const disbursement = await store.patchDisbursement(d.id, { status: 'success', utr: result.utr });
  let loan = await store.getLoan(d.loan_id);
  if (!loan.disbursed_at) {
    loan = await store.patchLoan(loan.id, { disbursed_at: new Date().toISOString() });
    const shares = await store.getLoanShares(loan.id);
    const fees = splitAmount(Number(loan.fee_amount), shares);
    await store.insertLedger([
      ...shares.map((s) => ({
        loan_id: loan.id, lender_id: s.lender_id, entry_type: 'disbursal', direction: 'debit',
        amount: Number(s.principal_share), ref_table: 'disbursement', ref_id: d.id,
      })),
      ...fees.filter((f) => f.amount > 0).map((f) => ({
        loan_id: loan.id, lender_id: f.lender_id, entry_type: 'fee', direction: 'debit',
        amount: f.amount, ref_table: 'loan', ref_id: loan.id,
      })),
    ]);
    await store.patchApplication(loan.application_id, { status: 'disbursed' });
    await emitPartnerEvent({
      store, applicationId: loan.application_id, type: 'loan.disbursed',
      data: { loan_id: loan.id, amount: Number(loan.principal), fee: Number(loan.fee_amount), due_date: loan.due_date, apr_pct: loan.apr_pct ?? null },
    });
    if (loan.cycle_number === 1 && !(await store.getCurrentLimit(loan.customer_id))) {
      await store.insertCustomerLimit({
        customer_id: loan.customer_id, limit_amount: Number(loan.principal), cycle_number: 1,
        reason: 'first_loan', created_by: 'system',
      });
    }
  }
  return { status: 'success', disbursement, loan };
}

// Settle payouts left 'pending' (unknown outcome, or the vendor webhook never arrived) by asking the vendor
// what happened. Needs the payout vendor to have a status check. Safe to run repeatedly (e.g. every 10 minutes).
// A lookup that errors (including a vendor "not found") is reported and left pending for a person to decide.
export async function reconcilePendingPayouts({ registry, store, olderThanMinutes = 15, now = new Date() }) {
  if (typeof registry.payout.status !== 'function') {
    throw new BusinessRuleError('the payout vendor has no status check configured (add a `status` block to its spec)');
  }
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60000).toISOString();
  const pending = await store.listPendingDisbursements(cutoff);
  const out = { checked: pending.length, settled: 0, failed: 0, stillPending: 0, errors: [] };
  for (const d of pending) {
    try {
      const r = await registry.payout.status({ idempotencyKey: d.idempotency_key, loanId: d.loan_id });
      if (r.status === 'pending') { out.stillPending += 1; continue; }
      await completeDisbursement({ store, disbursementId: d.id, result: r });
      if (r.status === 'success') out.settled += 1; else out.failed += 1;
    } catch (e) {
      out.errors.push(`${d.id}: ${e.message}`);
    }
  }
  return out;
}
