import test from "node:test";
import assert from "node:assert/strict";
import ElevenLabsClient, { describeElevenLabsFailure } from "./lib/elevenLabsClient.js";
import {
  runFlexiloansCampaign,
  IVR_SCRIPT,
  IVR_MODEL_ID,
} from "./lib/flexiloansCampaignOrchestrator.js";

// The second live run's failure, in one line:
//   {"ok":false,"error":"TTS failed: POST /text-to-speech/rqIg3iVrlZOAkxCMdelQ
//    failed with HTTP 400"}
//
// The voice is fine — Aarohi is a native Hindi voice whose profile lists IVR.
// elevenLabsClient's DEFAULT model is eleven_monolingual_v1, which is English
// only, and the orchestrator passed no model at all. A Devanagari script under
// an English-only model is an HTTP 400 every time.

/** Every model that cannot read the script. */
const ENGLISH_ONLY = ["eleven_monolingual_v1", "eleven_english_sts_v2"];

function deps({ tts } = {}) {
  const seen = [];
  return {
    seen,
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112", best_score: 99 }], error: null }) },
    tts: tts ?? {
      textToSpeech: async (o) => (seen.push(o), { success: true, audio: Buffer.from("ID3bytes") }),
    },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      uploadBaseFile: async () => ({ baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on", FLEXI_CAMPAIGN_CAP: "10" },
  };
}

test("the campaign names a model rather than taking the client's default", async () => {
  const d = deps();
  await runFlexiloansCampaign(d, { cap: 1 });
  assert.equal(d.seen.length, 1);
  assert.ok(d.seen[0].modelId, "no model was passed — the English-only default applies");
});

test("the model the Hindi script goes out under is never English-only", async () => {
  const d = deps();
  await runFlexiloansCampaign(d, { cap: 1 });
  assert.ok(!ENGLISH_ONLY.includes(d.seen[0].modelId),
    `${d.seen[0].modelId} cannot read Devanagari — this is the HTTP 400`);
  assert.equal(d.seen[0].modelId, IVR_MODEL_ID);
});

test("the script really is Devanagari, which is why the model matters", () => {
  assert.ok(/[ऀ-ॿ]/.test(IVR_SCRIPT), "script is not Devanagari");
  assert.ok(!ENGLISH_ONLY.includes(IVR_MODEL_ID));
  assert.match(IVR_MODEL_ID, /multilingual|flash_v2_5|turbo_v2_5/);
});

test("a caller may still override the model", async () => {
  const d = deps();
  await runFlexiloansCampaign(d, { cap: 1, modelId: "eleven_flash_v2_5" });
  assert.equal(d.seen[0].modelId, "eleven_flash_v2_5");
});

test("the client sends the model it is given, in the request body", async () => {
  const original = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      headers: { get: () => "audio/mpeg" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      text: async () => "", json: async () => ({}),
    };
  };
  try {
    const res = await new ElevenLabsClient("k").textToSpeech({
      text: IVR_SCRIPT, voiceId: "v1", modelId: IVR_MODEL_ID,
    });
    assert.equal(res.success, true);
    assert.equal(body.model_id, IVR_MODEL_ID);
  } finally {
    globalThis.fetch = original;
  }
});

// ── the failure has to say WHY ───────────────────────────────────────────────
// "failed with HTTP 400" cost a round trip to ElevenLabs' docs to diagnose.
// The body said it outright; the error captured the body and dropped it.

test("a 400 tells you what ElevenLabs objected to", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 400,
    headers: { get: () => "application/json" },
    json: async () => ({
      detail: { status: "invalid_model", message: "eleven_monolingual_v1 does not support hi" },
    }),
    text: async () => "", arrayBuffer: async () => new ArrayBuffer(0),
  });
  try {
    const res = await new ElevenLabsClient("k").textToSpeech({ text: "नमस्ते", voiceId: "v1" });
    assert.equal(res.success, false);
    assert.match(res.error, /HTTP 400/);
    assert.match(res.error, /does not support hi/, "the reason was dropped from the error");
  } finally {
    globalThis.fetch = original;
  }
});

test("describeElevenLabsFailure handles every body shape the API returns", () => {
  const mk = (response) => Object.assign(new Error("POST /x failed with HTTP 400"), { response });
  assert.equal(describeElevenLabsFailure(mk(null)), "POST /x failed with HTTP 400");
  assert.match(describeElevenLabsFailure(mk({ detail: "quota exceeded" })), /quota exceeded$/);
  assert.match(describeElevenLabsFailure(mk({ detail: { message: "bad voice" } })), /bad voice$/);
  assert.match(describeElevenLabsFailure(mk({ detail: { status: "voice_not_found" } })), /voice_not_found$/);
  assert.match(
    describeElevenLabsFailure(mk({ detail: [{ msg: "field required" }, { msg: "nope" }] })),
    /field required; nope$/);
  // Audio bodies are bytes; stringifying a Buffer into a log line helps nobody.
  assert.equal(describeElevenLabsFailure(mk(Buffer.from([1, 2]))), "POST /x failed with HTTP 400");
  // Bounded, because this reaches an HTTP response body.
  assert.ok(describeElevenLabsFailure(mk({ detail: "x".repeat(5000) })).length < 400);
});

test("a TTS failure still stops the campaign, now with the reason", async () => {
  const d = deps({
    tts: { textToSpeech: async () => ({ success: false, error: "HTTP 400: does not support hi" }) },
  });
  await assert.rejects(() => runFlexiloansCampaign(d, { cap: 1 }),
    /TTS failed: HTTP 400: does not support hi/);
});
