// Turn vendor results + what the customer told us into the feature object payday-engine scores.
// null means "not available": the engine scores absence below the midpoint and never treats it as good.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function buildFeatures({ intake = {}, kyc = null, bureau = null, bank = null }) {
  const b = bureau || {};
  const k = bank || {};

  // Salary used for offer sizing is the LOWER of declared and observed, so an inflated
  // declaration cannot raise the offer.
  const declared = num(intake.declaredSalary);
  const observed = num(k.observedSalary);
  const salaries = [declared, observed].filter((x) => x !== null && x > 0);
  const netSalary = salaries.length ? Math.min(...salaries) : null;

  const salaryMatchVariancePct = declared && observed
    ? (Math.abs(declared - observed) / declared) * 100 : null;

  // FOIR = existing monthly obligations (from bureau) / net salary. The new payday loan is a
  // single bullet repayment, so it is not added to monthly obligations.
  const foirPct = num(b.monthlyObligations) !== null && netSalary
    ? (b.monthlyObligations / netSalary) * 100 : null;

  return {
    // bureau
    cibil: num(b.cibil), maxDpd12m: num(b.maxDpd12m), npaStatus: b.npaStatus ?? null,
    activeLoans: num(b.activeLoans), enquiries90d: num(b.enquiries90d),
    bureauEmiBounces: num(b.bureauEmiBounces), ccUtilPct: num(b.ccUtilPct),
    wilfulDefaulter: b.wilfulDefaulter ?? null, writeOffMonthsAgo: num(b.writeOffMonthsAgo),
    // banking
    abb: num(k.abb), creditTrendPct: num(k.creditTrendPct), bankBounces6m: num(k.bankBounces6m),
    txnPerMonth: num(k.txnPerMonth), cashDepositPct: num(k.cashDepositPct),
    // salary
    netSalary, salaryCredits6m: num(k.salaryCredits6m), salaryVariationPct: num(k.salaryVariationPct),
    salaryTrendPct: num(k.salaryTrendPct), salaryMatchVariancePct,
    // profile (from intake)
    tenureMonths: num(intake.tenureMonths), employerCategory: intake.employerCategory ?? null,
    residence: intake.residence ?? null, purposeClarity: intake.purposeClarity ?? null,
    referencesVerified: intake.referencesVerified ?? null, foirPct,
    // hard-decline inputs
    kycFailed: kyc ? kyc.status === 'failed' : null,
    fraudFlag: intake.fraudFlag ?? null,
  };
}
