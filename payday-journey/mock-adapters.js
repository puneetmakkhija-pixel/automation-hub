// Deterministic mock vendors for development and tests. NEVER used for real loans:
// the registry refuses mock vendors when NODE_ENV=production unless explicitly allowed.
//
// Scenario is picked by the LAST DIGIT of the customer's mobile number:
//   9 -> KYC fails          8 -> bureau shows an NPA        7 -> thin file (no bureau, no bank data)
//   0-6 -> clean customer; CIBIL = 700 + 8 * digit

const digit = (customer) => Number(String(customer.mobile).slice(-1));

export const mockKyc = {
  name: 'mock',
  async verify({ customer }) {
    const failed = digit(customer) === 9;
    const status = failed ? 'failed' : 'verified';
    return {
      status,
      checks: ['pan', 'aadhaar_otp', 'liveness'].map((type) => ({
        type,
        status: failed && type === 'liveness' ? 'failed' : 'verified',
        providerRef: `mock-${type}-${customer.mobile}`,
        raw: { mock: true },
      })),
    };
  },
};

export const mockBureau = {
  name: 'mock',
  async pull({ customer }) {
    const d = digit(customer);
    if (d === 7) {
      return { cibil: null, maxDpd12m: null, npaStatus: null, activeLoans: null, enquiries90d: null,
        bureauEmiBounces: null, ccUtilPct: null, monthlyObligations: null, wilfulDefaulter: null, raw: { mock: true } };
    }
    return {
      cibil: d === 8 ? 600 : 700 + 8 * d,
      maxDpd12m: 0,
      npaStatus: d === 8 ? 'npa' : 'none',
      activeLoans: 2, enquiries90d: 1, bureauEmiBounces: 0, ccUtilPct: 25,
      monthlyObligations: 3000, wilfulDefaulter: false, writeOffMonthsAgo: null,
      raw: { mock: true },
    };
  },
};

export const mockBankStatement = {
  name: 'mock',
  async analyse({ customer }) {
    if (digit(customer) === 7) {
      return { abb: null, creditTrendPct: null, bankBounces6m: null, txnPerMonth: null, cashDepositPct: null,
        salaryCredits6m: null, salaryVariationPct: null, salaryTrendPct: null, observedSalary: null, raw: { mock: true } };
    }
    return {
      abb: 22000, creditTrendPct: 4, bankBounces6m: 0, txnPerMonth: 28, cashDepositPct: 5,
      salaryCredits6m: 6, salaryVariationPct: 3, salaryTrendPct: 2, observedSalary: 40000,
      raw: { mock: true },
    };
  },
};

export const mockEsign = {
  name: 'mock',
  async createRequest({ application }) {
    return { providerRef: `mock-esign-${application.id}`, status: 'sent' };
  },
};

export const mockPayout = {
  name: 'mock',
  async disburse({ loanId, amount }) {
    return { utr: `MOCKUTR${String(loanId).slice(0, 8)}${amount}`, status: 'success' };
  },
};
