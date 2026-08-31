-- Migration: Create Lenders Table
-- Date: 2025-08-29
-- Purpose: Create foundational lenders table for IVR campaign routing

-- Create lenders table
CREATE TABLE IF NOT EXISTS public.lenders (
  id SERIAL PRIMARY KEY,
  lender_id VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  webhook_url VARCHAR(500),
  status VARCHAR(50) DEFAULT 'active', -- 'active', 'inactive', 'paused'
  min_loan INTEGER DEFAULT 10000,
  max_loan INTEGER DEFAULT 1000000,
  logo_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create index on lender_id
CREATE INDEX IF NOT EXISTS idx_lenders_id ON public.lenders(lender_id);
CREATE INDEX IF NOT EXISTS idx_lenders_status ON public.lenders(status);

-- Enable RLS
ALTER TABLE public.lenders ENABLE ROW LEVEL SECURITY;

-- Allow service role to read/write
DROP POLICY IF EXISTS "Allow service role" ON public.lenders;
CREATE POLICY "Allow service role" ON public.lenders
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Insert default lenders (including FlexiLoans)
INSERT INTO public.lenders (lender_id, name, description, webhook_url, status, min_loan, max_loan)
VALUES
  ('poonawala', 'Poonawala Finance', 'Quick personal loans for salaried professionals', 'https://api.poonawalafinance.com/webhook', 'active', 50000, 5000000),
  ('hero_fincorp', 'Hero FinCorp', 'Finance solutions for working professionals', 'https://api.herofincorp.com/webhook', 'active', 100000, 2500000),
  ('hdfc_bank', 'HDFC Bank - Jumbo', 'Jumbo personal loans from HDFC Bank', 'https://api.hdfcbank.com/webhook', 'active', 500000, 10000000),
  ('bajaj_finserv', 'Bajaj Finserv', 'Consumer finance and personal loans', 'https://api.bajajfinserv.com/webhook', 'active', 50000, 3000000),
  ('flexiloans', 'FlexiLoans', 'Quick document collection for flexible loans', 'https://api.flexiloans.com/webhook', 'active', 50000, 5000000)
ON CONFLICT (lender_id) DO UPDATE SET updated_at = now();

COMMIT;
