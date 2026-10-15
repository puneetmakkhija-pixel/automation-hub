// Key Facts Statement (KFS) and the lender profile.
//
// RBI (Digital Lending) Directions, 2025 require the lender to give the borrower a KFS before the loan contract, in the
// layout of the RBI circular on Key Facts Statements (15 Apr 2024), and to show the grievance officer's contact details in it.
// This builds the KFS data from the offer, the product and the lender profile. The fields follow that circular's two parts;
// the exact wording and print layout must be confirmed by the lender's compliance officer before real use.
//
// Nothing here is invented: a lender detail that is not configured is reported in `missing`, and the KFS says
// `complete: false` so a front end can refuse to show an unfinished statement.
import { createHash } from 'node:crypto';
import { feeFor, repaymentFor, aprFor, withFeeWaiver } from '../payday-engine/index.js';
import { round2 } from './dates.js';
import { coolingOffDaysOf } from './servicing.js';

const LENDER_FIELDS = [
  ['name', 'LENDER_NAME'], ['registration', 'LENDER_REGISTRATION'], ['address', 'REGISTERED_ADDRESS'],
  ['support_email', 'SUPPORT_EMAIL'], ['support_phone', 'SUPPORT_PHONE'],
];
const GRIEVANCE_FIELDS = [['name', 'GRIEVANCE_OFFICER_NAME'], ['email', 'GRIEVANCE_OFFICER_EMAIL'], ['phone', 'GRIEVANCE_OFFICER_PHONE']];

// Who the lender is. The lender (the NBFC) is the party on the loan contract; the lending service provider (the app
// that introduces the customer) must be named too.
export function lenderProfile(env = process.env) {
  const missing = [];
  const get = (envName) => {
    const v = String(env[envName] ?? '').trim();
    if (!v) missing.push(envName);
    return v || null;
  };
  const profile = Object.fromEntries(LENDER_FIELDS.map(([k, e]) => [k, get(e)]));
  profile.grievance_officer = Object.fromEntries(GRIEVANCE_FIELDS.map(([k, e]) => [k, get(e)]));
  profile.lending_service_provider = { name: String(env.LSP_NAME ?? 'BuddyLoan').trim() || 'BuddyLoan' };
  return { ...profile, complete: missing.length === 0, missing };
}

export function buildKfs({ lender, product, application, customer = null, generatedAt = new Date().toISOString() }) {
  const p = withFeeWaiver(product, application.fee_waiver_pct);
  const amount = Number(application.approved_amount);
  if (!(amount > 0)) throw new Error('KFS needs an approved amount');
  const tenure = Number(p.tenure_days);
  const fee = feeFor(p, amount);
  const feeBefore = Number(application.fee_waiver_pct) > 0 ? feeFor(product, amount) : null;
  const repay = repaymentFor(p, amount);
  const apr = aprFor(p, amount, tenure);
  const penalty = Number(product.penalty_per_day_pct);
  const kfs = {
    version: 1,
    generated_at: generatedAt,
    application_id: application.id,
    complete: lender.complete,
    missing: lender.missing,
    lender: { name: lender.name, registration: lender.registration, address: lender.address },
    lending_service_provider: lender.lending_service_provider,
    // Part 1: the numbers
    part1: {
      loan_type: 'Short-term personal loan, single repayment',
      sanctioned_amount: amount,
      disbursal: 'In one payment, into the borrower\'s own bank account',
      loan_term_days: tenure,
      instalments: [{ number: 1, due: `${tenure} days after the loan is paid out`, amount: repay }],
      interest_rate_pct: 0,
      interest_note: 'No interest. The cost of the loan is the fee below.',
      fees_payable_to_lender: [{ name: 'Loan fee', amount: fee, ...(feeBefore !== null ? { before_waiver: feeBefore, waiver_pct: Number(application.fee_waiver_pct) } : {}) }],
      fees_payable_to_third_parties: [],
      total_to_repay: repay,
      apr_pct: apr.aprEffectivePct,
      apr_note: 'Annual percentage rate on all charges, compounded. The simple yearly rate is shown for comparison.',
      apr_simple_pct: apr.aprSimplePct,
      contingent_charges: [
        { name: 'Late payment charge', basis: `${penalty}% of the overdue principal for each day it is overdue` },
        { name: 'Foreclosure or early repayment', basis: 'No charge. You may repay early at any time.' },
      ],
    },
    // Part 2: the plain information
    part2: {
      cooling_off: {
        days: coolingOffDaysOf(product),
        terms: 'You may exit the loan during this period by repaying the principal and the fee for the days you held the money. No penalty applies.',
      },
      recovery_agents: 'Recovery agents, if any, are engaged only through the lender and its written policy. Ask the lender for the agent\'s name.',
      transfer_of_loan: 'The lender may assign the loan to another regulated entity. You will be told.',
      grievance_officer: lender.grievance_officer,
      data_and_consent: 'Your data is collected only with your explicit consent, for the stated purpose, with a record of when you gave it.',
    },
  };
  // A fingerprint of exactly what the borrower was shown, so it can be proved later.
  kfs.sha256 = createHash('sha256').update(JSON.stringify({ ...kfs, generated_at: undefined })).digest('hex');
  return kfs;
}

export const kfsTotals = (kfs) => ({ amount: kfs.part1.sanctioned_amount, fee: round2(kfs.part1.fees_payable_to_lender.reduce((a, f) => a + f.amount, 0)), repay: kfs.part1.total_to_repay });
