-- WhatsApp / Ananta flow tables
--
-- DRAFT — INFERRED FROM CODE USAGE, NOT FROM AN EXISTING SCHEMA.
-- Derived by tracing every .from(...) in:
--   lib/journeys/whatsappBotJourney.js
--   lib/routes/whatsappBotRoutes.js
--   lib/routes/whatsappFlowRoutes.js
--   lib/routes/anantaConfigRoutes.js
-- Columns come from insert/upsert/update payloads, .eq() filters and .order()
-- keys. Types, nullability, defaults and foreign keys are NOT inferable from
-- usage and are a judgement call — review before running.
--
-- Read the two "UNVERIFIED" notes below before applying to a live database.

-- ---------------------------------------------------------------------------
-- conversation_state — one live journey per phone number
--
-- phone_number MUST be UNIQUE. whatsappBotJourney.js upserts with no
-- onConflict (supabase-js then targets the primary key / a unique column) and
-- reads back with .eq('phone_number', …).single(), which errors on >1 row.
-- Without this constraint the upsert fails the same way the cron script did
-- (42P10) or silently duplicates rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_state (
  id              BIGSERIAL PRIMARY KEY,
  phone_number    TEXT        NOT NULL UNIQUE,
  user_name       TEXT,
  lender_id       TEXT,
  -- observed: greeting | external_journey | rejection_fallback | completion
  current_phase   TEXT        NOT NULL DEFAULT 'greeting',
  -- observed: active | completed | abandoned | rejected | transferred_to_external
  status          TEXT        NOT NULL DEFAULT 'active',
  form_data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  document_status TEXT,
  primary_url     TEXT,
  fallback_url    TEXT,
  last_user_input TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_conversation_state_status
  ON public.conversation_state(status);
CREATE INDEX IF NOT EXISTS idx_conversation_state_last_active_at
  ON public.conversation_state(last_active_at DESC);

-- ---------------------------------------------------------------------------
-- conversation_events — append-only journey log; many rows per phone number,
-- read newest-first via .order('created_at', { ascending: false })
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_events (
  id            BIGSERIAL PRIMARY KEY,
  phone_number  TEXT        NOT NULL,
  phase         TEXT,
  -- observed: user_message | redirected_to_external_journey |
  --           rejection_with_fallback | journey_abandoned
  event_type    TEXT        NOT NULL,
  user_input    TEXT,
  bot_response  TEXT,
  lender_id     TEXT,
  journey_url   TEXT,
  fallback_url  TEXT,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_phone_created
  ON public.conversation_events(phone_number, created_at DESC);

-- ---------------------------------------------------------------------------
-- ananta_config — HOLDS CREDENTIALS (api_key, api_token).
-- RLS below restricts it to service_role. Do not widen it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ananta_config (
  id           BIGSERIAL PRIMARY KEY,
  phone_number TEXT UNIQUE,
  api_key      TEXT,
  api_token    TEXT,
  -- observed: configured | pending_verification
  status       TEXT        NOT NULL DEFAULT 'pending_verification',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- whatsapp_templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id         BIGSERIAL PRIMARY KEY,
  lender_id  TEXT,
  type       TEXT,
  status     TEXT        NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_created_at
  ON public.whatsapp_templates(created_at DESC);

-- ---------------------------------------------------------------------------
-- whatsapp_messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id           BIGSERIAL PRIMARY KEY,
  phone_number TEXT        NOT NULL,
  direction    TEXT,                       -- inbound / outbound
  type         TEXT,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone_created
  ON public.whatsapp_messages(phone_number, created_at DESC);

-- ---------------------------------------------------------------------------
-- UNVERIFIED (1): whatsapp_conversations and whatsapp_documents
--
-- Nothing in this repository writes these two tables — they are only ever
-- SELECT *-ed by whatsappFlowRoutes.js. The columns below are ONLY the ones
-- that code filters and orders on; the real schema lives in whatever
-- populates them. If a producer already exists, take its definition instead
-- of these, or the shapes will diverge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id              BIGSERIAL PRIMARY KEY,
  phone_number    TEXT        NOT NULL UNIQUE,   -- read with .single()
  -- filtered on: active | completed
  status          TEXT        NOT NULL DEFAULT 'active',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_status
  ON public.whatsapp_conversations(status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_last_message_at
  ON public.whatsapp_conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.whatsapp_documents (
  id           BIGSERIAL PRIMARY KEY,
  phone_number TEXT        NOT NULL,
  -- UNVERIFIED (2): whatsappFlowRoutes.js:160 counts rows with
  -- status = 'verified', but no code anywhere writes that value. Either a
  -- producer outside this repo sets it, or that stat is permanently 0.
  -- Worth resolving before trusting the document counts.
  status       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_documents_phone
  ON public.whatsapp_documents(phone_number);
CREATE INDEX IF NOT EXISTS idx_whatsapp_documents_status
  ON public.whatsapp_documents(status);

-- ---------------------------------------------------------------------------
-- RLS — service_role only, matching the cron monitoring tables.
-- The service_role key bypasses RLS, so these policies are belt-and-braces:
-- what matters is that no policy grants the anon key access. ananta_config
-- especially must never be readable with the public anon key.
-- ---------------------------------------------------------------------------
ALTER TABLE public.conversation_state      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ananta_config           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_documents      ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access to conversation_state"
  ON public.conversation_state FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service role full access to conversation_events"
  ON public.conversation_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service role full access to ananta_config"
  ON public.ananta_config FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service role full access to whatsapp_templates"
  ON public.whatsapp_templates FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service role full access to whatsapp_messages"
  ON public.whatsapp_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service role full access to whatsapp_conversations"
  ON public.whatsapp_conversations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service role full access to whatsapp_documents"
  ON public.whatsapp_documents FOR ALL TO service_role USING (true) WITH CHECK (true);
