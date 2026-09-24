/**
 * The press that reached neither bot.
 *
 *   node test-neither-bot.mjs
 *
 * 23 Sep 2026: two presses arrived just before 10:00 IST. Each claimed one of
 * the day's slots, reached journey-run, came back refused by the calling-hours
 * rule — and stopped there. Our bot would not dial them, Oriserve was never
 * offered them, and two people who pressed 1 were called by nobody.
 *
 * The fix hands those on. The hard part is that it must hand on ONLY the ones
 * that provably never dialled: a journey-run that timed out may have originated
 * the call before the socket died, and handing that press to Oriserve rings one
 * customer from two numbers. Half these checks are about the calls that must
 * NOT be handed over.
 */
import assert from "node:assert/strict";
import { dispatchPressToOurBot } from "./lib/ourVoiceBotDispatch.js";
import { resetPacer } from "./lib/dialPacer.js";

delete process.env.OUR_BOT_CALLS_PER_MINUTE;
delete process.env.OUR_BOT_DIAL_QUEUE_LIMIT;
delete process.env.OUR_BOT_DAILY_CAP;
// dispatchPressToOurBot re-reads this from the real process.env: without it the
// press never gets past the variant gate and every check below asserts nothing.
process.env.OUR_BOT_PRESS_ENABLED = "on";

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

/** A journey-run that answers with `status` and `payload`, and counts handovers. */
const run = async (status, payload) => {
  resetPacer();
  const ori = [];
  const out = await dispatchPressToOurBot(
    { mobile: "9811484805", unique_id: "u1" },
    { digit: "1", variant: "businessloans" },
    {
      dispatchToOri: (b) => ori.push(String(b?.mobile)),
      // Immediate, so the assertions do not race the pacer.
      pace: (fn) => fn(),
      fetch: async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      }),
      sb: {
        rpc: async () => ({ data: true, error: null }),
        from: () => ({
          select: () => ({
            in: async () => ({
              data: [
                { key: "journey_fn_url", value: "https://j.example/run" },
                { key: "sync_secret", value: "s3cr3t" },
              ],
              error: null,
            }),
          }),
        }),
      },
    }
  );
  return { out, ori };
};

const SHUT = "outside calling hours — it is 09:58 IST and calls run 10:00–19:00 IST";

console.log("\nthe presses that must reach Oriserve\n");

await check("a press refused for calling hours is handed on, not dropped", async () => {
  const { out, ori } = await run(200, { voice: { ok: false, skipped: true, reason: SHUT } });
  assert.equal(out.dialled, false);
  assert.equal(out.handedToOriserve, true, "this is the 23 Sep bug: nobody called them");
  assert.deepEqual(ori, ["9811484805"]);
  // The real reason travels with it, so the ledger says WHY rather than just
  // "daily_cap" — a night with no calls has to read as a closed window.
  assert.match(out.reason, /outside calling hours/);
});

await check("the other three pre-dial refusals are handed on too", async () => {
  for (const reason of ["no recipient", "not a dialable Indian mobile", "not configured"]) {
    const { out, ori } = await run(200, { voice: { ok: false, skipped: true, reason } });
    assert.equal(out.handedToOriserve, true, `${reason} should reach Oriserve`);
    assert.deepEqual(ori, ["9811484805"], `${reason} should reach Oriserve`);
  }
});

await check("a 4xx is journey-run's own validation, before any dial", async () => {
  const { out, ori } = await run(400, { error: "no_customer" });
  assert.equal(out.handedToOriserve, true);
  assert.deepEqual(ori, ["9811484805"]);
});

await check("a rejected secret reaches Oriserve rather than nobody", async () => {
  const { out, ori } = await run(401, { error: "unauthorized" });
  assert.equal(out.handedToOriserve, true);
  assert.deepEqual(ori, ["9811484805"]);
});

console.log("\nthe presses that must NOT be handed on — two bots, one press, never both\n");

await check("a 5xx may have dialled first, so it stays with our bot", async () => {
  // journey-run's 500 is the catch-all AROUND the dial. The originate may
  // already have gone out.
  const { out, ori } = await run(500, { error: "server_error" });
  assert.equal(out.dialled, false);
  assert.notEqual(out.handedToOriserve, true);
  assert.deepEqual(ori, [], "a call that may have been placed must not be placed again");
});

await check("a failure AFTER the dial attempt stays with our bot", async () => {
  // skipped:false is the CRM saying it got as far as the trunk.
  const { out, ori } = await run(200, {
    voice: { ok: false, skipped: false, reason: "originate failed: 503 from ARI" },
  });
  assert.notEqual(out.handedToOriserve, true);
  assert.deepEqual(ori, []);
});

await check("a torn-off connection is ambiguous, so nobody is called twice", async () => {
  resetPacer();
  const ori = [];
  const out = await dispatchPressToOurBot(
    { mobile: "9811484805" },
    { digit: "1", variant: "businessloans" },
    {
      dispatchToOri: (b) => ori.push(String(b?.mobile)),
      pace: (fn) => fn(),
      fetch: async () => {
        throw new Error("socket hang up");
      },
      sb: {
        rpc: async () => ({ data: true, error: null }),
        from: () => ({
          select: () => ({
            in: async () => ({
              data: [
                { key: "journey_fn_url", value: "https://j.example/run" },
                { key: "sync_secret", value: "s3cr3t" },
              ],
              error: null,
            }),
          }),
        }),
      },
    }
  );
  assert.equal(out.dialled, false);
  assert.match(out.reason, /socket hang up/);
  assert.notEqual(out.handedToOriserve, true, "no response is not evidence of no dial");
  assert.deepEqual(ori, []);
});

await check("a successful dial is never handed on", async () => {
  const { out, ori } = await run(200, { voice: { ok: true, skipped: false } });
  assert.equal(out.dialled, true);
  assert.notEqual(out.handedToOriserve, true);
  assert.deepEqual(ori, []);
});

resetPacer();
console.log(failed === 0 ? "\nall good\n" : `\n${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
