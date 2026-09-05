/**
 * A nested callback still has to name its caller.
 *
 *   node test-voice-outcome-fields.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * The fixture below is a REAL Oriserve callback, copied from
 * crm.voice_call_events.raw on 5 Sep 2026 with the mobile changed. That matters:
 * the bug this guards was not a missing key, it was an assumption about shape.
 * A payload I invented would have been shaped the way I already believed, and
 * would have passed against the broken reader.
 */
import assert from "node:assert/strict";
import { readVoiceOutcome } from "./lib/voiceOutcomeFields.js";

/** Verbatim structure of a live Oriserve callback; mobile replaced. */
const ORISERVE = {
  call: {
    bot_id: "cd3c5ee6-5e1b-48b6-909a-18581eaa1c60",
    source: "ivr_keypress_webhook",
    purpose: "press1_qualification",
    bot_name: "Buddy Loan | Business Loan",
    caller_id: "+919876543210",
    unique_id: "",
    from_number: "+918031806342",
    ivr_variant: "businessloans",
    _campaign_id: "6a969a1c91b08220629d6b88",
    _campaign_call_id: "6a9b9bb20e5c7260fe276b43",
    ivr_campaign_id: "1172933",
    ivr_campaign_name: "totalfile_5sep_",
    callback_reason: "",
  },
  result: {
    status: "QUALIFIED_LEAD",
    call_id: "campaign-6a9b9bb31231431ed3c323d4",
    disposition: "Connected",
    transfer_at: "",
    call_end_time: "2026-09-05 10:04:04",
    recording_url: "https://api-buddy-loan-vox.oriserve.com/api/v1/public/recordings/f2tWL",
    call_start_time: "2026-09-05 10:03:59",
    disconnected_by: "customer",
    was_transferred: "no",
    call_duration_seconds: "157",
  },
  analysis: { disposition: "QUALIFIED_LEAD", summary: "", callSummary: "" },
  qc: { remarks: "", empathy_score: "", overall_score: "", compliance_score: "" },
};

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log("\nthe real oriserve shape\n");

check("every field is read out of the live payload", () => {
  const r = readVoiceOutcome(ORISERVE);
  assert.equal(r.mobile, "+919876543210");
  assert.equal(r.status, "QUALIFIED_LEAD");
  assert.equal(r.callId, "campaign-6a9b9bb31231431ed3c323d4");
  assert.equal(r.duration, 157);
});

check("the caller is the person we rang, never our own line", () => {
  // from_number is +918031806342 on all 719 live callbacks. A reader that
  // matched it would file every call against one fictional lead.
  const r = readVoiceOutcome(ORISERVE);
  assert.notEqual(r.mobile, ORISERVE.call.from_number);
  assert.equal(r.mobile, ORISERVE.call.caller_id);
});

check("dead air is not reported as a success", () => {
  // result.disposition reads "Connected" for dead air AND for a qualified
  // lead. Taking it in preference to result.status would turn 99 silent calls
  // into successes.
  const r = readVoiceOutcome({
    ...ORISERVE,
    result: { ...ORISERVE.result, status: "DEAD AIR", call_duration_seconds: "5" },
  });
  assert.equal(r.status, "DEAD AIR");
  assert.equal(r.duration, 5);
});

check("a failed call keeps its zero duration", () => {
  // 333 of the 719 were "failed" at 0 seconds. Zero is a fact; null is not.
  const r = readVoiceOutcome({
    ...ORISERVE,
    result: { ...ORISERVE.result, status: "failed", call_duration_seconds: "0" },
  });
  assert.equal(r.status, "failed");
  assert.equal(r.duration, 0);
});

console.log("\nblank and absent are the same thing\n");

check("empty strings are skipped, not stored", () => {
  const r = readVoiceOutcome({
    call: { caller_id: "", from_number: "+918031806342" },
    result: { status: "  ", call_id: "" },
  });
  assert.equal(r.mobile, null);
  assert.equal(r.status, null);
  assert.equal(r.callId, null);
});

check('the literal string "null" is skipped', () => {
  // utm_content arrives as the four characters n-u-l-l in this feed.
  const r = readVoiceOutcome({ call: { caller_id: "null" }, result: { status: "null" } });
  assert.equal(r.mobile, null);
  assert.equal(r.status, null);
});

check("a missing duration is null, not zero", () => {
  const r = readVoiceOutcome({ result: { status: "RNR" } });
  assert.equal(r.duration, null);
});

check("a negative duration is refused", () => {
  const r = readVoiceOutcome({ result: { call_duration_seconds: "-4" } });
  assert.equal(r.duration, null);
});

console.log("\nthe old flat shape still works\n");

check("a flat payload reads exactly as before", () => {
  const r = readVoiceOutcome({
    mobile: "9876543210",
    status: "answered",
    call_id: "abc-1",
    duration_sec: 42,
  });
  assert.deepEqual(r, { mobile: "9876543210", status: "answered", callId: "abc-1", duration: 42 });
});

check("nested wins over flat when both are present", () => {
  // The nested one is the provider's own; a flat key beside it is likelier to
  // be an envelope field than the call's own outcome.
  const r = readVoiceOutcome({ ...ORISERVE, status: "envelope-status" });
  assert.equal(r.status, "QUALIFIED_LEAD");
});

console.log("\nnothing throws on rubbish\n");

check("junk input returns four nulls rather than throwing", () => {
  for (const bad of [null, undefined, "a string", 42, [], [{ status: "x" }]]) {
    const r = readVoiceOutcome(bad);
    assert.deepEqual(r, { mobile: null, callId: null, status: null, duration: null });
  }
});

check("a nested value that is not an object is ignored", () => {
  const r = readVoiceOutcome({ call: "not-an-object", result: 7 });
  assert.equal(r.mobile, null);
  assert.equal(r.status, null);
});

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
