# Cron Status Monitoring Setup

## Overview

This document outlines the twice-daily cron status monitoring system that checks the health and status of all critical API pulls and cron jobs in the automation pipeline.

**Monitoring Schedule:**
- **Morning Check:** 6:00 AM UTC
- **Evening Check:** 6:00 PM UTC

## Monitored Jobs

### API Pulls (Digitap Integration)

| Job | Timeout | Critical | Description |
|-----|---------|----------|-------------|
| Digitap Bank Statement Parsing | 60 min | ✓ Yes | Parse bank statements via Digitap API |
| Digitap Credit Bureau Analytics | 30 min | ✓ Yes | Fetch credit analytics from Digitap bureau |
| Digitap Mobile to Pre-filled | 15 min | No | Pre-fill mobile verification data |
| Digitap GST Enhancement | 20 min | No | Enhance GST data from Digitap API |
| Digitap PAN Details Plus | 15 min | ✓ Yes | Fetch enhanced PAN details |

### Cron Jobs

| Job | Timeout | Critical | Description |
|-----|---------|----------|-------------|
| Lender MIS Email Sync | 30 min | ✓ Yes | Sync MIS data from lender emails |
| Email Cases Status Update | 20 min | ✓ Yes | Update case statuses from email triggers |
| TL Wise Documents Upload | 40 min | ✓ Yes | Upload TL documents and track pendency |
| Status Update of Cases in CRM | 30 min | ✓ Yes | Update case statuses in CRM system |
| All Reports Refresh | 60 min | ✓ Yes | Refresh all analytics reports |
| Excel Upload of Reported Numbers | 25 min | No | Upload reported numbers to Excel sheets |

## Status Definitions

| Status | Meaning | Action |
|--------|---------|--------|
| **Healthy** | Job ran successfully within timeout window | No action needed |
| **Error** | Job execution failed | Investigate error logs, restart if needed |
| **Overdue** | Job hasn't run in 1.5x the timeout window | Check if job is stuck, restart manually |
| **Never Run** | No execution record found | Job needs to be set up or executed for the first time |
| **Unknown** | Status cannot be determined | Review database connection and job records |

## Database Schema

### Tables Created

1. **cron_job_status**
   - Tracks the current status of each job
   - Records: job_key, status, last_run, duration, errors
   - Indexed by: job_key, checked_at, status

2. **cron_status_reports**
   - Stores periodic status reports from each monitor run
   - Records summary and full report data
   - Indexed by: report_time, overall_status

3. **cron_job_executions**
   - Records each job execution for audit trail
   - Tracks: start time, end time, duration, status, errors
   - Indexed by: job_key, started_at, status

### Database Setup

Apply the migration to your Supabase database:

```bash
# Using Supabase CLI
supabase db push

# Or manually run the SQL:
# Copy the contents of migrations/001_create_cron_monitoring_tables.sql
# and execute in your Supabase SQL editor
```

## Railway Cron Configuration

### Option 1: Railway UI (Recommended)

1. Go to your Railway project → Select the automation-hub service
2. Go to "Settings" → "Cron Schedule"
3. Create two cron jobs:

**Morning Check**
- Command: `npm run cron:morning`
- Schedule: `30 0 * * *` (6:00 AM IST daily / 0:30 AM UTC)
- Timeout: 300 seconds

**Evening Check**
- Command: `npm run cron:evening`
- Schedule: `30 12 * * *` (6:00 PM IST daily / 12:30 PM UTC)
- Timeout: 300 seconds

### Option 2: Docker Cron Service

Create a separate Railway service with cron capability:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY data-jobs/package.json .
COPY data-jobs/migrations ./migrations
COPY data-jobs/status-monitor.js .

RUN npm install

# Use crond for scheduling (alpine linux)
RUN apk add --no-cache dcron

# Create cron entries
RUN echo "0 6 * * * cd /app && npm run cron:morning >> /var/log/cron.log 2>&1" > /etc/crontabs/root && \
    echo "0 18 * * * cd /app && npm run cron:evening >> /var/log/cron.log 2>&1" >> /etc/crontabs/root

CMD ["crond", "-f", "-l", "2"]
```

### Option 3: External Cron Service

Use a service like EasyCron, AWS EventBridge, or Google Cloud Scheduler:

**Webhook URL to call:**
```
https://<your-railway-domain>/api/cron/status-check
```

**Schedule:** 
- `0 6 * * *` (6 AM UTC)
- `0 18 * * *` (6 PM UTC)

## Environment Variables

Add the following to your Railway project:

```env
# Supabase Connection
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Alerting (Optional)
ALERT_EMAIL=ops@yourdomain.com
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

## Running Manually

To test the status monitor locally:

```bash
cd data-jobs

# Install dependencies
npm install

# Run status check
SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." npm run monitor:status
```

## Alert Configuration

### Email Alerts

When configured with `ALERT_EMAIL`, the system will send emails on:
- Job execution failures
- Jobs running overdue (no successful run in timeout window)

