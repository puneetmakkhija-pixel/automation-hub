import { createClient } from "@supabase/supabase-js";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

// Builds a lender's campaign base in crm.lender_campaign_base, a page at a time.
//
//   node data-jobs/pull-lender-base.js --dry-run
//   node data-jobs/pull-lender-base.js --lender "Flexiloans (Epimoney)" --min-score 60
//   node data-jobs/pull-lender-base.js --resume 6003486502
//
// WHY A JOB AND NOT A QUERY
//
// fed.lender_recommendations is a foreign table over the scoring base, and
// nothing that scans it survives. Measured 15 Sep 2026 against production:
//
//   select count(*) where top1_lender = 'Flexiloans (Epimoney)'  -> TIMEOUT
//   select top1_lender, count(*) ... group by 1                  -> TIMEOUT
//
// A keyset page, though, is almost pure fixed cost:
//
//   ... where mobile_number > $1 order by mobile_number limit  500  -> 3.47 s
//   ... where mobile_number > $1 order by mobile_number limit 5000  -> 3.91 s
//
// Ten times the rows for twelve percent more time, which is why the default
// page is 5000 and not 500. The work itself is in crm.pull_lender_campaign_base
// (migration 20260915180000); this file only paces it and reports.
//
// ANY RANK, NOT top1
//
// The rule is "score above 60, any rank". top1_lender/top2_lender are only the
// first two entries of full_ranking, and this lender sits third or lower for
// plenty of people who still score well above 60 with it — filtering on the
// top1 column would drop them silently. The function expands full_ranking and
// keeps each person's best entry for the lender at whatever rank it appears.
//
// Exit codes: 0 pulled, 1 error.

const DEFAULT_LENDER = "Flexiloans (Epimoney)";
const DEFAULT_MIN_SCORE = 60;
const DEFAULT_PAGE = 5000;

/** Flags, with the same shape as the other jobs in this folder. */
export function parseArgs(args) {
  const flag = (name) => args.includes(name);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
  };
  // Number("") is 0, and 0 is finite — so a blank flag would have sailed
  // through as a real value. For --limit that means a page size of one row,
  // and since each page is a ~4s remote round trip whatever its size, the job
  // would still "work" while taking four seconds per person. Blank is absent.
  const num = (name, fallback) => {
    const raw = value(name, null);
    if (raw == null || String(raw).trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  // Page size and score differ on zero: --min-score 0 is a real instruction
  // ("any score"), --limit 0 is not a page.
  const positive = (name, fallback) => {
    const n = num(name, fallback);
    return n >= 1 ? Math.floor(n) : fallback;
  };
  return {
    lender: value("--lender", DEFAULT_LENDER),
    minScore: num("--min-score", DEFAULT_MIN_SCORE),
    pageSize: positive("--limit", DEFAULT_PAGE),
    // A cap so a first run can be bounded. 0 means "until the base is done".
    maxPages: num("--max-pages", 0),
    resume: value("--resume", ""),
    dryRun: flag("--dry-run"),
  };
}

/**
 * Page until the base is exhausted.
 *
 * `rpc` is injected so this is testable without a database — the loop, the
 * stop conditions and the totals are the part worth testing, and they are
 * pure given a page source.
 */
export async function pullBase(rpc, opts) {
  const { lender, minScore, pageSize, maxPages, resume, dryRun } = opts;
  let after = resume ?? "";
  let pages = 0;
  let scanned = 0;
  let kept = 0;

  for (;;) {
    const page = await rpc({
      p_lender: lender,
      p_min_score: minScore,
      p_after: after,
      p_limit: pageSize,
      p_dry_run: dryRun,
    });

    pages += 1;
    scanned += page.rows_scanned ?? 0;
    kept += page.rows_kept ?? 0;

    // A null key is the function saying the base is exhausted. It is
    // deliberately not an empty string, which is also a valid starting point
    // and would restart the walk forever.
    if (page.last_key == null) break;
    after = page.last_key;

    if (maxPages > 0 && pages >= maxPages) break;
  }

  return { pages, scanned, kept, lastKey: after };
}

async function main() {
  const opts = parseArgs(argv.slice(2));

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[lender-base] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    process.exit(1);
  }

  const sb = createClient(url, key, {
    db: { schema: "crm" },
    auth: { persistSession: false },
  });

  console.log(
    `[lender-base] lender="${opts.lender}" min-score=${opts.minScore} ` +
      `page=${opts.pageSize}${opts.dryRun ? " DRY RUN (writes nothing)" : ""}` +
      `${opts.resume ? ` resuming after ${opts.resume}` : ""}`
  );

  const started = Date.now();
  let lastReport = 0;

  const rpc = async (params) => {
    const { data, error } = await sb.rpc("pull_lender_campaign_base", params);
    if (error) throw new Error(error.message);
    // The function returns a one-row table; supabase-js hands it back as an array.
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("pull_lender_campaign_base returned no row");

    // Progress, but not one line per page: a base this size is hundreds of
    // pages and a wall of them hides the one line that matters.
    const now = Date.now();
    if (now - lastReport > 15000) {
      lastReport = now;
      console.log(`[lender-base]   … at ${row.last_key ?? "end"}`);
    }
    return row;
  };

  try {
    const out = await pullBase(rpc, opts);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `[lender-base] ${opts.dryRun ? "would keep" : "kept"} ${out.kept.toLocaleString("en-IN")} ` +
        `of ${out.scanned.toLocaleString("en-IN")} scanned, ${out.pages} pages, ${secs}s`
    );
    if (opts.maxPages > 0) {
      console.log(`[lender-base] stopped at the --max-pages cap; resume with --resume ${out.lastKey}`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`[lender-base] failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  await main();
}

export default pullBase;
