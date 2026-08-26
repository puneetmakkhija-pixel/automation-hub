-- Phase 3a: WhatsApp Bot Infrastructure - Database Schema
-- Run this SQL in your Supabase project

-- Create conversation_state table
CREATE TABLE IF NOT EXISTS public.conversation_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- User identification
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  user_name VARCHAR(255),
  application_id UUID,

  -- Conversation flow
  current_phase VARCHAR(100) NOT NULL DEFAULT 'product_selection',

  -- Form data (JSONB for flexibility)
  form_data JSONB DEFAULT '{}'::jsonb,

  -- Document tracking
  document_status JSONB DEFAULT '{}'::jsonb,

  -- Lender information
  eligible_lenders VARCHAR[] DEFAULT '{}',
  selected_lender VARCHAR,
  lender_assignment_id UUID,

  -- Timestamps
  started_at TIMESTAMP DEFAULT now(),
  last_active_at TIMESTAMP DEFAULT now(),
  completed_at TIMESTAMP,

  -- Metadata
  intent JSONB DEFAULT 'null'::jsonb,
  rejection_logs JSONB DEFAULT '{}'::jsonb,

  -- Status
  status VARCHAR(50) DEFAULT 'active',
  error_message TEXT,

  CONSTRAINT valid_phase CHECK (current_phase IN (
    'product_selection', 'eligibility_check', 'lender_selection',
    'form_personal', 'form_business', 'documents',
    'kyc_verification', 'lender_submission', 'approval', 'completed'
  ))
);

-- Create indexes on conversation_state
CREATE INDEX IF NOT EXISTS idx_conversation_state_phone ON public.conversation_state(phone_number);
CREATE INDEX IF NOT EXISTS idx_conversation_state_phase ON public.conversation_state(current_phase);
CREATE INDEX IF NOT EXISTS idx_conversation_state_status ON public.conversation_state(status);
CREATE INDEX IF NOT EXISTS idx_conversation_state_last_active ON public.conversation_state(last_active_at);

-- Enable RLS (Row Level Security)
ALTER TABLE public.conversation_state ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.conversation_state
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Create conversation_events table (Audit Trail)
CREATE TABLE IF NOT EXISTS public.conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES public.conversation_state(phone_number) ON DELETE CASCADE,
  phase VARCHAR(100) NOT NULL,
  event_type VARCHAR(50),
  user_input TEXT,
  bot_response TEXT,
  metadata JSONB DEFAULT 'null'::jsonb,
  created_at TIMESTAMP DEFAULT now()
);

-- Create indexes on conversation_events
CREATE INDEX IF NOT EXISTS idx_conversation_events_phone ON public.conversation_events(phone_number);
CREATE INDEX IF NOT EXISTS idx_conversation_events_created_at ON public.conversation_events(created_at);

-- Enable RLS on conversation_events
ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write conversation_events
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.conversation_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Phase 3.5a: Intent Generation - User Intents Table
CREATE TABLE IF NOT EXISTS public.user_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES public.conversation_state(phone_number) ON DELETE CASCADE,

  -- Intent analysis results
  intent VARCHAR(50), -- 'working_capital', 'debt_consolidation', 'expansion', 'equipment', 'emergency', 'other'
  intent_confidence NUMERIC(3,2), -- 0.0 - 1.0
  risk_profile VARCHAR(20), -- 'low', 'medium', 'high'
  completion_probability NUMERIC(3,2), -- 0.0 - 1.0
  messaging_angle VARCHAR(100), -- 'cash_flow_smooth', 'business_growth', 'debt_relief', 'seasonal_need', 'emergency_support'

  -- Recommendations
  recommended_amount INTEGER, -- Loan amount in rupees
  recommended_lender VARCHAR(50), -- 'poonawala', 'hero_fincorp', 'hdfc', 'other'
  personalized_message TEXT, -- WhatsApp message to send user
  reasoning TEXT, -- Explanation of analysis

  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  CONSTRAINT valid_risk_profile CHECK (risk_profile IN ('low', 'medium', 'high')),
  CONSTRAINT valid_intent CHECK (intent IN ('working_capital', 'debt_consolidation', 'expansion', 'equipment', 'emergency', 'other'))
);

