/**
 * Enrichment decides who the bot calls — and shadow mode decides nothing.
 *
 *   node test-lead-qualification.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * The bug this guards has not happened yet, which is the point. Turning
 * IVR_QUALIFY_ENFORCE on cuts dialling by 71% against real 04-05 Sep data — so
 * the expensive mistake here is not a wrong verdict, it is enforcing one before
 * anybody meant to. Most of what follows is about the OFF state.
 */
import assert from "node:assert/strict";

// Blanked before anything imports the client: these suites must never be able
// to reach the production CRM, and voiceDispatchLog builds a client eagerly on
// first write.
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.ORISERVE_API_KEY ||= "test-key";
process.env.ORISERVE_CAMPAIGN_ID ||= "test-campaign";

const q = await import("./lib/leadQualification.js");
const { dispatchPressToVoiceBot, _resetDialled } = await import("./lib/oriVoiceDispatch.js");
const OriserveVoiceClient = (await import("./lib/oriserveVoiceClient.js")).default;

let calls = [];
OriserveVoiceClient.prototype.makeRequest = async function (_m, _p, payload) {
  calls.push(payload);
  return { campaign_id: "ori-1" };
};

let failed = 0;
let n = 0;
const check = async (name, fn) => {
  n++;
  calls = [];
  _resetDialled();
  q._resetQualification();
  delete process.env.IVR_QUALIFY_ENFORCE;
  process.env.ORI_PRESS_VARIANTS = "businessloans";
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

/** A verdict, as crm.ivr_lead_qualifies() would return it. */
const verdict = (qualifies, reasons = []) =>
  q._setLookup(async () => ({
    data: { qualifies, enriched: true, reasons, facts: { abb: 60000 } },
  }));

const press = (over = {}) => ({ mobile: "+919876543210", unique_id: "call-1", ...over });

console.log("\nshadow mode changes nothing\n");

await check("a non-qualifying business loans press is STILL dialled", async () => {
  // The whole safety property. Shadow is the default, so a fresh deploy of this
  // change must dial exactly who it dialled yesterday.
  verdict(false);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
  assert.equal(calls.length, 1);
});

await check("a qualifying poonawalla press is NOT dialled while shadow", async () => {
  // Admitting Hero and Poonawalla before the verdict can stop anyone would
  // treble volume overnight. Shadow must not widen, only narrow-nothing.
  verdict(true, ["abb"]);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: undefined });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "variant_not_dialled");
  assert.deepEqual(calls, []);
});

await check("a qualifying hero press is NOT dialled while shadow", async () => {
  verdict(true, ["bureau"]);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "herofincorp" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "variant_not_dialled");
  assert.deepEqual(calls, []);
});

await check('ORI_PRESS_VARIANTS="*" does not widen shadow to hero or poonawalla', async () => {
  // Without this the two checks above pass for the wrong reason: with the env
  // var at its default, IT rejects Hero, so making shadow admit every source
  // would still leave them green. "*" takes the env var out of the way and
  // leaves only the code holding the line.
  process.env.ORI_PRESS_VARIANTS = "*";
  verdict(true, ["abb"]);
  for (const variant of ["herofincorp", undefined, "poonawalla"]) {
    _resetDialled();
    const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant });
    assert.equal(r.dialled, false, `variant=${String(variant)} was dialled while shadow`);
    assert.equal(r.reason, "variant_not_dialled");
  }
  assert.deepEqual(calls, []);
});

await check('ORI_PRESS_VARIANTS="*" still dials business loans while shadow', async () => {
  process.env.ORI_PRESS_VARIANTS = "*";
  verdict(false);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
});

await check("the verdict is still computed while shadow, so it can be measured", async () => {
  let asked = null;
  q._setLookup(async (m10) => {
    asked = m10;
    return { data: { qualifies: false, enriched: true, reasons: [] } };
  });
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(asked, "9876543210", "enrichment was never consulted");
  assert.equal(r.verdict.qualifies, false);
  assert.equal(r.dialled, true);
});

console.log("\nenforcing: enrichment decides, not the variant\n");

await check("a non-qualifying business loans press is refused", async () => {
  process.env.IVR_QUALIFY_ENFORCE = "1";
  verdict(false);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "not_qualified");
  assert.deepEqual(calls, []);
});

await check("a qualifying poonawalla press (no variant at all) IS dialled", async () => {
  // 3,616 of 5,462 press-1s on 04-05 Sep carried no variant field. The rule is
  // explicitly that these get called when they clear a bar.
  process.env.IVR_QUALIFY_ENFORCE = "1";
  verdict(true, ["bureau"]);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: undefined });
  assert.equal(r.dialled, true, r.reason);
  assert.equal(calls.length, 1);
});

await check("a qualifying hero press IS dialled", async () => {
  process.env.IVR_QUALIFY_ENFORCE = "1";
  verdict(true, ["gst_to"]);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "herofincorp" });
  assert.equal(r.dialled, true, r.reason);
  assert.equal(calls.length, 1);
});

