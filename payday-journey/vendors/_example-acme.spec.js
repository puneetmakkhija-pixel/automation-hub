// A COMPLETE, FICTIONAL example vendor ("acme") showing every slot and the webhook, so a real
// vendor can be added by copying this file and changing the paths. Acme does not exist; this is
// not registered by default and is used by the tests to prove the plug-in path works.

export const acme = {
  kyc: {
    configured: true,
    baseUrlEnv: 'ACME_BASE_URL',
    auth: { type: 'header', name: 'x-api-key', valueEnv: 'ACME_API_KEY' },
    request: { method: 'POST', path: '/v1/kyc', body: { mobile: '{{customer.mobile}}', ref: '{{customer.id}}' } },
    response: {
      fields: {
        status: { path: 'result.state', map: { OK: 'verified', REJECTED: 'failed', WAIT: 'pending' }, default: 'pending' },
        checks: {
          array: {
            path: 'result.checks',
            item: {
              type: 'name',
              status: { path: 'state', map: { OK: 'verified', REJECTED: 'failed', WAIT: 'pending' }, default: 'pending' },
              providerRef: 'id',
            },
          },
        },
      },
    },
  },
  bureau: {
    configured: true,
    baseUrlEnv: 'ACME_BASE_URL',
    auth: { type: 'basic', userEnv: 'ACME_USER', passEnv: 'ACME_PASS' },
    request: { method: 'POST', path: '/v1/bureau', body: { mobile: '{{customer.mobile}}', pan: '{{customer.pan}}' } },
    timeoutMs: 20000,
    response: {
      fields: {
        cibil: { path: 'score', type: 'number' },
        maxDpd12m: { path: 'dpd.max12m', type: 'number' },
        npaStatus: { path: 'flags.status', map: { CLEAN: 'none', SETTLED: 'settled', WRITTEN_OFF: 'writeoff', NPA: 'npa' } },
        activeLoans: { path: 'tradelines.active', type: 'number' },
        enquiries90d: { path: 'enquiries.d90', type: 'number' },
        bureauEmiBounces: { path: 'bounces', type: 'number' },
        ccUtilPct: { path: 'cc.utilisation', type: 'number' },
        monthlyObligations: { path: 'obligations.monthly_paise', type: 'number', divideBy: 100 },
        wilfulDefaulter: { path: 'flags.wilful', type: 'boolean' },
        writeOffMonthsAgo: { path: 'flags.writeoff_months', type: 'number' },
      },
    },
  },
  bankStatement: {
    configured: true,
    baseUrlEnv: 'ACME_BASE_URL',
    auth: { type: 'header', name: 'x-api-key', valueEnv: 'ACME_API_KEY' },
    request: { method: 'POST', path: '/v1/bank/analyse', body: { mobile: '{{customer.mobile}}' } },
    retry: { count: 2, idempotent: true },
    response: {
      fields: {
        abb: { path: 'summary.avg_balance', type: 'number' },
        creditTrendPct: { path: 'summary.credit_trend_pct', type: 'number' },
        bankBounces6m: { path: 'summary.bounces_6m', type: 'number' },
        txnPerMonth: { path: 'summary.txn_per_month', type: 'number' },
        cashDepositPct: { path: 'summary.cash_pct', type: 'number' },
        salaryCredits6m: { path: 'salary.months_credited', type: 'number' },
        salaryVariationPct: { path: 'salary.variation_pct', type: 'number' },
        salaryTrendPct: { path: 'salary.trend_pct', type: 'number' },
        observedSalary: { path: 'salary.latest', type: 'number' },
      },
    },
  },
  esign: {
    configured: true,
    baseUrlEnv: 'ACME_BASE_URL',
    auth: { type: 'header', name: 'x-api-key', valueEnv: 'ACME_API_KEY' },
    request: { method: 'POST', path: '/v1/esign', body: { ref: '{{application.id}}', mobile: '{{customer.mobile}}', amount: '{{offer.amount}}' } },
    response: {
      fields: {
        providerRef: 'envelope_id',
        status: { path: 'state', map: { SENT: 'sent', SIGNED: 'signed', FAILED: 'failed' }, default: 'pending' },
        documentUrl: 'document_url',
        kfsUrl: 'kfs_url',
      },
    },
  },
  payout: {
    configured: true,
    baseUrlEnv: 'ACME_BASE_URL',
    auth: { type: 'header', name: 'x-api-key', valueEnv: 'ACME_API_KEY' },
    // No retry: a payout must never be repeated blindly. Idempotency is by the key below.
    request: {
      method: 'POST',
      path: '/v1/payout',
      headers: { 'idempotency-key': '{{idempotencyKey}}' },
      body: { amount: '{{amount}}', account: '{{account.number}}', ifsc: '{{account.ifsc}}', name: '{{account.name}}', reference: '{{reference}}' },
    },
    response: {
      fields: {
        status: { path: 'state', map: { PAID: 'success', QUEUED: 'pending', FAILED: 'failed' }, default: 'pending' },
        utr: 'utr',
      },
    },
  },
  collect: {
    configured: true,
    baseUrlEnv: 'ACME_BASE_URL',
    auth: { type: 'header', name: 'x-api-key', valueEnv: 'ACME_API_KEY' },
    request: { method: 'POST', path: '/v1/collect', headers: { 'idempotency-key': 'collect-{{loan.id}}-{{amount}}' }, body: { amount: '{{amount}}', mobile: '{{customer.mobile}}', reference: '{{reference}}' } },
    response: {
      fields: {
        providerRef: 'collect_id',
        status: { path: 'state', map: { CREATED: 'created', QUEUED: 'pending', FAILED: 'failed' }, default: 'pending' },
        paymentUrl: 'pay_url',
      },
    },
  },
  // Inbound callbacks. HMAC-SHA256 of the raw body, hex, in the x-acme-signature header.
  webhook: {
    signature: { type: 'hmac-sha256', header: 'x-acme-signature', secretEnv: 'ACME_WEBHOOK_SECRET', encoding: 'hex' },
    eventIdPath: 'event_id',
    typePath: 'type',
    map: {
      'esign.signed': 'esign.signed',
      'esign.failed': 'esign.failed',
      'payout.paid': 'payout.success',
      'payout.failed': 'payout.failed',
      'collect.received': 'payment.received',
    },
    fields: {
      applicationId: 'data.application_ref',
      idempotencyKey: 'data.idempotency_key',
      utr: 'data.utr',
      loanId: 'data.loan_ref',
      amount: { path: 'data.amount', type: 'number' },
      mode: { path: 'data.mode', default: 'upi' },
    },
  },
};
