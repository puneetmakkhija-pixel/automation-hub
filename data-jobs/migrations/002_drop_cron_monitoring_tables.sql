-- Drop the cron monitoring tables created by 001.
--
-- NOT APPLIED. Run this only once the morning-check and afternoon-check Railway
-- services are gone, so nothing is left reading these tables.
--
-- Why they go: nothing ever wrote a heartbeat to them. status-monitor.js read
-- cron_job_status; setup-monitoring.js seeded one placeholder row per job; no
-- production code path in this repo or in dsa-business-crm ever recorded a run.
-- At the time of writing cron_job_status held 11 rows, all inserted in the same
-- instant on 2026-08-31 with last_run NULL, and cron_job_executions and
-- cron_status_reports held none at all. The monitor was faithfully reporting
-- that nothing reported to it.
--
-- Enrichment already logs to crm.enrich_run_log, which is live and which
-- crm.rpt_api_error_daily and crm.rpt_api_error_recent already read.
--
-- Checked before writing this: no view, rule or constraint in the database
-- depends on any of the three tables (pg_depend join over pg_rewrite returned
-- nothing), and no code outside documentation references them.

drop table if exists public.cron_status_reports;
drop table if exists public.cron_job_executions;
drop table if exists public.cron_job_status;
