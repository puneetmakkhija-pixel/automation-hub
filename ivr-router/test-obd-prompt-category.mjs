import test from "node:test";
import assert from "node:assert/strict";
import OBDApiClient, { OBD_PROMPT_CATEGORIES } from "./lib/obdApiClient.js";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// Run 10, once the 200-body check stopped hiding it:
//
//   Voice upload failed: HTTP 200 — Invalid Voice Category.
//
// The campaign had always uploaded with promptCategory "campaign". OBD has no
// such category. The 376 prompts already in the account say what it does have:
// menu 218, welcome 143, thanks 12, noagent 2, wronginput 1.

test("the categories are the ones the account actually uses", () => {
  for (const real of ["menu", "welcome", "thanks", "noagent", "wronginput"]) {
    assert.ok(OBD_PROMPT_CATEGORIES.includes(real), `${real} is used by real prompts`);
  }
  assert.ok(!OBD_PROMPT_CATEGORIES.includes("campaign"),
    "'campaign' is what the run sent for ten attempts and OBD has never had it");
});

function client() {
  const c = new OBDApiClient();
  c.token = "t"; c.userId = "u"; c.ensureToken = async () => {};
  return c;
}

test("a category OBD does not have is refused before the request", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    await assert.rejects(
      () => client().uploadVoiceFile(Buffer.from("ID3"), "P.mp3", "campaign", "mp3"),
      /needs one of \[welcome, menu, thanks, noagent, wronginput\]; got "campaign"/
    );
    assert.equal(called, false, "no point spending a round trip on a known-bad value");
  } finally { globalThis.fetch = original; }
});

test("a missing category is refused too", async () => {
  await assert.rejects(
    () => client().uploadVoiceFile(Buffer.from("ID3"), "P.mp3", undefined, "mp3"),
    /needs one of/
  );
});

test("every real category is accepted", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: "ok" }), text: async () => "" });
  try {
    for (const category of OBD_PROMPT_CATEGORIES) {
      await client().uploadVoiceFile(Buffer.from("ID3"), "P.mp3", category, "mp3");
    }
  } finally { globalThis.fetch = original; }
});

test("the category reaches the dialler as sent", async () => {
  const original = globalThis.fetch;
  let form = null;
  globalThis.fetch = async (_u, init) => {
    form = init.body;
    return { ok: true, status: 200, json: async () => ({ message: "ok" }), text: async () => "" };
  };
  try {
    await client().uploadVoiceFile(Buffer.from("ID3"), "P.mp3", "menu", "mp3");
    assert.equal(form.get("promptCategory"), "menu");
  } finally { globalThis.fetch = original; }
});

test("the campaign uploads its press-1 prompt as a menu", async () => {
  const sent = [];
  const deps = {
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112" }], error: null }) },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async (_a, _n, category) => (sent.push(category), { promptId: "p1" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async () => ({ baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
  await runFlexiloansCampaign(deps, { cap: 1, stamp: "20260916" });
  // The team's own BL_FLEXI_PRESS1_2.wav and BL_FLEXI_2.wav are both "menu",
  // as is the generic DTMF.wav. A prompt that asks for a keypress is a menu.
  assert.equal(sent[0], "menu");
  assert.ok(OBD_PROMPT_CATEGORIES.includes(sent[0]));
});
