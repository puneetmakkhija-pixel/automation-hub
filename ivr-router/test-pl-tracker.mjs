/**
 * The personal-loan press-1 tracker.
 *
 *   node test-pl-tracker.mjs
 *
 * Same shape as the other two check files here: plain node, a stub in place of
 * supabase-js, no credentials and no network. The aggregation itself lives in
 * public.pl_ivr_tracker() and is the database's job; what is checked here is
 * everything this service decides — which lender a press belongs to, what goes
 * in the sheet, and whether that sheet survives Excel.
 */
import assert from "node:assert/strict";
import {
  lenderOfLink,
  istDayBounds,
  istToday,
  toCsv,
  summaryRows,
  fetchDetail,
  SUMMARY_COLUMNS,
  DETAIL_COLUMNS,
} from "./lib/plTracker.js";

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log("\nlenderOfLink");

/**
 * The link, not the variant. Two rows in the live send log carry variant
 * 'herofincorp' and a Poonawalla link; the customer went to Poonawalla, so
 * that is whose press it is.
 */
await check("reads the lender off the link the customer was sent", async () => {
  assert.equal(lenderOfLink("https://instant-pocket-loan.poonawallafincorp.com/?utm_DSA_Code=PKA00192"), "poonawalla");
  assert.equal(lenderOfLink("https://loans.apps.herofincorp.com/en/personal-loan?af_xp=cu"), "herofincorp");
  assert.equal(lenderOfLink("https://crmbusinessloans.com/apply"), "businessloans");
});

await check("calls an unrecognised link unknown rather than guessing", async () => {
  assert.equal(lenderOfLink("https://example.com/x"), "unknown");
  assert.equal(lenderOfLink(""), "unknown");
  assert.equal(lenderOfLink(null), "unknown");
});

await check("is not fooled by case", async () => {
  assert.equal(lenderOfLink("HTTPS://INSTANT-POCKET-LOAN.POONAWALLAFINCORP.COM/"), "poonawalla");
});

console.log("\nIST day handling");

await check("bounds one IST day, not one UTC day", async () => {
  const { from, to } = istDayBounds("2026-09-02");
  assert.equal(from, "2026-09-02T00:00:00+05:30");
  // 03 Sep 00:00 IST is 02 Sep 18:30 UTC — the boundary a naive UTC day gets
  // wrong, putting an evening press on the wrong date.
  assert.equal(to, "2026-09-02T18:30:00.000Z");
});

await check("refuses a day it cannot parse", async () => {
  assert.throws(() => istDayBounds("02-09-2026"));
  assert.throws(() => istDayBounds(""));
});

await check("istToday is still the previous UTC date just after IST midnight", async () => {
  // 2026-09-01 19:00 UTC is 2026-09-02 00:30 IST.
  assert.equal(istToday(new Date("2026-09-01T19:00:00Z")), "2026-09-02");
  assert.equal(new Date("2026-09-01T19:00:00Z").toISOString().slice(0, 10), "2026-09-01");
});

console.log("\nthe sheet");

/**
 * Excel turns a 10-digit mobile into 9.81235e+09 and evaluates a cell opening
 * with = + - or @. Both make the file useless to the desk it was built for.
 */
await check("quotes what Excel would otherwise eat", async () => {
  const csv = toCsv([{ a: 'has "quotes"', b: "has,comma", c: "=cmd()", d: "line\nbreak" }], ["a", "b", "c", "d"]);
  assert.ok(csv.includes('"has ""quotes"""'));
  assert.ok(csv.includes('"has,comma"'));
  // Prefixed with an apostrophe, which is what makes Excel treat it as text.
  // No quoting needed — there is nothing in it that CSV itself must escape.
  assert.ok(csv.includes("'=cmd()"), "a formula-leading cell must be defused");
  assert.ok(!csv.includes(",=cmd()"), "it must not reach Excel as a live formula");
  assert.ok(csv.includes('"line\nbreak"'));
});

