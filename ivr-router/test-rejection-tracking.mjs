import test from "node:test";
import assert from "node:assert/strict";

// rejectionTrackingClient reaches its DB through the shared clients/supabaseClient.js
// singleton (supabase.supabase, not supabase itself).
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const supabaseWrapper = (await import("./lib/clients/supabaseClient.js")).default;
assert.ok(supabaseWrapper, "supabaseClient singleton failed to construct in test env");

const state = { rejection_logs: [] };
const writes = { inserts: [], updates: [] };

function fakeClient() {
  return {
    from(table) {
      const filters = {};
      const notFilters = [];
      let mode = "select";
      let patch = null;
      const builder = {
        select: () => builder,
        insert: (row) => { mode = "insert"; writes.inserts.push({ table, row }); return builder; },
        update: (p) => { mode = "update"; patch = p; return builder; },
        eq: (col, val) => { filters[col] = val; return builder; },
        gte: () => builder,
        not: (col, op, val) => { notFilters.push({ col, op, val }); return builder; },
        order: () => builder,
        limit: () => builder,
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
          notFilters.every(({ col, val }) => (val === null ? r[col] != null : true))
        );
        return { data: rows, error: null };
      }
      return builder;
    },
  };
}

function reset() {
  state.rejection_logs = [];
  writes.inserts = [];
  writes.updates = [];
  supabaseWrapper.supabase = fakeClient();
}

const { default: rejectionTrackingClient } = await import("./lib/llm/rejectionTrackingClient.js");

// ── captureRejection: the wrapper-vs-raw-client bug ─────────────────────────
//
// Called supabase.from(...) on the WRAPPER instance instead of
// supabase.supabase.from(...) -- every real call threw "supabase.from is not
// a function", caught by this file's own try/catch and turned into a silent
// {success:false}. POST /api/rejections/capture is "called by lenders or
// Phase 4 when application is rejected": with this bug, rejection_logs was
// never actually written by this route at all, which starves the very table
// reengagementClient.findMostRecentPendingRejection reads from.

test("captureRejection actually inserts a row", async () => {
  reset();
  const r = await rejectionTrackingClient.captureRejection({
    phone_number: "9990001112", lender_id: "poonawalla", rejection_reason: "cibil_low",
  });
  assert.equal(r.success, true);
  assert.equal(writes.inserts.length, 1);
  assert.equal(writes.inserts[0].table, "rejection_logs");
  assert.equal(writes.inserts[0].row.rejection_category, "bureau");
});

// ── recordReengagementResponse: the same malformed .eq() bug reengagementClient had ──
//
// .eq('reengagement_sent_at', { notNull: true }) passes an object where .eq()
// takes a scalar -- it matched nothing, ever, in the live code, the same class
// of bug reengagementClient.trackReengagementResponse carried before #149.

test("recordReengagementResponse finds the sent row by id and stamps a response", async () => {
  reset();
  state.rejection_logs = [{
    id: "r1", phone_number: "9990001112",
    reengagement_sent_at: "2026-09-28T00:00:00Z",
  }];
  const res = await rejectionTrackingClient.recordReengagementResponse("9990001112", "started_application");
  assert.equal(res.success, true);
  const update = writes.updates.find((u) => u.table === "rejection_logs" && u.filters.id === "r1");
  assert.ok(update, "expected the matched row to be updated by id");
  assert.ok(update.patch.reengagement_response_at);
});

test("recordReengagementResponse is a no-op, not a crash, when nothing was ever sent", async () => {
  reset(); // no rejection_logs rows at all
  const res = await rejectionTrackingClient.recordReengagementResponse("9990001112", "started_application");
  assert.equal(res.success, true);
  assert.equal(writes.updates.length, 0);
});
