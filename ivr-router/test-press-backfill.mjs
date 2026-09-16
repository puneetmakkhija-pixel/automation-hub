/**
 * Replaying a press must never become a second press, or a second message.
 *
 *   node test-press-backfill.mjs
 *
 * Plain node, plain asserts, no credentials and no network.
 *
 * WHY THIS EXISTS
 *
 * 1,281 people pressed 1, were sent their WhatsApp, and never reached the CRM:
 * forwardPressToCrm failed and said nothing, because it is fire-and-forget by
 * design. 03 Sep lost 718 of 761; 11 Sep lost 563 of 705.
 *
 * public.ivr_press_lead does NOT dedupe its event insert — calling it twice for
 * one mobile writes two rows. Selection is therefore the only thing standing
 * between a recovery and a corrupted press count, so it is what these checks
 * are about.
 */
import assert from "node:assert/strict";
import { findUnrecordedPresses } from "./lib/routes/resendFailedRoutes.js";

const SINCE = "2026-09-01T00:00:00.000Z";

const msg = (mobile, extra = {}) => ({
  phone_number: mobile,
  created_at: "2026-09-11T04:20:00Z",
  metadata: { status: "sent", digit: "1", variant: "businessloans", ...extra },
});
const ev = (mobile, extra = {}) => ({
  phone_number: mobile, dtmf_input: "1", event_type: "dtmf", ...extra,
});

function dbOf({ messages = [], events = [], fail = null }) {
  return {
    from(table) {
      const rows = table === "whatsapp_messages" ? messages : events;
      const result = fail === table
        ? { data: null, error: { message: "boom" } }
        : { data: rows, error: null };
      const q = {
        select: () => q, eq: () => q, gte: () => q, is: () => q, order: () => q,
        limit: async () => result,
      };
      return q;
    },
  };
}

let failed = 0;
let n = 0;
const check = async (name, fn) => {
  n++;
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (error) { failed++; console.log(`  FAIL ${name}\n       ${error.message}`); }
};

console.log("\nit finds exactly the presses the CRM is missing\n");

await check("a press with no CRM event is recovered", async () => {
  const { rows } = await findUnrecordedPresses(dbOf({ messages: [msg("9811100001")] }), {
    sinceIso: SINCE, variant: "businessloans",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mobile, "9811100001");
});

await check("a press the CRM ALREADY has is never replayed", async () => {
  // The whole risk. ivr_press_lead does not dedupe, so replaying a recorded
  // press writes a second event and inflates the press count permanently.
  const { rows, excluded } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100002")], events: [ev("9811100002")] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0, "this press would have been recorded twice");
  assert.equal(excluded.already_recorded, 1);
});

await check("a DIFFERENT digit already recorded still counts as recorded", async () => {
  // The mobile is in the table. Replaying would add a second row for one call.
  const { rows } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100003")], events: [ev("9811100003", { dtmf_input: "2" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
});

await check("a failed send is still a press worth recovering", async () => {
  // Today's Ananta outage: the message failed, but the person did press 1.
  const { rows } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100004", { status: "failed" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 1);
});

await check("a re-broadcast is NOT a press and is never recovered as one", async () => {
  // Re-broadcast rows carry digit 1 too. Recovering them would invent
  // thousands of presses that never happened.
  const { rows } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100005", { source: "ivr_rebroadcast" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
});

await check("a digit other than 1 is not a press-1", async () => {
  const { rows } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100006", { digit: "2" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
});

await check("another lender's press is not recovered into this CRM", async () => {
  // bdl_leads is the Business Loans book. Six thousand Hero callers a day do
  // not belong in it.
  const { rows } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100007", { variant: "herofincorp" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 0);
});

await check("three sends to one person are one press to recover", async () => {
  const { rows } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100008"), msg("9811100008"), msg("9811100008")] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.equal(rows.length, 1);
});

await check("it keeps the real press time and the call's own ids", async () => {
  // The recovered row is dated today; without this the true press time is lost.
  const { rows } = await findUnrecordedPresses(
    dbOf({ messages: [msg("9811100009", { campaign_id: "c9", campaign_name: "Sep11", unique_id: "u1" })] }),
    { sinceIso: SINCE, variant: "businessloans" }
  );
  assert.deepEqual(
    { at: rows[0].pressedAt, c: rows[0].campaignId, u: rows[0].uniqueId },
    { at: "2026-09-11T04:20:00Z", c: "c9", u: "u1" }
  );
});

await check("an unreadable event table REFUSES the run", async () => {
  // Fails closed. Treating it as empty would replay every press of the month.
  await assert.rejects(
    () => findUnrecordedPresses(
      dbOf({ messages: [msg("9811100010")], fail: "ivr_campaign_events" }),
      { sinceIso: SINCE, variant: "businessloans" }
    ),
    /ivr_campaign_events unreadable/
  );
});

await check("no database means no candidates, not a throw", async () => {
  const { rows, error } = await findUnrecordedPresses(null, { sinceIso: SINCE });
  assert.deepEqual(rows, []);
  assert.equal(error, "no_client");
});

console.log(`\n${failed === 0 ? `all ${n} checks passed` : `${failed} of ${n} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
