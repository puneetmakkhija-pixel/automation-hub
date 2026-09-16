import test from "node:test";
import assert from "node:assert/strict";
import { findPromptId } from "./lib/obdApiClient.js";
import { selectBase, runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// Run 8, in two lines:
//   {"step":"base","people":1000}                  <- cap was 50,000
//   {"step":"prompt","id":null,"returned":["message"]}
//
// The first is PostgREST's db-max-rows silently truncating the dial list to 2%
// of what was asked for. The second is the upload never having returned an id
// at all, so promptId ?? id was always null.

// ── the row cap ──────────────────────────────────────────────────────────────

function sbReturning(rows, capture = {}) {
  return { rpc: async (fn, args) => { capture.fn = fn; capture.args = args; return { data: rows, error: null }; } };
}

test("the dial list comes from the json rpc, which the row cap cannot touch", async () => {
  const seen = {};
  await selectBase(sbReturning([{ mobile10: "9990001112" }], seen), { limit: 25000 });
  assert.equal(seen.fn, "lender_campaign_batch_json",
    "the table-returning rpc is the one PostgREST truncates");
  assert.equal(seen.args.p_limit, 25000);
});

test("twenty-five thousand rows survive the trip", async () => {
  const rows = Array.from({ length: 25000 }, (_, i) => ({ mobile10: String(9000000000 + i) }));
  const got = await selectBase(sbReturning(rows), { limit: 25000 });
  assert.equal(got.length, 25000);
});

test("exactly 1000 against a larger limit is refused as the cap signature", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ mobile10: String(9000000000 + i) }));
  await assert.rejects(
    () => selectBase(sbReturning(rows), { limit: 25000 }),
    /exactly 1000 rows .* db-max-rows cap/,
    "silently dialling 2% of the base is the failure this exists to end"
  );
});

test("a genuinely small base is not mistaken for truncation", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ mobile10: String(9000000000 + i) }));
  const got = await selectBase(sbReturning(rows), { limit: 1000 });
  assert.equal(got.length, 1000, "1000 asked for and 1000 returned is not a cap hit");
});

// ── the prompt id ────────────────────────────────────────────────────────────

test("the id is found by the name it was uploaded under", () => {
  const list = [
    { promptId: 39921, fileName: "BL_FLEXI_OLD.wav" },
    { promptId: 40555, fileName: "FLEXI_BL_20260916.mp3" },
  ];
  assert.equal(findPromptId(list, "FLEXI_BL_20260916"), 40555);
});

test("an exact name matches too, extension or not", () => {
  assert.equal(findPromptId([{ promptId: 7, promptName: "FLEXI_BL_20260916" }], "FLEXI_BL_20260916"), 7);
});

test("the list may arrive wrapped, as vendors like to do", () => {
  const wrapped = { data: [{ id: 12, name: "FLEXI_BL_20260916.mp3" }] };
  assert.equal(findPromptId(wrapped, "FLEXI_BL_20260916"), 12);
});

test("a name that is not there is null, not the first prompt in the list", () => {
  const list = [{ promptId: 39921, fileName: "SOMEONE_ELSES.wav" }];
  assert.equal(findPromptId(list, "FLEXI_BL_20260916"), null,
    "picking the wrong prompt would broadcast the wrong recording");
});

test("junk in gives null, not a throw", () => {
  assert.equal(findPromptId(null, "x"), null);
  assert.equal(findPromptId([], "x"), null);
  assert.equal(findPromptId([{ fileName: "x" }], ""), null);
});

// ── end to end ───────────────────────────────────────────────────────────────

test("the run looks the prompt id up when the upload gives none", async () => {
  const deps = {
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112" }], error: null }) },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      // Exactly what run 8 saw from the dialler.
      uploadVoiceFile: async () => ({ message: "Prompt uploaded" }),
      getVoiceFiles: async () => [{ promptId: 40555, fileName: "FLEXI_BL_20260916.mp3" }],
      uploadBaseFile: async () => ({ message: "Base uploaded", baseId: "b9" }),
      composeCampaign: async (cfg) => ({ campaignId: "c1", got: cfg }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on", FLEXI_CAMPAIGN_CAP: "10" },
  };
  const out = await runFlexiloansCampaign(deps, { cap: 1, stamp: "20260916" });
  assert.equal(out.ok, true);
  assert.equal(out.steps.find((s) => s.step === "prompt").id, 40555);
});

test("the base upload's message is reported, since it has no list endpoint", async () => {
  const deps = {
    sb: { rpc: async () => ({ data: [{ mobile10: "9990001112" }], error: null }) },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ message: "ok" }),
      getVoiceFiles: async () => [{ promptId: 1, fileName: "FLEXI_BL_20260916.mp3" }],
      uploadBaseFile: async () => ({ message: "Base created with id 8123" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
  const err = await runFlexiloansCampaign(deps, { cap: 1, stamp: "20260916" }).then(() => null, (e) => e);
  assert.ok(err, "a null baseId should still refuse to compose");
  assert.equal(err.steps.find((s) => s.step === "contacts").said, "Base created with id 8123");
});
