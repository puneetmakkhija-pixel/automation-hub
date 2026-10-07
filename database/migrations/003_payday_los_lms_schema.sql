-- 003_payday_los_lms_schema.sql
-- Payday-loan LOS + LMS data model (step 1: schema only).
-- Lives in its own `payday` schema so it cannot collide with existing IVR tables.
-- DRAFT: review before applying to any Supabase project.
--
-- Journey covered:
--   customer -> kyc_check -> enrichment_report -> application -> scorecard_result
--   -> agreement -> loan (+ loan_lender_share for co-lending) -> disbursement
--   -> repayment_schedule / payment / ledger_entry -> customer_limit (repeat loans)

create schema if not exists payday;

-- ---------------------------------------------------------------- enums
do $$ begin
  create type payday.kyc_status as enum ('pending','in_progress','verified','failed');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type payday.application_status as enum
    ('draft','kyc_pending','enrichment','scored','offered','agreement_sent','signed',
     'approved','rejected','disbursed','cancelled','expired');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type payday.loan_status as enum
    ('active','closed','overdue','rolled_over','written_off');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type payday.fee_type as enum ('flat','percent_of_principal');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type payday.enrichment_source as enum
    ('bureau','bank_statement','gst','account_aggregator','employer','other');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type payday.payment_status as enum ('pending','success','failed','reversed');
  exception when duplicate_object then null; end $$;
do $$ begin
  create type payday.ledger_direction as enum ('debit','credit');
  exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- helpers
