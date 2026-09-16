/**
 * Nobody gets a message twice, and the cap can only narrow.
 *
 *   node test-resend-failed.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * WHY THIS EXISTS
 *
 * On 16 Sep 2026 Ananta timed out for ninety minutes: 769 send attempts failed
 * across 257 people, all of whom had pressed 1 and were owed a WhatsApp, and
 * nothing retried them. The two ways a recovery path makes things worse than
 * the outage are sending somebody a SECOND copy of a message they already got,
 * and sending to more people than the operator asked for. Both are here.
 */
import assert from "node:assert/strict";
import { findOwed, resolveRunCap } from "./lib/routes/resendFailedRoutes.js";

const SINCE = "2026-09-16T00:00:00.000Z";

/** A fake send log. Shapes match public.whatsapp_messages exactly. */
function log(rows) {
  return {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        gte: () => q,
        order: () => q,
        limit: async () => ({ data: rows, error: null }),
      };
      return q;
    },
  };
}

const row = (mobile, status, at, extra = {}) => ({
  phone_number: mobile,
  created_at: at,
  metadata: { status, digit: "1", variant: "businessloans", ...extra },
});

let failed = 0;
let n = 0;
const check = async (name, fn) => {
  n++;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log("\nit finds exactly the people who were owed a message\n");

await check("a failed send with no success is owed one", async () => {
  const { rows } = await findOwed(log([row("9811100001", "failed", "2026-09-16T06:10:00Z")]), {
    sinceIso: SINCE,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mobile, "9811100001");
});

await check("a mobile that later SUCCEEDED that day is not owed one", async () => {
  // The case that matters most. During the outage many numbers failed on one
  // attempt and went through on the next; messaging them again is a duplicate
  // to a real customer.
  const { rows } = await findOwed(
    log([
      row("9811100002", "failed", "2026-09-16T06:10:00Z"),
      row("9811100002", "sent", "2026-09-16T06:12:00Z"),
    ]),
    { sinceIso: SINCE }
  );
  assert.equal(rows.length, 0, "a customer who got the message would be sent it again");
});

await check("success BEFORE the failure also clears it", async () => {
  // Order must not matter: the question is whether the day produced a delivery.
  const { rows } = await findOwed(
    log([
      row("9811100003", "sent", "2026-09-16T05:00:00Z"),
      row("9811100003", "failed", "2026-09-16T06:10:00Z"),
    ]),
    { sinceIso: SINCE }
  );
  assert.equal(rows.length, 0);
});

await check("a success on a DIFFERENT day does not clear today's failure", async () => {
  // Yesterday's message is not this press's message.
  const { rows } = await findOwed(
    log([
      row("9811100004", "sent", "2026-09-15T06:00:00Z"),
      row("9811100004", "failed", "2026-09-16T06:10:00Z"),
    ]),
    { sinceIso: "2026-09-15T00:00:00.000Z" }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, "2026-09-16");
});

await check("the IST day boundary is used, not UTC", async () => {
  // The only pair that tells the two readings apart: both timestamps fall on
  // the same UTC day but different IST days.
  //
  //   17:00Z -> 22:30 IST on the 16th
  //   19:00Z -> 00:30 IST on the 17th
  //
  // Read as UTC they cancel, and the failure on the 16th is silently written
  // off against a message belonging to the 17th. Read as IST — the day the
  // business actually runs on — the 16th is still owed.
  //
  // The morning batch window (09:00-12:30 IST) means this cannot arise today.
  // It is here to pin the grain, because "which day" is the whole basis of
  // deciding whether somebody already got their message.
  const { rows } = await findOwed(
    log([
      row("9811100005", "failed", "2026-09-16T17:00:00Z"),
      row("9811100005", "sent", "2026-09-16T19:00:00Z"),
    ]),
    { sinceIso: SINCE }
  );
  assert.equal(rows.length, 1, "the 16th's failure was cancelled by the 17th's message");
  assert.equal(rows[0].day, "2026-09-16");
});

await check("three failures for one person are one owed message", async () => {
  // The real shape of the incident: the panel retried, so 769 attempts covered
  // only 257 people. Counting attempts would message each of them three times.
  const { rows } = await findOwed(
    log([
      row("9811100006", "failed", "2026-09-16T06:10:00Z"),
      row("9811100006", "failed", "2026-09-16T06:10:02Z"),
      row("9811100006", "failed", "2026-09-16T06:10:05Z"),
    ]),
    { sinceIso: SINCE }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firstFailedAt, "2026-09-16T06:10:00Z", "should keep the earliest press");
});

await check("it carries the original digit, variant and campaign forward", async () => {
  const { rows } = await findOwed(
    log([
      row("9811100007", "failed", "2026-09-16T06:10:00Z", {
        digit: "2", variant: "herofincorp", campaign_id: "c9", campaign_name: "Sep16", unique_id: "u1",
      }),
    ]),
    { sinceIso: SINCE }
  );
  assert.deepEqual(
    { d: rows[0].digit, v: rows[0].variant, c: rows[0].campaignId, u: rows[0].uniqueId },
    { d: "2", v: "herofincorp", c: "c9", u: "u1" }
  );
});

await check("a variant filter narrows to that book only", async () => {
  const rowsIn = [
    row("9811100008", "failed", "2026-09-16T06:10:00Z"),
    row("9811100009", "failed", "2026-09-16T06:10:00Z", { variant: "herofincorp" }),
  ];
  const all = await findOwed(log(rowsIn), { sinceIso: SINCE });
  const bl = await findOwed(log(rowsIn), { sinceIso: SINCE, variant: "businessloans" });
  assert.equal(all.rows.length, 2);
  assert.equal(bl.rows.length, 1);
  assert.equal(bl.rows[0].mobile, "9811100008");
});

await check("an unusable mobile is skipped rather than sent to", async () => {
  const { rows } = await findOwed(
    log([row("12", "failed", "2026-09-16T06:10:00Z")]),
    { sinceIso: SINCE }
  );
  assert.equal(rows.length, 0);
});

await check("no database means no candidates, not a throw", async () => {
  const { rows, error } = await findOwed(null, { sinceIso: SINCE });
  assert.deepEqual(rows, []);
  assert.equal(error, "no_client");
});

console.log("\nthe cap can only ever narrow the run\n");

await check("a smaller limit narrows it", () => {
  assert.equal(resolveRunCap(1, 257), 1);
  assert.equal(resolveRunCap(50, 257), 50);
});

await check("a larger limit CANNOT widen it", () => {
  // If a body could raise the cap, the cap protects nobody.
  assert.equal(resolveRunCap(100000, 257), 257);
  assert.equal(resolveRunCap(258, 257), 257);
});

await check("absent or nonsense means everything available", () => {
  for (const bad of [undefined, null, "", "abc", NaN]) {
    assert.equal(resolveRunCap(bad, 257), 257);
  }
});

await check("zero, negative and fractional are handled", () => {
  assert.equal(resolveRunCap(0, 257), 257, "0 is not a request for none");
  assert.equal(resolveRunCap(-5, 257), 257);
  assert.equal(resolveRunCap(2.9, 257), 2, "fractional rounds down, never up");
});

await check("nothing can exceed the hard ceiling", () => {
  assert.equal(resolveRunCap(999999, 50000), 2000);
  assert.equal(resolveRunCap(undefined, 50000), 2000);
});

console.log(`\n${failed === 0 ? `all ${n} checks passed` : `${failed} of ${n} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
