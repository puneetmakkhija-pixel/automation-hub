import test from "node:test";
import assert from "node:assert/strict";

// intentGenerationClient reaches its DB through the shared clients/supabaseClient.js
// singleton (supabase.supabase, not supabase itself). Dummy credentials only --
// constructing the singleton and the Anthropic client never makes a network call
// unless generateIntent (not exercised here) actually runs.
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";
process.env.CLAUDE_API_KEY ||= "test-claude-key";

const supabaseWrapper = (await import("./lib/clients/supabaseClient.js")).default;
assert.ok(supabaseWrapper, "supabaseClient singleton failed to construct in test env");

const state = { user_intents: [] };
const writes = { inserts: [] };

function fakeClient() {
  return {
    from(table) {
      const filters = {};
      let mode = "select";
      const builder = {
        select: () => builder,
        insert: (row) => { mode = "insert"; writes.inserts.push({ table, row }); return builder; },
        eq: (col, val) => { filters[col] = val; return builder; },
        order: () => builder,
        limit: () => builder,
        then: (resolve) => resolve(finalize()),
      };
      function finalize() {
        if (mode === "insert") return { data: null, error: null };
        const rows = (state[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v)
        );
        return { data: rows, error: null };
      }
      return builder;
    },
  };
}

function reset() {
  state.user_intents = [];
  writes.inserts = [];
  supabaseWrapper.supabase = fakeClient();
}

const { default: intentGenerationClient } = await import("./lib/llm/intentGenerationClient.js");

// ── storeIntent / getUserIntent: the wrapper-vs-raw-client bug ──────────────
//
// Both called supabase.from(...) on the WRAPPER instance instead of
// supabase.supabase.from(...). The wrapper has no .from method, so every real
// call threw, was caught by this file's own try/catch, and turned into a
// silent no-op (storeIntent) or a false "no intent found" (getUserIntent).
// That second one is not cosmetic: applicationPushRoutes.js's
// /send-application-push calls getUserIntent first and 400s if it comes back
// null -- so this bug alone made the entire Phase 3.5b push route unreachable.

test("storeIntent actually inserts a row", async () => {
  reset();
  const r = await intentGenerationClient.storeIntent("9990001112", {
    intent: "working_capital", intent_confidence: 0.8, risk_profile: "low",
    completion_probability: 0.7, messaging_angle: "business_growth",
    recommended_amount: 500000, recommended_lender: "poonawala",
    personalized_message: "hi", reasoning: "test",
  });
  assert.equal(r.valid, true);
  assert.equal(writes.inserts.length, 1);
  assert.equal(writes.inserts[0].table, "user_intents");
  assert.equal(writes.inserts[0].row.phone_number, "9990001112");
});

test("getUserIntent finds the most recently stored intent for this phone", async () => {
  reset();
  state.user_intents = [{ phone_number: "9990001112", intent: "expansion", created_at: "2026-09-29T00:00:00Z" }];
  const row = await intentGenerationClient.getUserIntent("9990001112");
  assert.equal(row?.intent, "expansion");
});

test("getUserIntent returns null for a phone with no stored intent", async () => {
  reset();
  const row = await intentGenerationClient.getUserIntent("9990009999");
  assert.equal(row, null);
});
