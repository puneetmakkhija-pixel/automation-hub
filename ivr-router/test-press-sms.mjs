import test from "node:test";
import assert from "node:assert/strict";
import {
  smsMode,
  smsConfigured,
  shouldSendSms,
  sendPressSms,
} from "./lib/smsSender.js";

// Meta paused the press-1 template on 16 Sep and 724 people who pressed 1 got
// nothing for a day and a half. The calls were paid for and the intent was
// real; the only thing missing was a way to deliver a URL. SMS has no template
// quality score to lose.

const ENV = [
  "MSG91_AUTH_KEY",
  "MSG91_PRESS1_TEMPLATE_ID",
  "MSG91_SENDER_ID",
  "IVR_SMS_MODE",
  "MSG91_SHORT_URL",
];
function clearEnv() {
  for (const k of ENV) delete process.env[k];
}
function configure() {
  process.env.MSG91_AUTH_KEY = "key-123";
  process.env.MSG91_PRESS1_TEMPLATE_ID = "tpl-456";
}
const okFetch = (capture = {}) => async (url, init) => {
  capture.url = url;
  capture.headers = init.headers;
  capture.body = JSON.parse(init.body);
  return { ok: true, status: 200, text: async () => '{"type":"success","request_id":"req-1"}' };
};

test("unconfigured sends nothing and says why, rather than failing per caller", async () => {
  clearEnv();
  assert.equal(smsConfigured(), false);
  const out = await sendPressSms({ mobile10: "9355333379", link: "https://x/apply" });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, "not_configured");
});

test("an auth key without a DLT template is still not configured", async () => {
  clearEnv();
  process.env.MSG91_AUTH_KEY = "key-123";
  // Indian transactional SMS requires a DLT-registered template. A key alone
  // cannot send a link, and pretending otherwise fails once per caller.
  assert.equal(smsConfigured(), false);
});

test("mode defaults to fallback, and an unknown value does not become always", () => {
  clearEnv();
  assert.equal(smsMode(), "fallback");
  process.env.IVR_SMS_MODE = "ALWAYS";
  assert.equal(smsMode(), "always");
  process.env.IVR_SMS_MODE = "yes-please";
  // Misreading an unknown value as "always" would silently double the
  // messaging bill on every lead.
  assert.equal(smsMode(), "fallback");
});

test("fallback sends only when WhatsApp did not", () => {
  clearEnv();
  configure();
  process.env.IVR_SMS_MODE = "fallback";
  assert.equal(shouldSendSms(true), false);
  assert.equal(shouldSendSms(false), true);
});

test("always sends regardless of WhatsApp", () => {
  clearEnv();
  configure();
  process.env.IVR_SMS_MODE = "always";
  assert.equal(shouldSendSms(true), true);
  assert.equal(shouldSendSms(false), true);
});

test("off sends nothing even when WhatsApp failed", () => {
  clearEnv();
  configure();
  process.env.IVR_SMS_MODE = "off";
  assert.equal(shouldSendSms(false), false);
});

test("unconfigured never sends, whatever the mode says", () => {
  clearEnv();
  process.env.IVR_SMS_MODE = "always";
  assert.equal(shouldSendSms(false), false);
});

test("the payload carries the link and a 91-prefixed mobile", async () => {
  clearEnv();
  configure();
  process.env.MSG91_SENDER_ID = "BDYLOAN";
  const cap = {};
  const out = await sendPressSms({
    mobile10: "9355333379",
    link: "https://crmbusinessloans.com/apply?t=abc",
    fetchImpl: okFetch(cap),
  });
  assert.equal(out.ok, true);
  assert.equal(cap.body.template_id, "tpl-456");
  assert.equal(cap.body.sender, "BDYLOAN");
  assert.equal(cap.body.recipients[0].mobiles, "919355333379");
  assert.equal(cap.body.recipients[0].LINK, "https://crmbusinessloans.com/apply?t=abc");
  assert.equal(cap.headers.authkey, "key-123");
});

test("a mobile arriving with +91 or spaces still sends as 91 + ten digits", async () => {
  clearEnv();
  configure();
  const cap = {};
  await sendPressSms({ mobile10: "+91 93553 33379", link: "https://x/a", fetchImpl: okFetch(cap) });
  assert.equal(cap.body.recipients[0].mobiles, "919355333379");
});

test("a short mobile is refused before the network", async () => {
  clearEnv();
  configure();
  let called = false;
  const out = await sendPressSms({
    mobile10: "12345",
    link: "https://x/a",
    fetchImpl: async () => { called = true; },
  });
  assert.equal(out.skipped, "bad_mobile");
  assert.equal(called, false, "must not spend a send on an invalid number");
});

test("no link means no send", async () => {
  clearEnv();
  configure();
  const out = await sendPressSms({ mobile10: "9355333379", link: "", fetchImpl: okFetch() });
  assert.equal(out.skipped, "no_link");
});

test("a 200 carrying type:error is a failure, not a success", async () => {
  clearEnv();
  configure();
  // The same trap the OBD client hit twice: a 2xx is necessary and not
  // sufficient. MSG91 answers 200 with {"type":"error"} on a rejected send.
  const out = await sendPressSms({
    mobile10: "9355333379",
    link: "https://x/a",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '{"type":"error","message":"template not approved"}',
    }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /template not approved/);
});

test("HTML on an error does not throw on the parse", async () => {
  clearEnv();
  configure();
  const out = await sendPressSms({
    mobile10: "9355333379",
    link: "https://x/a",
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "<html>gateway</html>" }),
  });
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.error, /JSON|Unexpected token/);
  assert.match(out.error, /HTTP 500/);
});

test("a network failure returns, it does not throw", async () => {
  clearEnv();
  configure();
  // This runs beside the WhatsApp send. A thrown error here would turn a
  // delivered WhatsApp into a failed webhook.
  const out = await sendPressSms({
    mobile10: "9355333379",
    link: "https://x/a",
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /ECONNRESET/);
});
