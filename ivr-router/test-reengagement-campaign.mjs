import test from "node:test";
import assert from "node:assert/strict";

// reengagementClient reaches its DB through the shared clients/supabaseClient.js
// singleton (supabase.supabase, not supabase itself -- see reengagementRoutes.js's
// own queryBuilder() for the same convention). Constructing that singleton just
// needs non-empty strings; it never makes a network call unless a query actually
// runs, so these are safe dummies, not real credentials.
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const supabaseWrapper = (await import("./lib/clients/supabaseClient.js")).default;
assert.ok(supabaseWrapper, "supabaseClient singleton failed to construct in test env");

// A fake Postgrest-shaped query builder. State is one array per table; each
// .from(table) call gets its own filter/mode closure, matching how the real
// client hands out a fresh builder per call.
const state = { rejection_logs: [], eligibility_rules: [], users: [] };
const writes = { inserts: [], updates: [] };

function fakeClient() {
  return {
    from(table) {
      const filters = {};
      let mode = "select";
      let patch = null;
      let singleMode = null; // null | "single" | "maybe"
      const builder = {
        select: () => builder,
        insert: (row) => { mode = "insert"; writes.inserts.push({ table, row }); return builder; },
        update: (p) => { mode = "update"; patch = p; return builder; },
        eq: (col, val) => { filters[col] = val; return builder; },
        is: (col, val) => { filters[col] = val; return builder; },
        not: () => builder, // trackReengagementResponse's own filter isn't asserted on here
        order: () => builder,
        limit: () => builder,
        single: () => { singleMode = "single"; return builder; },
        maybeSingle: () => { singleMode = "maybe"; return builder; },
        then: (resolve) => resolve(finalize()),
      };
      function finalize() {
        if (mode === "insert") return { data: null, error: null };
        if (mode === "update") {
          writes.updates.push({ table, filters: { ...filters }, patch });
          return { data: null, error: null };
        }
        const rows = (state[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v)
        );
        if (singleMode === "single") {
          return rows[0] ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116" } };
        }
        if (singleMode === "maybe") return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      }
      return builder;
    },
  };
}

const { default: reengagementClient } = await import("./lib/llm/reengagementClient.js");

function reset() {
  state.rejection_logs = [];
  state.eligibility_rules = [{ id: "rule-2", version: 2, cibil_minimum_score: 650, age_minimum: 21, age_maximum: 65, income_minimum: 150000, income_maximum: 5000000, created_at: "2026-09-20T00:00:00Z" }];
  state.users = [];
  writes.inserts = [];
  writes.updates = [];
  supabaseWrapper.supabase = fakeClient();
}

// ── findMostRecentPendingRejection / getCurrentEligibilityRules ─────────────

test("findMostRecentPendingRejection finds an unsent, unengaged rejection", async () => {
  reset();
  state.rejection_logs = [{
    id: "r1", phone_number: "9990001112", user_engaged_again: false,
    reengagement_sent_at: null, rejected_bureau_vars: { cibil_score: 700 }, rejected_demographic_vars: {},
  }];
  const row = await reengagementClient.findMostRecentPendingRejection("9990001112");
  assert.equal(row?.id, "r1");
});

test("findMostRecentPendingRejection returns null once reengagement_sent_at is stamped", async () => {
  reset();
  state.rejection_logs = [{
    id: "r1", phone_number: "9990001112", user_engaged_again: false,
    reengagement_sent_at: "2026-09-29T00:00:00Z",
  }];
  const row = await reengagementClient.findMostRecentPendingRejection("9990001112");
  assert.equal(row, null);
});

test("findMostRecentPendingRejection returns null once the user engaged again", async () => {
  reset();
  state.rejection_logs = [{
    id: "r1", phone_number: "9990001112", user_engaged_again: true, reengagement_sent_at: null,
  }];
  const row = await reengagementClient.findMostRecentPendingRejection("9990001112");
  assert.equal(row, null);
});

// ── sendReengagementCampaign: the gap this file exists to close ─────────────