await check("starts with a BOM so Excel reads it as UTF-8", async () => {
  assert.equal(toCsv([{ a: "x" }], ["a"]).charCodeAt(0), 0xfeff);
});

await check("writes a header even with no rows", async () => {
  const csv = toCsv([], ["lender_name", "campaign"]);
  assert.ok(csv.includes("lender_name,campaign"));
});

await check("renders a summary row per campaign, with its lender's totals", async () => {
  const rows = summaryRows({
    lenders: [{ lender: "poonawalla", ftd_presses: 0, mtd_presses: 5707 }],
    campaigns: [{ lender: "poonawalla", campaign: "PFL_Sep1st1LtoAllData", ftd_presses: 0, presses: 4809, phones: 4780, first_at: "2026-09-01T11:20:24", last_at: "2026-09-01T13:10:02" }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lender_name, "Poonawalla Fincorp");
  assert.equal(rows[0].presses_mtd, 4809);
  assert.equal(rows[0].lender_presses_mtd, 5707);
  assert.equal(rows[0].first_press_ist, "2026-09-01 11:20:24");
  for (const c of SUMMARY_COLUMNS) assert.ok(c in rows[0], `missing column ${c}`);
});

console.log("\nfetchDetail");

const stubClient = (rows) => ({
  from() {
    const q = {
      select: () => q, gte: () => q, lt: () => q, order: () => q,
      limit: () => Promise.resolve({ data: rows, error: null }),
    };
    return q;
  },
});

const press = (over = {}) => ({
  phone_number: "9812345678",
  created_at: "2026-09-01T06:00:00.000Z",
  metadata: { digit: "1", link: "https://instant-pocket-loan.poonawallafincorp.com/?x=1", campaign_name: "PFL_Sep1st1LtoAllData", status: "sent", ...over },
});

await check("keeps only press-1 rows", async () => {
  const rows = await fetchDetail(stubClient([
    press(),
    press({ digit: "9" }),
    { phone_number: "9812345670", created_at: "2026-09-01T06:00:00.000Z", metadata: { status: "read" } },
  ]), { day: "2026-09-01" });
  assert.equal(rows.length, 1);
});

/**
 * The Business Loans product reports through the CRM. Its presses must not
 * appear on a sheet handed to a personal-loan lender desk.
 */
await check("excludes business loans", async () => {
  const rows = await fetchDetail(stubClient([
    press(), press({ link: "https://crmbusinessloans.com/apply" }),
  ]), { day: "2026-09-01" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lender, "poonawalla");
});

await check("flags a press whose variant disagrees with its link", async () => {
  const rows = await fetchDetail(stubClient([press({ variant: "herofincorp" })]), { day: "2026-09-01" });
  assert.equal(rows[0].lender, "poonawalla", "the link decides");
  assert.equal(rows[0].variant, "herofincorp");
  assert.equal(rows[0].variant_matches_link, "NO");
});

await check("an unnamed variant is not a mismatch", async () => {
  const rows = await fetchDetail(stubClient([press()]), { day: "2026-09-01" });
  assert.equal(rows[0].variant_matches_link, "yes");
});

await check("filters to one lender when asked", async () => {
  const rows = await fetchDetail(stubClient([
    press(), press({ link: "https://loans.apps.herofincorp.com/en/personal-loan" }),
  ]), { day: "2026-09-01", lender: "herofincorp" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lender, "herofincorp");
});

await check("normalises the mobile and stamps the time in IST", async () => {
  const rows = await fetchDetail(stubClient([press({}, {})]), { day: "2026-09-01" });
  assert.equal(rows[0].mobile, "9812345678");
  // 06:00 UTC is 11:30 IST.
  assert.equal(rows[0].sent_at_ist, "2026-09-01 11:30:00");
  for (const c of DETAIL_COLUMNS) assert.ok(c in rows[0], `missing column ${c}`);
});

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
