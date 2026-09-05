/**
 * The dispatch decision reaches the database, and never costs a call.
 *
 *   node test-voice-dispatch-log.mjs
 *
 * Same shape as the other suites: plain node, plain asserts, no credentials.
 * The one difference is that this one does not stub the database client — it
 * points SUPABASE_URL at a fake PostgREST on loopback and asserts the request
 * that actually goes over the wire. A stub would have let a wrong column name
 * or a violated CHECK constraint through, and both of those are exactly the
 * failures this table's constraints exist to catch.
 *
 * What is being protected:
 *
 *   1. The row says the right thing. crm.voice_dispatch has a CHECK that a
 *      not-dispatched row carries a reason, so a null reason is a rejected
 *      insert — which would show on the IVR leads screen as "no dispatch
 *      record", meaning "we never decided", when in fact we decided not to.
 *   2. A database failure never changes a dialling decision. The call has
 *      already been placed by the time this writes; a 500 here must not turn a
 *      placed call into a failed one, and must never reject.
 *   3. The two gates that reject most presses do NOT write. ~6,000 Hero
 *      presses a day must not land in this table.
 */
import assert from "node:assert/strict";
import http from "node:http";

// ── A fake PostgREST ───────────────────────────────────────────────────────

let inserts = [];
let rpcCalls = [];
let respond = { status: 201, body: "[]" };

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(raw || "null");
    } catch {
      parsed = raw;
    }
    // Only the voice_dispatch write is this suite's business. The dispatch also
    // asks crm.ivr_lead_qualifies() over the same client now, and counting that
    // as an insert made every "exactly one row" assertion read 2.
    (req.url.includes("/rpc/") ? rpcCalls : inserts).push({
      method: req.method,
      path: req.url,
      schema: req.headers["content-profile"] ?? req.headers["accept-profile"] ?? null,
      body: parsed,
    });
    res.writeHead(respond.status, { "Content-Type": "application/json" });
    res.end(respond.body);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

// Set before the modules are imported, and with `=` rather than `||=`: a real
// URL inherited from the environment would make this suite write to the CRM.
process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ORISERVE_API_KEY ||= "test-key";
process.env.ORISERVE_CAMPAIGN_ID ||= "test-oriserve-campaign";

const { recordVoiceDispatch, mobile10Of, _resetDispatchLog } = await import(
  "./lib/voiceDispatchLog.js"
);
const { dispatchPressToVoiceBot, _resetDialled } = await import("./lib/oriVoiceDispatch.js");

const { default: OriserveVoiceClient } = await import("./lib/oriserveVoiceClient.js");
let reply = { success: true, campaign_id: "ori-1" };
OriserveVoiceClient.prototype.triggerCampaign = async function () {
  return reply;
};

let failed = 0;
const check = async (name, fn) => {
  inserts = [];
  rpcCalls = [];
  respond = { status: 201, body: "[]" };
  reply = { success: true, campaign_id: "ori-1" };
  _resetDialled();
  _resetDispatchLog();
  delete process.env.ORI_PRESS_DISPATCH;
  delete process.env.ORI_PRESS_VARIANTS;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

const press = (over = {}) => ({
  mobile: "9876543210",
  unique_id: "call-1",
  campaign_id: "our-campaign",
  campaign_name: "BL_Sep3",
  ...over,
});

/** The single row this insert carried. */
const row = () => {
  assert.equal(inserts.length, 1, `expected exactly one insert, got ${inserts.length}`);
  const body = inserts[0].body;
  return Array.isArray(body) ? body[0] : body;
};

console.log("\nthe row says what happened\n");

await check("a dialled press is recorded as dispatched, with no reason", async () => {
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
  const w = row();
  assert.equal(w.mobile10, "9876543210");
  assert.equal(w.dispatched, true);
  // The CHECK constraint refuses a dispatched row that also carries a reason.
  assert.equal(w.reason, null);
  assert.equal(w.provider, "oriserve");
  assert.equal(w.provider_campaign_id, "ori-1");
  assert.equal(w.variant, "businessloans");
  assert.equal(w.digit, "1");
  assert.equal(w.unique_id, "call-1");
});

await check("the kill switch is recorded, not silence", async () => {
  // The whole point of the table. Before it, ORI_PRESS_DISPATCH=0 and "Oriserve
  // refused every call" were the same empty cell on the screen.
  process.env.ORI_PRESS_DISPATCH = "0";
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "disabled");
  const w = row();
  assert.equal(w.dispatched, false);
  assert.equal(w.reason, "disabled");
  assert.equal(w.provider_campaign_id, null);
});

