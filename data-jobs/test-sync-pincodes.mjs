/**
 * The pincode sync: the guard and the row filter, not the network.
 *
 *   node data-jobs/test-sync-pincodes.mjs
 *
 * Plain node, no credentials and no network. Two comments in
 * sync-pincodes-from-crm.js said "Exported for the unit test" and "shrinkGuard
 * is imported by the test" while no such test existed. This is that test.
 *
 * What is checked here is what gets DISCARDED, because that is what fails
 * quietly. A pincode this job wrongly drops does not throw and does not show up
 * as an error: it shows up weeks later as a lender the IVR stopped offering in
 * a district nobody was watching.
 */
import assert from "node:assert/strict";
import { normalizePincodeRows, shrinkGuard } from "./sync-pincodes-from-crm.js";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("\nthe shrink guard");

check("lets a normal refresh through", () => {
  assert.equal(shrinkGuard(15227, 15200, false), null);
  assert.equal(shrinkGuard(15300, 15227, false), null);
});

/** Hero's 28 Jul list dropped 101 of 15,328 and Poonawalla's dropped 20. Both must pass. */
check("lets a real de-listing through", () => {
  assert.equal(shrinkGuard(15227, 15328, false), null);
  assert.equal(shrinkGuard(178, 198, false), null);
});

check("refuses a source that returned nothing", () => {
  const b = shrinkGuard(0, 15227, false);
  assert.match(b.error, /source returned no pincodes/);
  assert.equal(b.live, 15227);
});

check("refuses a list that shrank by more than a quarter", () => {
  const b = shrinkGuard(1000, 15227, false);
  assert.match(b.error, /shrinks by 93\.4%/);
});

/** Exactly 25% is not "more than", so it passes; a hair over does not. */
check("the threshold is a quarter, and the boundary is not off by one", () => {
  assert.equal(shrinkGuard(75, 100, false), null);
  assert.notEqual(shrinkGuard(74, 100, false), null);
});

check("--force overrides, and a first run into an empty table is not a shrink", () => {
  assert.equal(shrinkGuard(0, 15227, true), null);
  assert.equal(shrinkGuard(15227, 0, false), null);
  assert.equal(shrinkGuard(0, 0, false), null);
});

console.log("\nthe row filter says what it discarded");

const NOW = "2026-09-06T00:00:00.000Z";

check("keeps good pincodes and maps the columns", () => {
  const r = normalizePincodeRows(
    [{ pincode: "560001", status: "Serviceable", is_prime: true, state: "KA" }],
    "poonawala",
    NOW
  );
  assert.equal(r.records.length, 1);
  assert.deepEqual(r.records[0], {
    pincode: "560001", lender_type: "poonawala", status: "Serviceable",
    is_prime: true, state: "KA", updated_at: NOW,
  });
  assert.equal(r.dropped_malformed, 0);
  assert.equal(r.dropped_duplicate, 0);
});

/**
 * The reason this file exists. A source that starts sending "110001.0" loses
 * every row, and before this the only visible symptom was a smaller number.
 */
check("counts malformed rows instead of dropping them in silence", () => {
  const r = normalizePincodeRows(
    [
      { pincode: "560001" },
      { pincode: "110001.0" },   // a float that reached the column
      { pincode: "12345" },      // five digits
      { pincode: "0560 01" },    // embedded space
      { pincode: "abcdef" },
      { pincode: null },
      {},                        // no pincode key at all
    ],
    "poonawala",
    NOW
  );
  assert.equal(r.records.length, 1);
  assert.equal(r.dropped_malformed, 6);
});

/** A pincode may not start with 0 — padStart makes a 5-digit code look 6 long. */
check("a zero-padded five-digit code is malformed, not a valid pincode", () => {
  const r = normalizePincodeRows([{ pincode: "12345" }], "poonawala", NOW);
  assert.equal(r.records.length, 0);
  assert.equal(r.dropped_malformed, 1);
});

check("counts duplicates separately from malformed", () => {
  const r = normalizePincodeRows(
    [{ pincode: "560001" }, { pincode: "560001" }, { pincode: "560001" }, { pincode: "nope" }],
    "poonawala",
    NOW
  );
  assert.equal(r.records.length, 1);
  assert.equal(r.dropped_duplicate, 2);
  assert.equal(r.dropped_malformed, 1);
});

/** The arithmetic has to close, or a row went somewhere nobody is counting. */
check("kept + malformed + duplicate accounts for every row read", () => {
  const rows = [
    { pincode: "560001" }, { pincode: "560002" }, { pincode: "560001" },
    { pincode: "bad" }, { pincode: "12345" }, { pincode: "700001" },
  ];
  const r = normalizePincodeRows(rows, "poonawala", NOW);
  assert.equal(r.records.length + r.dropped_malformed + r.dropped_duplicate, rows.length);
});

check("is_prime is only true when upstream said true, never merely truthy", () => {
  const r = normalizePincodeRows(
    [
      { pincode: "560001", is_prime: true },
      { pincode: "560002", is_prime: "yes" },
      { pincode: "560003", is_prime: 1 },
      { pincode: "560004" },
    ],
    "poonawala",
    NOW
  );
  assert.deepEqual(r.records.map((x) => x.is_prime), [true, false, false, false]);
});

/**
 * The bare pincode_serviceability shape carries no status, Prime flag or state.
 * They stay null rather than being guessed, so a Prime pincode is never invented.
 */
check("missing status and state stay null rather than becoming empty strings", () => {
  const [rec] = normalizePincodeRows([{ pincode: "560001" }], "poonawala", NOW).records;
  assert.equal(rec.status, null);
  assert.equal(rec.state, null);
});

check("the seen set is the prune key, and holds exactly what was kept", () => {
  const r = normalizePincodeRows(
    [{ pincode: "560001" }, { pincode: "560001" }, { pincode: "bad" }, { pincode: "700001" }],
    "poonawala",
    NOW
  );
  assert.deepEqual([...r.seen].sort(), ["560001", "700001"]);
  assert.equal(r.seen.size, r.records.length);
});

check("no rows, and a null row list, do not throw", () => {
  assert.equal(normalizePincodeRows([], "poonawala", NOW).records.length, 0);
  assert.equal(normalizePincodeRows(null, "poonawala", NOW).dropped_malformed, 0);
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
