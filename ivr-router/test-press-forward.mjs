/**
 * The press forward, checked against a fake CRM and a fake Ananta.
 *
 *   node test-press-forward.mjs
 *
 * No framework: this package has no test runner, and adding one for one file
 * would be a bigger change than the one under test. Plain node, plain asserts,
 * self-contained — it stands up its own HTTP servers and needs no credentials,
 * no network and no database.
 *
 * What it is here to hold, in one sentence: the press forward runs ALONGSIDE
 * the WhatsApp send and never at its expense. Every check below was confirmed
 * to fail when the behaviour it names is removed — the forward moved after the
 * template check, the forward awaited, the digit mapping dropped, the trim on
 * the secret dropped — so a passing run means something.
 */
import http from "node:http";
import express from "express";
import assert from "node:assert/strict";
import { forwardPressToCrm } from "./lib/crmPressForward.js";

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(JSON.parse(raw || "{}")));
  });

let failed = 0;
const makeCheck = (reset) => async (name, fn) => {
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

// The forward is not awaited by the route, so give the floating promise a
// moment to land before asserting on what the CRM saw.
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// ── the forwarder on its own ──────────────────────────────────────────────
async function forwarderSuite() {
  console.log("\nlib/crmPressForward.js");

  let seen = [];
  let reply = { status: 200, body: { ok: true, created: true, lead_ref: "BDL-XY12", known_to_lookup: true } };

  const crm = await listen(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers, body: await readBody(req) });
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });

  process.env.CRM_BASE_URL = `http://127.0.0.1:${crm.port}`;
  process.env.CRM_SYNC_SECRET = "s3cret";
  const check = makeCheck(() => (seen = []));

  await check("posts to /api/ivr/press with the sync secret header", async () => {
    const r = await forwardPressToCrm(
      { mobile: "9812345678", dtmf: "1", unique_id: "call-1", campaign_id: "c9" },
      { digit: "1", variant: "businessloans" }
    );
    assert.deepEqual(r, { forwarded: true, created: true, leadRef: "BDL-XY12" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/ivr/press");
    assert.equal(seen[0].headers["x-sync-secret"], "s3cret");
  });

  await check("sends the resolved digit as dtmf when only dtmf_sequence was posted", async () => {
    await forwardPressToCrm({ mobile: "9812345678", dtmf_sequence: "91" }, { digit: "1" });
    assert.equal(seen[0].body.dtmf, "1", `dtmf was ${JSON.stringify(seen[0].body.dtmf)}`);
  });

  await check("maps unique_id to call_id", async () => {
    await forwardPressToCrm({ mobile: "9812345678", unique_id: "u-77" }, { digit: "1" });
    assert.equal(seen[0].body.call_id, "u-77");
  });

  await check("never overwrites a call_id the body already carries", async () => {
    await forwardPressToCrm({ mobile: "9812345678", unique_id: "u-77", call_id: "real-1" }, { digit: "1" });
    assert.equal(seen[0].body.call_id, "real-1");
  });

  await check("passes unknown fields through untouched", async () => {
    await forwardPressToCrm(
      { mobile: "9812345678", campaign_name: "BL Sep", agent_id: 42 },
      { digit: "1", variant: "businessloans" }
    );
    assert.equal(seen[0].body.campaign_name, "BL Sep");
    assert.equal(seen[0].body.agent_id, 42);
    assert.equal(seen[0].body.ivr_variant, "businessloans");
    assert.equal(seen[0].body.forwarded_by, "ivr-router");
  });

  await check("forwards a press with no digit at all", async () => {
    const r = await forwardPressToCrm({ mobile: "9812345678" }, {});
    assert.equal(r.forwarded, true);
    assert.equal("dtmf" in seen[0].body, false);
  });

  // Every failure below must RESOLVE. An un-awaited call that rejects is an
  // unhandled rejection, which takes the whole IVR service down.
  await check("a 401 resolves with a reason instead of throwing", async () => {
    reply = { status: 401, body: { ok: false, error: "unauthorized" } };
    const r = await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    assert.deepEqual(r, { forwarded: false, reason: "http_401" });
  });

  await check("a 502 resolves with a reason", async () => {
    reply = { status: 502, body: { ok: false, error: "intake_failed" } };
    const r = await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    assert.deepEqual(r, { forwarded: false, reason: "http_502" });
  });

  await check("an unreachable CRM resolves rather than rejecting", async () => {
    reply = { status: 200, body: { ok: true, created: false } };
    const good = process.env.CRM_BASE_URL;
    process.env.CRM_BASE_URL = "http://127.0.0.1:1";
    const r = await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    process.env.CRM_BASE_URL = good;
    assert.equal(r.forwarded, false);
  });

  await check("a floating call to an unreachable CRM raises no unhandled rejection", async () => {
    const good = process.env.CRM_BASE_URL;
    process.env.CRM_BASE_URL = "http://127.0.0.1:1";
    let unhandled = null;
    const onUnhandled = (e) => (unhandled = e);
    process.on("unhandledRejection", onUnhandled);
    forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" }); // deliberately not awaited
    await settle(500);
    process.off("unhandledRejection", onUnhandled);
    process.env.CRM_BASE_URL = good;
    assert.equal(unhandled, null, `unhandled rejection: ${unhandled}`);
  });

  await check("a null body does not throw", async () => {
    const r = await forwardPressToCrm(null, { digit: "1" });
    assert.equal(typeof r.forwarded, "boolean");
  });

  await check("CRM_PRESS_FORWARD=0 sends nothing", async () => {
    process.env.CRM_PRESS_FORWARD = "0";
    const r = await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    delete process.env.CRM_PRESS_FORWARD;
    assert.deepEqual(r, { forwarded: false, reason: "disabled" });
    assert.equal(seen.length, 0);
  });

  await check("no secret sends nothing", async () => {
    delete process.env.CRM_SYNC_SECRET;
    const r = await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    process.env.CRM_SYNC_SECRET = "s3cret";
    assert.deepEqual(r, { forwarded: false, reason: "no_secret" });
    assert.equal(seen.length, 0);
  });

  await check("a secret that is only whitespace counts as unset", async () => {
    process.env.CRM_SYNC_SECRET = "  \n";
    const r = await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    process.env.CRM_SYNC_SECRET = "s3cret";
    assert.deepEqual(r, { forwarded: false, reason: "no_secret" });
    assert.equal(seen.length, 0, "a blank secret must not be sent to the CRM");
  });

  await check("falls back to CRM_SSO_SECRET", async () => {
    delete process.env.CRM_SYNC_SECRET;
    process.env.CRM_SSO_SECRET = "sso-only";
    const r = await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    process.env.CRM_SYNC_SECRET = "s3cret";
    delete process.env.CRM_SSO_SECRET;
    assert.equal(r.forwarded, true);
    assert.equal(seen[0].headers["x-sync-secret"], "sso-only");
  });

  await check("CRM_PRESS_PATH overrides the path", async () => {
    process.env.CRM_PRESS_PATH = "/api/ivr/press-v2";
    await forwardPressToCrm({ mobile: "9812345678" }, { digit: "1" });
    delete process.env.CRM_PRESS_PATH;
    assert.equal(seen[0].url, "/api/ivr/press-v2");
  });

  crm.server.close();
}

// ── the webhook end to end ────────────────────────────────────────────────
async function webhookSuite() {
  console.log("\nPOST /webhooks/ivr/whatsapp");

  let crmHits = [];
  let anantaHits = [];
  let crmDelayMs = 0;

  const crm = await listen(async (req, res) => {
    crmHits.push({ url: req.url, secret: req.headers["x-sync-secret"], body: await readBody(req) });
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, created: true, lead_ref: "BDL-AA11" }));
    }, crmDelayMs);
  });

  const ananta = await listen(async (req, res) => {
    anantaHits.push(await readBody(req));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "success", message_id: "msg-1" }));
  });

  process.env.CRM_BASE_URL = `http://127.0.0.1:${crm.port}`;
  process.env.CRM_SYNC_SECRET = "sync-s3cret";
  process.env.ANANTA_WABA_URL = `http://127.0.0.1:${ananta.port}/waba/sendmessage`;
  process.env.ANANTA_API_KEY = "waba-key";
  process.env.IVR_DTMF_TEMPLATES = '{"1":"1234567890"}';
  process.env.IVR_DTMF_PLACEHOLDERS = '{"1":["Test"]}';
  delete process.env.ANANTA_WEBHOOK_SECRET; // the guard fails open when unset
  delete process.env.SUPABASE_URL; // no send log; the route must not need one

  const { default: routes } = await import("./lib/routes/ivrWhatsAppRoutes.js");
  const app = express();
  app.use(express.json());
  app.use("/webhooks/ivr", routes);
  const site = await listen(app);
  const base = `http://127.0.0.1:${site.port}/webhooks/ivr`;

  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  const check = makeCheck(() => {
    crmHits = [];
    anantaHits = [];
    crmDelayMs = 0;
  });

  // Each check uses its own mobile and unique_id: the route's dedupe set is
  // module state and lives for the whole run.
  await check("a press with a template both sends and forwards", async () => {
    const r = await post("/whatsapp/businessloans", { mobile: "9811100001", dtmf: "1", unique_id: "c-1" });
    await settle();
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, true, JSON.stringify(r.body));
    assert.equal(anantaHits.length, 1, "Ananta should have been called");
    assert.equal(crmHits.length, 1, "the CRM should have been called");
    assert.equal(crmHits[0].url, "/api/ivr/press");
    assert.equal(crmHits[0].secret, "sync-s3cret");
    assert.equal(crmHits[0].body.dtmf, "1");
    assert.equal(crmHits[0].body.call_id, "c-1");
    assert.equal(crmHits[0].body.ivr_variant, "businessloans");
  });

  await check("a digit with no template is still forwarded", async () => {
    const r = await post("/whatsapp/businessloans", { mobile: "9811100002", dtmf: "9", unique_id: "c-2" });
    await settle();
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, false);
    assert.equal(anantaHits.length, 0, "no message for an unmapped digit");
    assert.equal(crmHits.length, 1, "the press is a fact worth keeping even with no template");
    assert.equal(crmHits[0].body.dtmf, "9");
  });

  await check("an unusable caller number is still forwarded", async () => {
    const r = await post("/whatsapp", { mobile: "12", dtmf: "1", unique_id: "c-3" });
    await settle();
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, false);
    assert.equal(anantaHits.length, 0);
    assert.equal(crmHits.length, 1, "the CRM validates the number itself");
  });

  await check("a menu sequence forwards the digit the route resolved", async () => {
    await post("/whatsapp", { mobile: "9811100004", dtmf_sequence: "91", unique_id: "c-4" });
    await settle();
    assert.equal(crmHits.length, 1);
    assert.equal(crmHits[0].body.dtmf, "1", "the CRM reader does not know dtmf_sequence");
  });

  await check("a slow CRM does not delay the send or the response", async () => {
    crmDelayMs = 3000;
    const started = Date.now();
    const r = await post("/whatsapp", { mobile: "9811100005", dtmf: "1", unique_id: "c-5" });
    const elapsed = Date.now() - started;
    assert.equal(r.body.sent, true, "the message must go out while the CRM is still thinking");
    assert.ok(elapsed < 1000, `the webhook answered in ${elapsed}ms — it waited on the CRM`);
    await settle(3200); // let the slow reply land before the next check
  });

  await check("a CRM that is down does not stop the send", async () => {
    const good = process.env.CRM_BASE_URL;
    process.env.CRM_BASE_URL = "http://127.0.0.1:1";
    const r = await post("/whatsapp", { mobile: "9811100006", dtmf: "1", unique_id: "c-6" });
    await settle();
    process.env.CRM_BASE_URL = good;
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, true);
    assert.equal(anantaHits.length, 1);
  });

  crm.server.close();
  ananta.server.close();
  site.server.close();
}

await forwarderSuite();
await webhookSuite();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
