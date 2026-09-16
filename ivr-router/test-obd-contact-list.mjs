import test from "node:test";
import assert from "node:assert/strict";
import OBDApiClient from "./lib/obdApiClient.js";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// The base upload refuses BOTH ways, and differently each time:
//
//   contactList: null   ->  200 {"message":"File Upload Failed"}   (run 9)
//   field absent        ->  400, empty body                        (test call)
//
// Two different refusals means the field is not ignored. #91 removed it on the
// argument that the literal string "null" is indefensible — true, and the wrong
// conclusion: "send it correctly" and "do not send it" are different fixes, and
// only one of them had been tried.

function capture() {
  const c = new OBDApiClient();
  c.token = "t"; c.userId = "u"; c.ensureToken = async () => {};
  const original = globalThis.fetch;
  const seen = {};
  globalThis.fetch = async (_u, init) => {
    seen.form = init.body;
    return { ok: true, status: 200, json: async () => ({ baseId: 1 }), text: async () => "" };
  };
  return { c, seen, restore: () => { globalThis.fetch = original; } };
}

test("the field is sent again", async () => {
  const { c, seen, restore } = capture();
  try {
    await c.uploadBaseFile("mobile,name\n9990001112,X\n", "B");
    assert.ok(seen.form.has("contactList"), "removing it produced a 400 with no body");
  } finally { restore(); }
});

test("and never as the string 'null'", async () => {
  const { c, seen, restore } = capture();
  try {
    await c.uploadBaseFile("mobile,name\n9990001112,X\n", "B");
    assert.notEqual(seen.form.get("contactList"), "null",
      "FormData stringifies null to the word 'null' — that is what got File Upload Failed");
    assert.equal(seen.form.get("contactList"), "", "absent value means an empty field, not junk");
  } finally { restore(); }
});

test("a caller can supply any value, since the right one is not yet known", async () => {
  for (const value of ["9990001112", "9990001112,9990001113", "0", ""]) {
    const { c, seen, restore } = capture();
    try {
      await c.uploadBaseFile("csv", "B", value);
      assert.equal(seen.form.get("contactList"), value);
    } finally { restore(); }
  }
});

test("null and undefined both become an empty field, never 'null'", async () => {
  for (const value of [null, undefined]) {
    const { c, seen, restore } = capture();
    try {
      await c.uploadBaseFile("csv", "B", value);
      assert.equal(seen.form.get("contactList"), "");
    } finally { restore(); }
  }
});

test("the campaign passes its option straight through", async () => {
  const seen = {};
  const deps = {
    sb: { rpc: async (fn) => fn === "record_campaign_dispatch"
            ? { data: 1, error: null }
            : { data: [{ mobile10: "9990001112" }], error: null } },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async (_csv, _name, contactList) => (seen.contactList = contactList, { baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
  await runFlexiloansCampaign(deps, { testMobile: "9355333379", contactList: "9355333379" });
  assert.equal(seen.contactList, "9355333379");
});

test("no option means an empty field, not the word null", async () => {
  const seen = {};
  const deps = {
    sb: { rpc: async (fn) => fn === "record_campaign_dispatch"
            ? { data: 1, error: null }
            : { data: [{ mobile10: "9990001112" }], error: null } },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async (_csv, _name, contactList) => (seen.contactList = contactList, { baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
  await runFlexiloansCampaign(deps, { testMobile: "9355333379" });
  assert.equal(seen.contactList, "");
});
