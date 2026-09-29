/**
 * The press-1 funnel rollup — no Supabase client, no HTTP request.
 *
 *   node test-press1-funnel.mjs
 */
import assert from "node:assert/strict";
import { istDayBoundsUtc, istToday, summarizeRows } from "./lib/press1Funnel.js";

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
};

console.log("\nIST day boundaries\n");

check("IST midnight is 18:30 UTC the day before", () => {
  const { startIso, endIso } = istDayBoundsUtc("2026-09-29");
  assert.equal(startIso, "2026-09-28T18:30:00.000Z");
  assert.equal(endIso, "2026-09-29T18:30:00.000Z");
});

check("rejects a date that is not YYYY-MM-DD", () => {
  assert.throws(() => istDayBoundsUtc("29-09-2026"));
  assert.throws(() => istDayBoundsUtc(undefined));
});

check("istToday reads the IST calendar date, not the UTC one", () => {
  // 2026-09-29T19:00:00Z is 2026-09-30 00:30 IST -- past IST midnight even
  // though the UTC date is still the 29th.
  const today = istToday(new Date("2026-09-29T19:00:00.000Z"));
  assert.equal(today, "2026-09-30");
});

console.log("\nrolling rows into the funnel\n");

check("empty day: zeros, not a throw", () => {
  const out = summarizeRows([]);
  assert.equal(out.received, 0);
  assert.equal(out.dialled, 0);
  assert.deepEqual(out.by_provider, {});
});

check("counts received, dialled, and not-dialled by provider", () => {
  const rows = [
    { provider: "ours", variant: "businessloans", dispatched: true, reason: null, raw: {} },
    { provider: "ours", variant: "businessloans", dispatched: false, reason: "dial_queue_full", raw: {} },
    { provider: "oriserve", variant: "businessloans", dispatched: true, reason: null, raw: {} },
    { provider: "oriserve", variant: "herofincorp", dispatched: false, reason: "not_dialable_variant", raw: {} },
  ];
  const out = summarizeRows(rows);
  assert.equal(out.received, 4);
  assert.equal(out.dialled, 2);
  assert.equal(out.not_dialled, 2);
  assert.deepEqual(out.by_provider.ours, { dialled: 1, not_dialled: 1 });
  assert.deepEqual(out.by_provider.oriserve, { dialled: 1, not_dialled: 1 });
  assert.deepEqual(out.by_variant, { businessloans: 3, herofincorp: 1 });
});

check("groups not-dialled reasons per provider", () => {
  const rows = [
    { provider: "ours", dispatched: false, reason: "daily_cap", raw: {} },
    { provider: "ours", dispatched: false, reason: "daily_cap", raw: {} },
    { provider: "ours", dispatched: false, reason: "not_configured", raw: {} },
  ];
  const out = summarizeRows(rows);
  assert.deepEqual(out.not_dialled_reasons.ours, { daily_cap: 2, not_configured: 1 });
});

check("a missing reason files under 'unspecified' rather than dropping the row", () => {
  const out = summarizeRows([{ provider: "ours", dispatched: false, reason: null, raw: {} }]);
  assert.deepEqual(out.not_dialled_reasons.ours, { unspecified: 1 });
});

check("reads the A/B split's arm and fallback_reason out of raw, when present", () => {
  const rows = [
    { provider: "ours", dispatched: true, reason: null, raw: { arm: "ours" } },
    { provider: "oriserve", dispatched: true, reason: null, raw: { arm: "ours", fallback_reason: "daily_cap" } },
    { provider: "oriserve", dispatched: true, reason: null, raw: { arm: "oriserve" } },
    // No split fields at all -- must not appear as a zero-count key.
    { provider: "oriserve", dispatched: true, reason: null, raw: {} },
  ];
  const out = summarizeRows(rows);
  assert.deepEqual(out.split.arm_counts, { ours: 2, oriserve: 1 });
  assert.deepEqual(out.split.fallback_reasons, { daily_cap: 1 });
});

check("outside the split, arm_counts and fallback_reasons stay empty rather than zero", () => {
  const out = summarizeRows([{ provider: "ours", dispatched: true, reason: null, raw: {} }]);
  assert.deepEqual(out.split.arm_counts, {});
  assert.deepEqual(out.split.fallback_reasons, {});
});

console.log(failed === 0 ? "\nAll checks passed.\n" : `\n${failed} check(s) failed.\n`);
process.exit(failed === 0 ? 0 : 1);
