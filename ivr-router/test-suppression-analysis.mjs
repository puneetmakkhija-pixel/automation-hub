import test from "node:test";
import assert from "node:assert/strict";

// suppressionAnalysisClient reaches its DB through the shared
// clients/supabaseClient.js singleton (supabase.supabase, not supabase itself).
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";

const supabaseWrapper = (await import("./lib/clients/supabaseClient.js")).default;
assert.ok(supabaseWrapper, "supabaseClient singleton failed to construct in test env");

const state = { rejection_logs: [], eligibility_rules: [], rule_recommendations: [] };
const writes = { inserts: [], updates: [] };

function fakeClient() {
  return {
    from(table) {
      const filters = {};
      const inFilters = {};
      let mode = "select";
      let patch = null;
      let singleMode = false;
      const builder = {
        select: () => builder,
        insert: (row) => { mode = "insert"; writes.inserts.push({ table, row }); return builder; },
        update: (p) => { mode = "update"; patch = p; return builder; },
        eq: (col, val) => { filters[col] = val; return builder; },
        in: (col, vals) => { inFilters[col] = vals; return builder; },
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        single: () => { singleMode = true; return builder; },
        then: (resolve) => resolve(finalize()),
      };
      function finalize() {
        if (mode === "insert") return { data: null, error: null };
        if (mode === "update") {
          writes.updates.push({ table, filters: { ...filters }, patch });
          return { data: null, error: null };
        }
        const rows = (state[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v) &&
          Object.entries(inFilters).every(([k, vals]) => vals.includes(r[k]))
        );
        if (singleMode) return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "not found" } };
        return { data: rows, error: null };
      }
      return builder;
    },
  };
}

function reset() {
  state.rejection_logs = [];
  state.eligibility_rules = [{ id: "rule-2", version: 2, cibil_minimum_score: 650, age_minimum: 21, age_maximum: 65, income_minimum: 150000, income_maximum: 5000000, active: true, created_at: "2026-09-20T00:00:00Z" }];
  state.rule_recommendations = [];
  writes.inserts = [];
  writes.updates = [];
  supabaseWrapper.supabase = fakeClient();
}

const { default: suppressionAnalysisClient } = await import("./lib/llm/suppressionAnalysisClient.js");

// ── analyzeRejectionPatternsForRecalibration: the wrapper-vs-raw-client bug ──
//
// Read rejection_logs and eligibility_rules, then stored a recommendation, all
// via supabase.from(...) on the WRAPPER instance instead of
// supabase.supabase.from(...). Every one of those three calls threw, so the
// nightly recalibration job (Phase 3.5d) could read no rejections, no current
// rules, and persist no recommendation -- it ran and did nothing, silently.

test("reads rejections and current rules, then stores a recommendation", async () => {
  reset();
  state.rejection_logs = [{
    lender_id: "poonawalla", rejection_reason: "cibil_low", rejection_category: "bureau",
    rejected_bureau_vars: { cibil_score: 620 }, rejected_demographic_vars: {}, rejected_at: "2026-09-29T00:00:00Z",
  }];
  // The Claude call is not this test's concern; the DB reads/writes around it are.
  suppressionAnalysisClient.generateRuleRecommendation = async () => ({
    success: true, suggested_rules: { cibil_minimum_score: 600 }, rationale: {}, confidence: 0.8,
    estimated_additional_eligible_users: 5, key_insights: [],
  });

  const res = await suppressionAnalysisClient.analyzeRejectionPatternsForRecalibration(24, []);
  assert.equal(res.success, true);
  const stored = writes.inserts.find((w) => w.table === "rule_recommendations");
  assert.ok(stored, "expected a rule_recommendations row to be stored");
  assert.equal(stored.row.rejection_count, 1);
});

test("reports insufficient data rather than throwing when there are no rejections", async () => {
  reset(); // state.rejection_logs stays empty
  const res = await suppressionAnalysisClient.analyzeRejectionPatternsForRecalibration(24, []);
  assert.equal(res.success, true);
  assert.equal(res.recommendation, null);
});

// ── applyRuleChanges: the same bug, on the approval path ────────────────────

test("approving a recommendation deactivates old rules and inserts new ones", async () => {
  reset();
  state.rule_recommendations = [{
    id: "rec-1", recommended_rules: { cibil_minimum_score: 600 },
    current_rules: { version: 2 },
  }];
  const res = await suppressionAnalysisClient.applyRuleChanges("rec-1", true);
  assert.equal(res.success, true);
  assert.equal(res.new_version, 3);

  const deactivate = writes.updates.find((u) => u.table === "eligibility_rules" && u.filters.active === true);
  assert.ok(deactivate, "expected old rules to be deactivated");
  assert.equal(deactivate.patch.active, false);

  const insert = writes.inserts.find((w) => w.table === "eligibility_rules");
  assert.ok(insert, "expected the new rules row to be inserted");
  assert.equal(insert.row.version, 3);

  const markApplied = writes.updates.find((u) => u.table === "rule_recommendations" && u.filters.id === "rec-1");
  assert.equal(markApplied.patch.status, "applied");
});

test("rejecting a recommendation just marks it rejected", async () => {
  reset();
  const res = await suppressionAnalysisClient.applyRuleChanges("rec-1", false);
  assert.equal(res.success, true);
  const update = writes.updates.find((u) => u.table === "rule_recommendations" && u.filters.id === "rec-1");
  assert.equal(update.patch.status, "rejected");
  assert.equal(writes.inserts.length, 0);
});
