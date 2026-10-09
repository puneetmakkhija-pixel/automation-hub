// Audit trail helper. Rows go to payday.audit_log, which the database makes append-only. Sensitive values are
// redacted before they are written: an audit log must not become a second copy of the secrets.
const SENSITIVE = /(pan|account|number|ifsc|secret|key|token|password|authorization)/i;

export function redact(v, depth = 0) {
  if (v === null || typeof v !== 'object') return v;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(x, depth + 1)]));
}

export async function audit({ store, actor, action, entityType = null, entityId = null, details = null }) {
  await store.insertAudit({
    actor_client_id: actor?.id ?? null,
    actor_name: actor?.name ?? 'system',
    actor_role: actor?.role ?? 'system',
    action,
    entity_type: entityType,
    entity_id: entityId === null || entityId === undefined ? null : String(entityId),
    details: details === null ? null : redact(details),
  });
}
