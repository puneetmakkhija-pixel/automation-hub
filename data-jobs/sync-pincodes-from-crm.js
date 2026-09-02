import { createClient } from "@supabase/supabase-js";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";

// Copies lender serviceable-pincode lists from the DSA CRM (smecircle), which is
// canonical, into this project's serviceable_pincodes — the table the IVR gating
// engine reads.
//
//   node data-jobs/sync-pincodes-from-crm.js
//   node data-jobs/sync-pincodes-from-crm.js --lender Poonawalla --prune
//   node data-jobs/sync-pincodes-from-crm.js --dry-run
//
// WHY A SYNC AND NOT A SECOND CSV
//
// The same lender lists live in two Supabase projects, and both drifted to the
// same stale 198-pincode Poonawalla snapshot without anyone noticing, because
// each looked internally consistent. load-serviceable-pincodes.js bootstraps
// this project from a CSV; that is a second source of truth and will drift
// again. This pulls from the CRM instead, so there is one list and this project
// is a copy of it.
//
// SOURCE PREFERENCE
//
// crm.pincode_serviceability holds only an integer[] of pincodes — no status,
// no Prime flag, no state. crm.lender_pincode_import_row (added with the CRM's
// staged-import pipeline) carries all three for the most recent applied import.
// So the richer source is preferred and the bare array is the fallback, which
// is also what runs before that pipeline is deployed.

const CHUNK_SIZE = 1000;

// crm.pincode_serviceability.lender -> serviceable_pincodes.lender_type.
// The CRM uses a short display-ish key; this project uses the spelling baked
// into pincodeGatingClient.js. Only lenders listed here are ever synced: a
// lender whose list has not been confirmed as the right product must not reach
// live gating just because a row exists for it upstream.
//
// ADDING A LENDER
//
// One line — `Hero: "herofincorp",` — but not before the list is confirmed to
// be the right product's. Upstream carries 5,794 Hero pincodes with no product
// tag, drawn from an internal consolidated master rather than from Hero; that
// is a serviceability claim nobody has checked, and syncing it would gate live
// traffic on it. Confirmed means a list issued by the lender, naming the
// product it covers.
//
// For Hero specifically that is necessary but not sufficient:
// _checkHeroFincorpEligibility() in ivr-router/lib/pincodeGatingClient.js still
// returns "not yet implemented" and rejects every applicant, so a synced list
// would sit unused until that engine exists.
const LENDER_MAP = {
  Poonawalla: "poonawala",
};

function parseArgs(argv) {
  const args = { lender: null, prune: false, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--lender") args.lender = argv[i + 1];
    if (argv[i] === "--prune") args.prune = true;
    if (argv[i] === "--dry-run") args.dryRun = true;
    if (argv[i] === "--force") args.force = true;
  }
  return args;
}

