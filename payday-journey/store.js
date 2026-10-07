// Persistence behind a small interface so underwrite.js stays testable.
//   memoryStore()          - tests and local runs
//   supabaseStore(client)  - writes to the payday schema; the supabase-js client is INJECTED,
//                            so this package has no dependency on it.

export function memoryStore() {
  const db = { kycChecks: [], enrichment: [], scorecards: [], applicationPatches: [] };
  return {
    db,
    async saveKycChecks(rows) { db.kycChecks.push(...rows); },
    async saveEnrichment(row) { db.enrichment.push(row); },
    async saveScorecard(row) { db.scorecards.push(row); },
    async patchApplication(id, patch) { db.applicationPatches.push({ id, patch }); },
  };
}

export function supabaseStore(client) {
  const t = (name) => client.schema('payday').from(name);
  const ok = async (p, what) => {
    const { error } = await p;
    if (error) throw new Error(`payday.${what}: ${error.message}`);
  };
  return {
    saveKycChecks: (rows) => ok(t('kyc_check').insert(rows), 'kyc_check insert'),
    saveEnrichment: (row) => ok(t('enrichment_report').insert(row), 'enrichment_report insert'),
    saveScorecard: (row) => ok(t('scorecard_result').insert(row), 'scorecard_result insert'),
    patchApplication: (id, patch) => ok(t('application').update(patch).eq('id', id), 'application update'),
  };
}
