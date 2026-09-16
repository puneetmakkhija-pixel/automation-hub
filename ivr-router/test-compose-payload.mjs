import test from "node:test";
import assert from "node:assert/strict";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";
import { CampaignTypes, PromptCategories } from "./lib/campaignTemplates.js";

// Compose answered HTTP 400 with an empty body while holding a valid promptId
// and a valid baseId. It was not approval and it was not the ids: the payload
// shared NO FIELD with what OBD accepts. campaignTemplates.js has carried the
// real contract all along -- /api/obd/campaigns/dtmf uses it -- and this
// function hand-built its own:
//
//   sent                             wanted
//   campaignType: "DTMF" (string)    templateId: 1 (number)
//   promptId                         menuPId
//   dtmfKeys: [{key, action}]        dtmf: "1"

function deps(capture = {}) {
  return {
    sb: { rpc: async (fn) => fn === "record_campaign_dispatch"
            ? { data: 1, error: null } : { data: [{ mobile10: "9990001112" }], error: null } },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "68302" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async () => ({ baseId: "2774571" }),
      composeCampaign: async (cfg) => (capture.cfg = cfg, { campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
}

async function compose(opts = {}) {
  const cap = {};
  await runFlexiloansCampaign(deps(cap), { testMobile: "9355333379", ...opts });
  return cap.cfg;
}

test("templateId, a number, not campaignType, a string", async () => {
  const cfg = await compose();
  assert.equal(cfg.templateId, CampaignTypes.DTMF);
  assert.equal(cfg.templateId, 1);
  assert.equal(cfg.campaignType, undefined, "campaignType is not a field OBD has");
});

test("the prompt goes in menuPId", async () => {
  const cfg = await compose();
  assert.equal(cfg.menuPId, "68302");
  assert.equal(cfg.promptId, undefined, "promptId is not a field OBD has");
  // And this is why the category had to be "menu".
  assert.equal(PromptCategories.MENU, "menu");
});

test("dtmf is the string '1', not a list of key objects", async () => {
  const cfg = await compose();
  assert.equal(cfg.dtmf, "1");
  assert.equal(cfg.dtmfKeys, undefined, "dtmfKeys is not a field OBD has");
});

test("the baseId still reaches it", async () => {
  assert.equal((await compose()).baseId, "2774571");
});

test("every field the template defines is present", async () => {
  const cfg = await compose();
  // A partial payload is what an empty-bodied 400 is made of; the template
  // exists precisely so none of these is forgotten.
  for (const field of [
    "campaignName", "templateId", "dtmf", "baseId",
    "welcomePId", "menuPId", "noInputPId", "wrongInputPId", "thanksPId",
    "scheduleTime", "smsSuccessApi", "smsFailApi", "smsDtmfApi",
    "callDurationSMS", "retries", "retryInterval", "agentRows",
    "menuWaitTime", "rePrompt", "location", "clis", "webhook", "webhookId",
    "ttsRows", "gender", "language", "noAgentId",
    "callPatchSuccessMessage", "callPatchFailMessage",
  ]) {
    assert.ok(field in cfg, `missing ${field}`);
  }
});

test("scheduleTime is the format OBD takes, not an ISO string", async () => {
  const cfg = await compose();
  assert.match(cfg.scheduleTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.doesNotMatch(cfg.scheduleTime, /T|Z/);
});

test("a caller can set any template field without a deploy", async () => {
  const cfg = await compose({ campaignConfig: { webhook: true, webhookId: "wh-7", retries: 1 } });
  assert.equal(cfg.webhook, true);
  assert.equal(cfg.webhookId, "wh-7");
  assert.equal(cfg.retries, 1);
  // ...and the fields it did not set keep the template's defaults.
  assert.equal(cfg.templateId, CampaignTypes.DTMF);
  assert.equal(cfg.menuPId, "68302");
});

test("an override cannot quietly change which prompt or base is dialled", async () => {
  const cfg = await compose({ campaignConfig: { retries: 3 } });
  assert.equal(cfg.menuPId, "68302");
  assert.equal(cfg.baseId, "2774571");
});
