import test from "node:test";
import assert from "node:assert/strict";
import { istClock, effectiveWindow, planDue, projectSchedule, batchName, runPlannerTick, MAX_CONSECUTIVE_FAILURES } from "./lib/campaignPlanner.js";

// 2026-10-05 is a Monday. 06:30 UTC = 12:00 IST.
const at = (utc) => new Date(utc);
const MON_NOON = at("2026-10-05T06:30:00Z");
const basePlan = (o = {}) => ({
  id: "p1", name: "Flexi Oct", status: "approved", prompt_id: "77", dtmf: "1", batch_size: 3,
  window_start: "10:00:00", window_end: "19:00:00", days_of_week: [1, 2, 3, 4, 5, 6],
  start_date: "2026-10-01", end_date: null, lender: null, consecutive_failures: 0, ...o,
});

test("istClock converts to IST and ISO weekday", () => {
  const c = istClock(MON_NOON);
  assert.deepEqual(c, { date: "2026-10-05", time: "12:00", dow: 1, hourKey: "2026-10-05T12" });
  assert.equal(istClock(at("2026-10-04T06:30:00Z")).dow, 7); // Sunday
});

test("window is clamped to TRAI 09:00–21:00", () => {
  assert.deepEqual(effectiveWindow({ window_start: "07:00", window_end: "23:30" }), { start: "09:00", end: "21:00" });
  assert.equal(effectiveWindow({ window_start: "21:30", window_end: "23:00" }), null);
});

test("planDue: status, recording, days, window, dates, last 30 minutes", () => {
  assert.equal(planDue(basePlan(), MON_NOON).due, true);
  assert.match(planDue(basePlan({ status: "pending_approval" }), MON_NOON).why, /status/);
  assert.match(planDue(basePlan({ prompt_id: null }), MON_NOON).why, /recording/);
  assert.match(planDue(basePlan({ days_of_week: [2] }), MON_NOON).why, /day/);
  assert.match(planDue(basePlan({ start_date: "2026-10-06" }), MON_NOON).why, /start/);
  assert.match(planDue(basePlan({ end_date: "2026-10-04" }), MON_NOON).why, /end/);
  assert.match(planDue(basePlan(), at("2026-10-05T03:00:00Z")).why, /outside/);        // 08:30 IST
  assert.match(planDue(basePlan(), at("2026-10-05T13:05:00Z")).why, /30 min/);         // 18:35 IST
  assert.match(planDue(basePlan({ window_start: "06:00" }), at("2026-10-05T03:00:00Z")).why, /outside window 09:00/); // clamp wins
});

test("projectSchedule", () => {
  assert.deepEqual(projectSchedule({ window_start: "10:00", window_end: "19:00", batch_size: 500 }, 10000), { batches: 20, hoursPerDay: 9, days: 3 });
});

test("batchName is safe and unique per hour", () => {
  assert.equal(batchName({ name: "Flexi BL / Oct wk-1" }, 4, istClock(MON_NOON)), "FLEXI_BL_OCT_WK_1_B4_2026100512");
});

