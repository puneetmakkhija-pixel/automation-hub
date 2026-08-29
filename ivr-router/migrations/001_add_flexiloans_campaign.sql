-- Migration: Add FlexiLoans Lender and IVR Campaign for Document Collection
-- Date: 2025-08-29
-- Purpose: Set up FlexiLoans routing with WhatsApp bot for post-IVR document collection

-- Insert FlexiLoans as a lender (if not exists)
INSERT INTO public.lenders (lender_id, name, webhook_url, status, min_loan, max_loan, created_at, updated_at)
VALUES (
  'flexiloans',
  'FlexiLoans',
  'https://api.flexiloans.com/webhook',
  'connected',
  50000,
  5000000,
  now(),
  now()
)
ON CONFLICT (lender_id) DO UPDATE SET updated_at = now();

-- Insert IVR Campaign for FlexiLoans Document Collection
INSERT INTO public.ivr_campaigns (
  id,
  name,
  description,
  lead_count,
  status,
  ivr_config,
  dtmf_options,
  ori_voice_bot,
  created_at,
  updated_at
)
VALUES (
  'campaign_flexiloans_docs_' || to_char(now(), 'YYYY_MM_DD_HH24_MI_SS'),
  'FlexiLoans Document Collection',
  'Post-IVR document collection through WhatsApp bot with Ori voice bot integration',
  500,
  'draft',
  '{
    "greetingMessage": "Welcome to our loan service. We have a personalized offer for you with FlexiLoans. Press 1 if you''re interested in proceeding with document verification, or Press 2 if you prefer not to be contacted.",
    "greetingRecordingId": "rec_bureau_qualified_07",
    "greetingRecordingFile": "ivr_bureau_qualified_07.mp3",
    "maxDuration": 120,
    "language": "en-IN"
  }'::jsonb,
  '{
    "press1": {
      "action": "route_to_lender",
      "primary_lender": "flexiloans",
      "fallback_lender": "poonawala",
      "channel": "whatsapp",
      "whatsapp_bot_endpoint": "https://s1.whistleloop.com/?linkid=1710&offerid=178&publisher_id=259&parentid=259&pub_name=BuddyAdsIndia&sub_id1=PTest_alias_{sms_id}&loop_id={sms_id}",
      "whatsapp_message": "Hi! We have a personalized loan offer for you. Click below to complete your document verification with FlexiLoans.",
      "whatsapp_link": "https://s1.whistleloop.com/?linkid=1710&offerid=178&publisher_id=259&parentid=259&pub_name=BuddyAdsIndia&sub_id1=PTest_alias_{phone}&loop_id={campaign_id}",
      "collect_documents": true
    },
    "press2": {
      "action": "mark_dnd",
      "description": "Mark as Do Not Disturb"
    }
  }'::jsonb,
  '{
    "enabled": true,
    "purpose": "banking_documents",
    "voiceId": "default",
    "config": {
      "collect_documents": true,
      "verify_bank_statements": true,
      "collect_kyc": true,
      "collect_employment_proof": true,
      "collect_address_proof": true
    }
  }'::jsonb,
  now(),
  now()
)
ON CONFLICT DO NOTHING;

-- Create corresponding metrics entry
INSERT INTO public.ivr_campaign_metrics (
  campaign_id,
  total_calls_received,
  dtmf_press_1_count,
  dtmf_press_2_count,
  dtmf_no_response_count,
  whatsapp_sent_count,
  whatsapp_delivered_count,
  whatsapp_opened_count,
  ori_voice_bot_triggered_count,
  documents_collected_count,
  created_at,
  updated_at
)
SELECT
  id,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  now(),
  now()
FROM public.ivr_campaigns
WHERE name = 'FlexiLoans Document Collection'
AND NOT EXISTS (
  SELECT 1 FROM public.ivr_campaign_metrics WHERE campaign_id = public.ivr_campaigns.id
);

-- Document the routing flow
-- Flow:
-- 1. Lead receives IVR call
-- 2. IVR greeting plays (120 seconds max)
-- 3. Lead presses 1 → "Interested in FlexiLoans"
-- 4. System routes lead to FlexiLoans (primary), fallback to Poonawala
-- 5. WhatsApp bot initiates with message about document verification
-- 6. Ori voice bot collects: Bank statements, KYC docs, Employment proof, Address proof
-- 7. All interactions logged in ivr_campaign_events table
-- 8. Metrics updated in real-time in ivr_campaign_metrics table

COMMIT;
