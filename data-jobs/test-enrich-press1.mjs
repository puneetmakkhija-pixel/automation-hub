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
import { daysInRange, addDays, istToday } from "./enrich-press1-leads.js";

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

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