function validateEnvironment(dryRun) {
  const required = ["CRM_SUPABASE_URL", "CRM_SUPABASE_SERVICE_ROLE_KEY"];
  if (!dryRun) required.push("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

/**
 * Refuse a sync that would drop more than a quarter of the live list.
 *
 * A source that returns few or no rows — a half-applied migration upstream, a
 * lender row truncated by hand — is indistinguishable from a genuine
 * withdrawal once it arrives here, and the cost of being wrong is silently
 * ending offers across whole states. Exported for the unit test.
 */
export function shrinkGuard(incoming, live, force) {
  if (force) return null;
  if (live === 0) return null;
  if (incoming === 0) return { error: "source returned no pincodes", incoming, live };
  const removed = Math.max(0, live - incoming);
  if (removed / live > 0.25) {
    return {
      error: `list shrinks by ${((removed / live) * 100).toFixed(1)}% (${live} → ${incoming})`,
      incoming,
      live,
    };
  }
  return null;
}

// Prefers the applied import's rows, which carry status / is_prime / state.
// Returns null (not an empty list) when that pipeline is not deployed upstream
// or has no applied import yet, so the caller can tell "nothing there" from
// "nothing serviceable".
async function readFromAppliedImport(crm, lender) {
  const { data: imports, error } = await crm
    .schema("crm")
    .from("lender_pincode_import")
    .select("id, applied_at, row_count")
    .eq("lender", lender)
    .eq("status", "applied")
    .order("applied_at", { ascending: false })
    .limit(1);

  // Table absent (pipeline not deployed upstream) is a fallback, not a failure.
  if (error || !imports?.length) return null;

  const importId = imports[0].id;
  const rows = [];
  for (let from = 0; ; from += CHUNK_SIZE) {
    const { data, error: rowsError } = await crm
      .schema("crm")
      .from("lender_pincode_import_row")
      .select("pincode, status, is_prime, state")
      .eq("import_id", importId)
      .range(from, from + CHUNK_SIZE - 1);

    if (rowsError) throw new Error(`Reading import ${importId}: ${rowsError.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < CHUNK_SIZE) break;
  }

  return rows.length ? { rows, source: `applied import ${importId}` } : null;
}

async function readFromServiceabilityArray(crm, lender) {
  const { data, error } = await crm
    .schema("crm")
    .from("pincode_serviceability")
    .select("pincodes, pincode_count, updated_at")
    .eq("lender", lender)
    .maybeSingle();

  if (error) throw new Error(`Reading pincode_serviceability: ${error.message}`);
  if (!data?.pincodes?.length) return null;

  // status / is_prime / state are simply not held in this shape. They are left
  // null rather than guessed, so a Prime pincode is never invented here.
  return {
    rows: data.pincodes.map((p) => ({
      pincode: String(p).padStart(6, "0"),
      status: null,
      is_prime: false,
      state: null,
    })),
    source: `pincode_serviceability (updated ${data.updated_at ?? "unknown"}) — no status/Prime/state in this shape`,
  };
}

async function syncLender(crm, target, crmLender, lenderType, args) {
  const read = (await readFromAppliedImport(crm, crmLender))
    ?? (await readFromServiceabilityArray(crm, crmLender));

  if (!read) {
    return { lender: crmLender, lenderType, skipped: true, note: "no pincodes upstream" };
  }

  const seen = new Set();
  const records = [];
  for (const r of read.rows) {
    const pincode = String(r.pincode).trim().padStart(6, "0");
    if (!/^[1-9][0-9]{5}$/.test(pincode) || seen.has(pincode)) continue;
    seen.add(pincode);
    records.push({
      pincode,
      lender_type: lenderType,
      status: r.status ?? null,
      is_prime: r.is_prime === true,
      state: r.state ?? null,
      updated_at: new Date().toISOString(),
    });
  }

  let live = 0;
  if (!args.dryRun) {
    const { count, error } = await target
      .from("serviceable_pincodes")
      .select("*", { count: "exact", head: true })
      .eq("lender_type", lenderType);
    if (error) throw new Error(`Counting live rows: ${error.message}`);
    live = count ?? 0;
  }

  const blocked = args.dryRun ? null : shrinkGuard(records.length, live, args.force);
  if (blocked) {
    return { lender: crmLender, lenderType, blocked: blocked.error, source: read.source, incoming: records.length, live };
  }

  if (args.dryRun) {
    return { lender: crmLender, lenderType, dryRun: true, source: read.source, incoming: records.length };
  }

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const { error } = await target
      .from("serviceable_pincodes")
      .upsert(records.slice(i, i + CHUNK_SIZE), { onConflict: "pincode,lender_type" });
    if (error) throw new Error(`Upsert failed at row ${i}: ${error.message}`);
  }

  let pruned = 0;
  if (args.prune) {
    const { data: existing, error } = await target
      .from("serviceable_pincodes")
      .select("pincode")
      .eq("lender_type", lenderType);
    if (error) throw new Error(`Prune lookup failed: ${error.message}`);

    const stale = (existing ?? []).map((r) => r.pincode).filter((p) => !seen.has(p));
    for (let i = 0; i < stale.length; i += CHUNK_SIZE) {
      const { error: deleteError } = await target
        .from("serviceable_pincodes")
        .delete()
        .eq("lender_type", lenderType)
        .in("pincode", stale.slice(i, i + CHUNK_SIZE));
      if (deleteError) throw new Error(`Prune failed: ${deleteError.message}`);
    }
    pruned = stale.length;
  }

  return { lender: crmLender, lenderType, source: read.source, synced: records.length, live, pruned };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolved before the env check so an unknown lender is reported as one,
  // rather than as whichever credential happens to be missing too.
  const entries = Object.entries(LENDER_MAP).filter(
    ([crmLender]) => !args.lender || crmLender.toLowerCase() === args.lender.toLowerCase()
  );
  if (!entries.length) {
    throw new Error(`Unknown lender "${args.lender}". Known: ${Object.keys(LENDER_MAP).join(", ")}`);
  }

  validateEnvironment(args.dryRun);

  const crm = createClient(process.env.CRM_SUPABASE_URL, process.env.CRM_SUPABASE_SERVICE_ROLE_KEY);
  const target = args.dryRun
    ? null
    : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  let blocked = 0;
  for (const [crmLender, lenderType] of entries) {
    const result = await syncLender(crm, target, crmLender, lenderType, args);
    if (result.blocked) blocked += 1;
    console.log(`[sync-pincodes] ${JSON.stringify(result)}`);
  }

  if (blocked > 0) {
    console.error(`[sync-pincodes] ${blocked} lender(s) refused — re-run with --force only if the source is correct`);
    process.exit(2);
  }
}

// Only run when invoked directly. shrinkGuard is imported by the test, and a
// module that starts syncing on import cannot be tested without credentials.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error("[sync-pincodes]", error.message);
    process.exit(1);
  });
}
