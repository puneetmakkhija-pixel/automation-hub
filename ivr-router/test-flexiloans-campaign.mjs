/**
 * The Flexiloans broadcast, without an OBD account or a phone bill.
 *
 *   node test-flexiloans-campaign.mjs
 *
 * One question matters more than the rest here: WHOSE PHONE RINGS. Every check
 * below is that question from a different side, because the failure mode is not
 * a wrong log line — it is calls to real people who were never meant to be in
 * this campaign, and a bill.
 */
import assert from "node:assert/strict";
import {
  IVR_SCRIPT,
  buildBaseCsv,
  campaignCap,
  campaignEnabled,
  resolveRunCap,
  runFlexiloansCampaign,
} from "./lib/flexiloansCampaignOrchestrator.js";

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    mobile10: String(9800000000 + i),
    customer_name: `Customer ${i}`,
    best_score: 90 - i,
  }));

const fakeDeps = (n = 3, calls = []) => ({
  sb: {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: (l) => Promise.resolve({ data: rows(Math.min(n, l)), error: null }),
      };
      return q;
    },
  },
  obd: {
    uploadVoiceFile: async (...a) => (calls.push(["prompt", ...a]), { promptId: "p1" }),
    uploadBaseFile: async (...a) => (calls.push(["base", ...a]), { baseId: "b1" }),
    composeCampaign: async (cfg) => (calls.push(["compose", cfg]), { campaignId: "c1" }),
  },
  tts: { textToSpeech: async (o) => (calls.push(["tts", o]), Buffer.from("audio")) },
  env: {},
});

console.log("\nthe switch\n");

await check("absent, blank and nonsense all mean off", () => {
  assert.equal(campaignEnabled({}), false);
  assert.equal(campaignEnabled({ FLEXI_CAMPAIGN_ENABLED: "" }), false);
  assert.equal(campaignEnabled({ FLEXI_CAMPAIGN_ENABLED: "true" }), false);
  assert.equal(campaignEnabled({ FLEXI_CAMPAIGN_ENABLED: "yes" }), false);
  assert.equal(campaignEnabled({ FLEXI_CAMPAIGN_ENABLED: "1" }), false);
  // Exactly one spelling turns it on, so it cannot happen by accident.
  assert.equal(campaignEnabled({ FLEXI_CAMPAIGN_ENABLED: "on" }), true);
  assert.equal(campaignEnabled({ FLEXI_CAMPAIGN_ENABLED: " ON " }), true);
});

await check("switched off, everything is prepared and nothing is dialled", async () => {
  const calls = [];
  const out = await runFlexiloansCampaign(fakeDeps(3, calls));
  assert.equal(out.dialled, false);
  assert.ok(calls.some((c) => c[0] === "prompt"), "the prompt should still be rendered");
  assert.ok(calls.some((c) => c[0] === "base"), "the contacts should still be uploaded");
  assert.ok(!calls.some((c) => c[0] === "compose"), "composeCampaign is the one that rings phones");
});

await check("switched on, and only then, it broadcasts", async () => {
  const calls = [];
  const out = await runFlexiloansCampaign(fakeDeps(3, calls), { enabled: true });
  assert.equal(out.dialled, true);
  assert.equal(out.campaignId, "c1");
  const compose = calls.find((c) => c[0] === "compose")[1];
  assert.equal(compose.campaignType, "DTMF");
  assert.deepEqual(compose.dtmfKeys, [{ key: "1", action: "webhook" }], "1 is intent");
});

console.log("\nthe cap\n");

await check("an unset cap is 500, not everybody", () => {
  assert.equal(campaignCap({}), 500);
  assert.equal(campaignCap({ FLEXI_CAMPAIGN_CAP: "" }), 500);
  assert.equal(campaignCap({ FLEXI_CAMPAIGN_CAP: "0" }), 500);
  assert.equal(campaignCap({ FLEXI_CAMPAIGN_CAP: "-1" }), 500);
  assert.equal(campaignCap({ FLEXI_CAMPAIGN_CAP: "abc" }), 500);
  assert.equal(campaignCap({ FLEXI_CAMPAIGN_CAP: "2000" }), 2000);
});

await check("the cap bounds who is selected, not just who is reported", async () => {
  const out = await runFlexiloansCampaign(fakeDeps(10_000), { cap: 5, enabled: true });
  assert.equal(out.people, 5);
});

await check("an empty base does not compose an empty campaign", async () => {
  const calls = [];
  const out = await runFlexiloansCampaign(fakeDeps(0, calls), { enabled: true });
  assert.equal(out.dialled, false);
  assert.ok(!calls.some((c) => c[0] === "compose"));
});

await check("a request body can narrow the cap but never widen it", () => {
  // The route hands req.body.cap straight here. If a body could raise the cap,
  // the cap would protect nobody — anyone who reached the route could dial the
  // whole base with one number in a curl.
  assert.equal(resolveRunCap(100, 500), 100, "narrowing is allowed");
  assert.equal(resolveRunCap(5000, 500), 500, "widening is clamped to the env cap");
  assert.equal(resolveRunCap(undefined, 500), 500, "absent means the env cap");
  assert.equal(resolveRunCap("abc", 500), 500, "nonsense means the env cap");
  assert.equal(resolveRunCap(0, 500), 500, "zero is not a run of zero, it is no instruction");
  assert.equal(resolveRunCap(-10, 500), 500, "negative cannot mean unlimited");
  assert.equal(resolveRunCap(10.9, 500), 10, "fractional narrows down, never up");
});

console.log("\nthe contact file\n");

await check("a comma in a name cannot shift the phone column", () => {
  const csv = buildBaseCsv([{ mobile10: "9800000001", customer_name: "Kumar, Rajesh" }]);
  assert.equal(csv.split("\n")[1], "9800000001,Kumar  Rajesh");
  assert.equal(csv.split("\n")[1].split(",").length, 2);
});

await check("a number that is not ten digits is not dialled", () => {
  const csv = buildBaseCsv([
    { mobile10: "12345", customer_name: "Too Short" },
    { mobile10: "919800000002", customer_name: "With Country Code" },
    { mobile10: "9800000003", customer_name: "Fine" },
  ]);
  const lines = csv.split("\n").slice(1);
  assert.equal(lines.length, 2, "the short one is dropped, the +91 one is trimmed");
  assert.ok(lines[0].startsWith("9800000002"));
});

await check("a missing name is an empty column, not the word undefined", () => {
  const csv = buildBaseCsv([{ mobile10: "9800000004" }]);
  assert.equal(csv.split("\n")[1], "9800000004,");
});

console.log("\nthe script\n");

await check("numerals are words, because a TTS model reads digits its own way", () => {
  // "18 लाख" can come out as "eighteen", and if the caller does not hear "एक"
  // clearly there is no campaign at all.
  assert.ok(IVR_SCRIPT.includes("अठारह"), "eighteen lakh spelled out");
  assert.ok(IVR_SCRIPT.includes("एक दबाइए"), "press one spelled out");
  assert.ok(!/\d/.test(IVR_SCRIPT), "no digit should reach the TTS model");
});

await check("it never promises a sanction", () => {
  assert.ok(IVR_SCRIPT.includes("हो सकता है"), "can be approved");
  assert.ok(!IVR_SCRIPT.includes("अप्रूव है"), "never 'is approved'");
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
