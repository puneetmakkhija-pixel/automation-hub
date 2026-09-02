import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Loads lender pincode serviceability into public.serviceable_pincodes — the table
// ivr-router/lib/pincodeGatingClient.js reads on every gating check.
//
// Run database/migrations/002_serviceable_pincodes.sql first.
//
//   node data-jobs/load-serviceable-pincodes.js
//   node data-jobs/load-serviceable-pincodes.js --lender poonawala --prune
//
// Idempotent: upserts on (pincode, lender_type), so re-running is safe.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHUNK_SIZE = 1000;

const SOURCES = {
  poonawala: {
    file: join(__dirname, "..", "database", "data", "poonawalla_stpl_pincodes.csv"),
    description: "Poonawalla Fincorp STPL / InstaPL (bureau-based PL, RT1 master)",
  },
};

function validateEnvironment() {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

function parseArgs(argv) {
  const args = { lender: "poonawala", prune: false, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--lender") args.lender = argv[i + 1];
    if (argv[i] === "--prune") args.prune = true;
    if (argv[i] === "--dry-run") args.dryRun = true;
  }

  return args;
}

// The CSV is lender-issued and holds no quoted fields, but status values contain
// no commas either — split on comma and trim, rejecting anything malformed.
function parseCsv(path, lenderType) {
  const text = readFileSync(path, "utf8").trim();
  const [header, ...lines] = text.split("\n");
  const columns = header.split(",").map((c) => c.trim());
  const expected = ["pincode", "status", "is_prime", "state"];

  if (columns.join(",") !== expected.join(",")) {
    throw new Error(`Unexpected CSV header in ${path}: got "${columns.join(",")}"`);
  }

  return lines.map((line, index) => {
    const [pincode, status, isPrime, state] = line.split(",").map((v) => v.trim());

    if (!/^\d{6}$/.test(pincode)) {
      throw new Error(`Invalid pincode "${pincode}" on line ${index + 2} of ${path}`);
    }

    return {
      pincode,
      lender_type: lenderType,
      status,
      is_prime: isPrime === "true",
      state,
      updated_at: new Date().toISOString(),
    };
  });
}

async function upsertInChunks(supabase, records) {
  let written = 0;

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase
      .from("serviceable_pincodes")
      .upsert(chunk, { onConflict: "pincode,lender_type" });

    if (error) {
      throw new Error(`Upsert failed at row ${i}: ${error.message}`);
    }

    written += chunk.length;
    console.log(`[load-pincodes] upserted ${written}/${records.length}`);
  }

  return written;
}

// Removes rows the lender has since dropped from their list. Off by default —
// a partial or truncated source file would otherwise silently shrink the list.
async function pruneStale(supabase, lenderType, keep) {
  const { data, error } = await supabase
    .from("serviceable_pincodes")
    .select("pincode")
    .eq("lender_type", lenderType);

  if (error) throw new Error(`Prune lookup failed: ${error.message}`);

  const live = new Set(keep.map((r) => r.pincode));
  const stale = (data || []).map((r) => r.pincode).filter((p) => !live.has(p));

  for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
    const chunk = stale.slice(i, i + CHUNK_SIZE);
    const { error: deleteError } = await supabase
      .from("serviceable_pincodes")
      .delete()
      .eq("lender_type", lenderType)
      .in("pincode", chunk);

    if (deleteError) throw new Error(`Prune failed: ${deleteError.message}`);
  }

  return stale.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = SOURCES[args.lender];

  if (!source) {
    throw new Error(
      `Unknown lender "${args.lender}". Known: ${Object.keys(SOURCES).join(", ")}`
    );
  }

  const records = parseCsv(resolve(source.file), args.lender);
  console.log(`[load-pincodes] ${source.description}`);
  console.log(`[load-pincodes] parsed ${records.length} pincodes for "${args.lender}"`);

  // --dry-run only parses the CSV, so it stays usable without credentials.
  if (args.dryRun) {
    console.log("[load-pincodes] --dry-run set, nothing written");
    return;
  }

  validateEnvironment();

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const written = await upsertInChunks(supabase, records);

  if (args.prune) {
    const removed = await pruneStale(supabase, args.lender, records);
    console.log(`[load-pincodes] pruned ${removed} pincode(s) no longer serviceable`);
  }

  const { count, error } = await supabase
    .from("serviceable_pincodes")
    .select("*", { count: "exact", head: true })
    .eq("lender_type", args.lender);

  if (error) throw new Error(`Verification failed: ${error.message}`);

  console.log(`[load-pincodes] done — ${written} upserted, ${count} live for "${args.lender}"`);
}

main().catch((error) => {
  console.error("[load-pincodes]", error.message);
  process.exit(1);
});
