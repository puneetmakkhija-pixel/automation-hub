/**
 * Serviceable Pincodes & Gating Logs
 *
 * Migration: 002_serviceable_pincodes.sql
 * Date: 2026-09-02
 *
 * WHY THIS EXISTS
 * ivr-router/lib/pincodeGatingClient.js and ivr-router/lib/pincodeRoutes.js both
 * query `serviceable_pincodes`, and createGatingLog() writes to `gating_logs`.
 * Neither table had ever been created in the Supabase project, so
 * validatePincode() errored on every call and the gating engine treated every
 * lead as "pincode not serviceable" — a 100% reject rate on Poonawalla STPL.
 *
 * The 198 Poonawalla rows sitting in `pincode_serviceability` are a Delhi/NCR-only
 * remnant and are NOT what the router reads.
 *
 * AFTER RUNNING THIS: load the pincode data with
 *   node data-jobs/load-serviceable-pincodes.js
 */

-- ==================== Serviceable Pincodes ====================

CREATE TABLE IF NOT EXISTS public.serviceable_pincodes (
  id          BIGSERIAL PRIMARY KEY,
  pincode     TEXT NOT NULL,                  -- 6-digit, zero-padded
  lender_type TEXT NOT NULL,                  -- 'poonawala', 'herofincorp', ...
  status      TEXT,                           -- 'Sourcing Allowed' | 'Sourcing Allowed - Prime'
  is_prime    BOOLEAN DEFAULT FALSE,          -- convenience flag for Prime pincodes
  state       TEXT,
  city        TEXT,
  region      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Required by the loader's upsert and by validatePincode()'s .single() lookup
CREATE UNIQUE INDEX IF NOT EXISTS serviceable_pincodes_pincode_lender_uidx
  ON public.serviceable_pincodes (pincode, lender_type);
CREATE INDEX IF NOT EXISTS serviceable_pincodes_lender_type_idx
  ON public.serviceable_pincodes (lender_type);
CREATE INDEX IF NOT EXISTS serviceable_pincodes_state_idx
  ON public.serviceable_pincodes (state);

-- ==================== Gating Logs ====================

CREATE TABLE IF NOT EXISTS public.gating_logs (
  id            BIGSERIAL PRIMARY KEY,
  phone         TEXT NOT NULL,
  lender_type   TEXT NOT NULL,
  eligible      BOOLEAN DEFAULT FALSE,
  checks_passed JSONB DEFAULT '{}'::jsonb,
  hard_rejects  TEXT[] DEFAULT '{}',
  soft_rejects  TEXT[] DEFAULT '{}',
  logged_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gating_logs_phone_idx       ON public.gating_logs (phone);
CREATE INDEX IF NOT EXISTS gating_logs_lender_type_idx ON public.gating_logs (lender_type);
CREATE INDEX IF NOT EXISTS gating_logs_logged_at_idx   ON public.gating_logs (logged_at);

-- Service-role clients (the IVR router) bypass RLS; no anon policies are granted.
ALTER TABLE public.serviceable_pincodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gating_logs          ENABLE ROW LEVEL SECURITY;
