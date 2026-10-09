-- 004_payday_servicing_guards.sql
-- Constraints and views the payday LMS relies on. Run after 003. DRAFT: review before applying.
--
-- Invariants enforced in the database, not just in application code:
--   * one open loan per customer (an undisbursed loan row counts as open)
--   * a payment UTR or payout UTR can only be recorded once
--   * one agreement per application
--   * a vendor webhook event is processed once

-- One open loan per customer. 'active' and 'overdue' are the open statuses.
create unique index if not exists loan_one_open_per_customer
  on payday.loan (customer_id) where status in ('active','overdue');

create unique index if not exists payment_utr_unique
  on payday.payment (utr) where utr is not null;

create unique index if not exists agreement_one_per_application
  on payday.agreement (application_id);
-- The e-sign vendor's own envelope/document id, for support and reconciliation.
alter table payday.agreement add column if not exists provider_ref text;

-- Payout idempotency: the key sent to the payout vendor, so a retry cannot pay twice.
alter table payday.disbursement add column if not exists idempotency_key text;
create unique index if not exists disbursement_idempotency_unique
  on payday.disbursement (idempotency_key) where idempotency_key is not null;
create unique index if not exists disbursement_utr_unique
  on payday.disbursement (utr) where utr is not null;

-- Inbound vendor webhooks (e-sign status, payout result, payment received). Deduplicated per provider.
create table if not exists payday.vendor_event (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  event_id      text not null,
  event_type    text,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  unique (provider, event_id)
);
alter table payday.vendor_event enable row level security;

-- Own-book funding when a product has no co-lender arrangement.
insert into payday.lender (name, lender_type) values ('OWN_BOOK', 'own_book')
  on conflict (name) do nothing;

-- Ledger balance per loan: debits (disbursal, fee, penalty) minus credits (repayment, write-off).
create or replace view payday.loan_ledger_balance with (security_invoker = true) as
select loan_id,
       sum(case when direction = 'debit' then amount else -amount end) as balance
from payday.ledger_entry
group by loan_id;

-- What each open loan still owes, from the repayment schedule.
create or replace view payday.loan_outstanding with (security_invoker = true) as
select l.id as loan_id, l.customer_id, l.status, l.due_date, l.principal,
       coalesce(sum(s.principal_due), 0) as principal_due,
       coalesce(sum(s.fee_due), 0)       as fee_due,
       coalesce(sum(s.penalty_due), 0)   as penalty_due,
       coalesce(sum(s.paid_amount), 0)   as paid_amount,
       coalesce(sum(s.principal_due + s.fee_due + s.penalty_due - s.paid_amount), 0) as outstanding,
       greatest(current_date - l.due_date, 0) as days_overdue
from payday.loan l
left join payday.repayment_schedule s on s.loan_id = l.id
group by l.id;

-- Collections aging for the dashboard.
create or replace view payday.collections_aging with (security_invoker = true) as
select case
         when days_overdue = 0   then '0 current'
         when days_overdue <= 7  then '1-7'
         when days_overdue <= 30 then '8-30'
         when days_overdue <= 60 then '31-60'
         when days_overdue <= 90 then '61-90'
         else '90+'
       end as bucket,
       count(*) as loans,
       sum(outstanding) as outstanding
from payday.loan_outstanding
where status in ('active','overdue') and outstanding > 0
group by 1;
