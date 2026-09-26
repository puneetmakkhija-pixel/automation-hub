/**
 * The A/B split between Oriserve and our bot, and the labels it leaves behind.
 *
 *   node test-bot-split.mjs
 *
 * What is being protected:
 *
 *   1. Without BOT_SPLIT_MODE=split nothing changes: routePress() gives
 *      handledByOurBot()'s answer and the journey-run request carries no new
 *      key.
 *   2. The arm is a function of the caller, not of the press. A retry, a
 *      repeat press or a second replica must put one person in one arm.
 *   3. Only presses BOTH bots could take are split. Flexiloans, which Oriserve
 *      does not dial, keeps the flag's answer.
 *   4. A press assigned to our arm and handed to Oriserve still says arm=ours
 *      in crm.voice_dispatch, with why it was handed over -- intent-to-treat.
 *
 * Same fake PostgREST as test-voice-dispatch-log.mjs, so the ledger rows are
 * asserted as they go over the wire.
 */
import assert from "node:assert/strict";
import http from "node:http";

let inserts = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "POST" && !req.url.includes("/rpc/")) {
      const body = JSON.parse(raw || "null");
      inserts.push({ path: req.url, row: Array.isArray(body) ? body[0] : body });
    }
    res.writeHead(req.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
    res.end("[]");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

// `=`, not `||=`: an inherited real URL would make this suite write to the CRM.
process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ORISERVE_API_KEY ||= "test-key";
process.env.ORISERVE_CAMPAIGN_ID ||= "test-oriserve-campaign";

const { armFor, voiceVariantFor, oursPct, splitModeOn, splitSalt } = await import("./lib/botSplit.js");
const { routePress, handledByOurBot, dispatchPressToOurBot } = await import(
  "./lib/ourVoiceBotDispatch.js"
);
const { dispatchPressToVoiceBot, _resetDialled } = await import("./lib/oriVoiceDispatch.js");
const { withSplit, _resetDispatchLog } = await import("./lib/voiceDispatchLog.js");
const { default: OriserveVoiceClient } = await import("./lib/oriserveVoiceClient.js");
OriserveVoiceClient.prototype.triggerCampaign = async () => ({ success: true, campaign_id: "ori-1" });

let failed = 0;
const check = async (name, fn) => {
  inserts = [];
  _resetDialled();
  _resetDispatchLog();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

const SPLIT = { BOT_SPLIT_MODE: "split" };
const mobiles = Array.from({ length: 10000 }, (_, i) => String(6000000000 + i * 3917));
/** A mobile that hashes into the given arm under env. */
const mobileIn = (arm, env = SPLIT) => mobiles.find((m) => armFor(m, env) === arm);

console.log("\nthe switch and its settings\n");

await check("off unless exactly 'split'", () => {
  assert.equal(splitModeOn({}), false);
  assert.equal(splitModeOn({ BOT_SPLIT_MODE: "on" }), false);
  assert.equal(splitModeOn({ BOT_SPLIT_MODE: " Split " }), true);
});

await check("salt defaults to v1; the share to 50, and a typo cannot become 0 or 100", () => {
  assert.equal(splitSalt({}), "v1");
  assert.equal(splitSalt({ BOT_SPLIT_SALT: "  " }), "v1");
  assert.equal(oursPct({}), 50);
  assert.equal(oursPct({ BOT_SPLIT_OURS_PCT: "abc" }), 50);
  assert.equal(oursPct({ BOT_SPLIT_OURS_PCT: "101" }), 50);
  assert.equal(oursPct({ BOT_SPLIT_OURS_PCT: "-1" }), 50);
  assert.equal(oursPct({ BOT_SPLIT_OURS_PCT: "12.5" }), 50);
  assert.equal(oursPct({ BOT_SPLIT_OURS_PCT: "0" }), 0);
  assert.equal(oursPct({ BOT_SPLIT_OURS_PCT: "100" }), 100);
  assert.equal(oursPct({ BOT_SPLIT_OURS_PCT: "30" }), 30);
});

console.log("\nthe draw\n");

await check("one caller, one arm: every shape of their number agrees, every time", () => {
  for (const m of mobiles.slice(0, 200)) {
    const arm = armFor(m, SPLIT);
    assert.equal(armFor(`+91${m}`, SPLIT), arm);
    assert.equal(armFor(`91${m}`, SPLIT), arm);
    assert.equal(armFor(m, SPLIT), arm);
    assert.equal(voiceVariantFor(`+91 ${m}`, SPLIT), voiceVariantFor(m, SPLIT));
  }
});

await check("no ten-digit number, no arm", () => {
  assert.equal(armFor("12345", SPLIT), null);
  assert.equal(armFor("", SPLIT), null);
  assert.equal(voiceVariantFor(undefined, SPLIT), null);
});

await check("roughly half and half, and the share is honoured", () => {
  const share = (env) => mobiles.filter((m) => armFor(m, env) === "ours").length / mobiles.length;
  const half = share(SPLIT);
  assert.ok(half > 0.48 && half < 0.52, `ours share ${half}`);
  const thirty = share({ ...SPLIT, BOT_SPLIT_OURS_PCT: "30" });
  assert.ok(thirty > 0.28 && thirty < 0.32, `ours share at 30% was ${thirty}`);
  assert.equal(share({ ...SPLIT, BOT_SPLIT_OURS_PCT: "0" }), 0);
  assert.equal(share({ ...SPLIT, BOT_SPLIT_OURS_PCT: "100" }), 1);
});

await check("the voice variant is its own draw, balanced inside each arm", () => {
  for (const arm of ["ours", "oriserve"]) {
    const inArm = mobiles.filter((m) => armFor(m, SPLIT) === arm);
    const a = inArm.filter((m) => voiceVariantFor(m, SPLIT) === "A").length / inArm.length;
    // Derived from the arm's bytes, this would skew in one arm or the other.
    assert.ok(a > 0.47 && a < 0.53, `A share inside ${arm} was ${a}`);
  }
});

await check("a new salt reshuffles callers", () => {
  const moved = mobiles
    .slice(0, 1000)
    .filter((m) => armFor(m, SPLIT) !== armFor(m, { ...SPLIT, BOT_SPLIT_SALT: "v2" })).length;
  assert.ok(moved > 400 && moved < 600, `${moved} of 1000 changed arm`);
});

console.log("\nwhich presses are split\n");

const ori = (key) => key === "businessloans"; // Oriserve's allowlist today

await check("without the split, routePress is handledByOurBot and labels nothing", () => {
  for (const env of [{}, { OUR_BOT_PRESS_ENABLED: "on" }]) {
    for (const variant of ["businessloans", "flexiloans", "herofincorp", ""]) {
      for (const m of mobiles.slice(0, 20)) {
        const r = routePress({ variant, mobile: m, digit: "1" }, env, ori);
        assert.deepEqual(r, { ours: handledByOurBot(variant, env), arm: null, voiceVariant: null });
      }
    }
  }
});

await check("a businessloans press-1 follows its arm, whatever the old flag says", () => {
  const ours = mobileIn("ours");
  const theirs = mobileIn("oriserve");
  for (const flag of [{}, { OUR_BOT_PRESS_ENABLED: "on" }]) {
    const env = { ...SPLIT, ...flag };
    const a = routePress({ variant: "businessloans", mobile: ours, digit: "1" }, env, ori);
    assert.equal(a.ours, true);
    assert.equal(a.arm, "ours");
    assert.match(a.voiceVariant, /^[AB]$/);
    const b = routePress({ variant: "businessloans", mobile: theirs, digit: "1" }, env, ori);
    assert.deepEqual(b, { ours: false, arm: "oriserve", voiceVariant: null });
  }
});

await check("flexiloans is not split: Oriserve would drop its half", () => {
  const m = mobileIn("oriserve");
  const on = { ...SPLIT, OUR_BOT_PRESS_ENABLED: "on" };
  assert.deepEqual(routePress({ variant: "flexiloans", mobile: m, digit: "1" }, on, ori), {
    ours: true,
    arm: null,
    voiceVariant: null,
  });
  assert.equal(routePress({ variant: "flexiloans", mobile: m, digit: "1" }, SPLIT, ori).ours, false);
});

await check("not press 1, not our allowlist, or not Oriserve's: the flag decides", () => {
  const m = mobileIn("ours");
  assert.equal(routePress({ variant: "businessloans", mobile: m, digit: "2" }, SPLIT, ori).arm, null);
  assert.equal(routePress({ variant: "herofincorp", mobile: m, digit: "1" }, SPLIT, () => true).ours, false);
  // OUR_BOT_VARIANTS still subtracts, split or not.
  const narrowed = { ...SPLIT, OUR_BOT_VARIANTS: "flexiloans" };
  assert.equal(routePress({ variant: "businessloans", mobile: m, digit: "1" }, narrowed, ori).ours, false);
  // And an Oriserve that stops dialling a variant takes it out of the split.
  assert.equal(routePress({ variant: "businessloans", mobile: m, digit: "1" }, SPLIT, () => false).arm, null);
});

console.log("\nthe ours arm\n");

const sbGranting = (granted) => ({
  rpc: async () => ({ data: granted, error: null }),
  from: () => ({
    select: () => ({
      in: async () => ({
        data: [
          { key: "journey_fn_url", value: "https://j.example/run" },
          { key: "sync_secret", value: "s" },
        ],
        error: null,
      }),
    }),
  }),
});

/** Route with SPLIT without touching process.env. */
const splitRoute = (args) => routePress(args, SPLIT, ori);

await check("journey-run is told the voice variant", async () => {
  const m = mobileIn("ours");
  let sent = null;
  const out = await dispatchPressToOurBot(
    { mobile: m },
    { digit: "1", variant: "businessloans" },
    {
      route: splitRoute,
      cap: 100,
      sb: sbGranting(true),
      pace: (fn) => fn(),
      hasRoom: () => true,
      dispatchToOri: () => assert.fail("a dialled press must not reach Oriserve"),
      fetch: async (_url, init) => {
        sent = JSON.parse(init.body);
        return { ok: true, json: async () => ({ voice: { ok: true } }) };
      },
    }
  );
  assert.equal(out.dialled, true);
  assert.equal(sent.voice_variant, voiceVariantFor(m, SPLIT));
  // The rest of the request is untouched.
  assert.equal(sent.step, "intent");
  assert.deepEqual(sent.channels, { whatsapp: false, voice: true });

  const row = inserts.find((i) => i.path.includes("voice_dispatch"))?.row;
  assert.equal(row.provider, "ours");
  assert.equal(row.raw.arm, "ours");
  assert.equal(row.raw.voice_variant, sent.voice_variant);
  assert.equal(row.raw.fallback_reason, null);
});

await check("without the split the journey-run body has no voice_variant", async () => {
  process.env.OUR_BOT_PRESS_ENABLED = "on";
  try {
    let sent = null;
    await dispatchPressToOurBot(
      { mobile: "9876543210" },
      { digit: "1", variant: "businessloans" },
      {
        cap: 100,
        sb: sbGranting(true),
        pace: (fn) => fn(),
        hasRoom: () => true,
        fetch: async (_url, init) => {
          sent = JSON.parse(init.body);
          return { ok: true, json: async () => ({ voice: { ok: true } }) };
        },
      }
    );
    assert.ok(sent, "journey-run was not called");
    assert.equal("voice_variant" in sent, false);
    const row = inserts.find((i) => i.path.includes("voice_dispatch"))?.row;
    assert.deepEqual(row.raw, { bot: "elevenlabs_convai", via: "journey-run" }, "flag-mode rows unchanged");
  } finally {
    delete process.env.OUR_BOT_PRESS_ENABLED;
  }
});

await check("an oriserve-arm press is not our bot's to take", async () => {
  const out = await dispatchPressToOurBot(
    { mobile: mobileIn("oriserve") },
    { digit: "1", variant: "businessloans" },
    { route: splitRoute, fetch: async () => assert.fail("journey-run must not be called") }
  );
  assert.equal(out.reason, "not_our_variant");
});

for (const [name, deps, reason] of [
  ["the dial queue is full", { hasRoom: () => false }, "dial_queue_full"],
  ["the daily cap is spent", { hasRoom: () => true, sb: sbGranting(false) }, "daily_cap"],
]) {
  await check(`${name}: Oriserve rings, the row still says arm=ours (${reason})`, async () => {
    const m = mobileIn("ours");
    let handed = null;
    const out = await dispatchPressToOurBot(
      { mobile: m, unique_id: `u-${reason}` },
      { digit: "1", variant: "businessloans" },
      {
        route: splitRoute,
        cap: 100,
        ...deps,
        dispatchToOri: (body, ctx) => (handed = dispatchPressToVoiceBot(body, ctx)),
      }
    );
    assert.equal(out.handedToOriserve, true);
    await handed;
    const rows = inserts.filter((i) => i.path.includes("voice_dispatch")).map((i) => i.row);
    assert.equal(rows.length, 1, "exactly one ledger row, from the bot that rang");
    assert.equal(rows[0].provider, "oriserve");
    assert.equal(rows[0].dispatched, true);
    assert.equal(rows[0].raw.arm, "ours");
    assert.equal(rows[0].raw.fallback_reason, reason);
  });
}

await check("journey-run placing no call: both rows carry the arm and the reason", async () => {
  const m = mobileIn("ours");
  let handed = null;
  await dispatchPressToOurBot(
    { mobile: m, unique_id: "u-skip" },
    { digit: "1", variant: "businessloans" },
    {
      route: splitRoute,
      cap: 100,
      sb: sbGranting(true),
      pace: (fn) => fn(),
      hasRoom: () => true,
      dispatchToOri: (body, ctx) => (handed = dispatchPressToVoiceBot(body, ctx)),
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ voice: { ok: false, skipped: true, reason: "calling_hours" } }),
      }),
    }
  );
  await handed;
  const rows = inserts.filter((i) => i.path.includes("voice_dispatch")).map((i) => i.row);
  const ours = rows.find((r) => r.provider === "ours");
  const theirs = rows.find((r) => r.provider === "oriserve");
  assert.equal(ours.raw.arm, "ours");
  assert.equal(ours.raw.fallback_reason, "calling_hours");
  assert.equal(theirs.raw.arm, "ours");
  assert.equal(theirs.raw.fallback_reason, "calling_hours");
});

await check("an oriserve-arm press is labelled on its Oriserve row", async () => {
  await dispatchPressToVoiceBot(
    { mobile: mobileIn("oriserve"), unique_id: "u-ori" },
    { digit: "1", variant: "businessloans", arm: "oriserve" }
  );
  const row = inserts.find((i) => i.path.includes("voice_dispatch"))?.row;
  assert.equal(row.raw.arm, "oriserve");
  assert.equal(row.raw.fallback_reason, null);
});

await check("withSplit leaves an unlabelled row exactly as it was", () => {
  const raw = { a: 1 };
  assert.equal(withSplit(raw, {}), raw);
  assert.deepEqual(withSplit(null, {}), {});
  assert.deepEqual(withSplit(raw, { arm: "ours", voiceVariant: "B" }), {
    a: 1,
    arm: "ours",
    voice_variant: "B",
    fallback_reason: null,
  });
});

server.close();
console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
