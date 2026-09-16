import test from "node:test";
import assert from "node:assert/strict";
import { buildBaseCsv, runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// The dialler's answers, read together:
//
//   contactList absent   ->  400, empty body        (request malformed)
//   contactList "null"   ->  200 File Upload Failed (request fine, FILE rejected)
//   contactList ""       ->  200 File Upload Failed (same)
//
// Present-but-any-value gets the request accepted and the FILE refused. So the
// file is what it does not like, and the header was never verified: the comment
// on buildBaseCsv asserted "mobile,name with a header is what OBD takes" and
// nothing ever checked it. A dialler reading that first line sees the word
// "mobile" where a phone number should be.

const ROWS = [{ mobile10: "9355333379", customer_name: "Test" }, { mobile10: "9990001112" }];

test("the default is bare numbers, one per line", () => {
  assert.equal(buildBaseCsv(ROWS), "9355333379\n9990001112");
});

test("no header survives into the default shape", () => {
  const out = buildBaseCsv(ROWS);
  assert.doesNotMatch(out, /mobile/i, "the word 'mobile' where a number belongs is the suspect");
  assert.ok(out.split("\n").every((l) => /^\d{10}$/.test(l)), "every line is a phone number");
});

test("the other shapes stay reachable, so the right one can be found", () => {
  assert.equal(buildBaseCsv(ROWS, "csv"), "9355333379,Test\n9990001112,");
  assert.equal(buildBaseCsv(ROWS, "csv-header"), "mobile,name\n9355333379,Test\n9990001112,");
});

test("a number that is not ten digits is still never dialled", () => {
  const out = buildBaseCsv([
    { mobile10: "12345" },
    { mobile10: "919990001112" },
    { mobile10: "9990001113" },
  ]);
  assert.equal(out, "9990001112\n9990001113", "short dropped, +91 trimmed");
});

test("a comma in a name still cannot shift the phone column", () => {
  assert.equal(buildBaseCsv([{ mobile10: "9990001112", customer_name: "Kumar, Rajesh" }], "csv"),
    "9990001112,Kumar  Rajesh");
});

test("an unknown format falls back to numbers, never to something invented", () => {
  assert.equal(buildBaseCsv(ROWS, "nonsense"), "9355333379\n9990001112");
});

test("the campaign sends bare numbers unless told otherwise", async () => {
  const seen = {};
  const deps = (format) => ({
    sb: { rpc: async (fn) => fn === "record_campaign_dispatch"
            ? { data: 1, error: null } : { data: [{ mobile10: "9990001112" }], error: null } },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "p1" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async (file) => (seen.file = file, { baseId: "b1" }),
      composeCampaign: async () => ({ campaignId: "c1" }),
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  });
  await runFlexiloansCampaign(deps(), { testMobile: "9355333379" });
  assert.equal(seen.file, "9355333379");
  await runFlexiloansCampaign(deps(), { testMobile: "9355333379", baseFormat: "csv-header" });
  assert.match(seen.file, /^mobile,name\n/);
});
