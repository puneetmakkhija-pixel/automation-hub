import test from "node:test";
import assert from "node:assert/strict";
import { resolveTestMobiles, runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// Eleven runs went at the whole base and nobody ever heard the prompt.
// Dialling 25,000 people to find out what the recording sounds like is the
// wrong order, and no other order existed.

test("a real mobile resolves, in every shape it arrives in", () => {
  assert.deepEqual(resolveTestMobiles("9355333379"), ["9355333379"]);
  assert.deepEqual(resolveTestMobiles("+91 93553 33379"), ["9355333379"]);
  assert.deepEqual(resolveTestMobiles(["9355333379", "9990001112"]), ["9355333379", "9990001112"]);
  assert.deepEqual(resolveTestMobiles(["9355333379", "9355333379"]), ["9355333379"], "deduped");
});

test("nothing that is not a mobile resolves", () => {
  for (const junk of [undefined, null, "", "abc", "12345", [], ["nope"], 42]) {
    assert.deepEqual(resolveTestMobiles(junk), [], `${JSON.stringify(junk)} should resolve to nobody`);
  }
});

test("a test is bounded — a long list is not a test", () => {
  const many = Array.from({ length: 50 }, (_, i) => String(9000000000 + i));
  assert.equal(resolveTestMobiles(many).length, 10, "a campaign wearing a test's clothes");
});

function deps(capture = {}) {
  return {
    sb: {
      rpc: async (fn, args) => {
        capture.rpc = (capture.rpc ?? []).concat(fn);
        if (fn === "record_campaign_dispatch") return { data: 1, error: null };
        return { data: Array.from({ length: 25000 }, (_, i) => ({ mobile10: String(9800000000 + i) })), error: null };
      },
    },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async (csv, name) => (capture.baseCsv = csv, capture.baseName = name, { baseId: "b1" }),
      composeCampaign: async (cfg) => (capture.compose = cfg, { campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on", FLEXI_CAMPAIGN_CAP: "25000" },
  };
}

test("a test run dials the number given and nobody else", async () => {
  const cap = {};
  const out = await runFlexiloansCampaign(deps(cap), { testMobile: "9355333379", stamp: "20260916" });
  assert.equal(out.people, 1);
  assert.equal(out.test, true);
  assert.equal(cap.baseCsv.trim().split("\n").length, 2, "header plus one row");
  assert.match(cap.baseCsv, /9355333379/);
  // The base is not merely unused — it is never asked for.
  assert.ok(!(cap.rpc ?? []).includes("lender_campaign_batch_json"),
    "a test run must not read the dial list at all");
});

test("A TEST THAT RESOLVES TO NOBODY IS REFUSED, NOT WIDENED", async () => {
  // The whole reason this check exists: [] means "not a test", and "not a
  // test" means the base. A typo in a test number must never become a
  // broadcast to 25,000 strangers.
  const cap = {};
  await assert.rejects(
    () => runFlexiloansCampaign(deps(cap), { testMobile: "935533337" }),
    /no valid ten-digit mobile.*refusing rather than falling through to the base/s
  );
  assert.equal(cap.compose, undefined, "nothing was composed");
  assert.ok(!(cap.rpc ?? []).includes("lender_campaign_batch_json"), "the base was never read");
});

test("an empty test list is refused the same way", async () => {
  const cap = {};
  await assert.rejects(() => runFlexiloansCampaign(deps(cap), { testMobiles: [] }), /refusing rather than/);
  assert.equal(cap.compose, undefined);
});

test("a test campaign is named apart from the day's broadcast", async () => {
  const cap = {};
  await runFlexiloansCampaign(deps(cap), { testMobile: "9355333379", stamp: "20260916" });
  assert.match(cap.baseName, /^FLEXI_TEST_20260916_\d{4}$/);
  assert.ok(!cap.baseName.startsWith("FLEXI_BL_"), "it must not collide with the real campaign");
});

test("a test does not write the dispatch ledger", async () => {
  const cap = {};
  const out = await runFlexiloansCampaign(deps(cap), { testMobile: "9355333379" });
  assert.ok(!(cap.rpc ?? []).includes("record_campaign_dispatch"),
    "recording a test would suppress a real customer for 90 days");
  assert.equal(out.steps.find((s) => s.step === "recorded").skipped, "test run");
  assert.equal(out.dispatch_recorded, undefined);
});

test("no test argument at all still runs the real campaign", async () => {
  const cap = {};
  const out = await runFlexiloansCampaign(deps(cap), { cap: 25000, stamp: "20260916" });
  assert.equal(out.test, undefined);
  assert.equal(out.people, 25000);
  assert.equal(cap.baseName, "FLEXI_BL_20260916");
  assert.ok((cap.rpc ?? []).includes("record_campaign_dispatch"), "a real run still records");
});
