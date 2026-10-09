// Picks one adapter per slot from env, and checks every adapter's output against contracts.js.
//   VENDOR_KYC=mock|<vendor>   VENDOR_BUREAU   VENDOR_BANK_STATEMENT   VENDOR_ESIGN   VENDOR_PAYOUT   VENDOR_COLLECT
// A <vendor> is any key in the spec registry (vendors/index.js) that defines that slot.
// Default is mock everywhere. In production, mock is refused unless ALLOW_MOCK_VENDORS=1, so a
// missing env var can never end up approving a real loan on fake KYC or bureau data.
import {
  mockKyc, mockBureau, mockBankStatement, mockEsign, mockPayout, mockCollect,
} from './mock-adapters.js';
import { buildAdapter } from './http-adapter.js';
import { DEFAULT_SPECS } from './vendors/index.js';
import {
  assertKyc, assertBureau, assertBank, assertEsign, assertPayout, assertCollect,
} from './contracts.js';

const SLOTS = {
  kyc: { env: 'VENDOR_KYC', method: 'verify', check: assertKyc },
  bureau: { env: 'VENDOR_BUREAU', method: 'pull', check: assertBureau },
  bankStatement: { env: 'VENDOR_BANK_STATEMENT', method: 'analyse', check: assertBank },
  esign: { env: 'VENDOR_ESIGN', method: 'createRequest', check: assertEsign },
  payout: { env: 'VENDOR_PAYOUT', method: 'disburse', check: assertPayout, extra: { status: assertPayout } },
  collect: { env: 'VENDOR_COLLECT', method: 'request', check: assertCollect },
};

function guard(adapter, { method, check, extra = {} }) {
  const g = {
    name: adapter.name,
    [method]: async (...args) => check(await adapter[method](...args)),
  };
  // optional extra methods (e.g. payout.status) are exposed only if the adapter has them
  for (const [m, chk] of Object.entries(extra)) {
    if (typeof adapter[m] === 'function') g[m] = async (...args) => chk(await adapter[m](...args));
  }
  return g;
}

export function createRegistry({ env = process.env, fetchImpl, overrides = {}, specs = DEFAULT_SPECS } = {}) {
  const mocks = { kyc: mockKyc, bureau: mockBureau, bankStatement: mockBankStatement, esign: mockEsign, payout: mockPayout, collect: mockCollect };
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
      } else if (specs[vendor]?.[slot]) {
        adapter = buildAdapter(vendor, slot, specs[vendor][slot], { env, fetchImpl });
      } else {
        throw new Error(`Unknown or unsupported vendor "${vendor}" for slot "${slot}" (${spec.env})`);
      }
    }
    registry[slot] = guard(adapter, spec);
    names[slot] = adapter.name;
  }
  registry.names = names;
  registry.specs = specs; // the webhook handler reads webhook specs from here
  return registry;
}
