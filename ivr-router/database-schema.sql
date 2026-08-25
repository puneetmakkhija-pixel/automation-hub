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
