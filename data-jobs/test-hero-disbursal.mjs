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
import ExcelJS from "exceljs";
import { asDate, asTimestamp, parseArgs, readSheetFromBuffer, toRecord } from "./ingest-hero-disbursal.js";
import { HERO_DISBURSAL, pickAttachment, subjectMatches } from "./fetch-mis-mail.js";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

/** A stand-in for the real report — the real one is customer data and is not committed. */
async function workbookBuffer(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

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

console.log("\nmail selection");

/**
 * The sender was the one thing worth getting from the source rather than from a
 * mailbox search. Hero sends TWO daily emails from two different people:
 * digital.marketing@ sends Daily Pulse, which the CRM already ingests, and
 * sandeep.pant@ sends this one. Wiring the first address here would have
 * re-ingested the application feed and found no disbursals in it.
 */
check("keys on the address that actually sends the disbursal report", () => {
  assert.equal(HERO_DISBURSAL.from, "sandeep.pant@herofincorp.com");
});

check("matches the subject Hero actually sends, and not the Daily Pulse one", () => {
  assert.ok(subjectMatches("Buddy Loan Disbursement Report", HERO_DISBURSAL));
  assert.ok(subjectMatches("FW: Buddy Loan Disbursement Report - 02.09.2026", HERO_DISBURSAL));
  assert.ok(subjectMatches("BuddyLoan Disbursement report", HERO_DISBURSAL));
  assert.equal(subjectMatches("Buddy Loan Daily Pulse", HERO_DISBURSAL), false);
  assert.equal(subjectMatches("", HERO_DISBURSAL), false);
  assert.equal(subjectMatches(null, HERO_DISBURSAL), false);
});

/**
 * The signature image is the thing being excluded. Picking it would hand ExcelJS
 * a PNG and turn a delivered report into a parse error.
 */
check("picks the spreadsheet out of the attachments and skips the signature image", () => {
  const att = pickAttachment(
    [
      { filename: "image001.png" },
      { filename: "Buddy_Loan.xlsx" },
      { filename: "notes.pdf" },
    ],
    HERO_DISBURSAL
  );
  assert.equal(att.filename, "Buddy_Loan.xlsx");
  assert.equal(pickAttachment([{ filename: "image001.png" }], HERO_DISBURSAL), null);
  assert.equal(pickAttachment([], HERO_DISBURSAL), null);
  assert.equal(pickAttachment(undefined, HERO_DISBURSAL), null);
});

check("accepts a csv too, and an attachment with no filename does not throw", () => {
  assert.equal(pickAttachment([{ filename: "report.CSV" }], HERO_DISBURSAL).filename, "report.CSV");
  assert.equal(pickAttachment([{}], HERO_DISBURSAL), null);
});

console.log("\narguments");

/** A named file must beat --from-email, or re-running one day pulls the newest instead. */
check("a named file wins over --from-email", () => {
  const a = parseArgs(["--from-email", "sept.xlsx"]);
  assert.equal(a.file, "sept.xlsx");
  assert.equal(a.fromEmail, true);
});

check("--from-email alone asks for the mailbox, and --dry-run still parses", () => {
  assert.deepEqual(parseArgs(["--from-email"]), { file: null, dryRun: false, fromEmail: true });
  assert.deepEqual(parseArgs(["--dry-run", "--from-email"]), { file: null, dryRun: true, fromEmail: true });
  assert.deepEqual(parseArgs([]), { file: null, dryRun: false, fromEmail: false });
});

console.log("\nreading the attachment bytes");

/**
 * What the cron does every day: parse the workbook straight out of the mail
 * attachment, never off the disk. Worth its own checks because it is a
 * different ExcelJS entry point (load() rather than readFile()) from the one
 * the by-hand path uses.
 */
await checkAsync("parses a workbook from a buffer, not a path", async () => {
  const buf = await workbookBuffer([["Disbursement Data", [HEADERS, ROW]]]);
  const { headers, dataRows } = await readSheetFromBuffer(buf, "Buddy_Loan.xlsx");
  assert.deepEqual(headers, HEADERS);
  assert.equal(dataRows.length, 1);
  assert.equal(toRecord(headers, dataRows[0], "Buddy_Loan.xlsx").lan_id, "101211507");
});

/** The real file ships a Summary tab whose four rows of totals are not applications. */
await checkAsync("takes the named sheet even when it is not the first one", async () => {
  const buf = await workbookBuffer([
    ["Summary_Disbursement_Data", [["Total"], [58]]],
    ["Disbursement Data", [HEADERS, ROW]],
  ]);
  const { dataRows } = await readSheetFromBuffer(buf, "Buddy_Loan.xlsx");
  assert.equal(dataRows.length, 1);
});

/** A lender quietly renaming a column must stop the run, not write a table of NULLs. */
await checkAsync("refuses a workbook that has lost a column it needs", async () => {
  const buf = await workbookBuffer([["Disbursement Data", [HEADERS.slice(0, 5), ROW.slice(0, 5)]]]);
  await assert.rejects(() => readSheetFromBuffer(buf, "Buddy_Loan.xlsx"), /missing expected column/);
});

console.log(failed ? `\n${failed} failed\n` : "\nall passed\n");
process.exit(failed ? 1 : 0);
