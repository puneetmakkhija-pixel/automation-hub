import { createClient } from "@supabase/supabase-js";

// This is a run-once script, not a server — matches how `samay-reengage`
// already runs in your humble-courtesy project: Railway triggers it on a
// cron schedule (set via Settings → Cron Schedule), it does its work, exits.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log(`[data-jobs] run started at ${new Date().toISOString()}`);

  // TODO: replace with the real job — e.g. nightly loan-data cleanup,
  // Samay usage rollups, generating a report table.
  const { data, error } = await supabase.from("_placeholder").select("*").limit(1);

  if (error && error.code !== "PGRST205") {
    // PGRST205 = table not found, expected until you point this at a real table
    console.error("[data-jobs] error:", error.message);
    process.exit(1);
  }

  console.log(`[data-jobs] done. rows touched: ${data?.length ?? 0}`);
}

main();
