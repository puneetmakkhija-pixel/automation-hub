/**
 * Database Schema for Dual Campaign System
 * Tables for BRE Shortlisting, IVR Routing, and MIS Feedback
 *
 * Migration: 001_dual_campaign_system.sql
 * Date: 2024-01-15
 *
 * Run this migration to create the required tables and indexes
 */

-- ==================== BRE Shortlisting Tables ====================

/**
 * bre_shortlists
 * Stores daily shortlisted customers from BRE filtering
 */
CREATE TABLE IF NOT EXISTS public.bre_shortlists (
  id BIGSERIAL PRIMARY KEY,
  job_id VARCHAR NOT NULL,                    -- Daily job identifier
  shortlist_date DATE NOT NULL,               -- Date of shortlist
  lender_id VARCHAR NOT NULL,                 -- Target lender (poonawalla, hero_fincorp, etc.)
  phone VARCHAR NOT NULL UNIQUE,              -- Customer phone number
  name VARCHAR,                               -- Customer name
  customer_id VARCHAR,                        -- Reference to customer table
  eligibility_score INTEGER,                  -- BRE eligibility score (0-100)
  metadata JSONB DEFAULT '{}',                -- Age, income, CIBIL, Hunter, pincode, state, GST status
  evaluation_details JSONB DEFAULT '{}',      -- BRE evaluation results, passes/failures
  campaign_status VARCHAR DEFAULT 'pending',  -- pending, dispatched, completed
  campaign_id VARCHAR,                        -- Campaign this was dispatched to
  dispatched_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bre_shortlists_lender ON public.bre_shortlists(lender_id);
CREATE INDEX idx_bre_shortlists_status ON public.bre_shortlists(campaign_status);
CREATE INDEX idx_bre_shortlists_date ON public.bre_shortlists(shortlist_date);
CREATE INDEX idx_bre_shortlists_job ON public.bre_shortlists(job_id);

-- ==================== IVR Routing Tables ====================

/**
 * ivr_routing_decisions
 * Tracks routing decisions (DTMF input handling)
 */
CREATE TABLE IF NOT EXISTS public.ivr_routing_decisions (
  id BIGSERIAL PRIMARY KEY,
  routing_id VARCHAR UNIQUE NOT NULL,         -- Unique routing decision ID
  phone VARCHAR NOT NULL,                     -- Customer phone
  campaign_id VARCHAR NOT NULL,               -- Campaign ID
  campaign_type VARCHAR NOT NULL,             -- 'path_a' (document) or 'path_b' (diy)
  call_sid VARCHAR,                           -- OBD call SID
  dtmf_input VARCHAR,                         -- DTMF digit pressed
  routing_status VARCHAR,                     -- 'routed', 'failed', etc.
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ivr_routing_phone ON public.ivr_routing_decisions(phone);
CREATE INDEX idx_ivr_routing_campaign ON public.ivr_routing_decisions(campaign_id);
CREATE INDEX idx_ivr_routing_date ON public.ivr_routing_decisions(created_at);

/**
 * customer_journey_status
 * Tracks customer progress through document or DIY journey
 */
CREATE TABLE IF NOT EXISTS public.customer_journey_status (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR NOT NULL UNIQUE,              -- Customer phone (unique key)
  journey_type VARCHAR NOT NULL,              -- 'document_collection' or 'diy_application'
  campaign_id VARCHAR NOT NULL,               -- Campaign ID
  status VARCHAR DEFAULT 'active',            -- active, completed, abandoned
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_journey_phone ON public.customer_journey_status(phone);
CREATE INDEX idx_journey_campaign ON public.customer_journey_status(campaign_id);

/**
 * diy_journey_log
 * Logs DIY journey initiations with UTM links
 */
CREATE TABLE IF NOT EXISTS public.diy_journey_log (
  id BIGSERIAL PRIMARY KEY,
  routing_id VARCHAR UNIQUE NOT NULL,         -- Unique routing ID
  phone VARCHAR NOT NULL,                     -- Customer phone
  campaign_id VARCHAR NOT NULL,               -- Campaign ID
  lender_id VARCHAR NOT NULL,                 -- Target lender for DIY
  utm_link TEXT,                              -- Complete UTM-tagged link
  message_id VARCHAR,                         -- Ananta WhatsApp message ID
  status VARCHAR DEFAULT 'initiated',         -- initiated, clicked, rejected, approved
  clicked_at TIMESTAMP,
  application_id VARCHAR,                     -- Lender's application ID (when created)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_diy_journey_phone ON public.diy_journey_log(phone);
CREATE INDEX idx_diy_journey_lender ON public.diy_journey_log(lender_id);
CREATE INDEX idx_diy_journey_campaign ON public.diy_journey_log(campaign_id);

/**
 * diy_lender_tracking
 * Tracks DIY attempts for fallback logic (e.g., Poonawalla → Hero)
 */
CREATE TABLE IF NOT EXISTS public.diy_lender_tracking (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR NOT NULL,                     -- Customer phone
  campaign_id VARCHAR NOT NULL,               -- Campaign ID
  primary_lender VARCHAR NOT NULL,            -- First lender attempted
  fallback_lender VARCHAR,                    -- Next lender to try if primary rejects
  status VARCHAR DEFAULT 'pending',           -- pending, rejected, approved
  rejected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_diy_tracking_phone ON public.diy_lender_tracking(phone);
CREATE INDEX idx_diy_tracking_primary ON public.diy_lender_tracking(primary_lender);

/**
 * diy_fallback_log
 * Logs fallback attempts when primary lender rejects
 */
CREATE TABLE IF NOT EXISTS public.diy_fallback_log (
  id BIGSERIAL PRIMARY KEY,
  rejection_id VARCHAR UNIQUE NOT NULL,       -- Unique rejection ID
  phone VARCHAR NOT NULL,                     -- Customer phone
  campaign_id VARCHAR NOT NULL,               -- Campaign ID
  primary_lender VARCHAR NOT NULL,            -- First lender that rejected
  fallback_lender VARCHAR NOT NULL,           -- Fallback lender being tried
  rejection_code VARCHAR,                     -- Rejection code from primary lender
  rejection_reason TEXT,                      -- Rejection reason from primary lender
  message_id VARCHAR,                         -- Ananta message ID for fallback link
  status VARCHAR DEFAULT 'initiated',         -- initiated, clicked, rejected, approved
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_diy_fallback_phone ON public.diy_fallback_log(phone);
CREATE INDEX idx_diy_fallback_lender ON public.diy_fallback_log(fallback_lender);

-- ==================== MIS Feedback Tables ====================

/**
 * customer_rejection_history
 * Stores rejection history per customer for BRE optimization
 */
CREATE TABLE IF NOT EXISTS public.customer_rejection_history (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR NOT NULL UNIQUE,              -- Customer phone (unique key)
  rejection_count INTEGER DEFAULT 0,          -- Total rejections
  last_rejection_date TIMESTAMP,              -- Last rejection timestamp
  last_rejected_by VARCHAR,                   -- Last lender that rejected
  rejection_history JSONB DEFAULT '[]',       -- Array of rejection events
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_rejection_phone ON public.customer_rejection_history(phone);
CREATE INDEX idx_rejection_date ON public.customer_rejection_history(last_rejection_date);

/**
 * lender_rejection_events
 * Detailed log of all lender rejection events
 */
CREATE TABLE IF NOT EXISTS public.lender_rejection_events (
  id BIGSERIAL PRIMARY KEY,
  report_id VARCHAR NOT NULL,                 -- MIS report ID
  phone VARCHAR NOT NULL,                     -- Customer phone
  application_id VARCHAR NOT NULL,            -- Lender's application ID
  lender_id VARCHAR NOT NULL,                 -- Rejecting lender
  rejection_code VARCHAR NOT NULL,            -- Rejection code
  rejection_reason TEXT,                      -- Rejection reason text
  rejection_category VARCHAR,                 -- Category (credit_score, income, etc.)
  rejection_weight INTEGER,                   -- Weight for BRE optimization (1-35)
  bre_action_required VARCHAR,                -- Recommended BRE action
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_rejection_event_phone ON public.lender_rejection_events(phone);
CREATE INDEX idx_rejection_event_lender ON public.lender_rejection_events(lender_id);
CREATE INDEX idx_rejection_event_code ON public.lender_rejection_events(rejection_code);
CREATE INDEX idx_rejection_event_date ON public.lender_rejection_events(created_at);

/**
 * mis_report_logs
 * Metadata for each MIS report processed
 */
CREATE TABLE IF NOT EXISTS public.mis_report_logs (
  id BIGSERIAL PRIMARY KEY,
  report_id VARCHAR UNIQUE NOT NULL,          -- Unique report ID
  source VARCHAR NOT NULL,                    -- Lender source (poonawalla, hero_fincorp)
  report_date DATE NOT NULL,                  -- Report date
  total_records INTEGER,                      -- Total records in report
  valid_records INTEGER,                      -- Records that passed validation
  processed_records INTEGER,                  -- Records successfully processed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_mis_report_source ON public.mis_report_logs(source);
CREATE INDEX idx_mis_report_date ON public.mis_report_logs(report_date);

-- ==================== Aggregate Views ====================

/**
 * daily_rejection_summary
 * Summary of rejections by code for BRE optimization
 */
CREATE OR REPLACE VIEW public.daily_rejection_summary AS
SELECT
  DATE(created_at) as rejection_date,
  lender_id,
  rejection_code,
  rejection_category,
  COUNT(*) as rejection_count,
  ROUND(AVG(rejection_weight)::numeric, 2) as avg_weight,
  STRING_AGG(DISTINCT bre_action_required, ', ') as recommended_actions
FROM public.lender_rejection_events
GROUP BY DATE(created_at), lender_id, rejection_code, rejection_category
ORDER BY rejection_date DESC, rejection_count DESC;

/**
 * campaign_routing_summary
 * Summary of routing decisions by campaign
 */
CREATE OR REPLACE VIEW public.campaign_routing_summary AS
SELECT
  campaign_id,
  campaign_type,
  COUNT(*) as total_routings,
  COUNT(CASE WHEN dtmf_input = '1' THEN 1 END) as press_1_count,
  ROUND(
    100.0 * COUNT(CASE WHEN dtmf_input = '1' THEN 1 END) /
    COUNT(*),
    2
  ) as press_1_conversion_rate
FROM public.ivr_routing_decisions
GROUP BY campaign_id, campaign_type
ORDER BY total_routings DESC;

-- ==================== Permissions ====================

-- Grant read permissions to service role (already has full access)
-- Grant read-only access to analytics role if needed
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO analytics_role;

-- ==================== Triggers ====================

/**
 * Update updated_at timestamp on bre_shortlists
 */
CREATE OR REPLACE FUNCTION public.update_bre_shortlists_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bre_shortlists_update_timestamp
BEFORE UPDATE ON public.bre_shortlists
FOR EACH ROW
EXECUTE FUNCTION public.update_bre_shortlists_updated_at();

/**
 * Update customer_journey_status updated_at timestamp
 */
CREATE OR REPLACE FUNCTION public.update_journey_status_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journey_status_update_timestamp
BEFORE UPDATE ON public.customer_journey_status
FOR EACH ROW
EXECUTE FUNCTION public.update_journey_status_updated_at();

-- Migration complete
COMMENT ON TABLE public.bre_shortlists IS 'Daily BRE-filtered shortlists for lender campaigns';
COMMENT ON TABLE public.ivr_routing_decisions IS 'IVR routing decisions based on DTMF input';
COMMENT ON TABLE public.customer_journey_status IS 'Customer progress through document or DIY journey';
COMMENT ON TABLE public.diy_journey_log IS 'DIY journey initiations with UTM tracking';
COMMENT ON TABLE public.diy_lender_tracking IS 'Fallback logic tracking for DIY lender routing';
COMMENT ON TABLE public.diy_fallback_log IS 'Fallback attempts when primary lender rejects';
COMMENT ON TABLE public.customer_rejection_history IS 'Customer rejection history for BRE optimization';
COMMENT ON TABLE public.lender_rejection_events IS 'Detailed lender rejection event logs';
COMMENT ON TABLE public.mis_report_logs IS 'MIS report ingestion logs';
