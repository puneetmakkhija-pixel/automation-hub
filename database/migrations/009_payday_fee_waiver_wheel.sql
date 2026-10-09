-- 009_payday_fee_waiver_wheel.sql
-- Loyalty reward: customers who have repaid 3 or more loans earn spins of a wheel; each spin is a waiver of 10 to 50
-- percent of the fee on their next loan. DRAFT: not applied to any database yet. Run after 003-008.
create table if not exists payday.customer_reward (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references payday.customer(id) on delete cascade,
  kind           text not null default 'fee_waiver' check (kind in ('fee_waiver')),
  waiver_pct     integer not null check (waiver_pct between 10 and 50),
  slice          integer not null check (slice between 0 and 9),   -- which of the ten wheel slices came up
  spin_no        integer not null check (spin_no >= 1),
  expires_at     timestamptz not null,
  used_at        timestamptz,                                     -- set when the money is paid out
  application_id uuid references payday.application(id),          -- the application the waiver was applied to
  created_at     timestamptz not null default now(),
  unique (customer_id, spin_no)                                    -- two simultaneous spins cannot both take the same number
);
create index if not exists customer_reward_usable_idx on payday.customer_reward (customer_id, expires_at) where used_at is null;

alter table payday.application add column if not exists fee_waiver_pct numeric(5,2) not null default 0
  check (fee_waiver_pct >= 0 and fee_waiver_pct <= 50);

alter table payday.customer_reward enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on payday.customer_reward to service_role;
  end if;
end $$;
