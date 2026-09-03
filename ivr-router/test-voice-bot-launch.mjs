/**
 * The document journey actually reaches Oriserve.
 *
 *   node test-voice-bot-launch.mjs
 *
 * No framework, same as the other suites here: plain node, plain asserts,
 * self-contained, no credentials and no network.
 *
 * The bug this holds down: _launchOriserveVoiceBot called
 * `oriserveClient.initiateCampaign(...)`. The client has never had a method by
 * that name — triggerCampaign is the one — so every call threw TypeError.
 * _launchDocumentJourney wraps it in Promise.allSettled, so the throw became a
 * single VOICE_BOT_FAILED log line while the Ananta half went out and the
 * journey returned success. The voice bot never once reached Oriserve, and
 * nothing in the response said so.
 *
 * So the first check is not "does it work" but "is the method it calls a method
 * that exists" — asserted against the real client's prototype, not a mock,
 * because a mock that answers to anything is exactly what hid this for weeks.
 *
 * Each check was confirmed to fail against the original code.
 */
import assert from "node:assert/strict";

// The client's constructor throws without a key, and IVRCampaignRouter builds
// one eagerly. These are never used to reach the network — every call below
// goes to a stub — but they have to be set before the module is imported.
process.env.ORISERVE_API_KEY ||= "test-key";
process.env.ORISERVE_CAMPAIGN_ID ||= "test-oriserve-campaign";
process.env.OBD_BASE_URL ||= "https://obd.invalid";
process.env.OBD_USERNAME ||= "test";
process.env.OBD_PASSWORD ||= "test";
// The router also builds a Supabase client eagerly. Nothing below queries it —
// _launchOriserveVoiceBot touches no table — but createClient refuses to be
// constructed without these. The host is deliberately unroutable.
process.env.SUPABASE_URL ||= "https://test.supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const { default: IVRCampaignRouter } = await import("./lib/ivrCampaignRouter.js");
const { default: OriserveVoiceClient } = await import("./lib/oriserveVoiceClient.js");

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

/** A router whose Oriserve client is a recorder. Returns what the client got. */
function routerWithStub(reply = { success: true, campaign_id: "ori-camp-1" }) {
  const router = new IVRCampaignRouter();
  const calls = [];
  router.oriserveClient = {
    triggerCampaign: async (options) => {
      calls.push(options);
      return typeof reply === "function" ? reply(options) : reply;
    },
  };
  return { router, calls };
}

const DATA = {
  phone: "9876543210",
  name: "Test Customer",
  campaignId: "our-ivr-campaign-42",
  lenderId: "poonawalla",
};

console.log("\nthe method it calls exists\n");

await check("triggerCampaign is a real method on the real client", () => {
  assert.equal(
    typeof OriserveVoiceClient.prototype.triggerCampaign,
    "function",
    "the client lost triggerCampaign — the router call is dead again"
  );
});

await check("initiateCampaign is not, and never was", () => {
  assert.equal(
    OriserveVoiceClient.prototype.initiateCampaign,
    undefined,
    "if this method now exists, the comment in ivrCampaignRouter.js is wrong"
  );
});

console.log("\nwhat Oriserve is actually sent\n");

await check("a launch reaches the client instead of throwing TypeError", async () => {
  const { router, calls } = routerWithStub();
  const result = await router._launchOriserveVoiceBot(DATA, "routing-1");
  assert.equal(calls.length, 1, "the client was never called");
  assert.equal(result.success, true);
});

await check("the number is sent as `mobile`, the key the client reads", async () => {
  const { router, calls } = routerWithStub();
  await router._launchOriserveVoiceBot(DATA, "routing-1");
  assert.equal(calls[0].mobile, DATA.phone);
  assert.equal(calls[0].phone, undefined, "`phone` is our word, not the client's");
});

await check("our IVR campaign id is NOT sent as Oriserve's campaign_id", async () => {
  // The single most expensive mistake available here: campaignId is our
  // dialler's id. Sent as campaign_id it names a campaign Oriserve's tenant has
  // never heard of, and every trigger fails — or worse, names a real one.
  const { router, calls } = routerWithStub();
  await router._launchOriserveVoiceBot(DATA, "routing-1");
  assert.equal(
    calls[0].campaign_id,
    undefined,
    "campaign_id must be omitted so the client falls back to ORISERVE_CAMPAIGN_ID"
  );
  assert.equal(calls[0].metadata.ivr_campaign_id, DATA.campaignId, "ours belongs in metadata");
});

await check("the callback gets what it needs to find the lead", async () => {
  const { router, calls } = routerWithStub();
  await router._launchOriserveVoiceBot(DATA, "routing-7");
  assert.equal(calls[0].metadata.routingId, "routing-7");
  assert.equal(calls[0].metadata.lenderId, DATA.lenderId);
  assert.equal(calls[0].metadata.customer_name, DATA.name);
  assert.equal(calls[0].metadata.purpose, "document_collection");
});

await check("botId comes from the client's campaign_id, not campaignId", async () => {
  const { router } = routerWithStub({ success: true, campaign_id: "ori-camp-9" });
  const result = await router._launchOriserveVoiceBot(DATA, "routing-1");
  assert.equal(result.botId, "ori-camp-9", "reading result.campaignId yields undefined");
});

console.log("\na refusal is not a launch\n");

await check("success:false from the client raises, not resolves", async () => {
  // triggerCampaign returns { success: false } on an API error rather than
  // throwing. Treated as fulfilled, _launchDocumentJourney logs
  // VOICE_BOT_LAUNCHED for a call that never happened.
  const { router } = routerWithStub({ success: false, error: "tenant refused" });
  await assert.rejects(
    () => router._launchOriserveVoiceBot(DATA, "routing-1"),
    /tenant refused/,
    "a refused trigger must not read as a launched bot"
  );
});

await check("a refusal with no error text still raises", async () => {
  const { router } = routerWithStub({ success: false });
  await assert.rejects(() => router._launchOriserveVoiceBot(DATA, "routing-1"));
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
