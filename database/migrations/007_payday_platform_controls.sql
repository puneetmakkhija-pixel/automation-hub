-- 007_payday_platform_controls.sql
-- Controls the product brief asks for, in the database where they cannot be skipped by a bug in a service:
--   * API clients with roles (admin / ops / partner) instead of one shared key
--   * partners, and an outbox of callbacks to them
--   * an append-only audit log
--   * consent records
--   * versioned credit policies the credit team can change without a developer
--   * APR columns for the key fact statement
-- Run after 003-006. DRAFT: not applied to any database yet.

-- ---------------------------------------------------------------- partners and API clients
create table if not exists payday.partner (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null unique,
  active              boolean not null default true,
  callback_url        text,                      -- https only; validated by the API
  callback_secret_env text,                      -- NAME of the env var holding the signing secret; the secret is never stored here
  created_at          timestamptz not null default now()
);

create table if not exists payday.api_client (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  role         text not null check (role in ('admin', 'ops', 'partner')),
  partner_id   uuid references payday.partner(id),
  key_hash     text not null unique,             -- sha256 of the key; the key itself is shown once at creation and never stored
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  check ((role = 'partner') = (partner_id is not null))   -- a partner key names its partner; no other role does
);

alter table payday.application add column if not exists partner_id uuid references payday.partner(id);
alter table payday.application add column if not exists offered_apr_pct numeric(10,2);
alter table payday.loan add column if not exists apr_pct numeric(10,2);
create index if not exists application_partner_idx on payday.application (partner_id) where partner_id is not null;

-- ---------------------------------------------------------------- audit log (append only)
create table if not exists payday.audit_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  actor_client_id uuid,                          -- null for the bootstrap key and system jobs
  actor_name      text not null,
  actor_role      text not null,
  action          text not null,
  entity_type     text,
  entity_id       text,
  details         jsonb
);
create index if not exists audit_log_entity_idx on payday.audit_log (entity_type, entity_id, at);
create index if not exists audit_log_actor_idx on payday.audit_log (actor_name, at);

create or replace function payday.audit_log_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'payday.audit_log is append-only'; end $$;
create or replace trigger audit_log_no_change before update or delete on payday.audit_log
  for each row execute function payday.audit_log_immutable();
create or replace trigger audit_log_no_truncate before truncate on payday.audit_log
  for each statement execute function payday.audit_log_immutable();

-- ---------------------------------------------------------------- consent
create table if not exists payday.consent (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references payday.customer(id) on delete cascade,
  purpose      text not null check (purpose in ('kyc', 'credit_bureau', 'bank_data', 'terms', 'communication', 'data_sharing')),
  text_version text not null,                    -- which wording the customer agreed to
  channel      text not null,                    -- app / web / partner / ivr / whatsapp
  evidence     jsonb,                            -- ip, device, otp reference, partner-supplied timestamp
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz
);
create index if not exists consent_customer_idx on payday.consent (customer_id, purpose, granted_at desc);

-- ---------------------------------------------------------------- credit policies (versioned, frozen once active)
create table if not exists payday.credit_policy (
  id           uuid primary key default gen_random_uuid(),
  version      text not null unique,             -- scorecard_result.model_version points at exactly one row
  status       text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  config       jsonb not null,
  note         text,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  activated_by text,
  activated_at timestamptz
);
create unique index if not exists credit_policy_one_active on payday.credit_policy ((true)) where status = 'active';

create or replace function payday.credit_policy_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'only a draft credit policy can be deleted'; end if;
    return old;
  end if;
  if old.status in ('active', 'retired') and new.config is distinct from old.config then
    raise exception 'an activated credit policy cannot be edited: create a new version';
  end if;
  if old.version <> new.version and old.status <> 'draft' then
    raise exception 'an activated credit policy cannot be renamed';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'a retired credit policy cannot be reactivated: create a new version';
  end if;
  return new;
end $$;
create or replace trigger credit_policy_guard_trg before update or delete on payday.credit_policy
  for each row execute function payday.credit_policy_guard();

-- Activation is one atomic step: retire the current version and activate the draft, or neither.
create or replace function payday.activate_credit_policy(p_id uuid, p_by text) returns payday.credit_policy
language plpgsql set search_path = '' as $$
declare r payday.credit_policy;
begin
  perform 1 from payday.credit_policy where id = p_id and status = 'draft';
  if not found then raise exception 'only a draft credit policy can be activated'; end if;
  update payday.credit_policy set status = 'retired' where status = 'active';
  update payday.credit_policy set status = 'active', activated_by = p_by, activated_at = now()
    where id = p_id returning * into r;
  return r;
end $$;
revoke all on function payday.activate_credit_policy(uuid, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function payday.activate_credit_policy(uuid, text) to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------- partner callback outbox
create table if not exists payday.partner_event (
  id              uuid primary key default gen_random_uuid(),
  partner_id      uuid not null references payday.partner(id),
  event_id        text not null,
  event_type      text not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (partner_id, event_id)
);
create index if not exists partner_event_due_idx on payday.partner_event (next_attempt_at) where status = 'pending';

-- ---------------------------------------------------------------- security (same rule as 003)
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'payday' loop
    execute format('alter table payday.%I enable row level security', r.tablename);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on all tables in schema payday to service_role;
    grant all on all sequences in schema payday to service_role;
  end if;
end $$;