create or replace function payday.set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------- customer
create table if not exists payday.customer (
  id              uuid primary key default gen_random_uuid(),
  mobile          text not null unique,            -- E.164 / 10-digit, normalised by app
  full_name       text,
  dob             date,
  pan_hash        text,                            -- sha256(pan + pepper); never store raw PAN
  pan_last4       text,
  employer_name   text,
  monthly_salary  numeric(12,2),
  salary_day      smallint check (salary_day between 1 and 31),
  kyc_status      payday.kyc_status not null default 'pending',
  source          text,                            -- dsa / ivr / whatsapp / organic
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists customer_kyc_status_idx on payday.customer (kyc_status);

-- ---------------------------------------------------------------- kyc + enrichment
create table if not exists payday.kyc_check (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references payday.customer(id) on delete cascade,
  check_type   text not null,                      -- aadhaar_otp / pan / selfie / liveness / bank_penny_drop
  provider     text not null,                      -- vendor name (adapter slot)
  status       payday.kyc_status not null default 'pending',
  provider_ref text,
  response     jsonb,                              -- raw vendor payload, PII-minimised by the adapter
  checked_at   timestamptz not null default now()
);
create index if not exists kyc_check_customer_idx on payday.kyc_check (customer_id, check_type);

create table if not exists payday.enrichment_report (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references payday.customer(id) on delete cascade,
  source       payday.enrichment_source not null,
  provider     text not null,
  payload      jsonb not null,
  fetched_at   timestamptz not null default now(),
  expires_at   timestamptz                          -- re-pull after this (e.g. bureau 30d)
);
create index if not exists enrichment_customer_idx on payday.enrichment_report (customer_id, source, fetched_at desc);

-- ---------------------------------------------------------------- products + lenders
create table if not exists payday.loan_product (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,       -- e.g. PAYDAY_30
  name                  text not null,
  min_amount            numeric(12,2) not null,
  max_amount            numeric(12,2) not null,
  tenure_days           integer not null check (tenure_days > 0),
  fee_type              payday.fee_type not null,
  fee_value             numeric(10,4) not null,     -- flat INR or percent, per fee_type
  penalty_per_day_pct   numeric(6,4) not null default 0,
  rollover_allowed      boolean not null default false,
  max_rollovers         smallint not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (max_amount >= min_amount)
);

create table if not exists payday.lender (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  lender_type text not null default 'nbfc',         -- nbfc / bank / own_book
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Co-lending split per product: who funds how much.
create table if not exists payday.colending_arrangement (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references payday.loan_product(id),
  lender_id      uuid not null references payday.lender(id),
  share_pct      numeric(5,2) not null check (share_pct > 0 and share_pct <= 100),
  effective_from date not null default current_date,
  effective_to   date,
  unique (product_id, lender_id, effective_from)
);

-- ---------------------------------------------------------------- application + decision
create table if not exists payday.application (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references payday.customer(id),
  product_id       uuid not null references payday.loan_product(id),
  requested_amount numeric(12,2) not null check (requested_amount > 0),
  approved_amount  numeric(12,2),
  status           payday.application_status not null default 'draft',
  is_repeat        boolean not null default false,
  decision_reasons jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists application_customer_idx on payday.application (customer_id, created_at desc);
create index if not exists application_status_idx on payday.application (status);

create table if not exists payday.scorecard_result (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references payday.application(id) on delete cascade,
  model_version  text not null,
  total_points   numeric(8,2) not null,
  grade          text not null,                      -- A..E
  decision       text not null check (decision in ('approve','reject','refer')),
  parameters     jsonb not null,                     -- per-parameter value + points, for audit
  scored_at      timestamptz not null default now()
);
create index if not exists scorecard_application_idx on payday.scorecard_result (application_id, scored_at desc);

-- ---------------------------------------------------------------- agreement
create table if not exists payday.agreement (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references payday.application(id) on delete cascade,
  kfs_url        text,                               -- key fact statement
  document_url   text,
  esign_provider text,
  esign_status   text not null default 'pending',    -- pending / sent / signed / failed
  signed_at      timestamptz,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- loan (LMS core)
create table if not exists payday.loan (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references payday.application(id),
  customer_id    uuid not null references payday.customer(id),
  product_id     uuid not null references payday.loan_product(id),
  cycle_number   integer not null default 1,         -- 1 = first loan, 2+ = repeat
  principal      numeric(12,2) not null check (principal > 0),
  fee_amount     numeric(12,2) not null default 0,
  disbursed_at   timestamptz,
  due_date       date not null,
  rollover_count smallint not null default 0,
  status         payday.loan_status not null default 'active',
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists loan_customer_idx on payday.loan (customer_id, cycle_number desc);
create index if not exists loan_due_idx on payday.loan (due_date) where status in ('active','overdue');

create table if not exists payday.loan_lender_share (
  loan_id         uuid not null references payday.loan(id) on delete cascade,
  lender_id       uuid not null references payday.lender(id),
  share_pct       numeric(5,2) not null check (share_pct > 0 and share_pct <= 100),
  principal_share numeric(12,2) not null,
  primary key (loan_id, lender_id)
);

create table if not exists payday.disbursement (
  id         uuid primary key default gen_random_uuid(),
  loan_id    uuid not null references payday.loan(id),
  lender_id  uuid references payday.lender(id),      -- null = own book
  amount     numeric(12,2) not null check (amount > 0),
  provider   text,
  utr        text,
  status     payday.payment_status not null default 'pending',
  created_at timestamptz not null default now()
);
create index if not exists disbursement_loan_idx on payday.disbursement (loan_id);

create table if not exists payday.repayment_schedule (
  id            uuid primary key default gen_random_uuid(),
  loan_id       uuid not null references payday.loan(id) on delete cascade,
  installment_no smallint not null default 1,        -- payday = single bullet row
  due_date      date not null,
  principal_due numeric(12,2) not null,
  fee_due       numeric(12,2) not null default 0,
  penalty_due   numeric(12,2) not null default 0,
  paid_amount   numeric(12,2) not null default 0,
  status        text not null default 'due',         -- due / part_paid / paid / overdue
  unique (loan_id, installment_no)
);

create table if not exists payday.payment (
  id        uuid primary key default gen_random_uuid(),
  loan_id   uuid not null references payday.loan(id),
  amount    numeric(12,2) not null check (amount > 0),
  mode      text not null,                           -- upi / enach / netbanking / card / cash
  utr       text,
  status    payday.payment_status not null default 'pending',
  paid_at   timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists payment_loan_idx on payday.payment (loan_id);

-- Append-only ledger: every money movement is a row; balances are derived.
create table if not exists payday.ledger_entry (
  id          bigint generated always as identity primary key,
  loan_id     uuid not null references payday.loan(id),
  lender_id   uuid references payday.lender(id),
  entry_type  text not null,                         -- disbursal / fee / penalty / repayment / writeoff / lender_settlement
  direction   payday.ledger_direction not null,
  amount      numeric(12,2) not null check (amount > 0),
  ref_table   text,
  ref_id      uuid,
  created_at  timestamptz not null default now()
);
create index if not exists ledger_loan_idx on payday.ledger_entry (loan_id, created_at);

-- ---------------------------------------------------------------- repeat loans
create table if not exists payday.customer_limit (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references payday.customer(id) on delete cascade,
  limit_amount   numeric(12,2) not null,
  cycle_number   integer not null,                   -- the cycle this limit applies to
  reason         text,                               -- first_loan / on_time_repay / manual / reduced_after_dpd
  effective_from timestamptz not null default now(),
  created_by     text
);
create index if not exists customer_limit_idx on payday.customer_limit (customer_id, effective_from desc);

-- ---------------------------------------------------------------- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['customer','loan_product','application','loan'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on payday.%1$s', t);
    execute format('create trigger trg_%1$s_updated_at before update on payday.%1$s
                    for each row execute function payday.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- security
-- Deny by default: RLS on, no policies. Only the service role (which bypasses RLS)
-- can read or write. Add explicit policies later for any client-facing access.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'payday' loop
    execute format('alter table payday.%I enable row level security', r.tablename);
  end loop;
end $$;

comment on schema payday is 'Payday-loan LOS+LMS. Contains PII: mobile, PAN (hashed), salary. Service-role access only.';
