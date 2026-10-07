// Normalised shapes every vendor adapter must return, whatever the vendor's own payload looks like.
// The registry wraps each adapter with these checks so vendor drift fails loudly at the boundary
// instead of silently turning into a wrong score.

const isNum = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isBool = (v) => v === null || typeof v === 'boolean';

function need(cond, msg) {
  if (!cond) throw new Error(`adapter contract: ${msg}`);
}

export const KYC_STATUSES = ['verified', 'failed', 'pending'];

// kyc.verify({ customer }) -> { status, checks: [{ type, status, providerRef, raw }] }
export function assertKyc(r) {
  need(r && KYC_STATUSES.includes(r.status), `kyc.status must be one of ${KYC_STATUSES}`);
  need(Array.isArray(r.checks), 'kyc.checks must be an array');
  r.checks.forEach((c) => {
    need(typeof c.type === 'string' && c.type, 'kyc check needs a type');
    need(['verified', 'failed', 'pending', 'in_progress'].includes(c.status), 'kyc check status invalid');
  });
  return r;
}

// bureau.pull({ customer }) -> normalised bureau fields; null means "not available"
const BUREAU_NUM = ['cibil', 'maxDpd12m', 'activeLoans', 'enquiries90d', 'bureauEmiBounces', 'ccUtilPct', 'monthlyObligations', 'writeOffMonthsAgo'];
export function assertBureau(r) {
  need(r && typeof r === 'object', 'bureau result must be an object');
  BUREAU_NUM.forEach((k) => need(isNum(r[k] ?? null), `bureau.${k} must be a number or null`));
  need([null, 'none', 'settled', 'writeoff', 'npa'].includes(r.npaStatus ?? null), 'bureau.npaStatus invalid');
  need(isBool(r.wilfulDefaulter ?? null), 'bureau.wilfulDefaulter must be boolean or null');
  return r;
}

// bankStatement.analyse({ customer }) -> normalised bank/salary metrics
const BANK_NUM = ['abb', 'creditTrendPct', 'bankBounces6m', 'txnPerMonth', 'cashDepositPct',
  'salaryCredits6m', 'salaryVariationPct', 'salaryTrendPct', 'observedSalary'];
export function assertBank(r) {
  need(r && typeof r === 'object', 'bank result must be an object');
  BANK_NUM.forEach((k) => need(isNum(r[k] ?? null), `bank.${k} must be a number or null`));
  return r;
}

// esign.createRequest({ application, offer }) -> { providerRef, status }
export function assertEsign(r) {
  need(r && typeof r.providerRef === 'string' && r.providerRef, 'esign.providerRef required');
  need(['sent', 'signed', 'failed', 'pending'].includes(r.status), 'esign.status invalid');
  return r;
}

// payout.disburse({ loanId, amount, account }) -> { utr, status }
export function assertPayout(r) {
  need(r && ['success', 'pending', 'failed'].includes(r.status), 'payout.status invalid');
  need(r.status !== 'success' || (typeof r.utr === 'string' && r.utr), 'a successful payout needs a utr');
  return r;
}
