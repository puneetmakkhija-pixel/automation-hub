-- A stable identifier per mobile number.
--
-- Minted the first time a number ever reaches the IVR keypress webhook and
-- reused for every contact after, so one customer has one id across campaigns,
-- links and message history.
--
-- This is NOT a dedupe key. Dedupe needs to identify a call, and an id derived
-- from a phone number cannot: the same person ringing twice is two calls and
-- one customer. That remains unique_id from the IVR panel, with
-- campaign+mobile+digit as the fallback.
--
-- phone_number is stored in the normalised 10-digit form the router produces,
-- so 91XXXXXXXXXX, +91XXXXXXXXXX and XXXXXXXXXX all resolve to one customer.

CREATE TABLE IF NOT EXISTS public.ivr_customers (
  id                BIGSERIAL PRIMARY KEY,
  -- UNIQUE is load-bearing: it is what makes the mint race-safe. Two webhooks
  -- for the same new number arriving together both attempt an insert; one
  -- wins, the other conflicts and re-reads the winner's id.
  phone_number      TEXT        NOT NULL UNIQUE,
  customer_id       TEXT        NOT NULL UNIQUE,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Where this customer came from, kept for attribution.
  first_campaign_id TEXT,
  first_variant     TEXT
);

CREATE INDEX IF NOT EXISTS idx_ivr_customers_first_seen_at
  ON public.ivr_customers(first_seen_at DESC);

-- RLS, matching every other table this service owns: service_role only. The
-- anon key must never be able to enumerate customer phone numbers.
ALTER TABLE public.ivr_customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access to ivr_customers" ON public.ivr_customers;
CREATE POLICY "service role full access to ivr_customers"
  ON public.ivr_customers FOR ALL TO service_role USING (true) WITH CHECK (true);
