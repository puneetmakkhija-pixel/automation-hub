import { createClient } from "@supabase/supabase-js";

// Setup script to initialize monitoring infrastructure
// Run this once to set up the database tables and create initial job records

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const JOBS_TO_INITIALIZE = [
  {
    job_key: "digitap-bank-statement-parsing",
    job_name: "Digitap Bank Statement Parsing",
    category: "API Pull",
    status: "never_run",
  },
  {
    job_key: "digitap-credit-bureau-analytics",
    job_name: "Digitap Credit Bureau Analytics",
    category: "API Pull",
    status: "never_run",
  },
  {
    job_key: "digitap-mobile-to-prefilled",
    job_name: "Digitap Mobile to Pre-filled",
    category: "API Pull",
    status: "never_run",
  },
  {
    job_key: "digitap-gst-enhancement",
    job_name: "Digitap GST Enhancement",
    category: "API Pull",
    status: "never_run",
  },
  {
    job_key: "digitap-pan-details-plus",
    job_name: "Digitap PAN Details Plus",
    category: "API Pull",
    status: "never_run",
  },
  {
    job_key: "lender-mis-email-sync",
    job_name: "Lender MIS from Email Sync Up",
    category: "Cron Job",
    status: "never_run",
  },
  {
    job_key: "email-cases-status-update",
    job_name: "Email Cases Status Update",
    category: "Cron Job",
    status: "never_run",
  },
  {
    job_key: "tl-wise-documents-upload",
    job_name: "TL Wise Documents Upload and Pendency",
    category: "Cron Job",
    status: "never_run",
  },
  {
    job_key: "crm-cases-status-update",
    job_name: "Status Update of Cases in CRM",
    category: "Cron Job",
    status: "never_run",
  },
  {
    job_key: "all-reports-refresh",
    job_name: "All Reports Refresh",
    category: "Cron Job",
    status: "never_run",
  },
  {
    job_key: "excel-upload-reported-numbers",
    job_name: "Excel Upload of Reported Numbers",
    category: "Cron Job",
    status: "never_run",
  },
];

async function setupMonitoring() {
  console.log("[setup-monitoring] Starting monitoring infrastructure setup...\n");

  try {
    // Check database connection
    console.log("[setup-monitoring] Checking Supabase connection...");
    const { data: connectionTest, error: connectionError } = await supabase
      .from("cron_job_status")
      .select("count(*)")
      .limit(1);

    if (connectionError) {
      if (connectionError.code === "PGRST204") {
        console.warn(
          "[setup-monitoring] ⚠️  Table not found. Please apply the migration first:\n"
        );
        console.warn("  1. Run: supabase db push");
        console.warn("  2. Or manually execute migrations/001_create_cron_monitoring_tables.sql");
        console.warn("  3. Then run this setup script again\n");
        process.exit(1);
      }
      throw connectionError;
    }
    console.log("[setup-monitoring] ✓ Supabase connection successful\n");

    // Initialize job status records
    console.log("[setup-monitoring] Initializing job status records...");
    // cron_job_status holds a HISTORY of checks, not one row per job: its only
    // unique constraint is (job_key, checked_at), and status-monitor.js reads it
    // with .eq(job_key).order(checked_at desc).limit(1) to get the latest.
    //
    // So this seeds one placeholder row per job and then leaves the table alone.
    // It must not upsert on job_key -- Postgres requires ON CONFLICT to name a
    // unique index and none covers job_key alone, so that errored every time. It
    // must not blindly insert either: re-running setup after the jobs have run
    // would make a fresh "not yet executed" row the newest, hiding real status
    // from the reader. Seed only when the job has no rows at all.
    for (const job of JOBS_TO_INITIALIZE) {
      const { data: existing, error: lookupError } = await supabase
        .from("cron_job_status")
        .select("id")
        .eq("job_key", job.job_key)
        .limit(1);

      if (lookupError) {
        console.error(
          `[setup-monitoring] ✗ Could not check for existing ${job.job_name} — code: ${lookupError.code}, message: ${lookupError.message}, details: ${lookupError.details}, hint: ${lookupError.hint}`,
          lookupError
        );
        continue;
      }

      if (existing && existing.length > 0) {
        console.log(
          `[setup-monitoring] — Skipped: ${job.job_name} (already has status history)`
        );
        continue;
      }

      const { error } = await supabase.from("cron_job_status").insert([
        {
          job_key: job.job_key,
          job_name: job.job_name,
          category: job.category,
          status: job.status,
          checked_at: new Date().toISOString(),
          error_message: "Job not yet executed",
        },
      ]);

      if (error) {
        console.error(
          `[setup-monitoring] ✗ Failed to initialize ${job.job_name} — code: ${error.code}, message: ${error.message}, details: ${error.details}, hint: ${error.hint}`,
          error
        );
      } else {
        console.log(`[setup-monitoring] ✓ Initialized: ${job.job_name}`);
      }
    }

    console.log("\n[setup-monitoring] ✓ Monitoring setup complete!\n");
    console.log("[setup-monitoring] Next steps:");
    console.log("  1. Configure Railway cron jobs:");
    console.log("     - Schedule: 0 6 * * * (6 AM UTC)");
    console.log("     - Command: npm --prefix data-jobs run cron:morning");
    console.log("     - Timeout: 300s");
    console.log("");
    console.log("     - Schedule: 0 18 * * * (6 PM UTC)");
    console.log("     - Command: npm --prefix data-jobs run cron:evening");
    console.log("     - Timeout: 300s");
    console.log("");
    console.log("  2. Set environment variables in Railway:");
    console.log("     - SUPABASE_URL");
    console.log("     - SUPABASE_SERVICE_ROLE_KEY");
    console.log("     - ALERT_EMAIL (optional)");
    console.log("     - SLACK_WEBHOOK_URL (optional)");
    console.log("");
    console.log("  3. Start the cron jobs");
    console.log("  4. Monitor status at Supabase → cron_job_status table");
  } catch (error) {
    console.error("[setup-monitoring] Fatal error:", error.message);
    process.exit(1);
  }
}

setupMonitoring();
