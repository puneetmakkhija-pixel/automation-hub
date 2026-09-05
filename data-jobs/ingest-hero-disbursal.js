import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Ingests Hero Fincorp's daily disbursal report into crm.mis_hero_disbursal.
//
//   node data-jobs/ingest-hero-disbursal.js Buddy_Loan.xlsx
//   node data-jobs/ingest-hero-disbursal.js --dry-run report.csv
//
// WHY THIS FILE EXISTS AT ALL
//
// The Hero MIS we already ingest (crm.pl_lender_mis, lender 'herofincorp') is an
// APPLICATION feed: 2,464 rows, every one of them with a NULL sanction and a
// NULL disbursal. It carries identity — Hero echoes our customer_id, so
// crm.v_pl_mis decodes 100% of it to a mobile — and no outcome.
//
// This report is the mirror image: sanction and disbursal amounts, and no
// mobile, no PAN, no name. Its "App ID" is the same identifier space as
// pl_lender_mis.lan_id, which is the only thing joining the two halves.
//
// So neither file answers "did this lead convert" and both together do. That is
// the whole point of loading this one.
//
// NOT MERGED INTO pl_lender_mis ON PURPOSE
//
// That table is written by the CRM's own MIS pipeline. Two writers on one row is
// how one of them silently loses, and the loser would be whichever ran second
// on a day the other reordered its columns. This lands in its own table and
// public.pl_press1_mis_outcome joins the two on lan_id.

const COLUMNS = {
  // file header            -> column, parser
  "App ID": ["lan_id", (v) => String(v ?? "").trim() || null],
  "App Creation Date": ["app_created_at", (v) => asTimestamp(v)],
  "Sanction Loan Amount": ["sanction_amount", asNumber],
  "Sanction Rate": ["sanction_rate", asNumber],
  "Decision Date": ["decision_date", (v) => asDate(v)],
  "Current City": ["current_city", asText],
  "Current Pincode": ["current_pincode", asText],
  "CPV Action": ["cpv_action", asText],
  "Final Status": ["final_status", asText],
  decile: ["decile", (v) => (Number.isFinite(Number(v)) && String(v ?? "").trim() !== "" ? Math.trunc(Number(v)) : null)],
  appsflyerid: ["appsflyer_id", asText],
  media_source: ["media_source", asText],
  campaign: ["campaign", asText],
  "Campaign Id": ["campaign_id", asText],
  "Utm Medium": ["utm_medium", asText],
  Utm_Content: ["utm_content", asText],
  channel: ["channel", asText],
  "Partner Name": ["partner_name", asText],
  landisbursementamount: ["disbursal_amount", asNumber],
  landisbursementdate: ["disbursal_date", (v) => asDate(v)],
};

function asText(v) {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

function asNumber(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The file writes dates as DD-MM-YYYY, which Date.parse reads as MM-DD-YYYY for
 * every day below the 13th and rejects above it. Parsed by hand for that reason:
 * a silent month/day swap would put a disbursal in the wrong month for 40% of
 * rows and look entirely plausible doing it.
 */
function parts(v) {
  if (v instanceof Date) {
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate(), hh: v.getUTCHours(), mm: v.getUTCMinutes() };
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1], hh: +(m[4] ?? 0), mm: +(m[5] ?? 0) };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3], hh: +(m[4] ?? 0), mm: +(m[5] ?? 0) };
  return null;
}

const pad = (n) => String(n).padStart(2, "0");

export function asDate(v) {
  const p = parts(v);
  if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return null;
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function asTimestamp(v) {
  const p = parts(v);
  if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) return null;
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:00`;
}

/** Maps one sheet row to a table row. Exported for the unit test. */
export function toRecord(headers, values, sourceFile) {
  const rec = { source_file: sourceFile, raw: {} };
  headers.forEach((h, i) => {
    const v = values[i];
    rec.raw[h] = v instanceof Date ? v.toISOString() : v ?? null;
    const spec = COLUMNS[h];
    if (spec) rec[spec[0]] = spec[1](v);
  });
  return rec.lan_id ? rec : null;
}

async function readSheet(file) {
  const wb = new ExcelJS.Workbook();
  if (file.toLowerCase().endsWith(".csv")) await wb.csv.readFile(file);
  else await wb.xlsx.readFile(file);

  // The disbursal sheet by name where present, else the first sheet: the file
  // also carries a Summary tab, and reading that one would ingest four rows of
  // totals as if they were applications.
  const ws = wb.getWorksheet("Disbursement Data") ?? wb.worksheets[0];
  if (!ws) throw new Error(`${file}: no worksheet`);

  const rows = [];
  ws.eachRow((row) => rows.push(row.values.slice(1).map((c) => (c && c.text !== undefined ? c.text : c))));
  if (!rows.length) throw new Error(`${file}: empty sheet`);

  const headers = rows[0].map((h) => String(h ?? "").trim());
  const missing = ["App ID", "landisbursementamount", "landisbursementdate"].filter((h) => !headers.includes(h));
  if (missing.length) {
    throw new Error(`${file}: missing expected column(s): ${missing.join(", ")}. Headers seen: ${headers.join(", ")}`);
  }
  return { headers, dataRows: rows.slice(1) };
}

function parseArgs(argv) {
  const args = { file: null, dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (!a.startsWith("--")) args.file = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) throw new Error("usage: node ingest-hero-disbursal.js [--dry-run] <file.xlsx|file.csv>");

  const { headers, dataRows } = await readSheet(args.file);
  const source = path.basename(args.file);
  const records = dataRows.map((r) => toRecord(headers, r, source)).filter(Boolean);

  // A lender re-sending the same application twice in one file is not a reason
  // to fail, but sending two different outcomes for it is worth seeing.
  const byId = new Map();
  let dupes = 0;
  for (const r of records) {
    if (byId.has(r.lan_id)) dupes += 1;
    byId.set(r.lan_id, r);
  }
  const rows = [...byId.values()];

  const disbursed = rows.filter((r) => r.disbursal_date).length;
  const summary = {
    file: source,
    sheet_rows: dataRows.length,
    records: rows.length,
    duplicate_lan_ids: dupes,
    disbursed_rows: disbursed,
    sanction_total: rows.reduce((a, r) => a + (r.sanction_amount ?? 0), 0),
    disbursal_total: rows.reduce((a, r) => a + (r.disbursal_amount ?? 0), 0),
  };

  if (args.dryRun) {
    console.log(`[hero-disbursal] ${JSON.stringify({ ...summary, dryRun: true })}`);
    return;
  }

  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: "crm" },
  });

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, updated_at: new Date().toISOString() }));
    const { error } = await db.from("mis_hero_disbursal").upsert(chunk, { onConflict: "lan_id" });
    if (error) throw new Error(`upsert failed at row ${i}: ${error.message}`);
  }

  console.log(`[hero-disbursal] ${JSON.stringify(summary)}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error("[hero-disbursal]", error.message);
    process.exit(1);
  });
}