-- Create indexes on user_intents
CREATE INDEX IF NOT EXISTS idx_user_intents_phone ON public.user_intents(phone_number);
CREATE INDEX IF NOT EXISTS idx_user_intents_created_at ON public.user_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_user_intents_intent ON public.user_intents(intent);

-- Enable RLS on user_intents
ALTER TABLE public.user_intents ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.user_intents
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Phase 3.5c: Rejection Tracking - Rejection Logs Table
CREATE TABLE IF NOT EXISTS public.rejection_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES public.conversation_state(phone_number) ON DELETE CASCADE,
  application_id UUID,
  lender_id VARCHAR(50),

  -- Rejection details
  rejection_reason VARCHAR(100), -- 'cibil_low', 'age_out_of_range', 'income_below_minimum', 'pincode_not_serviceable', etc.
  rejection_category VARCHAR(50), -- 'bureau', 'demographic', 'business', 'soft'
  rejection_message TEXT,

  -- Rejected variables (what caused the rejection)
  rejected_bureau_vars JSONB DEFAULT '{}'::jsonb, -- {cibil: 650, hunter: 800, dpd: 1}
  rejected_demographic_vars JSONB DEFAULT '{}'::jsonb, -- {age: 56, income: 150000, pincode: '400001'}

  -- Re-engagement tracking
  user_engaged_again BOOLEAN DEFAULT FALSE,
  reengagement_channel VARCHAR(50),
  reengagement_sent_at TIMESTAMP,
  reengagement_response_at TIMESTAMP,

  -- Timestamps
  rejected_at TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now(),
  CONSTRAINT valid_category CHECK (rejection_category IN ('bureau', 'demographic', 'business', 'soft'))
);

-- Create indexes on rejection_logs
CREATE INDEX IF NOT EXISTS idx_rejection_logs_phone ON public.rejection_logs(phone_number);
CREATE INDEX IF NOT EXISTS idx_rejection_logs_lender ON public.rejection_logs(lender_id);
CREATE INDEX IF NOT EXISTS idx_rejection_logs_category ON public.rejection_logs(rejection_category);
CREATE INDEX IF NOT EXISTS idx_rejection_logs_created_at ON public.rejection_logs(created_at);

-- Enable RLS on rejection_logs
ALTER TABLE public.rejection_logs ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.rejection_logs
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Phase 3.5b: Application Push - Push Events Table
CREATE TABLE IF NOT EXISTS public.push_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES public.conversation_state(phone_number) ON DELETE CASCADE,

  -- Channel tracking
  channels_attempted VARCHAR[] DEFAULT '{}', -- ['whatsapp', 'email', 'slack']
  channels_succeeded VARCHAR[] DEFAULT '{}', -- Channels that successfully sent

  -- Message IDs for tracking
  whatsapp_message_id VARCHAR(255),
  email_message_id VARCHAR(255),

  -- Intent and personalization
  intent_used VARCHAR(50),
  personalized_message TEXT,

  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  delivered_at TIMESTAMP,
  read_at TIMESTAMP
);

-- Create indexes on push_events
CREATE INDEX IF NOT EXISTS idx_push_events_phone ON public.push_events(phone_number);
CREATE INDEX IF NOT EXISTS idx_push_events_created_at ON public.push_events(created_at);

-- Enable RLS on push_events
ALTER TABLE public.push_events ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.push_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Phase 3.5b: Application Push - Push Engagement Events Table
CREATE TABLE IF NOT EXISTS public.push_engagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES public.conversation_state(phone_number) ON DELETE CASCADE,

  -- Engagement tracking
  event_type VARCHAR(100), -- 'whatsapp_opened', 'email_clicked', 'application_started', 'inactivity_2h', 'document_rejected'
  metadata JSONB DEFAULT '{}'::jsonb, -- Additional context about the event

  -- Timestamps
  created_at TIMESTAMP DEFAULT now()
);

