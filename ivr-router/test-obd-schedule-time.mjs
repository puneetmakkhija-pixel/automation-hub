import test from "node:test";
import assert from "node:assert/strict";
import { obdScheduleTime, createDtmfCampaign, createSimpleIvrCampaign, createCallPatchCampaign }
  from "./lib/campaignTemplates.js";

// With the payload finally in a shape OBD recognises, it named the one field
// that was wrong:
//
//   {"message":"Invalid Schedule Date and Time !!"}
//
// The templates built scheduleTime from new Date().toISOString() -- UTC. OBD is
// an Indian dialler and reads the string as IST, so a campaign composed at
// 10:14 UTC asked to be scheduled at 10:14 IST: five and a half hours in the
// past, every time.

const AT = new Date("2026-09-16T10:14:35Z"); // 15:44:35 IST

test("the time is IST, not UTC", () => {
  // UTC would be 10:14; IST at that instant is 15:44.
  assert.equal(obdScheduleTime(AT, 0), "2026-09-16 15:44:35");
});

test("it is never in the past, which is what 'Invalid' meant", () => {
  const scheduled = obdScheduleTime(AT);
  const istNow = new Date(AT.getTime() + (5 * 60 + 30) * 60000)
    .toISOString().slice(0, 19).replace("T", " ");
  assert.ok(scheduled > istNow, `${scheduled} must be after ${istNow}`);
});

test("the lead is two minutes by default", () => {
  assert.equal(obdScheduleTime(AT), "2026-09-16 15:46:35");
});

test("the format is what OBD takes — no T, no Z, no milliseconds", () => {
  const out = obdScheduleTime(AT);
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.doesNotMatch(out, /[TZ.]/);
});

test("it rolls the date when IST crosses midnight", () => {
  // 19:00 UTC on the 16th is 00:30 IST on the 17th. A campaign composed in the
  // evening must not be scheduled for yesterday.
  assert.match(obdScheduleTime(new Date("2026-09-16T19:00:00Z"), 0), /^2026-09-17 00:30:00$/);
});

test("all three templates carry it, not just the one that was being used", () => {
  for (const make of [createSimpleIvrCampaign, createDtmfCampaign, createCallPatchCampaign]) {
    const cfg = make({ campaignName: "C", baseId: "b", menuPromptId: "p", agents: [], agentGroups: [] });
    assert.match(cfg.scheduleTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, make.name);
    // The UTC bug was in every one of them.
    const utcNow = new Date().toISOString().slice(0, 19).replace("T", " ");
    assert.ok(cfg.scheduleTime > utcNow, `${make.name} scheduled at ${cfg.scheduleTime}, UTC now ${utcNow}`);
  }
});

test("an explicit scheduleTime is still honoured", () => {
  const cfg = createDtmfCampaign({
    campaignName: "C", baseId: "b", menuPromptId: "p",
    scheduleTime: "2026-12-25 09:00:00",
  });
  assert.equal(cfg.scheduleTime, "2026-12-25 09:00:00");
});
