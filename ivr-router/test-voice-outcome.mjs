/**
 * A voice callback has to name its caller.
 *
 *   node test-voice-outcome.mjs
 *
 * Same shape as test-press-forward.mjs and for the same reason: this package
 * has no test runner, and the check is small enough that adding one would be a
 * bigger change than the code it guards. A stub stands in for supabase-js, so
 * this needs no credentials, no network and no database.
 *
 * What it holds: logVoiceCallOutcome() reads the caller for
 * public.webhook_events.ext_ref and must put the same value on the
 * crm.voice_call_events row. It used to read it and drop it, which left the
 * enrichment unable to reach a lead. Confirmed to fail when `mobile` is removed
 * from that insert.
 */
import assert from "node:assert/strict";
import SupabaseClient from "./lib/supabaseClient.js";

let inserts = [];

function stubClient() {
  const table = (schema) => (name) => ({
    insert: (row) => {
      inserts.push({ schema, table: name, row });
      return Promise.resolve({ error: null });
    },
  });
  return { from: table("public"), schema: (s) => ({ from: table(s) }) };
}

const db = new SupabaseClient("http://stub.invalid", "stub-key");
db.client = stubClient();

const row = (schema, name) =>
  inserts.find((i) => i.schema === schema && i.table === name)?.row;

let failed = 0;
const check = async (name, fn) => {
  inserts = [];
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log("\nlogVoiceCallOutcome");

await check("puts the caller on the voice_call_events row", async () => {
  const r = await db.logVoiceCallOutcome({
    provider: "oriserve",
    payload: { mobile: "9812345678", call_id: "c-1", status: "answered", call_duration: "42" },
  });
  assert.equal(r.success, true);
  const voice = row("crm", "voice_call_events");
  assert.ok(voice, "no crm.voice_call_events insert");
  assert.equal(voice.mobile, "9812345678", `mobile was ${JSON.stringify(voice.mobile)}`);
  assert.equal(voice.call_id, "c-1");
  assert.equal(voice.event_status, "answered");
  assert.equal(voice.duration_sec, 42);
});

await check("uses the same caller both tables see", async () => {
  await db.logVoiceCallOutcome({ provider: "oriserve", payload: { mobile: "9812345678" } });
  assert.equal(row("public", "webhook_events").ext_ref, "9812345678");
  assert.equal(row("crm", "voice_call_events").mobile, "9812345678");
});

await check("reads `phone` when the provider calls it that", async () => {
  await db.logVoiceCallOutcome({ provider: "deepcall", payload: { phone: "+919812345678" } });
  // Stored as sent — crm.voice_call_events.mobile10 does the normalising, so a
  // provider's formatting is never this writer's problem.
  assert.equal(row("crm", "voice_call_events").mobile, "+919812345678");
});

await check("a callback with no caller still lands, with a null mobile", async () => {
  const r = await db.logVoiceCallOutcome({ provider: "oriserve", payload: { call_id: "c-9" } });
  assert.equal(r.success, true, "the call happened; the row must not be lost over a missing field");
  assert.equal(row("crm", "voice_call_events").mobile, null);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
