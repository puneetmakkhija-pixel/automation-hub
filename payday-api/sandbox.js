// Sandbox boot: an in-memory copy of the API for a partner's developers. It never touches a real database or a real vendor.
// Everything resets when the service restarts, which is the point: a developer can break it and start again.
import { createRegistry, memoryStore, createPartner, hashKey } from '../payday-journey/index.js';

export const SANDBOX_PRODUCT = {
  id: 'prod-sandbox', code: 'PAYDAY_30', min_amount: 5000, max_amount: 50000, tenure_days: 30,
  fee_type: 'percent_of_principal', fee_value: 8, penalty_per_day_pct: 1, rollover_allowed: false, max_rollovers: 0, cooling_off_days: 1, active: true,
};

// Throws with a plain message if the environment could put the sandbox next to something real.
export function sandboxProblem(env) {
  const real = Object.keys(env).filter((k) => /^VENDOR_/.test(k) && env[k] && env[k].toLowerCase() !== 'mock');
  if (env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY) return 'the sandbox never uses a real database: unset SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY';
  if (real.length) return `the sandbox never uses a real vendor: unset ${real.join(', ')}`;
  if (!env.PAYDAY_API_KEY) return 'set PAYDAY_API_KEY: the sandbox needs an admin key to create the partner key';
  return null;
}

// SANDBOX_PARTNER_KEY (at least 32 characters) seeds one partner and its key, so the key survives a restart and can be handed
// to the partner's developers once. SANDBOX_CALLBACK_URL is where their events go; without it events still queue and can be
// read back with GET /v1/events. The callback signing secret is read from the env var named PARTNER_SANDBOX_SECRET.
export async function createSandbox(env) {
  const problem = sandboxProblem(env);
  if (problem) throw new Error(problem);
  const store = memoryStore({ products: [{ ...SANDBOX_PRODUCT }] });
  const registry = createRegistry({ env: { ...env, NODE_ENV: 'development' } }); // all mock vendors
  const key = env.SANDBOX_PARTNER_KEY;
  if (key) {
    if (String(key).length < 32) throw new Error('SANDBOX_PARTNER_KEY must be at least 32 characters');
    const partner = await createPartner({
      store, name: env.SANDBOX_PARTNER_NAME || 'BuddyLoan', callbackUrl: env.SANDBOX_CALLBACK_URL || 'https://sandbox-events.invalid/payday', callbackSecretEnv: 'PARTNER_SANDBOX_SECRET',
    });
    await store.insertApiClient({ name: `${partner.name} sandbox`, role: 'partner', partner_id: partner.id, key_hash: hashKey(key) });
  }
  return { store, registry };
}