await check("ORI_PRESS_VARIANTS cannot re-close the gate once enforcing", async () => {
  // It defaults to "businessloans" and IS set in production. Leaving it in the
  // path would reject every Hero and Poonawalla press before the verdict was
  // asked for — the change silently undone by a variable nobody edited.
  process.env.IVR_QUALIFY_ENFORCE = "1";
  process.env.ORI_PRESS_VARIANTS = "businessloans";
  verdict(true, ["abb"]);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "herofincorp" });
  assert.equal(r.dialled, true, r.reason);
});

await check("an unrelated variant is still refused when enforcing", async () => {
  process.env.IVR_QUALIFY_ENFORCE = "1";
  verdict(true, ["abb"]);
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "creditcards" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "variant_not_dialled");
  assert.deepEqual(calls, []);
});

await check("press 2 is refused even when the caller qualifies", async () => {
  process.env.IVR_QUALIFY_ENFORCE = "1";
  verdict(true, ["abb"]);
  const r = await dispatchPressToVoiceBot(press(), { digit: "2", variant: "businessloans" });
  assert.equal(r.dialled, false);
  assert.equal(r.reason, "not_press_1");
});

console.log("\nnot knowing is not a no\n");

await check("an unreachable lookup dials anyway", async () => {
  // A database blip must not become a day of missed calls.
  process.env.IVR_QUALIFY_ENFORCE = "1";
  q._setLookup(async () => {
    throw new Error("connection reset");
  });
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
  assert.equal(r.verdict.qualifies, null);
  assert.equal(r.verdict.status, "lookup_failed");
});

await check("no enrichment client configured dials anyway", async () => {
  process.env.IVR_QUALIFY_ENFORCE = "1";
  q._setLookup(async () => ({ error: "no_client" }));
  const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
  assert.equal(r.dialled, true, r.reason);
  assert.equal(r.verdict.status, "no_client");
});

await check("a garbage response dials anyway rather than refusing", async () => {
  process.env.IVR_QUALIFY_ENFORCE = "1";
  for (const bad of [null, undefined, "a string", 42]) {
    q._setLookup(async () => ({ data: bad }));
    _resetDialled();
    const r = await dispatchPressToVoiceBot(press(), { digit: "1", variant: "businessloans" });
    assert.equal(r.dialled, true, `data=${JSON.stringify(bad)}: ${r.reason}`);
  }
});

console.log("\nthe verdict itself\n");

await check("qualifyLead reads the function's answer faithfully", async () => {
  q._setLookup(async () => ({
    data: { qualifies: true, enriched: true, reasons: ["abb", "bureau"], facts: { abb: 73711 } },
  }));
  const v = await q.qualifyLead("+91 98765 43210");
  assert.equal(v.qualifies, true);
  assert.equal(v.enriched, true);
  assert.deepEqual(v.reasons, ["abb", "bureau"]);
  assert.equal(v.facts.abb, 73711);
  assert.equal(v.status, "qualified");
});

await check('"no data" is reported apart from "does not qualify"', async () => {
  // 4,874 of 5,459 presses have no enrichment at all. If those read the same as
  // a genuine refusal, the shadow numbers are meaningless.
  q._setLookup(async () => ({ data: { qualifies: false, enriched: false, reasons: [] } }));
  const v = await q.qualifyLead("9876543210");
  assert.equal(v.qualifies, false);
  assert.equal(v.enriched, false);
});

await check("a number that is not ten digits is never looked up", async () => {
  let asked = false;
  q._setLookup(async () => {
    asked = true;
    return { data: { qualifies: true } };
  });
  for (const bad of ["", null, undefined, "12345", "abc"]) {
    const v = await q.qualifyLead(bad);
    assert.equal(v.status, "no_mobile10");
    assert.equal(v.qualifies, null);
  }
  assert.equal(asked, false);
});

await check("decideFromVerdict passes everything while shadow", async () => {
  for (const v of [{ qualifies: false }, { qualifies: true }, { qualifies: null }, null]) {
    assert.equal(q.decideFromVerdict(v).dial, true, JSON.stringify(v));
  }
});

await check("decideFromVerdict refuses only a definite no when enforcing", async () => {
  process.env.IVR_QUALIFY_ENFORCE = "1";
  assert.equal(q.decideFromVerdict({ qualifies: false }).dial, false);
  assert.equal(q.decideFromVerdict({ qualifies: true }).dial, true);
  assert.equal(q.decideFromVerdict({ qualifies: null }).dial, true);
  assert.equal(q.decideFromVerdict(null).dial, true);
  assert.equal(q.decideFromVerdict(undefined).dial, true);
});

await check("qualifyLead never rejects, whatever the lookup does", async () => {
  for (const boom of [
    async () => {
      throw new Error("boom");
    },
    async () => Promise.reject(new Error("nope")),
    () => {
      throw new Error("sync throw");
    },
  ]) {
    q._setLookup(boom);
    const v = await q.qualifyLead("9876543210");
    assert.equal(v.qualifies, null);
  }
});

console.log(`\n${failed === 0 ? `all ${n} checks passed` : `${failed} of ${n} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