await check("a refusal by Oriserve is recorded as refused, not as a call", async () => {
  reply = { success: false, error: "no credit", statusCode: 402 };
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
  const w = row();
  assert.equal(w.dispatched, false);
  assert.equal(w.reason, "refused");
});

await check("a duplicate press is recorded, and does not dial twice", async () => {
  await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  inserts = [];
  rpcCalls = [];
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.reason, "duplicate");
  assert.equal(row().reason, "duplicate");
});

await check("the write goes to the crm schema", async () => {
  // Without .schema('crm') this resolves to public.voice_dispatch, which does
  // not exist — a 404 on every press, invisible until someone reads the logs.
  await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(inserts[0].schema, "crm", `schema header was ${inserts[0].schema}`);
  assert.match(inserts[0].path, /voice_dispatch/);
});

console.log("\nwhat is deliberately not recorded\n");

await check("a herofincorp press-1 writes nothing", async () => {
  // 6,047 presses on 02 Sep. A row each would be six thousand a day saying
  // "not a Business Loans press-1", which the book already means by existing.
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "herofincorp" });
  assert.equal(r.reason, "variant_not_dialled");
  assert.equal(inserts.length, 0);
});

await check("a press of 2 writes nothing", async () => {
  const r = await dispatchPressToVoiceBot(press(), { digit: "2", variant: "businessloans" });
  assert.equal(r.reason, "not_press_1");
  assert.equal(inserts.length, 0);
});

await check("the kill switch does not silence the variant gate", async () => {
  // The switch used to be checked first, so a Hero press with the dispatch off
  // returned 'disabled' — which would have been recorded as a Business Loans
  // press we chose not to dial. It is not one.
  process.env.ORI_PRESS_DISPATCH = "0";
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "herofincorp" });
  assert.equal(r.reason, "variant_not_dialled");
  assert.equal(inserts.length, 0);
});

console.log("\na database problem never costs a call\n");

await check("a rejected insert does not change the dialling result", async () => {
  respond = { status: 400, body: JSON.stringify({ message: "violates check constraint" }) };
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, "a failed write turned a placed call into a failure");
});

await check("recordVoiceDispatch resolves rather than rejecting", async () => {
  respond = { status: 500, body: "boom" };
  const r = await recordVoiceDispatch({ mobile: "9876543210", dispatched: true });
  assert.equal(r.recorded, false);
  assert.equal(r.reason, "write_failed");
});

await check("a not-dispatched row is never written without a reason", async () => {
  // The CHECK constraint would reject it, and a rejected row reads on screen as
  // "no dispatch record" — which means something else entirely.
  await recordVoiceDispatch({ mobile: "9876543210", dispatched: false, reason: null });
  assert.equal(row().reason, "unspecified");
});

await check("an unusable number is not filed under a wrong key", async () => {
  const r = await recordVoiceDispatch({ mobile: "12345", dispatched: false, reason: "bad_mobile" });
  assert.equal(r.recorded, false);
  assert.equal(r.reason, "no_mobile10");
  assert.equal(inserts.length, 0, "wrote a row with no valid mobile10");
});

await check("mobile10Of takes the last ten digits, or nothing", async () => {
  assert.equal(mobile10Of("919876543210"), "9876543210");
  assert.equal(mobile10Of("+91 98765 43210"), "9876543210");
  assert.equal(mobile10Of("9876543210"), "9876543210");
  assert.equal(mobile10Of("12345"), null);
  assert.equal(mobile10Of(null), null);
  assert.equal(mobile10Of(undefined), null);
});

await check("no credentials means no write and no throw", async () => {
  const url = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "";
  _resetDispatchLog();
  try {
    const r = await recordVoiceDispatch({ mobile: "9876543210", dispatched: true });
    assert.equal(r.recorded, false);
    assert.equal(r.reason, "no_client");
    assert.equal(inserts.length, 0);
  } finally {
    process.env.SUPABASE_URL = url;
    _resetDispatchLog();
  }
});

server.close();
console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
