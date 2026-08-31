-- IVR Campaigns Management Schema
-- Run this SQL in your Supabase project

-- Drop existing tables (if any) to ensure clean schema
DROP TABLE IF EXISTS public.ivr_campaign_events CASCADE;
DROP TABLE IF EXISTS public.ivr_campaign_metrics CASCADE;
DROP TABLE IF EXISTS public.ivr_campaigns CASCADE;

-- Create IVR Campaigns table
CREATE TABLE public.ivr_campaigns (
  id VARCHAR(255) PRIMARY KEY,

  -- Campaign metadata
  name VARCHAR(255) NOT NULL,
  description TEXT,
  lead_count INTEGER NOT NULL,

  -- IVR Configuration
  ivr_config JSONB NOT NULL DEFAULT '{}'::jsonb, -- {greetingMessage, maxDuration}

  -- DTMF Options Configuration
  dtmf_options JSONB NOT NULL DEFAULT '{}'::jsonb, -- {press1: {...}, press2: {...}}

  -- Optional Ori Voice Bot Configuration
  ori_voice_bot JSONB DEFAULT NULL, -- {enabled, voiceId, purpose}

  -- Campaign Status
  status VARCHAR(50) NOT NULL DEFAULT 'draft', -- 'draft', 'active', 'paused', 'completed'

  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  launched_at TIMESTAMP DEFAULT NULL,
  completed_at TIMESTAMP DEFAULT NULL,

  -- Constraints
  CONSTRAINT valid_status CHECK (status IN ('draft', 'active', 'paused', 'completed'))
);

-- Create indexes on ivr_campaigns
CREATE INDEX IF NOT EXISTS idx_ivr_campaigns_status ON public.ivr_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_ivr_campaigns_created_at ON public.ivr_campaigns(created_at);
CREATE INDEX IF NOT EXISTS idx_ivr_campaigns_launched_at ON public.ivr_campaigns(launched_at);

-- Enable RLS (Row Level Security)
ALTER TABLE public.ivr_campaigns ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
DROP POLICY IF EXISTS "Allow service role" ON public.ivr_campaigns;
CREATE POLICY "Allow service role" ON public.ivr_campaigns
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Create IVR Campaign Metrics table (for tracking campaign performance)
CREATE TABLE public.ivr_campaign_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id VARCHAR(255) NOT NULL REFERENCES public.ivr_campaigns(id) ON DELETE CASCADE,

  -- DTMF metrics
  total_calls_received INTEGER DEFAULT 0,
  dtmf_press_1_count INTEGER DEFAULT 0, -- "Interested"
  dtmf_press_2_count INTEGER DEFAULT 0, -- "Not Interested"
  dtmf_no_response_count INTEGER DEFAULT 0,

  -- WhatsApp routing metrics
  whatsapp_sent_count INTEGER DEFAULT 0,
  whatsapp_delivered_count INTEGER DEFAULT 0,
  whatsapp_opened_count INTEGER DEFAULT 0,

  -- Lender routing metrics
  primary_lender_routed_count INTEGER DEFAULT 0,
  fallback_lender_routed_count INTEGER DEFAULT 0,
  dnd_marked_count INTEGER DEFAULT 0,

  -- Ori voice bot metrics (if enabled)
  ori_voice_bot_triggered_count INTEGER DEFAULT 0,
  documents_collected_count INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Create indexes on ivr_campaign_metrics
CREATE INDEX IF NOT EXISTS idx_ivr_campaign_metrics_campaign_id ON public.ivr_campaign_metrics(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ivr_campaign_metrics_created_at ON public.ivr_campaign_metrics(created_at);

-- Enable RLS on ivr_campaign_metrics
ALTER TABLE public.ivr_campaign_metrics ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
DROP POLICY IF EXISTS "Allow service role" ON public.ivr_campaign_metrics;
CREATE POLICY "Allow service role" ON public.ivr_campaign_metrics
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Create IVR Campaign Events table (for audit trail)
CREATE TABLE public.ivr_campaign_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id VARCHAR(255) NOT NULL REFERENCES public.ivr_campaigns(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,

  -- Event tracking
  event_type VARCHAR(100) NOT NULL, -- 'call_received', 'dtmf_press_1', 'dtmf_press_2', 'whatsapp_sent', 'lender_routed', 'dnd_marked'
  dtmf_input VARCHAR(1),

  -- Routing information
  primary_lender VARCHAR(100),
  fallback_lender VARCHAR(100),
  selected_lender VARCHAR(100),

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Create indexes on ivr_campaign_events
CREATE INDEX IF NOT EXISTS idx_ivr_campaign_events_campaign_id ON public.ivr_campaign_events(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ivr_campaign_events_phone ON public.ivr_campaign_events(phone_number);
CREATE INDEX IF NOT EXISTS idx_ivr_campaign_events_event_type ON public.ivr_campaign_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ivr_campaign_events_created_at ON public.ivr_campaign_events(created_at);

-- Enable RLS on ivr_campaign_events
ALTER TABLE public.ivr_campaign_events ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
DROP POLICY IF EXISTS "Allow service role" ON public.ivr_campaign_events;
CREATE POLICY "Allow service role" ON public.ivr_campaign_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
