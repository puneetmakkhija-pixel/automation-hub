import test from "node:test";
import assert from "node:assert/strict";
import OBDApiClient from "./lib/obdApiClient.js";
import { runFlexiloansCampaign } from "./lib/flexiloansCampaignOrchestrator.js";

// The run that got all the way through:
//
//   {"ok":true,"dialled":true,"campaignId":null,
//    "steps":[... {"step":"campaign","id":null} ...]}
//
// It told us it had broadcast and had no campaign to point at. #91 gave the two
// uploads a check for a 200 whose body refuses; compose was left out, and
// compose is the step that rings phones.

function deps(composeResult, capture = {}) {
  return {
    sb: { rpc: async (fn) => fn === "record_campaign_dispatch"
            ? { data: 1, error: null } : { data: [{ mobile10: "9990001112" }], error: null } },
    tts: { textToSpeech: async () => ({ success: true, audio: Buffer.from("ID3") }) },
    obd: {
      uploadVoiceFile: async () => ({ promptId: "68324" }),
      getVoiceFiles: async () => [],
      uploadBaseFile: async () => ({ baseId: "2774653" }),
      composeCampaign: async () => { capture.composed = true; return composeResult; },
    },
    env: { FLEXI_CAMPAIGN_ENABLED: "on" },
  };
}

test("a compose with no id is refused, not reported as a broadcast", async () => {
  await assert.rejects(
    () => runFlexiloansCampaign(deps({ message: "ok" }), { testMobile: "9355333379" }),
    /Compose returned no campaign id.*refusing to report a broadcast that cannot be pointed at/s
  );
});

test("the refusal names what the dialler actually returned", async () => {
  const err = await runFlexiloansCampaign(
    deps({ message: "Campaign limit exceeded", status: "0" }),
    { testMobile: "9355333379" }
  ).then(() => null, (e) => e);
  assert.match(err.message, /keys \[message,status\]/);
  assert.match(err.message, /said "Campaign limit exceeded"/);
});

test("the campaign step reports its keys and message like the others do", async () => {
  const err = await runFlexiloansCampaign(
    deps({ message: "Something went wrong" }),
    { testMobile: "9355333379" }
  ).then(() => null, (e) => e);
  const step = err.steps.find((s) => s.step === "campaign");
  assert.equal(step.id, null);
  assert.deepEqual(step.returned, ["message"]);
  assert.equal(step.said, "Something went wrong");
});

test("a real campaign id still reports a broadcast", async () => {
  const out = await runFlexiloansCampaign(deps({ campaignId: "c-99" }), { testMobile: "9355333379" });
  assert.equal(out.ok, true);
  assert.equal(out.dialled, true);
  assert.equal(out.campaignId, "c-99");
});

test("id is accepted under either key the vendor might use", async () => {
  assert.equal((await runFlexiloansCampaign(deps({ id: 4242 }), { testMobile: "9355333379" })).campaignId, 4242);
});

test("dialled is never true without an id", async () => {
  for (const body of [{}, { message: "ok" }, { campaignId: null }, null]) {
    const out = await runFlexiloansCampaign(deps(body), { testMobile: "9355333379" })
      .then((o) => o, () => null);
    assert.equal(out, null, `${JSON.stringify(body)} should have been refused`);
  }
});

// ── and the client-level check compose never got ────────────────────────────

test("compose refuses a 200 whose body says it failed", async () => {
  const c = new OBDApiClient();
  c.token = "t"; c.userId = "u"; c.ensureToken = async () => {};
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    // The body rides in text(): compose reads the response ONCE, as bytes, so
    // that a 400 with nothing in it stays readable instead of throwing on the
    // parse. json() is no longer the client's way in.
    json: async () => ({ message: "Invalid Campaign Name" }),
    text: async () => '{"message":"Invalid Campaign Name"}',
  });
  try {
    await assert.rejects(
      () => c.composeCampaign({ campaignName: "C" }),
      /Compose campaign failed: HTTP 200 — Invalid Campaign Name/
    );
  } finally { globalThis.fetch = original; }
});

test("a genuine compose response still comes back", async () => {
  const c = new OBDApiClient();
  c.token = "t"; c.userId = "u"; c.ensureToken = async () => {};
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ campaignId: 5150, message: "Campaign created successfully" }),
    text: async () => '{"campaignId":5150,"message":"Campaign created successfully"}',
  });
  try {
    assert.equal((await c.composeCampaign({ campaignName: "C" })).campaignId, 5150);
  } finally { globalThis.fetch = original; }
});
