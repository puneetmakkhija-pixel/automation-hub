import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ElevenLabsClient, { DEFAULT_MODEL_ID, RETIRED_MODEL_IDS } from "./lib/elevenLabsClient.js";
import { IVR_MODEL_ID } from "./lib/flexiloansCampaignOrchestrator.js";

// ElevenLabs, asked to render anything under the old default:
//
//   "The models eleven_monolingual_v1 and eleven_multilingual_v1 have been
//    deprecated and are no longer available."
//
// It was hardcoded in three places, so /api/voice/tts, /api/voice/ivr-menu and
// /api/voice/greeting were all answering HTTP 400 for every caller in every
// language. #84 fixed the campaign by passing a model explicitly and left the
// default, and these three, exactly as broken.

function capture(body) {
  const original = globalThis.fetch;
  const sent = {};
  globalThis.fetch = async (_url, init) => {
    Object.assign(sent, JSON.parse(init.body));
    return {
      ok: true, status: 200,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => "", json: async () => ({}),
    };
  };
  return { sent, restore: () => { globalThis.fetch = original; } };
}

test("the default is a model that still exists", () => {
  assert.ok(!RETIRED_MODEL_IDS.includes(DEFAULT_MODEL_ID),
    `${DEFAULT_MODEL_ID} has been retired — every call using it is an HTTP 400`);
  assert.match(DEFAULT_MODEL_ID, /multilingual_v2|flash_v2_5|eleven_v3/);
});

test("/api/voice/tts renders under a live model", async () => {
  const { sent, restore } = capture();
  try {
    await new ElevenLabsClient("k").textToSpeech({ text: "Hello", voiceId: "v1" });
    assert.equal(sent.model_id, DEFAULT_MODEL_ID);
  } finally { restore(); }
});

test("/api/voice/ivr-menu does too", async () => {
  const { sent, restore } = capture();
  try {
    await new ElevenLabsClient("k").createIVRMenu({
      menuTitle: "Main menu", options: [{ digit: "1", label: "loans" }],
    });
    assert.ok(!RETIRED_MODEL_IDS.includes(sent.model_id), sent.model_id);
    assert.equal(sent.model_id, DEFAULT_MODEL_ID);
  } finally { restore(); }
});

test("/api/voice/greeting does too", async () => {
  const { sent, restore } = capture();
  try {
    await new ElevenLabsClient("k").generatePersonalizedGreeting({ customerName: "Rajesh" });
    assert.ok(!RETIRED_MODEL_IDS.includes(sent.model_id), sent.model_id);
    assert.equal(sent.model_id, DEFAULT_MODEL_ID);
  } finally { restore(); }
});

test("all three take an override, which two of them never did", async () => {
  for (const call of [
    (c, m) => c.textToSpeech({ text: "x", voiceId: "v", modelId: m }),
    (c, m) => c.createIVRMenu({ menuTitle: "t", options: [{ digit: "1", label: "l" }], modelId: m }),
    (c, m) => c.generatePersonalizedGreeting({ customerName: "R", modelId: m }),
  ]) {
    const { sent, restore } = capture();
    try {
      await call(new ElevenLabsClient("k"), "eleven_flash_v2_5");
      assert.equal(sent.model_id, "eleven_flash_v2_5");
    } finally { restore(); }
  }
});

test("no retired model id is sent from anywhere in this file", () => {
  // The source, not the behaviour: the bug was three copies of one id and one
  // of them being missed. A fourth call site added later is caught here on the
  // day it is written rather than on the day it is dialled.
  const src = readFileSync(new URL("./lib/elevenLabsClient.js", import.meta.url), "utf8");
  const sentModels = [...src.matchAll(/model_id:\s*'([^']+)'/g)].map((m) => m[1]);
  for (const id of sentModels) {
    assert.ok(!RETIRED_MODEL_IDS.includes(id), `a retired model is hardcoded: ${id}`);
  }
  // And the id must not be spelled out at each site at all.
  const literals = [...src.matchAll(/model_id:\s*'/g)];
  assert.equal(literals.length, 0,
    "model_id should come from a variable, so there is one place to change it");
});

test("the campaign's own model is not a retired one either", () => {
  // The orchestrator names its model rather than inheriting the default, which
  // is deliberate — it is the only caller that knows its script is Hindi. But
  // that makes it a SECOND copy of a model id, and the lesson of this whole
  // change is that a second copy is how one of them gets left behind.
  assert.ok(!RETIRED_MODEL_IDS.includes(IVR_MODEL_ID),
    `${IVR_MODEL_ID} has been retired — the broadcast would 400 on every run`);
});
