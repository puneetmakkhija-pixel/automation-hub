-- 011_payday_idempotency_keys.sql
-- Idempotency keys for partner POST calls. Applied to the smecircle Supabase project (ymdkcaedwnnhszhzirli) on 2026-10-16 as migration
-- "payday_idempotency_keys". Run after 003-010. Safe to re-run: every statement is idempotent.
-- A partner may send an Idempotency-Key header on calls that create something (an application, a payment link, a limit
-- increase). The first call claims the key and its answer is stored; a retry with the same key and the same request gets
-- the stored answer instead of doing the work twice. The same key with a different request is refused.
-- Additive only. Apply BEFORE deploying the code that reads this table.
create table if not exists payday.idempotency_key (
  id              uuid primary key default gen_random_uuid(),
  client_key      text not null,                    -- which API client sent it (client id, or 'bootstrap')
  idem_key        text not null check (length(idem_key) between 8 and 128),
  request_hash    text not null,                    -- sha256 of method, path and body
  status          text not null default 'in_progress' check (status in ('in_progress', 'done')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  unique (client_key, idem_key)
);
create index if not exists idempotency_key_age_idx on payday.idempotency_key (created_at);
alter table payday.idempotency_key enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on payday.idempotency_key to service_role;
  end if;
end $$;
