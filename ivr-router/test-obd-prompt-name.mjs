import test from "node:test";
import assert from "node:assert/strict";
import { obdSafeFileName } from "./lib/obdApiClient.js";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// The third live run got past TTS and died on the upload:
//
//   Voice upload failed: HTTP 400 —
//   {"message":"File Name only accepts digits, alphabets,minus and underscore."}
//
// The name was FLEXI_BL_20260916.mp3. The dot is the whole problem, and the
// extension was never information the dialler needed: fileType carries it.

test("the extension comes off, because the dot is what OBD refuses", () => {
  assert.equal(obdSafeFileName("FLEXI_BL_20260916.mp3"), "FLEXI_BL_20260916");
  assert.equal(obdSafeFileName("prompt.wav"), "prompt");
});

test("what comes back contains only what the dialler allows", () => {
  for (const input of [
    "FLEXI_BL_20260916.mp3",
    "a name with spaces.mp3",
    "weird/slashes\\and:colons",
    "Flexiloans (Epimoney).mp3",
  ]) {
    assert.match(obdSafeFileName(input), /^[A-Za-z0-9_-]+$/, `rejected: ${input}`);
  }
});

test("a name with no extension is left alone", () => {
  assert.equal(obdSafeFileName("FLEXI_BL_20260916"), "FLEXI_BL_20260916");
  assert.equal(obdSafeFileName("BL-FLEXI-1"), "BL-FLEXI-1");
});

test("a dot inside the name is not mistaken for an extension", () => {
  // Only a trailing .ext comes off; an interior dot is just an illegal char.
  assert.equal(obdSafeFileName("v1.2_campaign"), "v1_2_campaign");
});

test("an empty name is refused by name, not by a vague 400", () => {
  // The dialler's own answer to this is the same unhelpful 400 that cost a run.
  assert.throws(() => obdSafeFileName(""), /needs a file name/);
  assert.throws(() => obdSafeFileName("...."), /needs a file name/);
  assert.throws(() => obdSafeFileName(null), /needs a file name/);
  // A name with nothing OBD can represent is the same case: "नमस्ते" would
  // sanitise to "______", which the dialler accepts and nobody can ever find
  // in the prompt list again.
  assert.throws(() => obdSafeFileName("नमस्ते.mp3"), /needs a file name/);
});

test("the campaign's own prompt name survives the round trip", async () => {
  const sent = [];
  const deps = {
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112", best_score: 99 }], error: null }) },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3bytes") }) },
    obd: {
      uploadVoiceFile: async (_a, name) => (sent.push(name), { promptId: "p1" }),
      uploadBaseFile: async () => ({ baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on", FLEXI_CAMPAIGN_CAP: "10" },
  };
  await runFlexiloansCampaign(deps, { cap: 1, stamp: "20260916" });
  // What the orchestrator hands over is still the dotted name — the client is
  // where the dialler's rule is enforced, so every caller gets it.
  assert.equal(sent.length, 1);
  assert.match(obdSafeFileName(sent[0]), /^[A-Za-z0-9_-]+$/);
  assert.equal(obdSafeFileName(sent[0]), "FLEXI_BL_20260916");
});

// ── run 5: OBD contradicted run 4 ────────────────────────────────────────────
//
//   fileName "FLEXI_BL_20260916.mp3" -> "File Name only accepts digits,
//                                        alphabets,minus and underscore."
//   fileName "FLEXI_BL_20260916"     -> "Only accepts .wav or .mp3 file ext"
//
// Two fields, two opposite rules. Sending one string for both cannot satisfy
// them, which is what run 5 proved.

import OBDApiClient from "./lib/obdApiClient.js";

async function capturedUpload(fileName, fileType) {
  const client = new OBDApiClient();
  client.token = "t";
  client.userId = "u";
  client.ensureToken = async () => {};
  const original = globalThis.fetch;
  let form = null;
  globalThis.fetch = async (_url, init) => {
    form = init.body;
    return { ok: true, status: 200, json: async () => ({ promptId: 1 }), text: async () => "" };
  };
  try {
    await client.uploadVoiceFile(Buffer.from("ID3bytes"), fileName, "campaign", fileType);
  } finally {
    globalThis.fetch = original;
  }
  return form;
}

test("the fileName FIELD carries no extension — run 4's error", async () => {
  const form = await capturedUpload("FLEXI_BL_20260916.mp3", "mp3");
  assert.equal(form.get("fileName"), "FLEXI_BL_20260916");
  assert.doesNotMatch(form.get("fileName"), /\./, "a dot in fileName is what OBD refused");
});

test("the uploaded FILE keeps its extension — run 5's error", async () => {
  const form = await capturedUpload("FLEXI_BL_20260916.mp3", "mp3");
  assert.equal(form.get("waveFile").name, "FLEXI_BL_20260916.mp3");
});

test("the extension follows fileType, not whatever the caller typed", async () => {
  // A caller naming it .mp3 while declaring wav would otherwise upload a file
  // whose extension contradicts the type field the dialler reads.
  const form = await capturedUpload("PROMPT.mp3", "wav");
  assert.equal(form.get("waveFile").name, "PROMPT.wav");
  assert.equal(form.get("fileName"), "PROMPT");
});

test("the two fields are never the same string", async () => {
  // The single fix that satisfied run 4 broke run 5 precisely because they were.
  const form = await capturedUpload("FLEXI_BL_20260916.mp3", "mp3");
  assert.notEqual(form.get("fileName"), form.get("waveFile").name);
});
