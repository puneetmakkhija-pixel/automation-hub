// Kept for convenience: Digitap adapters built from vendors/digitap.spec.js.
// The spec is not configured until filled in from Digitap's partner API document.
import { buildAdapter } from './http-adapter.js';
import { digitap } from './vendors/digitap.spec.js';

export { NotConfiguredError } from './errors.js';

export function createDigitapAdapters({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const deps = { env, fetchImpl };
  return {
    kyc: buildAdapter('digitap', 'kyc', digitap.kyc, deps),
    bankStatement: buildAdapter('digitap', 'bankStatement', digitap.bankStatement, deps),
  };
}
