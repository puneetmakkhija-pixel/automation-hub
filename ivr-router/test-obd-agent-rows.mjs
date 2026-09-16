import test from "node:test";
import assert from "node:assert/strict";
import {
  createSimpleIvrCampaign,
  createDtmfCampaign,
  createCallPatchCampaign,
} from "./lib/campaignTemplates.js";

// Compose answers 400 with a ZERO-BYTE body. Every earlier refusal named its
// field -- "locationList is missing", "Invalid Schedule Date and Time !!" -- so
// an empty one does not look like validation; it looks like the vendor threw
// before it could write a message.
//
// agentRows is the field shaped like a crash. Two templates send '""' (a
// JSON-encoded empty STRING) and the third, written by someone who knew the
// shape, sends JSON.stringify({patchList: [...]}) -- an OBJECT. A server doing
// JSON.parse(agentRows).patchList on a string throws exactly that way.
//
// Overridable, not changed blind: the default stays until the dialler says
// otherwise, and probe-compose can settle it in one request.

const base = { campaignName: "C", baseId: "1", menuPromptId: "68361" };

test("the default is unchanged, so this commit cannot alter a live campaign", () => {
  assert.equal(createDtmfCampaign(base).agentRows, '""');
  assert.equal(createSimpleIvrCampaign(base).agentRows, '""');
});

test("DTMF accepts an agentRows override", () => {
  assert.equal(createDtmfCampaign({ ...base, agentRows: "[]" }).agentRows, "[]");
  assert.equal(
    createDtmfCampaign({ ...base, agentRows: '{"patchList":[]}' }).agentRows,
    '{"patchList":[]}'
  );
});

test("simple IVR accepts one too", () => {
  assert.equal(createSimpleIvrCampaign({ ...base, agentRows: "{}" }).agentRows, "{}");
});

test("an empty-string override survives, rather than falling back to the default", () => {
  // ?? not ||: "" is a shape worth being able to send, and || would silently
  // replace it with '""' -- a DIFFERENT value, and the very one under suspicion.
  assert.equal(createDtmfCampaign({ ...base, agentRows: "" }).agentRows, "");
});

test("call patch still derives agentRows from its agent groups", () => {
  const out = createCallPatchCampaign({ ...base, agentGroups: [{ groupName: "g" }] });
  assert.deepEqual(JSON.parse(out.agentRows), { patchList: [{ groupName: "g" }] });
});

test("but an explicit agentRows beats the derived one on call patch too", () => {
  const out = createCallPatchCampaign({ ...base, agentGroups: [{ groupName: "g" }], agentRows: "[]" });
  assert.equal(out.agentRows, "[]");
});
