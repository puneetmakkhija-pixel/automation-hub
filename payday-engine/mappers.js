// Map a decide() result onto the payday.* tables (database/migrations/003).
// Pure: returns row objects only. The caller (step 3 orchestrator) does the writes.

// -> payday.scorecard_result
export function toScorecardRow(applicationId, result) {
  return {
    application_id: applicationId,
    model_version: result.modelVersion,
    total_points: result.totalPoints,
    grade: result.grade,
    decision: result.decision, // 'approve' | 'reject' | 'refer', matches the table check
    parameters: {
      max_points: result.maxPoints,
      missing_count: result.missingCount,
      red_flags: result.redFlags,
      offer: result.offer,
      params: result.parameters,
    },
  };
}

// -> patch for payday.application
//   approve -> offered (approved_amount set), refer -> scored (waits for a person), reject -> rejected
export function toApplicationPatch(result) {
  const status = { approve: 'offered', refer: 'scored', reject: 'rejected' }[result.decision];
  return {
    status,
    approved_amount: result.decision === 'approve' ? result.offer.amount : null,
    decision_reasons: result.reasons,
  };
}
