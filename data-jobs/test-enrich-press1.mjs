/**
 * The press-1 enrichment job's day walk.
 *
 *   node data-jobs/test-enrich-press1.mjs
 *
 * Same shape as the check files in ivr-router: plain node, no credentials and
 * no network. The enrichment itself is public.pl_press1_enrich() and is the
 * database's job; what is checked here is which days this script decides to
 * ask for, because a range that quietly skips a day leaves a hole in a table
 * nobody looks at until a lender asks for that day's sheet.
 */
import assert from "node:assert/strict";
import { daysInRange, addDays, istToday , rollUp } from "./enrich-press1-leads.js";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("\ndaysInRange");

check("walks an explicit range inclusively at both ends", () => {
  assert.deepEqual(daysInRange({ from: "2026-09-01", to: "2026-09-04" }),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
});

check("--days N counts back from today and includes today", () => {
  assert.deepEqual(daysInRange({ days: 3 }, "2026-09-04"),
    ["2026-09-02", "2026-09-03", "2026-09-04"]);
  assert.deepEqual(daysInRange({ days: 1 }, "2026-09-04"), ["2026-09-04"]);
});

check("defaults to today alone", () => {
  assert.deepEqual(daysInRange({}, "2026-09-04"), ["2026-09-04"]);
});

check("crosses a month boundary", () => {
  assert.deepEqual(daysInRange({ from: "2026-08-31", to: "2026-09-01" }),
    ["2026-08-31", "2026-09-01"]);
});

check("refuses a backwards range instead of silently doing nothing", () => {
  assert.throws(() => daysInRange({ from: "2026-09-04", to: "2026-09-01" }));
});

check("refuses a date it cannot parse", () => {
  assert.throws(() => daysInRange({ from: "01-09-2026", to: "2026-09-04" }));
});

/**
 * --from 2020-01-01 is a typo, not a backfill request. Left unchecked it is
 * two thousand round trips against a foreign table in another project.
 */
check("refuses a range wide enough to be a typo", () => {
  assert.throws(() => daysInRange({ from: "2020-01-01", to: "2026-09-04" }), /range too wide/);
});

console.log("\nIST");

check("today is IST's today, not UTC's", () => {
  // 2026-09-01 19:00 UTC is 2026-09-02 00:30 IST. A UTC-based default would
  // enrich the wrong day for every run in that five-and-a-half-hour window.
  assert.equal(istToday(new Date("2026-09-01T19:00:00Z")), "2026-09-02");
});

check("addDays steps whole days without drifting on month ends", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

console.log("\nan empty run says why it is empty");

/**
 * The reason this exists. On 05 Sep 2026 the cron logged presses:0 and exited
 * clean, and it took a hand query against whatsapp_messages to learn the day
 * held 768 press-1 rows, all of them a Business Loans campaign. That log line
 * reads identically when nobody dialled personal loans, when the IVR stops
 * recording presses, and when pl_press_lender() quietly stops recognising a
 * lender -- and the last one has happened here, when 3,740 Whistleloop presses
 * counted as 'unknown' until offerid=1351 was mapped.
 */
check("a quiet personal-loan day is distinguishable from no traffic at all", () => {
  const quiet = rollUp([{ presses: 0, matched: 0, press1_in_range: 768, dropped_by_lender: { businessloans: 768 } }]);
  const dark  = rollUp([{ presses: 0, matched: 0, press1_in_range: 0,   dropped_by_lender: {} }]);
  assert.equal(quiet.press1_in_range, 768);
  assert.deepEqual(quiet.dropped_by_lender, { businessloans: 768 });
  assert.match(quiet.note, /none of it was personal-loan/);
  assert.equal(dark.press1_in_range, 0);
  assert.match(dark.note, /no press-1 rows at all/);
  assert.notEqual(quiet.note, dark.note);
});

check("a run that enriched something carries no note to skim past", () => {
  const r = rollUp([{ presses: 3742, matched: 1724, press1_in_range: 4694, dropped_by_lender: { businessloans: 952 } }]);
  assert.equal(r.note, undefined);
  assert.equal(r.match_rate, 46.1);
});

/** 3,742 enriched + 952 dropped = 4,694 seen. If that stops adding up, a filter changed. */
check("sums presses and drops across days, and the arithmetic closes", () => {
  const r = rollUp([
    { presses: 3742, matched: 1724, press1_in_range: 4694, dropped_by_lender: { businessloans: 952 } },
    { presses: 0,    matched: 0,    press1_in_range: 768,  dropped_by_lender: { businessloans: 768 } },
  ]);
  assert.equal(r.days, 2);
  assert.equal(r.presses, 3742);
  assert.equal(r.press1_in_range, 5462);
  assert.equal(r.dropped_by_lender.businessloans, 1720);
  assert.equal(r.presses + r.dropped_by_lender.businessloans, r.press1_in_range);
});

check("an older function that does not send the new fields still rolls up", () => {
  const r = rollUp([{ presses: 10, matched: 4 }]);
  assert.equal(r.press1_in_range, 0);
  assert.deepEqual(r.dropped_by_lender, {});
  assert.equal(r.match_rate, 40);
});

check("no days, and a null result, do not throw", () => {
  assert.equal(rollUp([]).days, 0);
  assert.equal(rollUp([null]).presses, 0);
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
