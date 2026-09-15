/**
 * Which bot takes a press — and, above all, that today nothing changes.
 *
 *   node test-our-voice-bot.mjs
 *
 * Oriserve's bot is doing 700-1,500 real calls a day on `businessloans`. The
 * expensive failure here is not our bot failing to dial; it is our bot quietly
 * taking presses that were paying Oriserve's campaign, or both bots taking the
 * same press and calling one person twice from two numbers. Every check below
 * is one of those two.
 */
import assert from "node:assert/strict";
import {
  dispatchPressToOurBot,
  handledByOurBot,
  ourBotEnabled,
  ourBotVariants,
} from "./lib/ourVoiceBotDispatch.js";

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

const ON = { OUR_BOT_PRESS_ENABLED: "on" };

console.log("\nthe live campaign is not touched\n");

await check("businessloans never goes to our bot, even with everything on", () => {
  // The whole safety property. businessloans is not on our bot's hardcoded
  // allowlist, so no env setting can hand it over.
  assert.equal(handledByOurBot("businessloans", ON), false);
  assert.equal(handledByOurBot("businessloans", { ...ON, OUR_BOT_VARIANTS: "*" }), false);
  assert.equal(
    handledByOurBot("businessloans", { ...ON, OUR_BOT_VARIANTS: "businessloans" }),
    false,
    "naming it explicitly must not be enough — the allowlist is in code"
  );
});

await check("the env can only subtract from the allowlist", () => {
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "*" })], ["flexiloans"]);
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "flexiloans" })], ["flexiloans"]);
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "poonawalla,herofincorp" })], []);
  // Unset means "the whole allowlist"; explicitly BLANK means "none". They are
  // different instructions, and only the safe one can be typed by accident.
  assert.deepEqual([...ourBotVariants({})], ["flexiloans"]);
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "" })], []);
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "   " })], []);
});

console.log("\nthe switch\n");

await check("off unless exactly 'on'", () => {
  assert.equal(ourBotEnabled({}), false);
  assert.equal(ourBotEnabled({ OUR_BOT_PRESS_ENABLED: "true" }), false);
  assert.equal(ourBotEnabled({ OUR_BOT_PRESS_ENABLED: "1" }), false);
  assert.equal(ourBotEnabled({ OUR_BOT_PRESS_ENABLED: "yes" }), false);
  assert.equal(ourBotEnabled({ OUR_BOT_PRESS_ENABLED: "on" }), true);
  assert.equal(ourBotEnabled({ OUR_BOT_PRESS_ENABLED: " ON " }), true);
});

await check("with the switch off, our bot takes nothing at all", () => {
  assert.equal(handledByOurBot("flexiloans", {}), false);
  assert.equal(handledByOurBot("flexiloans", { OUR_BOT_VARIANTS: "*" }), false);
});

await check("with the switch on, our bot takes its own variant", () => {
  assert.equal(handledByOurBot("flexiloans", ON), true);
  assert.equal(handledByOurBot("FlexiLoans", ON), true, "case is not a routing decision");
  assert.equal(handledByOurBot("  flexiloans  ", ON), true);
});

await check("a missing variant goes to nobody of ours", () => {
  // Poonawalla presses arrive with no variant at all. They must not fall into
  // our bot by default.
  assert.equal(handledByOurBot(undefined, ON), false);
  assert.equal(handledByOurBot("", ON), false);
  assert.equal(handledByOurBot(null, ON), false);
});

console.log("\ndispatching\n");

await check("a press for someone else's variant places no call", async () => {
  let called = false;
  const out = await dispatchPressToOurBot(
    { mobile: "9876543210" },
    { digit: "1", variant: "businessloans" },
    { fetch: async () => ((called = true), { ok: true, json: async () => ({}) }) }
  );
  assert.equal(out.dialled, false);
  assert.equal(out.reason, "not_our_variant");
  assert.equal(called, false, "journey-run must not even be contacted");
});

await check("it never rejects, whatever the network does", async () => {
  process.env.OUR_BOT_PRESS_ENABLED = "on";
  try {
    const out = await dispatchPressToOurBot(
      { mobile: "9876543210" },
      { digit: "1", variant: "flexiloans" },
      {
        sb: { from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }) },
        fetch: async () => { throw new Error("network down"); },
      }
    );
    // The keypress route does not await this. A rejection would surface as an
    // unhandled rejection rather than as a lead nobody called.
    assert.equal(out.dialled, false);
    assert.ok(out.reason);
  } finally {
    delete process.env.OUR_BOT_PRESS_ENABLED;
  }
});

console.log("\nthe route wiring\n");

/**
 * Source-level, like the other route-wiring checks in
 * test-ori-press-dispatch.mjs, and for the same reason: the route imports both
 * dispatchers directly, so there is no seam to stub. What is being protected is
 * the one line that decides which vendor gets paid for a press.
 */
const routeSrc = await (async () => {
  const { readFileSync } = await import("node:fs");
  return readFileSync(new URL("./lib/routes/ivrWhatsAppRoutes.js", import.meta.url), "utf8");
})();

await check("the press is routed by handledByOurBot, not unconditionally", () => {
  // Without the guard our bot takes every press-1 on the webhook, including
  // Oriserve's live businessloans campaign.
  assert.match(
    routeSrc,
    /if\s*\(\s*handledByOurBot\(\s*variant\s*\)\s*\)/,
    "the routing guard is missing or no longer reads the variant"
  );
});

await check("exactly one bot per press: an if with an else, never two calls", () => {
  const ours = routeSrc.indexOf("dispatchPressToOurBot(body");
  const ori = routeSrc.indexOf("dispatchPressToVoiceBot(body");
  const guard = routeSrc.search(/if\s*\(\s*handledByOurBot/);
  assert.ok(guard > -1 && ours > guard, "our dispatch must sit inside the guard");
  assert.ok(ori > ours, "Oriserve must be the else branch");
  assert.match(
    routeSrc.slice(ours, ori),
    /\}\s*else\s*\{/,
    "without an else both bots call the same person, seconds apart, from two numbers"
  );
});

await check("neither dispatch is awaited in front of the customer's message", () => {
  assert.doesNotMatch(routeSrc, /await\s+dispatchPressToOurBot/);
  assert.doesNotMatch(routeSrc, /await\s+dispatchPressToVoiceBot/);
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
