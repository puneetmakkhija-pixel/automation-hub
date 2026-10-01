import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import SupabaseClient from "../lib/supabaseClient.js";
import { obdClient } from "../lib/flexiloansCampaignOrchestrator.js";
import { runPlannerTick } from "../lib/campaignPlanner.js";

// Hourly batches for the IVR campaign planner (lib/campaignPlanner.js).
// Its own Railway cron service, schedule "5 * * * *" (UTC — the planner works
// in IST itself), built from Dockerfile.campaign-planner-cron. Safe to overlap:
// one batch per plan per IST hour is enforced by a unique index.
async function main() {
  const result = await runPlannerTick({ sb: new SupabaseClient().client.schema("crm"), obd: obdClient() });
  console.log(`[campaign-planner-cron] ${JSON.stringify(result)}`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((error) => {
    console.error("[campaign-planner-cron]", error.message);
    process.exit(1);
  });
}
