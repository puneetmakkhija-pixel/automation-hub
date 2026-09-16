import test from "node:test";
import assert from "node:assert/strict";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// Run 7 reached step 5 — the first run ever to — and came back with:
//
//   {"ok":false,"error":"Compose campaign failed: HTTP 400"}
//
// An empty body from the dialler, and the steps[] the run had already
// collected were thrown away with the exception. So whether it composed with
// real ids or with nulls was unknowable, and that is a whole cycle spent.

function deps(obdOverrides = {}) {
  return {
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112", best_score: 99 }], error: null }) },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3bytes") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      uploadBaseFile: async () => ({ baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
      ...obdOverrides,
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on", FLEXI_CAMPAIGN_CAP: "10" },
  };
}

test("a failure carries the steps it got through", async () => {
  const d = deps({ composeCampaign: async () => { throw new Error("Compose campaign failed: HTTP 400"); } });
  const err = await runFlexiloansCampaign(d, { cap: 1 }).then(() => null, (e) => e);
  assert.ok(err, "should have thrown");
  assert.ok(Array.isArray(err.steps), "steps did not ride along on the error");
  assert.deepEqual(err.steps.map((s) => s.step), ["base", "tts", "prompt", "contacts"]);
});

test("the steps say which ids the compose would have used", async () => {
  const d = deps({ composeCampaign: async () => { throw new Error("boom"); } });
  const err = await runFlexiloansCampaign(d, { cap: 1 }).then(() => null, (e) => e);
  assert.equal(err.steps.find((s) => s.step === "prompt").id, "p1");
  assert.equal(err.steps.find((s) => s.step === "contacts").id, "b1");
});

test("the steps name the fields the dialler actually returned", async () => {
  // The whole question run 7 could not answer: was the id read from the right
  // key, or is the vendor's shape different from what the code looks for?
  const d = deps({ uploadVoiceFile: async () => ({ prompt_id: 7, status: "ok" }) });
  const err = await runFlexiloansCampaign(d, { cap: 1 }).then(() => null, (e) => e);
  const prompt = err.steps.find((s) => s.step === "prompt");
  assert.deepEqual(prompt.returned, ["prompt_id", "status"]);
});

test("a null id refuses to compose, and says where it looked", async () => {
  // snake_case is exactly the shape the code does NOT read, and composing with
  // null is a guaranteed 400 whose body says nothing.
  const d = deps({ uploadVoiceFile: async () => ({ prompt_id: 7 }) });
  await assert.rejects(
    () => runFlexiloansCampaign(d, { cap: 1 }),
    /Cannot compose: promptId=null baseId=b1.*prompt_id.*promptId\/id/s
  );
});

test("a null baseId is refused the same way", async () => {
  const d = deps({ uploadBaseFile: async () => ({ base_id: 9 }) });
  await assert.rejects(() => runFlexiloansCampaign(d, { cap: 1 }), /baseId=null/);
});

test("compose is never called when an id is missing", async () => {
  let composed = false;
  const d = deps({
    uploadVoiceFile: async () => ({ nothing: true }),
    composeCampaign: async () => { composed = true; return {}; },
  });
  await runFlexiloansCampaign(d, { cap: 1 }).catch(() => {});
  assert.equal(composed, false, "composed with a null id — a guaranteed vague 400");
});

test("a healthy run still returns its steps and dials", async () => {
  const out = await runFlexiloansCampaign(deps(), { cap: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.dialled, true);
  assert.equal(out.campaignId, "c1");
  // "recorded" is the dispatch-ledger write, which runs after the compose so a
  // second lot does not call the same people again.
  assert.deepEqual(out.steps.map((s) => s.step),
    ["base", "tts", "prompt", "contacts", "campaign", "recorded"]);
});