// Mutation: drop the findMostRecentPendingRejection guard from
// sendReengagementCampaign. This is the whole bug -- /campaign trusted a bare
// {phone_number} list from the caller and sent to it unconditionally.
test("refuses a phone with no pending rejection -- already sent, already engaged, or never rejected", async () => {
  reset(); // state.rejection_logs stays empty: nothing pending for anybody
  const res = await reengagementClient.sendReengagementCampaign([{ phone_number: "9990009999" }]);
  assert.equal(res.results.skipped, 1);
  assert.equal(res.results.sent, 0);
  assert.equal(writes.updates.length, 0);
});

// Mutation: check eligibility against the rules the CALLER'S rejection row
// carries instead of the CURRENT active rules. A rule can tighten between
// find-eligible computing its list and campaign actually being called.
test("refuses a phone that no longer passes the CURRENT rules, even with a pending rejection", async () => {
  reset();
  state.eligibility_rules = [{ id: "rule-3", version: 3, cibil_minimum_score: 750, age_minimum: 21, age_maximum: 65, income_minimum: 150000, income_maximum: 5000000, created_at: "2026-09-29T00:00:00Z" }];
  state.rejection_logs = [{
    id: "r1", phone_number: "9990001112", user_engaged_again: false, reengagement_sent_at: null,
    rejected_bureau_vars: { cibil_score: 700 }, rejected_demographic_vars: {},
  }];
  const res = await reengagementClient.sendReengagementCampaign([{ phone_number: "9990001112" }]);
  assert.equal(res.results.skipped, 1);
  assert.equal(res.results.sent, 0);
});

// Mutation: never write reengagement_sent_at after a successful send. Without
// it, the very next /campaign call -- with the same stale list -- messages
// this person a second time.
test("stamps reengagement_sent_at on the matched row after a successful send", async () => {
  reset();
  state.rejection_logs = [{
    id: "r1", phone_number: "9990001112", user_engaged_again: false, reengagement_sent_at: null,
    rejected_bureau_vars: { cibil_score: 700 }, rejected_demographic_vars: {},
  }];
  state.users = [{ phone_number: "9990001112", name: "Asha" }];
  // Network sends are not this test's concern; the guard and the write are.
  reengagementClient.generateReengagementMessage = async () => "test message";
  reengagementClient.sendWhatsAppReengagement = async () => ({ success: true, message_id: "m1" });

  const res = await reengagementClient.sendReengagementCampaign([{ phone_number: "9990001112" }]);
  assert.equal(res.results.sent, 1);
  const stamp = writes.updates.find((u) => u.table === "rejection_logs" && u.filters.id === "r1");
  assert.ok(stamp, "expected an update keyed on the matched rejection_logs row");
  assert.ok(stamp.patch.reengagement_sent_at, "expected reengagement_sent_at to be set");
});

// ── trackReengagementResponse: the query that used to match nothing ────────

// Mutation: pass an object to .eq() again (the original bug), or drop
// user_engaged_again from the update. Either way this stays broken silently --
// nothing throws, the row just never gets found or never stops being resurfaced.
test("trackReengagementResponse finds the sent row and sets user_engaged_again", async () => {
  reset();
  state.rejection_logs = [{
    id: "r1", phone_number: "9990001112", user_engaged_again: false,
    reengagement_sent_at: "2026-09-28T00:00:00Z",
  }];
  const res = await reengagementClient.trackReengagementResponse("9990001112", "started_application");
  assert.equal(res.success, true);
  const update = writes.updates.find((u) => u.table === "rejection_logs" && u.filters.id === "r1");
  assert.ok(update, "expected the matched row to be updated by id");
  assert.equal(update.patch.user_engaged_again, true);
  assert.ok(update.patch.reengagement_response_at);
  // The old column that PostgREST would have rejected outright.
  assert.equal(update.patch.reengagement_response_outcome, undefined);
});

test("trackReengagementResponse is a no-op, not a crash, when nothing was ever sent", async () => {
  reset(); // no rejection_logs rows at all
  const res = await reengagementClient.trackReengagementResponse("9990001112", "started_application");
  assert.equal(res.success, true);
  assert.equal(writes.updates.length, 0);
});