// ── tick, against an in-memory fake ──────────────────────────────────────────
function fakeWorld({ plans, contacts, paused = false, appConfigError = null }) {
  const state = { plans: plans.map((p) => ({ ...p })), batches: [], contacts: contacts.map((m) => ({ mobile10: m, batch_id: null, dispatched_at: null })), rpcs: [] };
  const table = (name) => {
    const q = { name, filters: [], op: "select", patch: null, row: null, opts: {} };
    const api = {
      select(_cols, opts) { if (q.op === "select") q.opts = opts ?? {}; return api; },
      eq(k, v) { q.filters.push((r) => r[k] === v); return api; },
      in(k, vs) { q.filters.push((r) => vs.includes(r[k])); return api; },
      order() { return api; },
      insert(row) { q.op = "insert"; q.row = row; return api; },
      update(patch) { q.op = "update"; q.patch = patch; return api; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(res, rej) { return run(false).then(res, rej); },
    };
    function rows() {
      if (name === "ivr_plan") return state.plans;
      if (name === "ivr_plan_batch") return state.batches;
      if (name === "app_config") return [{ key: "pipeline_paused", value: paused ? "on" : "off" }];
      return [];
    }
    async function run(single) {
      if (name === "app_config" && appConfigError) return { data: null, error: { message: appConfigError } };
      if (q.op === "insert") {
        if (name === "ivr_plan_batch" && state.batches.some((b) => b.plan_id === q.row.plan_id && b.hour_key === q.row.hour_key))
          return { data: null, error: { message: "duplicate key value violates unique constraint" } };
        const row = { id: `b${state.batches.length + 1}`, ...q.row };
        state.batches.push(row);
        return { data: row, error: null };
      }
      const hit = rows().filter((r) => q.filters.every((f) => f(r)));
      if (q.op === "update") { hit.forEach((r) => Object.assign(r, q.patch)); return { data: hit, error: null }; }
      if (q.opts.head) return { count: hit.length, error: null };
      return { data: single ? hit[0] ?? null : hit, error: null };
    }
    return api;
  };
  const sb = {
    from: table,
    async rpc(fn, args) {
      state.rpcs.push(fn);
      if (fn === "ivr_plan_claim") {
        const free = state.contacts.filter((c) => c.batch_id === null).slice(0, args.p_limit);
        free.forEach((c) => (c.batch_id = args.p_batch));
        return { data: free.map((c) => ({ mobile10: c.mobile10, customer_name: null })), error: null };
      }
      if (fn === "ivr_plan_release") { state.contacts.filter((c) => c.batch_id === args.p_batch).forEach((c) => (c.batch_id = null)); return { data: 0, error: null }; }
      if (fn === "ivr_plan_mark_dispatched") { state.contacts.filter((c) => c.batch_id === args.p_batch).forEach((c) => (c.dispatched_at = "now")); return { data: 0, error: null }; }
      return { data: 0, error: null };
    },
  };
  return { sb, state };
}
const goodObd = () => ({ calls: [], async uploadBaseFile(csv, name) { this.calls.push(["base", name, csv]); return { baseId: 11 }; }, async composeCampaign(cfg) { this.calls.push(["compose", cfg]); return { campaignId: 99 }; } });
const ON = { CAMPAIGN_PLANNER_ENABLED: "on" };

test("tick dials one batch of batch_size, marks dispatched, sets running", async () => {
  const { sb, state } = fakeWorld({ plans: [basePlan()], contacts: ["9000000001", "9000000002", "9000000003", "9000000004"] });
  const obd = goodObd();
  const r = await runPlannerTick({ sb, obd, env: ON, now: () => MON_NOON });
  assert.equal(r.plans[0].dialled, 3);
  assert.equal(state.contacts.filter((c) => c.dispatched_at).length, 3);
  assert.equal(state.plans[0].status, "running");
  const compose = obd.calls.find((c) => c[0] === "compose")[1];
  assert.equal(compose.menuPId, "77");
  assert.equal(compose.baseId, 11);
  assert.equal(compose.dtmf, "1");
});

test("a plan with a thank-you recording passes it to the campaign; one without sends an empty slot", async () => {
  for (const [plan, want] of [[basePlan({ thanks_prompt_id: "55" }), "55"], [basePlan(), ""]]) {
    const { sb } = fakeWorld({ plans: [plan], contacts: ["9000000001", "9000000002"] });
    const obd = goodObd();
    await runPlannerTick({ sb, obd, env: ON, now: () => MON_NOON });
    assert.equal(obd.calls.find((c) => c[0] === "compose")[1].thanksPId, want);
  }
});

test("second tick in the same IST hour does nothing", async () => {
  const { sb } = fakeWorld({ plans: [basePlan()], contacts: ["9000000001", "9000000002", "9000000003", "9000000004"] });
  await runPlannerTick({ sb, obd: goodObd(), env: ON, now: () => MON_NOON });
  const r2 = await runPlannerTick({ sb, obd: goodObd(), env: ON, now: () => MON_NOON });
  assert.equal(r2.plans[0].skipped, "already batched this hour");
});

test("kill switch on, or unreadable, means nobody is dialled", async () => {
  for (const w of [{ paused: true }, { appConfigError: "boom" }]) {
    const { sb } = fakeWorld({ plans: [basePlan()], contacts: ["9000000001"], ...w });
    const obd = goodObd();
    const r = await runPlannerTick({ sb, obd, env: ON, now: () => MON_NOON });
    assert.equal(r.skipped, "pipeline_paused");
    assert.equal(obd.calls.length, 0);
  }
});

test("not enabled: base prepared, no compose, people released", async () => {
  const { sb, state } = fakeWorld({ plans: [basePlan()], contacts: ["9000000001", "9000000002"] });
  const obd = goodObd();
  const r = await runPlannerTick({ sb, obd, env: {}, now: () => MON_NOON });
  assert.equal(r.plans[0].dialled, false);
  assert.equal(obd.calls.some((c) => c[0] === "compose"), false);
  assert.equal(state.contacts.every((c) => c.batch_id === null && !c.dispatched_at), true);
  assert.equal(state.batches[0].status, "prepared_only");
});

test("compose failure releases people; three in a row auto-pauses", async () => {
  const { sb, state } = fakeWorld({ plans: [basePlan({ consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1 })], contacts: ["9000000001"] });
  const obd = { async uploadBaseFile() { return { baseId: 1 }; }, async composeCampaign() { return { message: "Invalid" }; } };
  const r = await runPlannerTick({ sb, obd, env: ON, now: () => MON_NOON });
  assert.match(r.plans[0].failed, /no campaign id/);
  assert.equal(r.plans[0].autoPaused, true);
  assert.equal(state.plans[0].status, "paused");
  assert.match(state.plans[0].pause_reason, /auto-paused/);
  assert.equal(state.contacts[0].batch_id, null);
  assert.equal(state.batches[0].status, "failed");
});

test("empty plan completes", async () => {
  const { sb, state } = fakeWorld({ plans: [basePlan()], contacts: [] });
  const r = await runPlannerTick({ sb, obd: goodObd(), env: ON, now: () => MON_NOON });
  assert.equal(r.plans[0].completed, true);
  assert.equal(state.plans[0].status, "completed");
});

test("outside window: no batch row at all", async () => {
  const { sb, state } = fakeWorld({ plans: [basePlan()], contacts: ["9000000001"] });
  const r = await runPlannerTick({ sb, obd: goodObd(), env: ON, now: () => at("2026-10-05T16:00:00Z") }); // 21:30 IST
  assert.match(r.plans[0].skipped, /outside/);
  assert.equal(state.batches.length, 0);
});
