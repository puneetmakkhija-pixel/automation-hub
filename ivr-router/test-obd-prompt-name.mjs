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
