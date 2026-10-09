// Digitap. NOT CONFIGURED: their API reference is partner-only, so nothing below is guessed.
//
// To switch it on, from Digitap's partner API document:
//   1. set baseUrlEnv / auth to match their authentication scheme,
//   2. set request.path and request.body (use {{customer.mobile}} etc. placeholders),
//   3. fill response.fields so each normalised field points at the right place in their response,
//   4. change `configured` to true,
//   5. set the env vars on the host and VENDOR_KYC=digitap / VENDOR_BANK_STATEMENT=digitap.
// _example-acme.spec.js shows a complete, filled-in spec of the same shape.
//
// Digitap's site lists Digital KYC / Video KYC, bank-statement and alternate-data scoring, and an
// Account Aggregator module. It lists no bureau pull, e-sign or payout, so those slots are absent.

export const digitap = {
  kyc: {
    configured: false,
    baseUrlEnv: 'DIGITAP_BASE_URL',
    auth: { type: 'none' }, // replace with Digitap's scheme, e.g. { type: 'header', name: ..., valueEnv: 'DIGITAP_CLIENT_SECRET' }
    request: { method: 'POST', path: '', body: {} },
    response: { fields: {} },
  },
  bankStatement: {
    configured: false,
    baseUrlEnv: 'DIGITAP_BASE_URL',
    auth: { type: 'none' },
    request: { method: 'POST', path: '', body: {} },
    response: { fields: {} },
  },
  // Webhook (optional): fill in if Digitap calls back asynchronously. See _example-acme.spec.js.
  webhook: null,
};
