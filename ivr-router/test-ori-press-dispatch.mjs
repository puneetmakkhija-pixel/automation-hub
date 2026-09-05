/**
 * A press of 1 rings the ORI voice bot — and nothing else does.
 *
 *   node test-ori-press-dispatch.mjs
 *
 * No framework, same as test-press-forward.mjs: plain node, plain asserts,
 * self-contained, no credentials and no network.
 *
 * Every check here is really the same question asked from a different side:
 * WHOSE PHONE RINGS, AND HOW OFTEN. This is the one path in the service that
 * spends money per press, so the negatives matter more than the positive —
 * a bug that dials Hero's 6,047 daily presses instead of Business Loans' 692
 * is not a wrong log line, it is six thousand calls and a bill.
 *
 * Each check was confirmed to fail under a targeted mutation of the module.
 */
import assert from "node:assert/strict";

process.env.ORISERVE_API_KEY ||= "test-key";
process.env.ORISERVE_CAMPAIGN_ID ||= "test-oriserve-campaign";

// The dispatch now writes each decision to crm.voice_dispatch. Blanked, not
// left alone: `||=` would keep a real SUPABASE_URL that a developer already has
// exported, and running this suite would then insert test presses into the
// production CRM. Empty means the client cannot be built, the writer says so
// once and returns, and this file keeps its promise of no credentials and no
// network. The write itself is covered by test-voice-dispatch-log.mjs, which
// points these at a fake on loopback.
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

const mod = await import("./lib/oriVoiceDispatch.js");
const { dispatchPressToVoiceBot, toE164, dialKey, _resetDialled } = mod;

// The module builds its own client lazily from the env. Swap the constructed
// one for a recorder by intercepting at the prototype: the module holds the
// instance privately, and stubbing the class it calls is the honest seam.
const { default: OriserveVoiceClient } = await import("./lib/oriserveVoiceClient.js");
const realTrigger = OriserveVoiceClient.prototype.triggerCampaign;

let calls = [];
let reply = { success: true, campaign_id: "ori-1" };
OriserveVoiceClient.prototype.triggerCampaign = async function (options) {
  calls.push(options);
  return typeof reply === "function" ? reply(options) : reply;
};

let failed = 0;
const check = async (name, fn) => {
  calls = [];
  reply = { success: true, campaign_id: "ori-1" };
  _resetDialled();
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
  name: "Test Customer",
  ...over,
});

console.log("\nwho gets dialled\n");

await check("a businessloans press-1 is dialled", async () => {
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mobile, "+919876543210");
});

await check("a herofincorp press-1 is NOT dialled", async () => {
  // 6,047 presses on 02 Sep. This is the check that stands between the default
  // config and six thousand paid calls a day.
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "herofincorp" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "variant_not_dialled");
  assert.deepEqual(calls, []);
});

await check("a poonawalla press-1 is NOT dialled", async () => {
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "poonawalla" });
  assert.equal(r.dialled, false);
  assert.deepEqual(calls, []);
});

await check("an unnamed press is NOT dialled", async () => {
  // The bare /whatsapp path carries nothing saying which book it belongs to.
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "" });
  assert.equal(r.dialled, false);
  assert.deepEqual(calls, []);
});

await check("the variant match ignores case and padding", async () => {
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: " BusinessLoans " });
  assert.equal(r.dialled, true, r.reason);
});

await check("ORI_PRESS_VARIANTS cannot widen past the allowlist", async () => {
  // The env var used to be the only gate, so this exact string put Hero's
  // 126 daily press-1s on a paid outbound bot from a dashboard edit.
  process.env.ORI_PRESS_VARIANTS = "businessloans,herofincorp";
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "herofincorp" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "variant_not_dialled");
  assert.deepEqual(calls, []);
});

await check("...and business loans still dials with that same setting", async () => {
  // The narrowing half has to keep working, or the guard above is just an
  // outage: a bad env var must cost Hero its calls, not cost us ours.
  process.env.ORI_PRESS_VARIANTS = "businessloans,herofincorp";
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
});

await check('"*" means every ALLOWED variant, not every press', async () => {
  process.env.ORI_PRESS_VARIANTS = "*";
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "anything" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "variant_not_dialled");
  assert.deepEqual(calls, []);
});

await check('"*" still dials business loans', async () => {
  process.env.ORI_PRESS_VARIANTS = "*";
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
});

await check("a press carrying no variant is never dialled", async () => {
  // 3,614 of the 5,460 press-1s on 04-05 Sep came from s1.whistleloop.com with
  // no variant field at all. They must not fall through any setting.
  for (const setting of ["businessloans", "*", "businessloans,herofincorp"]) {
    process.env.ORI_PRESS_VARIANTS = setting;
    for (const variant of [undefined, null, "", "   "]) {
      const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant });
      assert.equal(r.dialled, false, `setting=${setting} variant=${JSON.stringify(variant)}`);
      assert.equal(r.reason, "variant_not_dialled");
    }
  }
  assert.deepEqual(calls, []);
});

console.log("\nonly a press of 1\n");

for (const digit of ["2", "0", "9", "", undefined]) {
  await check(`digit ${JSON.stringify(digit)} places no call`, async () => {
    const r = await dispatchPressToVoiceBot(press(), { digit, variant: "businessloans" });
    assert.equal(r.dialled, false);
    assert.equal(r.reason, "not_press_1");
    assert.deepEqual(calls, []);
  });
}