### Slack Alerts

When configured with `SLACK_WEBHOOK_URL`, messages are posted to Slack with:
- Job status summary
- List of failed/overdue jobs
- Recommended actions

### Custom Alerting

To add custom alerts, modify the `generateStatusReport()` function in `status-monitor.js`:

```javascript
// Example: Send to PagerDuty
if (report.summary.overall_status === 'ALERT') {
  await notifyPagerDuty({
    severity: errorCount > 0 ? 'critical' : 'warning',
    summary: `Cron status check: ${errorCount} errors, ${overdueCount} overdue`,
    details: report
  });
}
```

## Monitoring Dashboard

View recent status reports in Supabase:

```sql
-- Get latest status report
SELECT * FROM cron_status_reports
ORDER BY report_time DESC
LIMIT 1;

-- Get job execution history (last 30 days)
SELECT job_name, status, COUNT(*) as executions, 
       AVG(duration_seconds) as avg_duration
FROM cron_job_executions
WHERE started_at > NOW() - INTERVAL '30 days'
GROUP BY job_name, status
ORDER BY started_at DESC;

-- Get currently failing jobs
SELECT job_name, status, error_message, last_run
FROM cron_job_status
WHERE status IN ('error', 'overdue')
ORDER BY checked_at DESC;
```

## Job-Specific Status Tracking

Each job should update its status in the database when it runs:

```javascript
// Example: In your job runner
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runJob(jobKey, jobName) {
  const startTime = new Date();
  
  try {
    // Your job logic here
    console.log(`Running ${jobName}...`);
    
    // Record execution
    const duration = Math.round((new Date() - startTime) / 1000);
    await supabase.from("cron_job_executions").insert([{
      job_key: jobKey,
      job_name: jobName,
      started_at: startTime.toISOString(),
      completed_at: new Date().toISOString(),
      duration_seconds: duration,
      status: "success"
    }]);
    
    // Update status
    await supabase.from("cron_job_status").upsert([{
      job_key: jobKey,
      job_name: jobName,
      status: "healthy",
      last_run: new Date().toISOString(),
      last_run_duration_seconds: duration
    }], { onConflict: "job_key" });
    
  } catch (error) {
    const duration = Math.round((new Date() - startTime) / 1000);
    
    // Record failure
    await supabase.from("cron_job_executions").insert([{
      job_key: jobKey,
      job_name: jobName,
      started_at: startTime.toISOString(),
      completed_at: new Date().toISOString(),
      duration_seconds: duration,
      status: "error",
      error_message: error.message
    }]);
    
    // Update status
    await supabase.from("cron_job_status").upsert([{
      job_key: jobKey,
      job_name: jobName,
      status: "error",
      error_message: error.message,
      last_run: new Date().toISOString()
    }], { onConflict: "job_key" });
    
    throw error;
  }
}
```

## Troubleshooting

### Cron Job Not Running

1. Check Railway logs: `railway logs -s automation-hub`
2. Verify cron schedule in Railway UI
3. Ensure service has proper permissions and environment variables

### No Status Data in Database

1. Verify Supabase connection string is correct
2. Check that service_role key has correct permissions
3. Ensure migration has been applied: `SELECT * FROM cron_job_status;`

### Alerts Not Sending

1. Verify ALERT_EMAIL or SLACK_WEBHOOK_URL is set
2. Check email service configuration
3. Test Slack webhook manually

### Jobs Showing as "Never Run"

1. Job hasn't executed yet - run manually or wait for scheduled time
2. Check if job's status update code is implemented
3. Verify job execution logs in cron_job_executions table

## Performance Monitoring

### Execution Time Trends

```sql
-- Average execution time by job (last 7 days)
SELECT job_name, 
       ROUND(AVG(duration_seconds)::numeric, 2) as avg_seconds,
       MAX(duration_seconds) as max_seconds,
       MIN(duration_seconds) as min_seconds,
       COUNT(*) as total_runs
FROM cron_job_executions
WHERE started_at > NOW() - INTERVAL '7 days'
GROUP BY job_name
ORDER BY avg_seconds DESC;
```

### Success Rate

```sql
-- Success rate by job (last 30 days)
SELECT job_name,
       COUNT(*) as total_runs,
       COUNT(CASE WHEN status = 'success' THEN 1 END) as successful,
       ROUND(100.0 * COUNT(CASE WHEN status = 'success' THEN 1 END) / COUNT(*), 2) as success_rate
FROM cron_job_executions
WHERE started_at > NOW() - INTERVAL '30 days'
GROUP BY job_name
ORDER BY success_rate ASC;
```

## Future Enhancements

- [ ] Grafana dashboard for visual monitoring
- [ ] Automated remediation for common failures
- [ ] ML-based anomaly detection for execution times
- [ ] Cost tracking for API calls
- [ ] Integration with incident management systems
- [ ] Job dependency tracking and validation
