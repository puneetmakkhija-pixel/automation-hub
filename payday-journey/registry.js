// Picks one adapter per slot from env, and checks every adapter's output against contracts.js.
//   VENDOR_KYC=mock|digitap   VENDOR_BUREAU=mock   VENDOR_BANK_STATEMENT=mock|digitap
//   VENDOR_ESIGN=mock         VENDOR_PAYOUT=mock
// Default is mock everywhere. In production, mock is refused unless ALLOW_MOCK_VENDORS=1, so a
// missing env var can never end up approving a real loan on fake KYC or bureau data.
import {
  mockKyc, mockBureau, mockBankStatement, mockEsign, mockPayout,
} from './mock-adapters.js';
import { createDigitapAdapters } from './digitap-adapter.js';
import {
  assertKyc, assertBureau, assertBank, assertEsign, assertPayout,
} from './contracts.js';

const SLOTS = {
  kyc: { env: 'VENDOR_KYC', method: 'verify', check: assertKyc },
  bureau: { env: 'VENDOR_BUREAU', method: 'pull', check: assertBureau },
  bankStatement: { env: 'VENDOR_BANK_STATEMENT', method: 'analyse', check: assertBank },
  esign: { env: 'VENDOR_ESIGN', method: 'createRequest', check: assertEsign },
  payout: { env: 'VENDOR_PAYOUT', method: 'disburse', check: assertPayout },
};

function guard(adapter, { method, check }) {
  return {
    name: adapter.name,
    [method]: async (...args) => check(await adapter[method](...args)),
  };
}

export function createRegistry({ env = process.env, fetchImpl, overrides = {} } = {}) {
  const mocks = { kyc: mockKyc, bureau: mockBureau, bankStatement: mockBankStatement, esign: mockEsign, payout: mockPayout };
  const digitap = createDigitapAdapters({ env, fetchImpl });
  const real = { digitap };
  const registry = {};
  const names = {};

  for (const [slot, spec] of Object.entries(SLOTS)) {
    const vendor = (env[spec.env] || 'mock').toLowerCase();
    let adapter = overrides[slot];
    if (!adapter) {
      if (vendor === 'mock') {
        if (env.NODE_ENV === 'production' && env.ALLOW_MOCK_VENDORS !== '1') {
          throw new Error(`${spec.env} is "mock" in production. Set a real vendor, or ALLOW_MOCK_VENDORS=1 to override.`);
        }
        adapter = mocks[slot];
      } else if (real[vendor]?.[slot]) {
        adapter = real[vendor][slot];
      } else {
        throw new Error(`Unknown or unsupported vendor "${vendor}" for slot "${slot}" (${spec.env})`);
      }
    }
    registry[slot] = guard(adapter, spec);
    names[slot] = adapter.name;
  }
  registry.names = names;
  return registry;
}
