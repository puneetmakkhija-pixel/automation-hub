/**
 * The dial pace, and that it is the dials it slows rather than the decisions.
 *
 *   node test-dial-pacer.mjs
 *
 * On 24 Sep 2026 all 200 of the day's slots were claimed in 203 seconds and 98
 * calls went out in three minutes. 42 of the first 100 never connected at all:
 * call_duration_secs 0, message_count 0. Failure rate against calls started in
 * the preceding minute — 0% below ten a minute, 50% past twenty, 54% past
 * forty. The cap was right; putting all of it on the trunk at once was not.
 *
 * What must stay true is narrower than "it is slower". A burst of presses has
 * to be ROUTED immediately — which bot takes it, does it fit the cap, does the
 * overflow reach Oriserve — because the customer is on the line and Oriserve's
 * handover cannot wait in a queue. Only the dial itself may be held back.
 */
import assert from "node:assert/strict";
import {
  callsPerMinute,
  drainPacer,
  hasRoom,
  intervalMs,
  maxWaiting,
  paceDial,
  pacerStats,
  resetPacer,
} from "./lib/dialPacer.js";
import { dispatchPressToOurBot } from "./lib/ourVoiceBotDispatch.js";

// This suite asserts defaults, so it must not inherit a rate from the shell
// that started it: an ambient OUR_BOT_CALLS_PER_MINUTE would make the "defaults
// to eight" check assert whatever Railway happens to be set to.
delete process.env.OUR_BOT_CALLS_PER_MINUTE;
delete process.env.OUR_BOT_DIAL_QUEUE_LIMIT;

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

console.log("\nthe rate, read from the environment\n");

await check("defaults to eight a minute, inside the band where nothing failed", () => {
  assert.equal(callsPerMinute({}), 8);
  // The measured danger zone starts around 11-20/min and is half-failing past
  // 20. The default must not be in it.
  assert.ok(callsPerMinute({}) <= 10, "default must stay under the failure band");
});

await check("a blank or junk value falls back rather than stopping the bot", () => {
  // Number("") is 0, which as a rate means "never dial again".
  assert.equal(callsPerMinute({ OUR_BOT_CALLS_PER_MINUTE: "" }), 8);
  assert.equal(callsPerMinute({ OUR_BOT_CALLS_PER_MINUTE: "   " }), 8);
  assert.equal(callsPerMinute({ OUR_BOT_CALLS_PER_MINUTE: "fast" }), 8);
  assert.equal(callsPerMinute({ OUR_BOT_CALLS_PER_MINUTE: "0" }), 8);
  assert.equal(callsPerMinute({ OUR_BOT_CALLS_PER_MINUTE: "-5" }), 8);
});

await check("an explicit rate is honoured", () => {
  assert.equal(callsPerMinute({ OUR_BOT_CALLS_PER_MINUTE: "12" }), 12);
  assert.equal(intervalMs({ OUR_BOT_CALLS_PER_MINUTE: "60" }), 1000);
  assert.equal(intervalMs({ OUR_BOT_CALLS_PER_MINUTE: "8" }), 7500);
});

console.log("\nthe pacing itself\n");

await check("dials are spaced, not fired together", async () => {
  resetPacer();
  process.env.OUR_BOT_CALLS_PER_MINUTE = "1200"; // 50ms apart, so the test is quick
  const startedAt = [];
  const jobs = Array.from({ length: 5 }, () =>
    paceDial(async () => {
      startedAt.push(Date.now());
      return { dialled: true };
    })
  );
  await Promise.all(jobs);

  assert.equal(startedAt.length, 5);
  const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]);
  // Every gap at least the interval, allowing for timer coarseness. Without
  // pacing these land in the same millisecond and the gaps are all zero.
  for (const gap of gaps) {
    assert.ok(gap >= 40, `dials were ${gap}ms apart, expected the full interval`);
  }
  delete process.env.OUR_BOT_CALLS_PER_MINUTE;
});

