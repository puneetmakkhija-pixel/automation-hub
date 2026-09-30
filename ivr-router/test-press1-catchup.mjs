/**
 * The end-of-gap sweep: everyone who pressed 1 today or yesterday and got no
 * bot dispatch attempt, called oldest press first, through the one dispatcher.
 *
 *   node test-press1-catchup.mjs
 */
import assert from "node:assert/strict";
import {
  catchupCandidates,
  catchupEnabled,
  catchupLimit,
  istDayStartIso,
  istLookbackStartIso,
  runPress1Catchup,
} from "./lib/press1Catchup.js";

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

console.log("\nthe switch\n");

await check("off unless exactly 'on', same posture as OUR_BOT_PRESS_ENABLED", () => {
  assert.equal(catchupEnabled({}), false);
  assert.equal(catchupEnabled({ PRESS1_CATCHUP_ENABLED: "true" }), false);
  assert.equal(catchupEnabled({ PRESS1_CATCHUP_ENABLED: "1" }), false);
  assert.equal(catchupEnabled({ PRESS1_CATCHUP_ENABLED: "on" }), true);
  assert.equal(catchupEnabled({ PRESS1_CATCHUP_ENABLED: " ON " }), true);
});

await check("with the switch off, the sweep reads nothing and dials nobody", async () => {
  let readCalled = false;
  const out = await runPress1Catchup({
    env: {},
    sb: { from: () => { readCalled = true; return {}; } },
    dispatch: async () => ({ dialled: true }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.enabled, false);
  assert.equal(out.candidates, 0);
  assert.equal(readCalled, false, "reaching the route must not be permission to dial");
});

console.log("\nthe limit\n");

await check("the limit defaults to 200, and a typo cannot become 'no limit'", () => {
  assert.equal(catchupLimit({}), 200);
  assert.equal(catchupLimit({ PRESS1_CATCHUP_LIMIT: "" }), 200);
  assert.equal(catchupLimit({ PRESS1_CATCHUP_LIMIT: "abc" }), 200);
  assert.equal(catchupLimit({ PRESS1_CATCHUP_LIMIT: "-5" }), 200);
  assert.equal(catchupLimit({ PRESS1_CATCHUP_LIMIT: "0" }), 200);
  assert.equal(catchupLimit({ PRESS1_CATCHUP_LIMIT: "50" }), 50);
});

console.log("\nthe IST day boundary\n");

await check("today starts at 00:00 IST, expressed as the UTC instant that is", () => {
  // 2026-09-28 10:00 UTC = 2026-09-28 15:30 IST -> today's IST midnight is
  // 2026-09-27 18:30 UTC.
  const now = new Date("2026-09-28T10:00:00.000Z");
  assert.equal(istDayStartIso(now), "2026-09-27T18:30:00.000Z");
});

await check("just before IST midnight still belongs to the day that is ending", () => {
  // 2026-09-27 18:29:59 UTC = 2026-09-27 23:59:59 IST.
  const now = new Date("2026-09-27T18:29:59.000Z");
  assert.equal(istDayStartIso(now), "2026-09-26T18:30:00.000Z");
});

console.log("\nthe lookback floor\n");

await check("the lookback floor is yesterday's IST midnight, one day before today's", () => {
  const now = new Date("2026-09-28T10:00:00.000Z");
  assert.equal(istDayStartIso(now), "2026-09-27T18:30:00.000Z");
  assert.equal(istLookbackStartIso(now), "2026-09-26T18:30:00.000Z");
});

console.log("\ncandidate selection\n");

// A hand-rolled, order-preserving chainable stub is simpler here than
// reimplementing PostgREST's builder — every method returns `this` except the
// terminal one, which resolves.
function leadsQuery(rows) {
  const q = {
    _rows: rows,
    eq() { return q; },
    gte(col, value) { q._rows = q._rows.filter((r) => r[col] >= value); return q; },
    lt(col, value) { q._rows = q._rows.filter((r) => r[col] < value); return q; },
    order(col, { ascending }) {
      q._rows = [...q._rows].sort((a, b) =>
        ascending ? a[col].localeCompare(b[col]) : b[col].localeCompare(a[col])
      );
      return q;
    },
    limit(n) { q._rows = q._rows.slice(0, n); return q; },
    then(resolve) { resolve({ data: q._rows, error: null }); },
  };
  return q;
}

function suppressionQuery(phones) {
  const q = {
    is() { return q; },
    in(_col, mobiles) {
      const blocked = mobiles.filter((m) => phones.includes(m));
      return Promise.resolve({ data: blocked.map((phone) => ({ phone })), error: null });
    },
  };
  return q;
}

function sbFor({ leads = [], suppressedPhones = [] } = {}) {
  return {
    from(table) {
      if (table === "v_ivr_lead") return { select: () => leadsQuery(leads) };
      if (table === "contact_suppression") return { select: () => suppressionQuery(suppressedPhones) };
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

const lead = (mobile10, first_pressed_at, over = {}) => ({
  mobile10, first_pressed_at, customer_name: null, press_variant: "businessloans", ...over,
});

await check("candidates come back oldest press first", async () => {
  const sb = sbFor({
    leads: [
      lead("9876543210", "2026-09-28T10:00:00.000Z"),
      lead("9123456780", "2026-09-28T06:00:00.000Z"),
      lead("9988776655", "2026-09-28T08:00:00.000Z"),
    ],
  });
  const out = await catchupCandidates(sb, { now: new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(out.map((r) => r.mobile10), ["9123456780", "9988776655", "9876543210"]);
});

await check("an invalid mobile is dropped rather than dialled", async () => {
  const sb = sbFor({ leads: [lead("12345", "2026-09-28T06:00:00.000Z")] });
  const out = await catchupCandidates(sb, {});
  assert.deepEqual(out, []);
});

await check("a suppressed contact is never a candidate for a call", async () => {
  const sb = sbFor({
    leads: [lead("9876543210", "2026-09-28T06:00:00.000Z"), lead("9123456780", "2026-09-28T07:00:00.000Z")],
    suppressedPhones: ["9876543210"],
  });
  // now pinned, like every sibling test in this file: catchupCandidates
  // filters on a lookback floor relative to `now`, so leaving `now` at its
  // real-wall-clock default makes these hardcoded 2026-09-28 leads age out
  // of the window the day after this test was written, and the test starts
  // failing for a reason that has nothing to do with suppression at all.
  const out = await catchupCandidates(sb, { now: new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(out.map((r) => r.mobile10), ["9123456780"]);
});

await check("yesterday's still-undialled press is a candidate today", async () => {
  const sb = sbFor({ leads: [lead("9876543210", "2026-09-27T10:00:00.000Z")] });
  const out = await catchupCandidates(sb, { now: new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(out.map((r) => r.mobile10), ["9876543210"]);
});

await check("a press from two days ago has aged out of the sweep", async () => {
  const sb = sbFor({ leads: [lead("9876543210", "2026-09-26T10:00:00.000Z")] });
  const out = await catchupCandidates(sb, { now: new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(out, []);
});

await check("today's presses come first, backlog after, not merged oldest-first", async () => {
  const sb = sbFor({
    leads: [
      lead("9876543210", "2026-09-28T06:00:00.000Z"),
      lead("9123456780", "2026-09-27T10:00:00.000Z"),
    ],
  });
  const out = await catchupCandidates(sb, { now: new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(out.map((r) => r.mobile10), ["9876543210", "9123456780"]);
});

await check("today's unused quota rolls over to the backlog", async () => {
  // limit 4 -> today's quota is ceil(4*0.5) = 2, but today only has 1
  // candidate, so the backlog should get the other 3 slots, not just 2.
  const sb = sbFor({
    leads: [
      lead("9111111111", "2026-09-28T06:00:00.000Z"),
      lead("9222222222", "2026-09-27T01:00:00.000Z"),
      lead("9333333333", "2026-09-27T02:00:00.000Z"),
      lead("9444444444", "2026-09-27T03:00:00.000Z"),
      lead("9555555555", "2026-09-27T04:00:00.000Z"),
    ],
  });
  const out = await catchupCandidates(sb, { limit: 4, now: new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(out.map((r) => r.mobile10), [
    "9111111111", "9222222222", "9333333333", "9444444444",
  ]);
});

await check("today is capped at its quota even when the backlog is thin", async () => {
  // limit 4 -> today's quota is ceil(4*0.5) = 2, today has 3 candidates but
  // only the oldest 2 should be taken even though the backlog has just 1.
  const sb = sbFor({
    leads: [
      lead("9111111111", "2026-09-28T06:00:00.000Z"),
      lead("9222222222", "2026-09-28T07:00:00.000Z"),
      lead("9333333333", "2026-09-28T08:00:00.000Z"),
      lead("9444444444", "2026-09-27T10:00:00.000Z"),
    ],
  });
  const out = await catchupCandidates(sb, { limit: 4, now: new Date("2026-09-28T12:00:00.000Z") });
  assert.deepEqual(out.map((r) => r.mobile10), [
    "9111111111", "9222222222", "9444444444",
  ]);
});

console.log("\nthe run\n");

const ON = { PRESS1_CATCHUP_ENABLED: "on" };

await check("every candidate is dialled through the one dispatcher, in order", async () => {
  const sb = sbFor({
    leads: [
      lead("9123456780", "2026-09-28T06:00:00.000Z"),
      lead("9876543210", "2026-09-28T07:00:00.000Z"),
    ],
  });
  const dialledOrder = [];
  const out = await runPress1Catchup({
    env: ON,
    sb,
    now: new Date("2026-09-28T12:00:00.000Z"),
    dispatch: async (body, ctx) => {
      dialledOrder.push(body.mobile);
      assert.equal(ctx.digit, "1");
      assert.equal(ctx.variant, "businessloans");
      return { dialled: true };
    },
  });
  assert.deepEqual(dialledOrder, ["9123456780", "9876543210"]);
  assert.equal(out.candidates, 2);
  assert.equal(out.dialled, 2);
});

await check("a per-candidate throw is counted, not fatal to the run", async () => {
  const sb = sbFor({
    leads: [lead("9123456780", "2026-09-28T06:00:00.000Z"), lead("9876543210", "2026-09-28T07:00:00.000Z")],
  });
  let calls = 0;
  const out = await runPress1Catchup({
    env: ON,
    sb,
    now: new Date("2026-09-28T12:00:00.000Z"), // pinned -- see the suppression test's comment above
    dispatch: async () => {
      calls++;
      if (calls === 1) throw new Error("journey-run unreachable");
      return { dialled: true };
    },
  });
  assert.equal(out.errors, 1);
  assert.equal(out.dialled, 1);
  assert.equal(calls, 2, "one candidate throwing must not stop the rest");
});

await check("Oriserve hand-offs and skips are counted separately from dials", async () => {
  const sb = sbFor({
    leads: [
      lead("9123456780", "2026-09-28T06:00:00.000Z"),
      lead("9876543210", "2026-09-28T07:00:00.000Z"),
      lead("9988776655", "2026-09-28T08:00:00.000Z"),
    ],
  });
  let n = 0;
  const out = await runPress1Catchup({
    env: ON,
    sb,
    now: new Date("2026-09-28T12:00:00.000Z"), // pinned -- see the suppression test's comment above
    dispatch: async () => {
      n++;
      if (n === 1) return { dialled: true };
      if (n === 2) return { dialled: false, handedToOriserve: true };
      return { dialled: false, reason: "bad_mobile" };
    },
  });
  assert.equal(out.dialled, 1);
  assert.equal(out.handedToOriserve, 1);
  assert.equal(out.skipped, 1);
});

await check("an unreadable candidate pool fails the run rather than dialling nothing silently", async () => {
  const sb = { from: () => ({ select: () => ({ eq: function () { return this; }, gte: function () { return this; }, order: function () { return this; }, limit: function () { return this; }, then: (resolve) => resolve({ data: null, error: { message: "connection refused" } }) }) }) };
  const out = await runPress1Catchup({ env: ON, sb, dispatch: async () => ({ dialled: true }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /connection refused/);
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
