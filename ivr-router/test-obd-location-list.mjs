import test from "node:test";
import assert from "node:assert/strict";
import { createDtmfCampaign, createSimpleIvrCampaign, createCallPatchCampaign }
  from "./lib/campaignTemplates.js";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// The dialler, twice in a row on an otherwise complete payload:
//
//   {"message":"locationList is missing"}
//
// It is a SEPARATE field from `location`, which the templates were already
// sending, and nothing here had ever sent it.

test("locationList is sent, and is not the same field as location", () => {
  const cfg = createDtmfCampaign({ campaignName: "C", baseId: "b", menuPromptId: "p" });
  assert.ok("locationList" in cfg, "the dialler asked for this by name");
  assert.ok("location" in cfg, "and still wants the one we were already sending");
});

test("it is a list, by this file's own convention", () => {
  const cfg = createDtmfCampaign({ campaignName: "C", baseId: "b", menuPromptId: "p" });
  // Everything here is stringified: '[]' for list-shaped fields (ttsRows),
  // '{}' for object-shaped ones (location, smsSuccessApi). A locationList is
  // a list, and an empty one means no location filter.
  assert.equal(cfg.locationList, "[]");
  assert.equal(cfg.ttsRows, "[]", "the convention it follows");
  assert.equal(cfg.location, "{}", "the convention it does not");
});

test("all three templates carry it", () => {
  for (const make of [createSimpleIvrCampaign, createDtmfCampaign, createCallPatchCampaign]) {
    const cfg = make({ campaignName: "C", baseId: "b", menuPromptId: "p", agents: [], agentGroups: [] });
    assert.equal(cfg.locationList, "[]", make.name);
  }
});

test("a caller can set it, since an empty list is a guess about intent", () => {
  const cfg = createDtmfCampaign({
    campaignName: "C", baseId: "b", menuPromptId: "p",
    locationList: '["MH","KA"]',
  });
  assert.equal(cfg.locationList, '["MH","KA"]');
});

test("the campaign passes it through from the request body", async () => {
  const seen = {};
  const deps = {
    sb: { rpc: async (fn) => fn === "record_campaign_dispatch"
            ? { data: 1, error: null } : { data: [{ mobile10: "9990001112" }], error: null } },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async () => ({ baseId: "b1" }),
      composeCampaign: async (cfg) => (seen.cfg = cfg, { campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
  await runFlexiloansCampaign(deps, { testMobile: "9355333379" });
  assert.equal(seen.cfg.locationList, "[]");

  await runFlexiloansCampaign(deps, {
    testMobile: "9355333379",
    campaignConfig: { locationList: '["DL"]' },
  });
  assert.equal(seen.cfg.locationList, '["DL"]');
});
