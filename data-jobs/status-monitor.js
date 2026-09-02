import { createClient } from "@supabase/supabase-js";

// Twice-daily cron status monitor for API pulls and cron jobs
// Runs at 6 AM and 6 PM to check status of critical jobs

function validateEnvironment() {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `[status-monitor] Missing required environment variable(s): ${missing.join(", ")}`
    );
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}`
    );
  }
}

let supabase;

try {
  validateEnvironment();
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
} catch (error) {
  console.error(
    "[status-monitor] Failed to initialize Supabase client:",
    error
  );
  process.exit(1);
}

const JOB_CONFIGS = {
  "digitap-bank-statement-parsing": {
    name: "Digitap Bank Statement Parsing",
    category: "API Pull",
    description: "Parse bank statements via Digitap API",
    timeout: 3600,
  },
  "digitap-credit-bureau-analytics": {
    name: "Digitap Credit Bureau Analytics",
    category: "API Pull",
    description: "Fetch credit analytics from Digitap bureau",
    timeout: 1800,
  },
  "digitap-mobile-to-prefilled": {
    name: "Digitap Mobile to Pre-filled",
    category: "API Pull",
    description: "Pre-fill mobile verification data",
    timeout: 900,
  },
  "digitap-gst-enhancement": {
    name: "Digitap GST Enhancement",
    category: "API Pull",
    description: "Enhance GST data from Digitap API",
    timeout: 1200,
  },
  "digitap-pan-details-plus": {
    name: "Digitap PAN Details Plus",
    category: "API Pull",
    description: "Fetch enhanced PAN details",
    timeout: 900,
  },
  "lender-mis-email-sync": {
    name: "Lender MIS from Email Sync Up",
    category: "Cron Job",
    description: "Sync MIS data from lender emails",
    timeout: 1800,
  },
  "email-cases-status-update": {
    name: "Email Cases Status Update",
    category: "Cron Job",
    description: "Update case statuses from email triggers",
    timeout: 1200,
  },
  "tl-wise-documents-upload": {
    name: "TL Wise Documents Upload and Pendency",
    category: "Cron Job",
    description: "Upload TL documents and track pendency",
    timeout: 2400,
  },
  "crm-cases-status-update": {
    name: "Status Update of Cases in CRM",
    category: "Cron Job",
    description: "Update case statuses in CRM system",
    timeout: 1800,
  },
  "all-reports-refresh": {
    name: "All Reports Refresh",
    category: "Cron Job",
    description: "Refresh all analytics reports",
    timeout: 3600,
  },
  "excel-upload-reported-numbers": {
    name: "Excel Upload of Reported Numbers",
    category: "Cron Job",
    description: "Upload reported numbers to Excel sheets",
    timeout: 1500,
  },
};

async function checkJobStatus(jobKey, config) {
  const now = new Date();
  const statusRecord = {
    job_key: jobKey,
    job_name: config.name,
    category: config.category,
    checked_at: now.toISOString(),
    status: "unknown",
    last_run: null,
    last_run_duration_seconds: null,
    error_message: null,
  };

  try {
    // Query the job status from the database
    const { data, error } = await supabase
      .from("cron_job_status")
      .select("*")
      .eq("job_key", jobKey)
      .order("checked_at", { ascending: false })
      .limit(1);

    if (error) {
      console.error(
        `[status-monitor] Supabase error querying cron_job_status for "${jobKey}" — code: ${error.code}, message: ${error.message}, details: ${error.details}, hint: ${error.hint}`,
        error
      );
      throw new Error(`Failed to query status: ${error.message}`);
    }

    if (data && data.length > 0) {
      const lastStatus = data[0];
      statusRecord.last_run = lastStatus.last_run;
      statusRecord.last_run_duration_seconds = lastStatus.last_run_duration_seconds;

      // Determine status based on last run time and timeout
      if (lastStatus.last_run) {
        const lastRunTime = new Date(lastStatus.last_run);
        const timeSinceLastRun = (now - lastRunTime) / 1000; // in seconds

        if (lastStatus.status === "error") {
          statusRecord.status = "error";
          statusRecord.error_message = lastStatus.error_message;
        } else if (timeSinceLastRun > config.timeout * 1.5) {
          // Job hasn't run in 1.5x the timeout
          statusRecord.status = "overdue";
          statusRecord.error_message = `No successful run for ${Math.round(timeSinceLastRun / 60)} minutes (timeout: ${Math.round(config.timeout / 60)}m)`;
        } else {
          statusRecord.status = "healthy";
        }
      } else {
        statusRecord.status = "never_run";
        statusRecord.error_message = "Job has never been executed";
      }
    } else {
      statusRecord.status = "never_run";
      statusRecord.error_message = "No status record found";
    }
  } catch (error) {
    console.error(
      `[status-monitor] Error checking job status for "${jobKey}":`,
      error
    );
    statusRecord.status = "error";
    statusRecord.error_message = error.message;
  }

  return statusRecord;
}

async function generateStatusReport(allStatuses) {
  const healthyCount = allStatuses.filter((s) => s.status === "healthy").length;
  const errorCount = allStatuses.filter((s) => s.status === "error").length;
  const overdueCount = allStatuses.filter((s) => s.status === "overdue").length;
  const neverRunCount = allStatuses.filter((s) => s.status === "never_run").length;

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total_jobs: allStatuses.length,
      healthy: healthyCount,
      errors: errorCount,
      overdue: overdueCount,
      never_run: neverRunCount,
      overall_status: errorCount > 0 || overdueCount > 0 ? "ALERT" : "OK",
    },
    jobs: allStatuses,
    alerts: allStatuses.filter((s) => s.status !== "healthy"),
  };

  return report;
}

async function saveStatusReport(report) {
  try {
    const { error } = await supabase
      .from("cron_status_reports")
      .insert([
        {
          report_time: report.timestamp,
          overall_status: report.summary.overall_status,
          summary: report.summary,
          full_report: report,
        },
      ]);

    if (error) {
      console.error(
        `[status-monitor] Supabase error inserting into cron_status_reports — code: ${error.code}, message: ${error.message}, details: ${error.details}, hint: ${error.hint}`,
        error
      );
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      "[status-monitor] Unexpected error saving report:",
      error
    );
    return false;
  }
}

async function main() {
  // Re-validate environment at the start of main() in case this function
  // is ever invoked without the module-level guard (e.g. in tests).
  validateEnvironment();

  console.log(
    `[status-monitor] Cron status check started at ${new Date().toISOString()}`
  );
  console.log(
    `[status-monitor] Startup banner: SUPABASE_URL=${
      process.env.SUPABASE_URL ? "loaded" : "MISSING"
    }, SUPABASE_SERVICE_ROLE_KEY=${
      process.env.SUPABASE_SERVICE_ROLE_KEY ? "loaded" : "MISSING"
    }`
  );

  const allStatuses = [];

  // Check each job
  for (const [jobKey, config] of Object.entries(JOB_CONFIGS)) {
    try {
      const status = await checkJobStatus(jobKey, config);
      allStatuses.push(status);
      console.log(
        `[status-monitor] ${status.job_name}: ${status.status.toUpperCase()}`
      );
    } catch (error) {
      console.error(
        `[status-monitor] Error checking ${jobKey}:`,
        error && error.message ? error.message : error,
        error
      );
    }
  }

  // Generate and save report
  let report;
  try {
    report = await generateStatusReport(allStatuses);
  } catch (error) {
    console.error(
      "[status-monitor] Error generating status report:",
      error
    );
    throw error;
  }

  console.log(
    `[status-monitor] Report Summary: ${report.summary.healthy} healthy, ${report.summary.errors} errors, ${report.summary.overdue} overdue`
  );

  if (report.alerts.length > 0) {
    console.log("[status-monitor] ALERTS:");
    report.alerts.forEach((alert) => {
      console.log(`  - ${alert.job_name}: ${alert.error_message}`);
    });
  }

  try {
    const saved = await saveStatusReport(report);
    if (!saved) {
      console.error(
        "[status-monitor] Status report was not saved to the database. See errors above for details."
      );
    }
  } catch (error) {
    console.error(
      "[status-monitor] Unexpected error while saving status report:",
      error
    );
    throw error;
  }

  console.log(`[status-monitor] Status check completed`);
}

main().catch((error) => {
  console.error("[status-monitor] Fatal error:", error);
  if (error && error.stack) {
    console.error("[status-monitor] Stack trace:", error.stack);
  }
  process.exit(1);
});
