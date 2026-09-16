/**
 * A re-broadcast selects people who ALREADY got a message. Every guard counts.
 *
 *   node test-rebroadcast.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * WHY THIS EXISTS
 *
 * /failed refuses anybody who already received a message. This route selects
 * them on purpose: 10,277 people got a Business Loans link in September and
 * never started the apply, because until 16 Sep that link put an OTP screen in
 * front of them and 93% of readers stopped there.
 *
 * Inverting the safety rule makes every other guard load-bearing, and this is a
 * 9,765-message serial run — it WILL be interrupted and somebody WILL run it
 * again. Without the repeat guard the second run messages the whole base twice.
 */
import assert from "node:assert/strict";
import { findRebroadcast, resolveRunCap } from "./lib/routes/resendFailedRoutes.js";

const SINCE = "2026-09-01T00:00:00.000Z";

const msg = (mobile, extra = {}) => ({
  phone_number: mobile,
  created_at: "2026-09-12T06:00:00Z",
  metadata: { status: "sent", digit: "1", variant: "businessloans", ...extra },
});

/** A fake database across the four tables the selection reads. */
function dbOf({ messages = [], otp = [], suppression = [], voice = [], fail = null }) {
  return {
    from(table) {
      const rows =
        table === "whatsapp_messages" ? messages
        : table === "portal_otp_sessions" ? otp
        : table === "contact_suppression" ? suppression
        : table === "voice_call_events" ? voice
        : [];
      const result =
        fail === table
          ? { data: null, error: { message: "boom" } }
          : { data: rows, error: null };
      const q = {
        select: () => q,
        eq: () => q,
        gte: () => q,
        is: () => q,
        order: () => q,
        limit: async () => result,
        then: (res) => Promise.resolve(result).then(res),
      };
      return q;
    },
  };
}

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

console.log("\nit selects people who got a link and never started\n");

await check("a delivered send with no apply attempt is selected", async () => {
  const { rows } = await findRebroadcast(dbOf({ messages: [msg("9811100001")] }), {
    sinceIso: SINCE, variant: "businessloans",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mobile, "9811100001");
});

await check("somebody who started the apply is left alone", async () => {
  const { rows, excluded } = await findRebroadcast(
    dbOf({ messages: [msg("9811100002")], otp: [{ mobile: "9811100002" }] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
  assert.equal(excluded.started, 1);
});

await check("a send that FAILED is not a re-broadcast candidate", async () => {
  // Those people belong to /failed, which sends them their first message.
  const { rows } = await findRebroadcast(
    dbOf({ messages: [msg("9811100003", { status: "failed" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
});

await check("another lender's send is not selected", async () => {
  const { rows } = await findRebroadcast(
    dbOf({ messages: [msg("9811100004", { variant: "herofincorp" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
});

console.log("\nnobody is messaged twice, however often the job is re-run\n");

await check("a mobile already re-broadcast is never selected again", async () => {
  // The guard that matters at 9,765 messages over a serial loop: the run will
  // be interrupted and re-run, and without this the base is messaged twice.
  const { rows, excluded } = await findRebroadcast(
    dbOf({
      messages: [
        msg("9811100005"),
        msg("9811100005", { source: "ivr_rebroadcast" }),
      ],
    }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0, "this customer would have been messaged a second time");
  assert.equal(excluded.already_rebroadcast, 1);
});

await check("the stamp excludes even when it arrives before the original", async () => {
  // Row order must not decide it.
  const { rows } = await findRebroadcast(
    dbOf({
      messages: [
        msg("9811100006", { source: "ivr_rebroadcast" }),
        msg("9811100006"),
      ],
    }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
});

await check("a re-broadcast stamp on ONE person does not exclude the rest", async () => {
  const { rows } = await findRebroadcast(
    dbOf({
      messages: [
        msg("9811100007"),
        msg("9811100008", { source: "ivr_rebroadcast" }),
        msg("9811100009"),
      ],
    }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.deepEqual(rows.map((r) => r.mobile).sort(), ["9811100007", "9811100009"]);
});

console.log("\nand people who asked not to be contacted are not contacted\n");

await check("an active suppression entry excludes the mobile", async () => {
  const { rows, excluded } = await findRebroadcast(
    dbOf({
      messages: [msg("9811100010")],
      suppression: [{ phone: "9811100010", released_at: null }],
    }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
  assert.equal(excluded.suppressed, 1);
});

await check("DND, NOT_INTERESTED and WRNG from the bot all exclude", async () => {
  // Said out loud on a recorded call. A second link is how a sender gets reported.
  for (const d of ["DND", "NOT_INTERESTED", "WRNG"]) {
    const { rows } = await findRebroadcast(
      dbOf({
        messages: [msg("9811100011")],
        voice: [{ mobile10: "9811100011", raw: { analysis: { DISPOSITION: d } } }],
      }),
      { sinceIso: SINCE, variant: "businessloans" }
    );
    assert.equal(rows.length, 0, `${d} was not excluded`);
  }
});

await check("a QUALIFIED_LEAD is NOT excluded", async () => {
  // Only refusals suppress. Excluding every bot outcome would empty the run.
  const { rows } = await findRebroadcast(
    dbOf({
      messages: [msg("9811100012")],
      voice: [{ mobile10: "9811100012", raw: { analysis: { DISPOSITION: "QUALIFIED_LEAD" } } }],
    }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 1);
});

await check("an unreadable suppression list REFUSES the run", async () => {
  // Fails closed. An exclusion list that cannot be read must never be treated
  // as an empty one — that is how a suppressed customer gets messaged.
  await assert.rejects(
    () => findRebroadcast(
      dbOf({ messages: [msg("9811100013")], fail: "contact_suppression" }),
      { sinceIso: SINCE, variant: "businessloans" }
    ),
    /suppression list unreadable/
  );
});

await check("unreadable voice outcomes also refuse the run", async () => {
  await assert.rejects(
    () => findRebroadcast(
      dbOf({ messages: [msg("9811100014")], fail: "voice_call_events" }),
      { sinceIso: SINCE, variant: "businessloans" }
    ),
    /voice outcomes unreadable/
  );
});

await check("no database means no candidates, not a throw", async () => {
  const { rows, error } = await findRebroadcast(null, { sinceIso: SINCE });
  assert.deepEqual(rows, []);
  assert.equal(error, "no_client");
});

console.log("\nthe re-broadcast ceiling is its own, and still only narrows\n");

await check("it can exceed the outage ceiling of 2000", async () => {
  // A whole base is not an outage cohort. 9,765 must be runnable in one go.
  assert.equal(resolveRunCap(undefined, 9765, 20000), 9765);
});

await check("but a limit still only narrows", () => {
  assert.equal(resolveRunCap(100, 9765, 20000), 100);
  assert.equal(resolveRunCap(999999, 9765, 20000), 9765);
  assert.equal(resolveRunCap(0, 9765, 20000), 9765);
});

await check("and nothing exceeds the hard ceiling", () => {
  assert.equal(resolveRunCap(999999, 999999, 20000), 20000);
});

console.log(`\n${failed === 0 ? `all ${n} checks passed` : `${failed} of ${n} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
