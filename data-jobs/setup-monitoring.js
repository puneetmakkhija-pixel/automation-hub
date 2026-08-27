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
    for (const job of JOBS_TO_INITIALIZE) {
      const { error } = await supabase.from("cron_job_status").upsert(
        [
          {
            job_key: job.job_key,
            job_name: job.job_name,
            category: job.category,
            status: job.status,
            checked_at: new Date().toISOString(),
            error_message: "Job not yet executed",
          },
        ],
        { onConflict: "job_key" }
      );

      if (error) {
        console.error(
          `[setup-monitoring] ✗ Failed to initialize ${job.job_name}: ${error.message}`
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
