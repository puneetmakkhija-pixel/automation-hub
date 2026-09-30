import test from "node:test";
import assert from "node:assert/strict";

// applicationPushClient reaches its DB through the shared clients/supabaseClient.js
// singleton (supabase.supabase, not supabase itself). Same dummy-credential
// convention as test-reengagement-campaign.mjs: constructing the singleton never
// makes a network call unless a query actually runs.
process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const supabaseWrapper = (await import("./lib/clients/supabaseClient.js")).default;
assert.ok(supabaseWrapper, "supabaseClient singleton failed to construct in test env");

const state = { contact_suppression: [], push_events: [], push_engagement_events: [] };
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
        is: (col, val) => { filters[col] = val; return builder; },
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
  state.contact_suppression = [];
  state.push_events = [];
  state.push_engagement_events = [];
  writes.inserts = [];
  supabaseWrapper.supabase = fakeClient();
}

const { default: applicationPushClient } = await import("./lib/llm/applicationPushClient.js");

const INTENT = {
  intent: "working_capital",
  completion_probability: 0.5,
  personalized_message: "test message",
};
const PROFILE = { name: "Rajesh" };

// ── isSuppressed: the check this file exists to add ─────────────────────────

test("isSuppressed is true for a mobile on the suppression list", async () => {
  reset();
  state.contact_suppression = [{ phone: "9990001112", released_at: null }];
  assert.equal(await applicationPushClient.isSuppressed("9990001112"), true);
});

test("isSuppressed is false for a clean mobile", async () => {
  reset();
  assert.equal(await applicationPushClient.isSuppressed("9990001112"), false);
});

test("isSuppressed ignores a released suppression (released_at is not null)", async () => {
  reset();
  // The fake filters on released_at === null exactly, matching the real
  // .is('released_at', null) query -- a released row never matches.
  state.contact_suppression = [{ phone: "9990001112", released_at: "2026-09-01T00:00:00Z" }];
  assert.equal(await applicationPushClient.isSuppressed("9990001112"), false);
});

test("isSuppressed fails CLOSED when the table is unreadable", async () => {
  reset();
  supabaseWrapper.supabase = {
    from: () => ({
      select: () => ({ eq: () => ({ is: () => ({ limit: () =>
        Promise.resolve({ data: null, error: { message: "relation missing" } }) }) }) }),
    }),
  };
  assert.equal(await applicationPushClient.isSuppressed("9990001112"), true);
});

test("isSuppressed refuses anything that isn't a 10-digit mobile, rather than guessing", async () => {
  reset();
  assert.equal(await applicationPushClient.isSuppressed(""), true);
  assert.equal(await applicationPushClient.isSuppressed("12345"), true);
});

// ── sendPersonalizedApplicationPush: the gap this check closes ──────────────

// Mutation: drop the isSuppressed guard from sendPersonalizedApplicationPush.
// This is the whole bug -- nothing in this push path checked the suppression
// list at all, unlike the WhatsApp rebroadcast and press1-catchup sweeps.
test("never pushes a suppressed number: no channel is attempted", async () => {
  reset();
  state.contact_suppression = [{ phone: "9990001112", released_at: null }];
  let whatsappCalled = false;
  applicationPushClient.sendWhatsAppMessage = async () => { whatsappCalled = true; return { success: true, message_id: "m1" }; };

  const res = await applicationPushClient.sendPersonalizedApplicationPush("9990001112", INTENT, PROFILE);
  assert.equal(res.success, false);
  assert.equal(res.error, "suppressed");
  assert.equal(whatsappCalled, false, "WhatsApp must never be attempted for a suppressed number");
  assert.equal(writes.inserts.length, 0, "no push_events row for a refused push");
});

test("a clean number still gets pushed", async () => {
  reset();
  applicationPushClient.sendWhatsAppMessage = async () => ({ success: true, message_id: "m1" });
  const res = await applicationPushClient.sendPersonalizedApplicationPush("9990001112", INTENT, PROFILE);
  assert.equal(res.success, true);
  assert.ok(writes.inserts.some((w) => w.table === "push_events"));
});

// ── storePushEvent / trackPushEngagement: the wrapper-vs-raw-client bug ─────
//
// Both used to call supabase.from(...) directly on the WRAPPER instance
// instead of supabase.supabase.from(...) -- the wrapper has no .from method at
// all, so every real call threw "supabase.from is not a function", caught and
// swallowed by this file's own try/catch. Nothing was ever persisted.

test("storePushEvent actually inserts a row", async () => {
  reset();
  const r = await applicationPushClient.storePushEvent({
    phone_number: "9990001112", channels_attempted: ["whatsapp"], channels_succeeded: ["whatsapp"],
    push_timestamp: "2026-09-30T00:00:00Z",
  });
  assert.equal(r.success, true);
  assert.equal(writes.inserts.length, 1);
  assert.equal(writes.inserts[0].table, "push_events");
});

test("trackPushEngagement actually inserts a row", async () => {
  reset();
  const r = await applicationPushClient.trackPushEngagement("9990001112", "whatsapp_opened", { device: "mobile" });
  assert.equal(r.success, true);
  assert.equal(writes.inserts.length, 1);
  assert.equal(writes.inserts[0].table, "push_engagement_events");
});
