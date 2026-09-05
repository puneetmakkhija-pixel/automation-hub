/**
 * Hero's daily disbursal report: the parsing, not the upload.
 *
 *   node data-jobs/test-hero-disbursal.mjs
 *
 * Plain node, no credentials and no network. What is checked here is the date
 * handling and the row mapping, because those are what fail quietly: a
 * month/day swap produces a perfectly plausible disbursal in the wrong month,
 * and a dropped column produces a NULL that reads as "the lender did not say".
 */
import assert from "node:assert/strict";
import { asDate, asTimestamp, toRecord } from "./ingest-hero-disbursal.js";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("\ndates");

/**
 * The file writes DD-MM-YYYY. Date.parse reads that as MM-DD-YYYY, which is
 * silently wrong for every day below the 13th and rejected above it — so the
 * bug would look like correct data for 40% of rows and missing data for the
 * rest.
 */
check("reads DD-MM-YYYY as day first, not month first", () => {
  assert.equal(asDate("02-08-2026 12:24"), "2026-08-02");   // 2 Aug, not 8 Feb
  assert.equal(asDate("29-08-2026 07:20"), "2026-08-29");   // unambiguous
  assert.equal(asDate("01-09-2026 00:00"), "2026-09-01");
});

check("still accepts ISO, which is what the xlsx date cells give", () => {
  assert.equal(asDate("2026-09-02"), "2026-09-02");
  assert.equal(asDate(new Date(Date.UTC(2026, 8, 2))), "2026-09-02");
});

check("keeps the time on a timestamp and drops it on a date", () => {
  assert.equal(asTimestamp("02-08-2026 12:24"), "2026-08-02T12:24:00");
  assert.equal(asTimestamp("02-08-2026"), "2026-08-02T00:00:00");
  assert.equal(asDate("02-08-2026 12:24"), "2026-08-02");
});

check("returns null rather than guessing at junk", () => {
  for (const v of ["", null, undefined, "N/A", "-", "not a date"]) {
    assert.equal(asDate(v), null, `asDate(${JSON.stringify(v)})`);
    assert.equal(asTimestamp(v), null, `asTimestamp(${JSON.stringify(v)})`);
  }
});

check("refuses an impossible month or day instead of rolling it over", () => {
  assert.equal(asDate("32-01-2026"), null);
  assert.equal(asDate("01-13-2026"), null);
});

console.log("\nrow mapping");

const HEADERS = ["App ID","App Creation Date","Sanction Loan Amount","Sanction Rate","Decision Date",
  "Current City","Current Pincode","CPV Action","Final Status","decile","appsflyerid","media_source",
  "campaign","Campaign Id","Utm Medium","Utm_Content","channel","Partner Name",
  "landisbursementamount","landisbursementdate"];
const ROW = ["101211507","02-08-2026 12:24",307050,19,"01-09-2026 00:00","Pimpri Chinchwad","411033",
  "Residence","TVR Waived & CPV Positive",1,"046ae2d0-p","partnership","Buddyloan","N_Base_RSH_Jun20",
  "27",null,"-","Buddy Loan",290705,"2026-09-02"];

check("maps the lender's headers onto the table's columns", () => {
  const r = toRecord(HEADERS, ROW, "Buddy_Loan.xlsx");
  assert.equal(r.lan_id, "101211507");
  assert.equal(r.app_created_at, "2026-08-02T12:24:00");
  assert.equal(r.sanction_amount, 307050);
  assert.equal(r.disbursal_amount, 290705);
  assert.equal(r.disbursal_date, "2026-09-02");
  assert.equal(r.decile, 1);
  assert.equal(r.current_pincode, "411033");
  assert.equal(r.source_file, "Buddy_Loan.xlsx");
});

/**
 * A pincode that arrives as a number must not lose a leading zero, and must not
 * come back as 411033 the integer either — every downstream join treats it as
 * text.
 */
check("keeps identifiers as text", () => {
  const r = toRecord(HEADERS, ["101211507", ...ROW.slice(1, 6), 110001, ...ROW.slice(7)], "f.xlsx");
  assert.equal(r.current_pincode, "110001");
  assert.equal(typeof r.current_pincode, "string");
  assert.equal(typeof r.lan_id, "string");
});

check("a row with no App ID is dropped, not written with a null key", () => {
  assert.equal(toRecord(HEADERS, ["", ...ROW.slice(1)], "f.xlsx"), null);
  assert.equal(toRecord(HEADERS, [null, ...ROW.slice(1)], "f.xlsx"), null);
});

/** 8 of 58 rows in the first real file had no disbursal yet. Sanctioned, not disbursed. */
check("an undisbursed row keeps its sanction and nulls the disbursal", () => {
  const r = toRecord(HEADERS, [...ROW.slice(0, 18), null, null], "f.xlsx");
  assert.equal(r.sanction_amount, 307050);
  assert.equal(r.disbursal_amount, null);
  assert.equal(r.disbursal_date, null);
});

check("keeps the whole original row in raw, including columns we do not map", () => {
  const r = toRecord([...HEADERS, "Some New Column"], [...ROW, "surprise"], "f.xlsx");
  assert.equal(r.raw["Some New Column"], "surprise");
  assert.equal(r.raw["App ID"], "101211507");
});

check("strips thousands separators off an amount", () => {
  const r = toRecord(HEADERS, [...ROW.slice(0, 18), "2,90,705", "2026-09-02"], "f.xlsx");
  assert.equal(r.disbursal_amount, 290705);
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
