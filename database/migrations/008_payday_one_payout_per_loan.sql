-- 008_payday_one_payout_per_loan.sql
-- A loan is paid out once. The API refuses a new payout attempt while an earlier one is pending or successful,
-- and this index is the backstop: a second SUCCESSFUL disbursement for the same loan cannot be recorded, so a
-- double payout shows up as an error to be refunded instead of a second ledger entry.
-- Run after 007. Before running, check there is nothing to violate it:
--   select loan_id, count(*) from payday.disbursement where status = 'success' group by 1 having count(*) > 1;
create unique index if not exists disbursement_one_success_per_loan
  on payday.disbursement (loan_id) where status = 'success';
