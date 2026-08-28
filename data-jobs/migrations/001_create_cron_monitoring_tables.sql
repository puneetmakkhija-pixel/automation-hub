-- Cron Job Status Monitoring Tables
-- Created for twice-daily status monitoring of API pulls and cron jobs

-- Table to track individual job statuses
CREATE TABLE IF NOT EXISTS public.cron_job_status (
  id BIGSERIAL PRIMARY KEY,
  job_key VARCHAR(100) NOT NULL,
  job_name VARCHAR(255) NOT NULL,
  category VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'unknown',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run TIMESTAMPTZ,
  last_run_duration_seconds INTEGER,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_key, checked_at)
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_cron_job_status_job_key ON public.cron_job_status(job_key);
CREATE INDEX IF NOT EXISTS idx_cron_job_status_checked_at ON public.cron_job_status(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_job_status_status ON public.cron_job_status(status);

-- Table to store periodic status reports
CREATE TABLE IF NOT EXISTS public.cron_status_reports (
  id BIGSERIAL PRIMARY KEY,
  report_time TIMESTAMPTZ NOT NULL,
  overall_status VARCHAR(50) NOT NULL,
  summary JSONB NOT NULL,
  full_report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_cron_status_reports_report_time ON public.cron_status_reports(report_time DESC);
CREATE INDEX IF NOT EXISTS idx_cron_status_reports_overall_status ON public.cron_status_reports(overall_status);

-- Table to track cron job executions
CREATE TABLE IF NOT EXISTS public.cron_job_executions (
  id BIGSERIAL PRIMARY KEY,
  job_key VARCHAR(100) NOT NULL,
  job_name VARCHAR(255) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  status VARCHAR(50) NOT NULL DEFAULT 'running',
  error_message TEXT,
  output_logs TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_cron_job_executions_job_key ON public.cron_job_executions(job_key);
CREATE INDEX IF NOT EXISTS idx_cron_job_executions_started_at ON public.cron_job_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_job_executions_status ON public.cron_job_executions(status);

-- Enable RLS (Row Level Security) if required
ALTER TABLE public.cron_job_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_status_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_job_executions ENABLE ROW LEVEL SECURITY;

-- Create policies for service role read/write access (can be restricted as needed)
CREATE POLICY "Allow service role read access to cron_job_status" ON public.cron_job_status
  FOR SELECT TO service_role USING (true);

CREATE POLICY "Allow service role insert access to cron_job_status" ON public.cron_job_status
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow service role update access to cron_job_status" ON public.cron_job_status
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow service role read access to cron_status_reports" ON public.cron_status_reports
  FOR SELECT TO service_role USING (true);

CREATE POLICY "Allow service role insert access to cron_status_reports" ON public.cron_status_reports
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow service role update access to cron_status_reports" ON public.cron_status_reports
  FOR UPDATE USING (true) WITH CHECK (true);

CREATE POLICY "Allow read access to cron_job_executions" ON public.cron_job_executions
  FOR SELECT USING (true);