console.log("\nnobody is rung twice\n");

await check("the same unique_id does not dial twice", async () => {
  await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "duplicate");
  assert.equal(calls.length, 1, "the customer was called twice");
});

await check("with no unique_id, the same mobile does not dial twice", async () => {
  const body = press({ unique_id: "" });
  await dispatchPressToVoiceBot(body, { digit: "1", variant: "businessloans" });
  const r = await dispatchPressToVoiceBot(body, { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
  assert.equal(calls.length, 1);
});

await check("a different caller in the same campaign is still dialled", async () => {
  await dispatchPressToVoiceBot(press({ unique_id: "", mobile: "9876543210" }), {
    digit: "1",
    variant: "businessloans",
  });
  const r = await dispatchPressToVoiceBot(press({ unique_id: "", mobile: "9123456789" }), {
    digit: "1",
    variant: "businessloans",
  });
  assert.equal(r.dialled, true, r.reason);
  assert.equal(calls.length, 2);
});

await check("a refused call releases the key so the next press can retry", async () => {
  reply = { success: false, error: "tenant busy", statusCode: 503 };
  const first = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(first.dialled, false);
  assert.equal(first.reason, "refused");

  reply = { success: true, campaign_id: "ori-2" };
  const second = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(second.dialled, true, "a refusal must not permanently block the number");
});

console.log("\nwhat Oriserve is sent\n");

await check("our campaign id is never sent as Oriserve's", async () => {
  await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(
    calls[0].campaign_id,
    undefined,
    "must fall back to ORISERVE_CAMPAIGN_ID, not name our dialler's campaign"
  );
  assert.equal(calls[0].metadata.ivr_campaign_id, "our-campaign");
});

await check("the callback gets what it needs to find the lead", async () => {
  await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  const m = calls[0].metadata;
  assert.equal(m.unique_id, "call-1");
  assert.equal(m.ivr_variant, "businessloans");
  assert.equal(m.ivr_campaign_name, "BL_Sep3");
  assert.equal(m.customer_name, "Test Customer");
  assert.equal(m.purpose, "press1_qualification");
});

console.log("\nbad input rings nobody\n");

await check("a number that is not an Indian mobile is not dialled", async () => {
  for (const bad of ["12345", "", null, "5555555555", "+1 415 555 0100"]) {
    _resetDialled();
    calls = [];
    const r = await dispatchPressToVoiceBot(press({ mobile: bad }), {
      digit: "1",
      variant: "businessloans",
    });
    assert.equal(r.dialled, false, `dialled a bad number: ${bad}`);
    assert.deepEqual(calls, []);
  }
});

await check("toE164 takes the last ten digits and demands 6-9", () => {
  assert.equal(toE164("9876543210"), "+919876543210");
  assert.equal(toE164("919876543210"), "+919876543210");
  assert.equal(toE164("+91 98765 43210"), "+919876543210");
  assert.equal(toE164("5876543210"), null, "Indian mobiles start 6-9");
  assert.equal(toE164("98765"), null);
});

console.log("\nit can never cost a send\n");

await check("ORI_PRESS_DISPATCH=0 turns it off", async () => {
  process.env.ORI_PRESS_DISPATCH = "0";
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "disabled");
  assert.deepEqual(calls, []);
});

await check("a throwing client resolves rather than rejects", async () => {
  // The route does not await this. An unhandled rejection on a floating
  // promise takes the process down — the whole webhook, for every lender.
  reply = () => {
    throw new Error("boom");
  };
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "error");
});

await check("a rejecting client resolves rather than rejects", async () => {
  reply = () => Promise.reject(new Error("network down"));
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
});

await check("a null body resolves rather than throwing", async () => {
  const r = await dispatchPressToVoiceBot(null, { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
});

await check("the returned promise never rejects, whatever happens", async () => {
  reply = () => {
    throw new Error("boom");
  };
  // assert.doesNotReject on the actual floating-promise shape the route creates.
  await assert.doesNotReject(() =>
    dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" })
  );
});

console.log("\nthe route wiring\n");

await check("the keypress route dispatches before the template lookup", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./lib/routes/ivrWhatsAppRoutes.js", import.meta.url), "utf8");
  const dispatch = src.indexOf("dispatchPressToVoiceBot(body");
  const template = src.indexOf("const template = templateMap()[digit]");
  assert.ok(dispatch > -1, "the route never dispatches to the voice bot");
  assert.ok(template > -1);
  assert.ok(
    dispatch < template,
    "a press-1 with no mapped template must still get the call"
  );
});

await check("the route does not await the dispatch", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./lib/routes/ivrWhatsAppRoutes.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    src,
    /await\s+dispatchPressToVoiceBot/,
    "awaiting it puts an Oriserve round trip in front of the customer's message"
  );
});

await check("dialKey prefers unique_id over the caller", () => {
  assert.equal(dialKey({ unique_id: "u1", mobile: "9876543210" }, "bl"), "uid:u1");
  assert.equal(dialKey({ mobile: "9876543210" }, "BL"), "cm:bl:9876543210");
});

OriserveVoiceClient.prototype.triggerCampaign = realTrigger;
console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
