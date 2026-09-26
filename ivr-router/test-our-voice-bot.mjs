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
  ourBotDailyCap,
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

console.log("\nthe live campaign is bounded, not untouched\n");

// This file used to assert that businessloans could never reach our bot. That
// was the right property while the only protection was the allowlist. The cap
// replaced it: our bot now takes a fixed number of that variant's presses per
// day and Oriserve takes the rest. The property being protected is no longer
// "never" -- it is "a bounded number, and the overflow still reaches a bot".

await check("businessloans is on the allowlist now, deliberately", () => {
  assert.equal(handledByOurBot("businessloans", ON), true);
  // Still off unless the switch is on. Adding the variant did not arm anything.
  assert.equal(handledByOurBot("businessloans", {}), false);
});

await check("a variant nobody allowlisted still cannot be handed over", () => {
  // herofincorp and poonawalla are ~6,000 presses a day into books this floor
  // does not work. The allowlist is in code precisely so a dashboard edit
  // cannot point a paid bot at them.
  assert.equal(handledByOurBot("herofincorp", { ...ON, OUR_BOT_VARIANTS: "*" }), false);
  assert.equal(
    handledByOurBot("herofincorp", { ...ON, OUR_BOT_VARIANTS: "herofincorp" }),
    false,
    "naming it explicitly must not be enough — the allowlist is in code"
  );
});

await check("the env can only subtract from the allowlist", () => {
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "*" })], ["flexiloans", "businessloans"]);
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "flexiloans" })], ["flexiloans"]);
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "poonawalla,herofincorp" })], []);
  // Taking our bot off the live variant without touching code: name the other.
  assert.deepEqual([...ourBotVariants({ OUR_BOT_VARIANTS: "flexiloans" })], ["flexiloans"]);
  // Unset means "the whole allowlist"; explicitly BLANK means "none". They are
  // different instructions, and only the safe one can be typed by accident.
  assert.deepEqual([...ourBotVariants({})], ["flexiloans", "businessloans"]);
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
    { digit: "1", variant: "herofincorp" },
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

console.log("\nthe daily cap\n");

// dispatchPressToOurBot re-checks handledByOurBot() against the real
// process.env, so the switch has to be on for these to get past the variant
// gate and reach the cap at all.
process.env.OUR_BOT_PRESS_ENABLED = "on";

/** A Supabase stub: rpc answers the claim, from() answers journey_fn_url. */
const sbWith = (claim, { url = "https://j.example/run", secret = "s3cr3t" } = {}) => ({
  rpc: async (fn, args) => {
    assert.equal(fn, "claim_our_bot_slot", "the cap must be claimed through the function");
    assert.ok(Number.isInteger(args.p_cap), "the cap must be passed, not defaulted in SQL");
    // supabase-js resolves { data, error }, never a bare value.
    const granted = typeof claim === "function" ? claim(args) : claim;
    return { data: granted, error: null };
  },
  from: () => ({
    select: () => ({
      in: async () => ({
        data: [
          { key: "journey_fn_url", value: url },
          { key: "sync_secret", value: secret },
        ],
        error: null,
      }),
    }),
  }),
});

await check("the cap defaults to 100, and a typo cannot become 'no cap'", () => {
  assert.equal(ourBotDailyCap({}), 100);
  assert.equal(ourBotDailyCap({ OUR_BOT_DAILY_CAP: "" }), 100);
  assert.equal(ourBotDailyCap({ OUR_BOT_DAILY_CAP: "   " }), 100);
  assert.equal(ourBotDailyCap({ OUR_BOT_DAILY_CAP: "abc" }), 100);
  assert.equal(ourBotDailyCap({ OUR_BOT_DAILY_CAP: "-5" }), 100);
  assert.equal(ourBotDailyCap({ OUR_BOT_DAILY_CAP: "10.5" }), 100);
  assert.equal(ourBotDailyCap({ OUR_BOT_DAILY_CAP: "250" }), 250);
  // Zero is a real instruction -- "our bot takes nothing today" -- and must
  // survive, unlike the unparseable values above.
  assert.equal(ourBotDailyCap({ OUR_BOT_DAILY_CAP: "0" }), 0);
});

