// Digitap slots. NOT WIRED YET, deliberately.
//
// Digitap's website lists three things that map onto this journey:
//   - Onboarding Suite (Digital KYC, document OCR/validation, Video KYC)  -> kyc slot
//   - Alternate Data Suite (bank statements, device, e-commerce, telecom)  -> bankStatement slot
//   - Account Aggregator TSP module                                        -> alternative bankStatement source
// Their API reference is not public, so the endpoint paths, authentication scheme and response
// fields below are unknown to us. Nothing is guessed: each slot throws NotConfiguredError until
// the three marked values are filled in from Digitap's partner API document.
//
// Digitap does not list a credit-bureau pull, e-sign or payout, so those slots have no Digitap
// adapter; they need another vendor or Digitap confirming they offer them.

export class NotConfiguredError extends Error {
  constructor(slot, what) {
    super(`Digitap ${slot}: ${what} is not configured. Fill it in payday-journey/digitap-adapter.js from Digitap's API document.`);
    this.name = 'NotConfiguredError';
  }
}

// FILL IN from Digitap's partner API document:
export const DIGITAP = {
  // 1. Base URL and how to authenticate (header name / token scheme). Credentials come from env,
  //    never from the repo: DIGITAP_BASE_URL, DIGITAP_CLIENT_ID, DIGITAP_CLIENT_SECRET.
  authHeaders: null, // (env) => ({ ...headers })  e.g. whatever Digitap specifies
  // 2. Endpoint path per operation.
  endpoints: { kyc: null, bankStatement: null },
  // 3. Map Digitap's response onto the normalised shapes in contracts.js.
  normalize: { kyc: null, bankStatement: null },
};

async function call(slot, payload, { env, fetchImpl }) {
  const base = env.DIGITAP_BASE_URL;
  if (!base) throw new NotConfiguredError(slot, 'DIGITAP_BASE_URL');
  if (!DIGITAP.authHeaders) throw new NotConfiguredError(slot, 'authHeaders');
  if (!DIGITAP.endpoints[slot]) throw new NotConfiguredError(slot, 'endpoint path');
  if (!DIGITAP.normalize[slot]) throw new NotConfiguredError(slot, 'response mapping');
  const res = await fetchImpl(`${base}${DIGITAP.endpoints[slot]}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...DIGITAP.authHeaders(env) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Digitap ${slot} failed: HTTP ${res.status}`);
  return DIGITAP.normalize[slot](await res.json());
}

export function createDigitapAdapters({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return {
    kyc: { name: 'digitap', verify: ({ customer }) => call('kyc', { customer }, { env, fetchImpl }) },
    bankStatement: { name: 'digitap', analyse: ({ customer }) => call('bankStatement', { customer }, { env, fetchImpl }) },
  };
}