await check("a long call does not throttle the queue behind it", async () => {
  resetPacer();
  process.env.OUR_BOT_CALLS_PER_MINUTE = "1200";
  const startedAt = [];
  // The first dial takes far longer than the interval. Pacing the START means
  // the second must not wait for it -- a two-minute conversation holding up
  // every call behind it would undo the cap by the length of its calls.
  const slow = paceDial(async () => {
    startedAt.push(Date.now());
    await new Promise((r) => setTimeout(r, 300));
    return { dialled: true };
  });
  const quick = paceDial(async () => {
    startedAt.push(Date.now());
    return { dialled: true };
  });
  await Promise.all([slow, quick]);
  const gap = startedAt[1] - startedAt[0];
  assert.ok(gap < 250, `second dial waited ${gap}ms for the first to finish`);
  delete process.env.OUR_BOT_CALLS_PER_MINUTE;
});

await check("a throwing dial does not take the queue with it", async () => {
  resetPacer();
  process.env.OUR_BOT_CALLS_PER_MINUTE = "6000";
  const boom = paceDial(async () => {
    throw new Error("trunk said no");
  });
  const after = paceDial(async () => ({ dialled: true }));
  const [first, second] = await Promise.all([boom, after]);
  // Never rejects: an unhandled rejection in Node 22 ends the process and every
  // dial still queued with it.
  assert.equal(first.dialled, false);
  assert.match(first.reason, /trunk said no/);
  assert.equal(second.dialled, true);
  delete process.env.OUR_BOT_CALLS_PER_MINUTE;
});

await check("the queue has a ceiling and reports it", () => {
  resetPacer();
  assert.equal(hasRoom(), true);
  assert.equal(maxWaiting({}), 300);
  assert.equal(maxWaiting({ OUR_BOT_DIAL_QUEUE_LIMIT: "2" }), 2);
  assert.deepEqual(pacerStats(), { waiting: 0, callsPerMinute: 8, maxWaiting: 300 });
});

console.log("\nrouting still happens at once\n");

// dispatchPressToOurBot re-reads handledByOurBot() against the real
// process.env. Without this the press is refused at the variant gate and
// returns before the pacer is ever consulted -- the checks below would then
// pass or fail on whether the shell happened to export the switch, which is
// how this file first shipped green while asserting nothing about pacing.
process.env.OUR_BOT_PRESS_ENABLED = "on";

await check("a press over the pace goes to Oriserve, with its slot intact", async () => {
  resetPacer();
  const oriCalls = [];
  const claims = [];
  const out = await dispatchPressToOurBot(
    { mobile: "9811484805" },
    { digit: "1", variant: "businessloans" },
    {
      // The pacer is full. This press must not wait, and must not spend a slot.
      hasRoom: () => false,
      dispatchToOri: (body) => oriCalls.push(body.mobile),
      sb: {
        rpc: async () => {
          claims.push("claimed");
          return { data: true, error: null };
        },
        from: () => ({ select: () => ({ in: async () => ({ data: [], error: null }) }) }),
      },
    }
  );

  assert.equal(out.dialled, false);
  assert.equal(out.reason, "dial_queue_full");
  assert.equal(out.handedToOriserve, true);
  assert.deepEqual(oriCalls, ["9811484805"]);
  // THE POINT: the slot is claimed AFTER the pace check, so a press we cannot
  // pace costs nothing from the day's allowance.
  assert.deepEqual(claims, [], "a paced-out press must not claim a daily slot");
});

await check("the wrong variant is still refused before any of this", async () => {
  resetPacer();
  let paced = 0;
  const out = await dispatchPressToOurBot(
    { mobile: "9811484805" },
    { digit: "1", variant: "herofincorp" },
    { pace: (fn) => { paced++; return fn(); } }
  );
  assert.equal(out.reason, "not_our_variant");
  assert.equal(paced, 0, "a press for another bot must never reach the pacer");
});

await drainPacer();
resetPacer();

console.log(failed === 0 ? "\nall good\n" : `\n${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
