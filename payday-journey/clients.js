// API clients: one key per caller, each with a role, so who did what can be told apart and a single key can be
// revoked. Keys are random (256 bits) and only their SHA-256 hash is stored; the key is shown once, at creation.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { ValidationError } from './errors.js';

export const ROLES = ['admin', 'ops', 'partner'];
export const generateApiKey = () => `pk_${randomBytes(32).toString('base64url')}`;
export const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex');

function sameKey(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y); // equal-length digests, constant time
}

export async function createApiClient({ store, name, role, partnerId = null }) {
  const errs = [];
  if (typeof name !== 'string' || !name.trim() || name.length > 80) errs.push('name must be 1-80 characters');
  if (!ROLES.includes(role)) errs.push(`role must be one of ${ROLES.join(', ')}`);
  if (role === 'partner' && !partnerId) errs.push('a partner key needs a partner_id');
  if (role !== 'partner' && partnerId) errs.push('only a partner key may name a partner');
  if (errs.length) throw new ValidationError('invalid client', errs);
  if (partnerId) {
    const p = await store.getPartner(partnerId);
    if (!p || !p.active) throw new ValidationError('invalid client', ['partner not found or inactive']);
  }
  const key = generateApiKey();
  const row = await store.insertApiClient({ name: name.trim(), role, partner_id: partnerId, key_hash: hashKey(key) });
  return { client: { id: row.id, name: row.name, role: row.role, partner_id: row.partner_id }, key }; // key: shown once
}

// -> { id, name, role, partner_id } or null. A bootstrap key (from env) is an admin with no client row, so a
// brand-new deployment can create its first real clients; replace it with real clients and unset it.
export async function authenticate({ store, key, bootstrapKey = null }) {
  if (typeof key !== 'string' || !key || key.length > 200) return null;
  if (bootstrapKey && sameKey(key, bootstrapKey)) return { id: null, name: 'bootstrap', role: 'admin', partner_id: null };
  const c = await store.findApiClientByKeyHash(hashKey(key));
  if (!c || !c.active || c.revoked_at) return null;
  if (c.partner_id) {
    const p = await store.getPartner(c.partner_id);
    if (!p || !p.active) return null; // a deactivated partner's keys stop working at once
  }
  Promise.resolve(store.touchApiClient(c.id)).catch(() => {}); // best effort; never blocks or fails a request
  return { id: c.id, name: c.name, role: c.role, partner_id: c.partner_id };
}
