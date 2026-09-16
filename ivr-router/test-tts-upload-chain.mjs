import test from "node:test";
import assert from "node:assert/strict";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// The chain that silently broke a 50,000-call campaign:
//   makeRequest read audio/mpeg as TEXT (POST never matched its GET-only branch)
//   -> textToSpeech wrapped it { success, audio }
//   -> the orchestrator passed the WRAPPER to the uploader
//   -> FormData stringified it to "[object Object]"
//   -> OBD rejected it, and the error said "Voice upload failed: " and nothing more.

function deps({ tts, obd } = {}) {
  const calls = [];
  return {
    calls,
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112", best_score: 99 }], error: null }) },
    tts: tts ?? {
      textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3fakemp3bytes") }),
    },
    obd: obd ?? {
      uploadVoiceFile: async (...a) => (calls.push(["prompt", ...a]), { promptId: "p1" }),
      uploadBaseFile: async (...a) => (calls.push(["contacts", ...a]), { baseId: "b1" }),
      composeCampaign: async (...a) => (calls.push(["campaign", ...a]), { campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on", FLEXI_CAMPAIGN_CAP: "10" },
  };
}

test("the uploader receives BYTES, never the textToSpeech wrapper", async () => {
  const d = deps();
  await runFlexiloansCampaign(d, { cap: 1 });
  const prompt = d.calls.find((c) => c[0] === "prompt");
  assert.ok(prompt, "voice upload never happened");
  const sent = prompt[1];
  // The exact failure: an object with .audio on it reaching the dialler.
  assert.ok(!(sent && typeof sent === "object" && "audio" in sent),
    "the wrapper object reached the uploader — this is the 50,000-call bug");
  assert.equal(Buffer.from(sent).toString(), "ID3fakemp3bytes");
});

test("a bare buffer still works, because obdRoutes passes one", async () => {
  const d = deps({ tts: { textToSpeech: async () => Buffer.from("rawbytes") } });
  await runFlexiloansCampaign(d, { cap: 1 });
  const prompt = d.calls.find((c) => c[0] === "prompt");
  assert.equal(Buffer.from(prompt[1]).toString(), "rawbytes");
});

test("a failed TTS stops the run instead of uploading nothing", async () => {
  // textToSpeech RESOLVES on failure rather than throwing, so without this
  // check the campaign uploaded garbage and carried on to dial people.
  const d = deps({
    tts: { textToSpeech: async () => ({ success: false, error: "quota exceeded" }) },
  });
  await assert.rejects(() => runFlexiloansCampaign(d, { cap: 1 }), /TTS failed: quota exceeded/);
  assert.equal(d.calls.length, 0, "nothing should have been uploaded");
});

test("empty audio stops the run", async () => {
  const d = deps({ tts: { textToSpeech: async () => ({ success: true, audio: Buffer.alloc(0) }) } });
  await assert.rejects(() => runFlexiloansCampaign(d, { cap: 1 }), /no audio bytes/);
  assert.equal(d.calls.length, 0);
});

test("the reported byte count is the real one", async () => {
  const d = deps();
  const out = await runFlexiloansCampaign(d, { cap: 1 });
  const step = out.steps.find((s) => s.step === "tts");
  assert.equal(step.bytes, 15, "bytes was null before, because it read .length off the wrapper");
});
