// Credit policy management. The credit team creates a draft, checks it with `simulate`, and activates it. Each
// version is immutable once active (the database enforces it), and every decision records the version it used.
import { validatePolicy, DEFAULT_POLICY, decide } from '../payday-engine/index.js';
import { ValidationError, BusinessRuleError } from './errors.js';

function checked(policy) {
  const v = validatePolicy(policy);
  if (!v.ok) throw new ValidationError('invalid credit policy', v.errors);
  return v;
}

export async function createPolicyDraft({ store, version, config, by, note = null }) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new ValidationError('invalid credit policy', ['config must be an object']);
  const policy = { ...config, version }; // the version argument is the one that counts
  checked(policy);
  return store.insertPolicy({ version, config: policy, created_by: by, note });
}

export async function updatePolicyDraft({ store, id, config, note }) {
  const p = await store.getPolicyById(id);
  if (!p) throw new BusinessRuleError('policy not found');
  if (p.status !== 'draft') throw new BusinessRuleError('only a draft can be edited: create a new version');
  const policy = { ...config, version: p.version };
  checked(policy);
  return store.patchPolicy(id, { config: policy, ...(note !== undefined ? { note } : {}) });
}

export async function activatePolicy({ store, id, by }) {
  const p = await store.getPolicyById(id);
  if (!p) throw new BusinessRuleError('policy not found');
  if (p.status !== 'draft') throw new BusinessRuleError(`only a draft can be activated (this one is ${p.status})`);
  checked(p.config); // re-validated at the moment it goes live
  return store.activatePolicy(id, by);
}

// The policy decisions use: the active version, or the built-in default if none has been activated yet.
export async function loadActivePolicy({ store }) {
  const row = await store.getActivePolicy();
  return row ? row.config : DEFAULT_POLICY;
}

// Run a policy on made-up inputs without saving anything, so the credit team can see the effect of a change.
export function simulatePolicy({ policy, features, product, requestedAmount, customerLimit = null }) {
  checked(policy);
  return decide({ features, product, requestedAmount, customerLimit, policy });
}