await check("within the cap: our bot dials, Oriserve is not touched", async () => {
  let journeyCalled = false;
  let oriCalled = false;
  const out = await dispatchPressToOurBot(
    { mobile: "9876543210" },
    { digit: "1", variant: "businessloans" },
    {
      cap: 100,
      sb: sbWith(true),
      dispatchToOri: () => { oriCalled = true; },
      fetch: async () => {
        journeyCalled = true;
        return { ok: true, json: async () => ({ voice: { ok: true } }) };
      },
    }
  );
  assert.equal(out.dialled, true);
  assert.equal(journeyCalled, true);
  assert.equal(oriCalled, false, "paying two vendors for one press is the expensive bug");
});

await check("over the cap: Oriserve takes it and journey-run is never called", async () => {
  let journeyCalled = false;
  let oriCalled = false;
  const out = await dispatchPressToOurBot(
    { mobile: "9876543210" },
    { digit: "1", variant: "businessloans" },
    {
      cap: 100,
      sb: sbWith(false),
      dispatchToOri: () => { oriCalled = true; },
      fetch: async () => ((journeyCalled = true), { ok: true, json: async () => ({}) }),
    }
  );
  assert.equal(out.dialled, false);
  assert.equal(out.reason, "daily_cap");
  assert.equal(out.handedToOriserve, true);
  assert.equal(oriCalled, true, "press 101 must still reach a bot");
  assert.equal(journeyCalled, false, "a slot we did not get must not place a call");
});

await check("a database we cannot read sends the press to Oriserve, not past the cap", async () => {
  let oriCalled = false;
  let journeyCalled = false;
  const out = await dispatchPressToOurBot(
    { mobile: "9876543210" },
    { digit: "1", variant: "businessloans" },
    {
      cap: 100,
      sb: { rpc: async () => ({ data: null, error: { message: "connection refused" } }) },
      dispatchToOri: () => { oriCalled = true; },
      fetch: async () => ((journeyCalled = true), { ok: true, json: async () => ({}) }),
    }
  );
  assert.equal(out.dialled, false);
  assert.equal(oriCalled, true);
  assert.equal(journeyCalled, false, "an unreadable cap must never mean 'dial anyway'");
});

await check("the configured cap is what reaches the database", async () => {
  let seen = null;
  await dispatchPressToOurBot(
    { mobile: "9876543210" },
    { digit: "1", variant: "businessloans" },
    {
      cap: 37,
      sb: sbWith((args) => ((seen = args.p_cap), false)),
      dispatchToOri: () => {},
    }
  );
  assert.equal(seen, 37);
});

await check("a claimed slot with journey-run unconfigured still reaches Oriserve", async () => {
  let oriCalled = false;
  const out = await dispatchPressToOurBot(
    { mobile: "9876543210" },
    { digit: "1", variant: "businessloans" },
    {
      cap: 100,
      sb: sbWith(true, { url: null, secret: null }),
      dispatchToOri: () => { oriCalled = true; },
    }
  );
  assert.equal(out.reason, "not_configured");
  assert.equal(oriCalled, true, "the caller is not left uncalled because we are misconfigured");
});

delete process.env.OUR_BOT_PRESS_ENABLED;

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

await check("the press is routed by routePress, not unconditionally", () => {
  // Without the guard our bot takes every press-1 on the webhook, including
  // Oriserve's live businessloans campaign. routePress() is handledByOurBot()
  // unless BOT_SPLIT_MODE=split -- test-bot-split.mjs holds it to that.
  assert.match(
    routeSrc,
    /const\s+route\s*=\s*routePress\(\s*\{\s*variant\s*,\s*mobile\s*,\s*digit\s*\}\s*\)/,
    "the routing decision is missing or no longer reads variant, mobile and digit"
  );
  assert.match(routeSrc, /if\s*\(\s*route\.ours\s*\)/, "the routing guard is missing");
});

await check("exactly one bot per press: an if with an else, never two calls", () => {
  const ours = routeSrc.indexOf("dispatchPressToOurBot(body");
  const ori = routeSrc.indexOf("dispatchPressToVoiceBot(body");
  const guard = routeSrc.search(/if\s*\(\s*route\.ours/);
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
