-- Indexes for the IVR keypress -> WhatsApp send log.
--
-- The route writes one public.whatsapp_messages row per send attempt
-- (direction 'outbound', type 'ivr_dtmf_template') and reads it back before
-- sending, to suppress a retry that arrives after a restart has emptied the
-- in-memory dedupe set. No new columns: everything beyond phone_number lives
-- in metadata, so existing readers of this table are unaffected.
--
-- Safe to run more than once, and safe on a live table — both indexes are
-- partial and CREATE INDEX IF NOT EXISTS is a no-op when they already exist.
-- On a table with meaningful traffic, add CONCURRENTLY (it cannot run inside a
-- transaction block, so run those two statements on their own).

-- The lookup before every send:
--   WHERE direction = 'outbound'
--     AND metadata->>'unique_id' = $1
--     AND metadata->>'status'    = 'sent'
-- Partial, because rows without a unique_id can never match it — the IVR panel
-- only sends that field if the operator added it to the webhook body.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_unique_id
  ON public.whatsapp_messages ((metadata->>'unique_id'))
  WHERE metadata->>'unique_id' IS NOT NULL;

-- Reporting: "what did this campaign send, newest first". Partial so it stays
-- small as other producers write to this table.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_ivr_campaign
  ON public.whatsapp_messages ((metadata->>'campaign_id'), created_at DESC)
  WHERE type = 'ivr_dtmf_template';
