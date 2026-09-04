/**
 * The callback URL we hand Oriserve carries the credential we demand back.
 *
 *   node test-oriserve-callback-url.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * This exists because the two halves of the callback were configured
 * independently and nothing checked they agreed. We sent Oriserve a bare
 * notification_webhook_url, then guarded /webhooks/oriserve with
 * ORISERVE_WEBHOOK_SECRET and answered every callback with a 401. On 04 Sep
 * that lost the outcome of 951 real calls, and the only symptom was an empty
 * table — no error anywhere near the code that caused it.
 *
 * So the assertions are about the JOIN between those halves, not about string
 * building: what actually leaves for Oriserve has to contain the secret the
 * guard will look for.
 */
import assert from "node:assert/strict";

process.env.ORISERVE_API_KEY ||= "test-key";
process.env.ORISERVE_CAMPAIGN_ID ||= "test-campaign";

const { default: OriserveVoiceClient } = await import("./lib/oriserveVoiceClient.js");
const { verifyWebhookSecret } = await import("./lib/middleware/verifyWebhookSecret.js");

let failed = 0;
const check = (name, fn) => {
  process.env.ORISERVE_WEBHOOK_SECRET = "s3cret-token";
  process.env.ORISERVE_WEBHOOK_URL = "https://ivr.example.com/webhooks/oriserve";
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

const checkAsync = async (name, fn) => {
  process.env.ORISERVE_WEBHOOK_SECRET = "s3cret-token";
  process.env.ORISERVE_WEBHOOK_URL = "https://ivr.example.com/webhooks/oriserve";
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

const client = () => new OriserveVoiceClient();

console.log("\nthe url carries the token\n");

check("the token is appended to the configured callback url", () => {
  const url = new URL(client().callbackUrl());
  assert.equal(url.origin + url.pathname, "https://ivr.example.com/webhooks/oriserve");
  assert.equal(url.searchParams.get("token"), "s3cret-token");
});

check("an existing query string is preserved", () => {
  process.env.ORISERVE_WEBHOOK_URL = "https://ivr.example.com/webhooks/oriserve?src=ivr";
  const url = new URL(client().callbackUrl());
  assert.equal(url.searchParams.get("src"), "ivr");
  assert.equal(url.searchParams.get("token"), "s3cret-token");
});

check("a token already on the url is not overwritten", () => {
  process.env.ORISERVE_WEBHOOK_URL = "https://ivr.example.com/webhooks/oriserve?token=chosen";
  assert.equal(client().callbackUrl(), "https://ivr.example.com/webhooks/oriserve?token=chosen");
});

check("an explicit per-call url gets the token too", () => {
  const url = new URL(client().callbackUrl("https://other.example.com/hook"));
  assert.equal(url.origin + url.pathname, "https://other.example.com/hook");
  assert.equal(url.searchParams.get("token"), "s3cret-token");
});

check("the secret is read on every call, not cached", () => {
  // The process is long-lived and the client is built once, lazily. A value
  // captured on the first call would keep being sent after the variable moved.
  // The first call here is what makes this bite: without it, a cache populated
  // on first use would already hold the new value and the check would pass
  // against nothing.
  const c = client();
  assert.equal(new URL(c.callbackUrl()).searchParams.get("token"), "s3cret-token");
  process.env.ORISERVE_WEBHOOK_SECRET = "rotated";
  assert.equal(new URL(c.callbackUrl()).searchParams.get("token"), "rotated");
});

console.log("\nand it is the url that actually leaves for oriserve\n");

await checkAsync("triggerCampaign sends the tokened url in its payload", async () => {
  // The check the first cut of this suite was missing. Everything above tested
  // callbackUrl() directly, so reverting the one line in the payload — the
  // whole bug — left every check green. Assert on what goes over the wire.
  const c = client();
  let sent = null;
  c.makeRequest = async (_method, _path, payload) => {
    sent = payload;
    return { campaign_id: "ori-1" };
  };

  const result = await c.triggerCampaign({ mobile: "+919876543210" });
  assert.equal(result.success, true, result.error);
  assert.equal(
    new URL(sent.notification_webhook_url).searchParams.get("token"),
    "s3cret-token",
    `notification_webhook_url went out as ${sent.notification_webhook_url}`
  );
});

console.log("\nit degrades to the old behaviour rather than mangling the url\n");

check("no secret set leaves the url untouched", () => {
  delete process.env.ORISERVE_WEBHOOK_SECRET;
  assert.equal(client().callbackUrl(), "https://ivr.example.com/webhooks/oriserve");
});

check("no callback url configured stays absent", () => {
  delete process.env.ORISERVE_WEBHOOK_URL;
  assert.equal(client().callbackUrl(), undefined);
});

check("an unparseable url is sent unchanged, not half-built", () => {
  process.env.ORISERVE_WEBHOOK_URL = "not a url";
  assert.equal(client().callbackUrl(), "not a url");
});

console.log("\nwhat we send is what the guard accepts\n");

check("the guard admits a request carrying the url's own token", () => {
  // The check that would have caught this. Both halves, end to end: take the
  // token out of the URL we hand Oriserve, present it the way an inbound
  // callback would, and require the real middleware to let it through.
  const sent = new URL(client().callbackUrl());
  const token = sent.searchParams.get("token");

  let passed = false;
  const guard = verifyWebhookSecret("ORISERVE_WEBHOOK_SECRET", "ORISERVE");
  guard(
    { path: "/webhooks/oriserve", ip: "1.2.3.4", query: { token }, get: () => undefined },
    { status: () => ({ json: () => {} }) },
    () => {
      passed = true;
    }
  );
  assert.equal(passed, true, "the guard rejected the token we send Oriserve");
});

check("a bare url is still rejected — the bug, reproduced", () => {
  let passed = false;
  let status = null;
  const guard = verifyWebhookSecret("ORISERVE_WEBHOOK_SECRET", "ORISERVE");
  guard(
    { path: "/webhooks/oriserve", ip: "1.2.3.4", query: {}, get: () => undefined },
    { status: (c) => ((status = c), { json: () => {} }) },
    () => {
      passed = true;
    }
  );
  assert.equal(passed, false);
  assert.equal(status, 401);
});

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
