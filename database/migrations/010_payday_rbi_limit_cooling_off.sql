-- 010_payday_rbi_limit_cooling_off.sql
-- RBI (Digital Lending) Directions, 2025. DRAFT: not applied to any database yet. Run after 003-009.
--  1. A credit limit must not rise unless the borrower asks. customer_limit.limit_amount stays the limit OFFERED;
--     eligible_amount holds what the repayment ladder says the customer qualifies for (null = same as limit_amount).
--  2. Cooling-off: the borrower may exit by repaying the principal and the fee for the days held. The product sets the
--     length (at least 1 day); a loan records when the borrower asked to exit.
-- Additive only. Apply BEFORE deploying the code that reads these columns.
alter table payday.customer_limit add column if not exists eligible_amount numeric(12,2)
  check (eligible_amount is null or eligible_amount >= 0);
alter table payday.loan add column if not exists cooling_off_exit_at timestamptz;
alter table payday.loan_product add column if not exists cooling_off_days smallint not null default 1
  check (cooling_off_days >= 1);