-- Create indexes on push_engagement_events
CREATE INDEX IF NOT EXISTS idx_push_engagement_phone ON public.push_engagement_events(phone_number);
CREATE INDEX IF NOT EXISTS idx_push_engagement_event_type ON public.push_engagement_events(event_type);
CREATE INDEX IF NOT EXISTS idx_push_engagement_created_at ON public.push_engagement_events(created_at);

-- Enable RLS on push_engagement_events
ALTER TABLE public.push_engagement_events ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.push_engagement_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Phase 3.5d: Suppression Analysis - Eligibility Rules Table
CREATE TABLE IF NOT EXISTS public.eligibility_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Rule version tracking
  version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  recommendation_id UUID,

  -- CIBIL rules
  cibil_minimum_score INTEGER NOT NULL DEFAULT 700,

  -- Age rules
  age_minimum INTEGER NOT NULL DEFAULT 21,
  age_maximum INTEGER NOT NULL DEFAULT 65,

  -- Income rules (in INR)
  income_minimum INTEGER NOT NULL DEFAULT 150000,
  income_maximum INTEGER NOT NULL DEFAULT 5000000,

  -- Business rules
  business_age_minimum_months INTEGER NOT NULL DEFAULT 12,

  -- Loan amount rules (in INR)
  loan_amount_minimum INTEGER NOT NULL DEFAULT 50000,
  loan_amount_maximum INTEGER NOT NULL DEFAULT 5000000,

  -- Geographic rules
  pincode_blocklist VARCHAR[] DEFAULT '{}',

  -- Metadata
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create indexes on eligibility_rules
CREATE INDEX IF NOT EXISTS idx_eligibility_rules_active ON public.eligibility_rules(active);
CREATE INDEX IF NOT EXISTS idx_eligibility_rules_version ON public.eligibility_rules(version);
CREATE INDEX IF NOT EXISTS idx_eligibility_rules_created_at ON public.eligibility_rules(created_at);

-- Enable RLS on eligibility_rules
ALTER TABLE public.eligibility_rules ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.eligibility_rules
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Phase 3.5d: Suppression Analysis - Rule Recommendations Table
CREATE TABLE IF NOT EXISTS public.rule_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Analysis context
  analysis_window_hours INTEGER NOT NULL DEFAULT 24,
  rejection_count INTEGER NOT NULL,
  analysis_data JSONB NOT NULL,

  -- Rule comparison
  current_rules JSONB NOT NULL,
  recommended_rules JSONB NOT NULL,

  -- Recommendation metadata
  confidence_score NUMERIC(3,2) NOT NULL,
  estimated_reengagement_count INTEGER,

  -- Status tracking
  status VARCHAR(50) DEFAULT 'pending_review',

  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  reviewed_at TIMESTAMP,
  applied_at TIMESTAMP,

  CONSTRAINT valid_status CHECK (status IN ('pending_review', 'approved', 'rejected', 'applied'))
);

-- Create indexes on rule_recommendations
CREATE INDEX IF NOT EXISTS idx_rule_recommendations_status ON public.rule_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_rule_recommendations_created_at ON public.rule_recommendations(created_at);

-- Enable RLS on rule_recommendations
ALTER TABLE public.rule_recommendations ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.rule_recommendations
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Phase 3.5e: Re-engagement Campaign - Re-engagement Events Table
CREATE TABLE IF NOT EXISTS public.reengagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number VARCHAR(20) NOT NULL REFERENCES public.conversation_state(phone_number) ON DELETE CASCADE,

  -- Event tracking
  event_type VARCHAR(100) NOT NULL, -- 'campaign_sent', 'email_clicked', 'whatsapp_opened', 'application_started', 'response_recorded'
  metadata JSONB DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at TIMESTAMP DEFAULT now()
);

-- Create indexes on reengagement_events
CREATE INDEX IF NOT EXISTS idx_reengagement_events_phone ON public.reengagement_events(phone_number);
CREATE INDEX IF NOT EXISTS idx_reengagement_events_event_type ON public.reengagement_events(event_type);
CREATE INDEX IF NOT EXISTS idx_reengagement_events_created_at ON public.reengagement_events(created_at);

-- Enable RLS on reengagement_events
ALTER TABLE public.reengagement_events ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
CREATE POLICY IF NOT EXISTS "Allow service role" ON public.reengagement_events
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
