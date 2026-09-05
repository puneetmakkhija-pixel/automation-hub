import { createClient } from "@supabase/supabase-js";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

// Enriches the personal-loan press-1 leads against the SE base.
//
//   node data-jobs/enrich-press1-leads.js                      # today (IST)
//   node data-jobs/enrich-press1-leads.js --days 7             # last 7 IST days
//   node data-jobs/enrich-press1-leads.js --from 2026-09-01 --to 2026-09-04
//   node data-jobs/enrich-press1-leads.js --dry-run            # counts, no write
//
// A Poonawalla or Hero Fincorp press-1 hands the customer to that lender's own
// journey and never reaches the CRM, so all we hold is a mobile number in
// public.whatsapp_messages. This walks each IST day in range through
// public.pl_press1_enrich(), which joins those numbers to se_base and lands the
// result in public.pl_press1_enriched. See ivr-router/migrations/005.
//
// WHY IT WALKS DAY BY DAY
//
// One call per day, not one call for the range. A day is the unit the sheet is
// read in, so a day that fails is a day that is missing rather than a range
// that half-wrote; and the per-day match rate is the number worth watching —
// a campaign dialled off a list that is not in se_base shows up as that day's
// rate collapsing, and a single range figure averages it away.
//
// RUNNING AS A CRON
//
// The `jobs` Railway service (root data-jobs, restart policy NEVER) runs
// `npm run enrich:press1:cron` on `30 22 * * *` UTC — 04:00 IST, an hour behind
// the pincode sync so the two never contend, and after both the day's dialling
// and se_base's overnight rescoring.
//
// That script passes --days 2 rather than today-only, and the schedule is the
// reason it has to: at 04:00 IST the IST date has already rolled over, so a
// today-only run would enrich a day on which nobody has pressed anything yet and
// skip the one that just finished. --days 2 covers the boundary either way.
//
// Re-running is safe — pl_press1_enrich() upserts on the press row's id and
// refreshes the se_base snapshot.

// 2,000 mobiles per foreign-table round trip. Measured on 02 Sep 2026 (6,047
// presses): 7.0s at 1,000, 4.1s at 5,000 — nearly all of it FDW round trips.
// 2,000 takes most of that win while keeping each remote query small enough to
// read in a slow-query log.
const BATCH = 2000;

function parseArgs(argv) {
  const args = { from: null, to: null, days: null, dryRun: false, batch: BATCH };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--from") args.from = argv[i + 1];
    if (argv[i] === "--to") args.to = argv[i + 1];
    if (argv[i] === "--days") args.days = Number(argv[i + 1]);
    if (argv[i] === "--batch") args.batch = Number(argv[i + 1]);
    if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

/** Today in IST, as YYYY-MM-DD. India has no daylight saving, so +05:30 is fixed. */
export function istToday(now = new Date()) {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The IST days to enrich, oldest first.
 *
 * Exported for the unit test: getting this wrong is how a backfill silently
 * skips a day, and the only symptom would be a gap in a table nobody reads
 * until a lender asks for the sheet.
 */
export function daysInRange({ from, to, days }, today = istToday()) {
  const end = to ?? today;
  let start;
  if (from) start = from;
  else if (days) start = addDays(end, -(Math.max(1, Math.floor(days)) - 1));
  else start = end;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error(`dates must be YYYY-MM-DD (got ${start} .. ${end})`);
  }
  if (start > end) throw new Error(`--from (${start}) is after --to (${end})`);

  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(d);
    // A typo like --from 2020-01-01 is a two-thousand-day loop against a
    // foreign table. Refuse it rather than discover it in the Railway logs.
    if (out.length > 400) throw new Error(`range too wide: ${start} .. ${end}`);
  }
  return out;
}

function validateEnvironment() {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

async function enrichDay(db, day, batch) {
  const { data, error } = await db.rpc("pl_press1_enrich", {
    p_from: day,
    p_to: day,
    p_batch: batch,
  });
  if (error) throw new Error(`${day}: ${error.message}`);
  return data;
}

/** Presses in range without writing anything — what a --dry-run can honestly report. */
async function countDay(db, day) {
  const { count, error } = await db
    .from("pl_press1_enriched")
    .select("*", { count: "exact", head: true })
    .eq("ist_day", day);
  if (error) throw new Error(`${day}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = daysInRange(args);
  validateEnvironment();

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let presses = 0;
  let matched = 0;

  for (const day of days) {
    if (args.dryRun) {
      const already = await countDay(db, day);
      console.log(`[enrich-press1] ${JSON.stringify({ day, dryRun: true, alreadyEnriched: already })}`);
      continue;
    }

    const result = await enrichDay(db, day, args.batch);
    presses += Number(result?.presses ?? 0);
    matched += Number(result?.matched ?? 0);
    console.log(`[enrich-press1] ${JSON.stringify(result)}`);
  }

  if (!args.dryRun && days.length > 1) {
    const rate = presses ? ((matched / presses) * 100).toFixed(1) : "0.0";
    console.log(
      `[enrich-press1] ${JSON.stringify({ days: days.length, presses, matched, match_rate: Number(rate) })}`
    );
  }
}

// Only run when invoked directly — daysInRange is imported by the test, and a
// module that starts writing on import cannot be tested without credentials.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error("[enrich-press1]", error.message);
    process.exit(1);
  });
}
