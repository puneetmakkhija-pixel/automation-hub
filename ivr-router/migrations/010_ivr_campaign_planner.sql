-- 010 — IVR campaign planner: upload a base + recording from the panel, then
-- dial it in hourly batches inside a calling window, behind an approval.
--
-- Apply to the CRM project (ymdkcaedwnnhszhzirli). Additive only: three new
-- tables and four functions in crm. Touches no existing object.
--
-- Flow
--   draft            plan created from the panel (settings only)
--     + contacts     crm.ivr_plan_add_contacts, chunked; suppression applied here
--     + recording    prompt_id written by the API after the OBD upload
--   pending_approval submitted from the panel
--   approved         owner approves (separate approver secret) -> hourly tick may dial
--   running          at least one batch composed
--   paused           by the owner, or automatically after 3 failed batches in a row
--   completed        no undialled contact left
--   cancelled        by the owner; undialled contacts are never called
--
-- Every batch is one row in crm.ivr_plan_batch with unique (plan_id, hour_key),
-- so a cron that fires twice in the same hour cannot dial a plan twice.

create table if not exists crm.ivr_plan (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  lender           text,                       -- optional: enables lender send-blocks + the 90-day ledger
  variant          text not null default 'businessloans',  -- press-1 webhook variant
  prompt_id        text,
  prompt_name      text,
  recording_source text check (recording_source in ('upload','existing','tts')),
  dtmf             text not null default '1',
  webhook_id       text,
  batch_size       int  not null default 500 check (batch_size between 1 and 20000),
  window_start     time not null default '10:00',
  window_end       time not null default '19:00',
  days_of_week     int[] not null default '{1,2,3,4,5,6}',   -- ISO: 1 = Monday … 7 = Sunday
  start_date       date not null default ((now() at time zone 'Asia/Kolkata')::date),
  end_date         date,
  status           text not null default 'draft'
                   check (status in ('draft','pending_approval','approved','running','paused','completed','cancelled')),
  pause_reason     text,
  total_contacts   int not null default 0,
  suppressed       int not null default 0,
  duplicates       int not null default 0,
  invalid          int not null default 0,
  consecutive_failures int not null default 0,
  created_by       text,
  approved_by      text,
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (window_start < window_end)
);

create table if not exists crm.ivr_plan_contact (
  plan_id       uuid not null references crm.ivr_plan(id) on delete cascade,
  mobile10      text not null check (mobile10 ~ '^[6-9][0-9]{9}$'),
  customer_name text,
  batch_id      uuid,
  dispatched_at timestamptz,
  primary key (plan_id, mobile10)
);
create index if not exists ivr_plan_contact_pending on crm.ivr_plan_contact (plan_id) where batch_id is null;

create table if not exists crm.ivr_plan_batch (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references crm.ivr_plan(id) on delete cascade,
  batch_no        int  not null,
  hour_key        text not null,                 -- 'YYYY-MM-DDTHH' IST; one batch per plan per hour
  size            int  not null default 0,
  obd_base_id     text,
  obd_campaign_id text,
  status          text not null default 'claimed'
                  check (status in ('claimed','composed','failed','prepared_only','empty','test')),
  error           text,
  steps           jsonb,
  created_at      timestamptz not null default now(),
  unique (plan_id, hour_key)
);

alter table crm.ivr_plan        enable row level security;
alter table crm.ivr_plan_contact enable row level security;
alter table crm.ivr_plan_batch  enable row level security;

-- Add a chunk of uploaded rows. p_rows = [{"mobile": "...", "name": "..."}].
-- Normalises to ten digits, drops invalid, de-duplicates within the plan, and
-- refuses anyone on crm.contact_suppression (unreleased) or — when the plan
-- names a lender — anyone that lender's send-block says not to contact.
create or replace function crm.ivr_plan_add_contacts(p_plan uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path to 'crm','public'
set statement_timeout to '120s' as $$
declare
  v_lender text; v_status text;
  v_total int; v_invalid int; v_dupe int; v_supp int; v_ins int;
begin
  select lender, status into v_lender, v_status from crm.ivr_plan where id = p_plan for update;
  if not found then raise exception 'plan % not found', p_plan; end if;
  if v_status <> 'draft' then raise exception 'contacts can only be added to a draft plan (this one is %)', v_status; end if;

  create temp table _in on commit drop as
  select right(regexp_replace(coalesce(r->>'mobile',''), '\D', '', 'g'), 10) as m,
         nullif(left(btrim(coalesce(r->>'name','')), 120), '') as n
    from jsonb_array_elements(coalesce(p_rows,'[]'::jsonb)) r;

  select count(*) into v_total from _in;
  select count(*) into v_invalid from _in where m !~ '^[6-9][0-9]{9}$';
  delete from _in where m !~ '^[6-9][0-9]{9}$';

  create temp table _uniq on commit drop as select distinct on (m) m, n from _in order by m, n nulls last;
  v_dupe := (select count(*) from _in) - (select count(*) from _uniq);

  delete from _uniq u where exists (select 1 from crm.ivr_plan_contact c where c.plan_id = p_plan and c.mobile10 = u.m);
  get diagnostics v_ins = row_count; v_dupe := v_dupe + v_ins;

  delete from _uniq u
   where exists (select 1 from crm.contact_suppression s where s.phone = u.m and s.released_at is null)
      or (v_lender is not null and crm.lender_campaign_send_blocked(v_lender, u.m));
  get diagnostics v_supp = row_count;

  insert into crm.ivr_plan_contact (plan_id, mobile10, customer_name) select p_plan, m, n from _uniq;
  get diagnostics v_ins = row_count;

  update crm.ivr_plan
     set total_contacts = total_contacts + v_ins, suppressed = suppressed + v_supp,
         duplicates = duplicates + v_dupe, invalid = invalid + v_invalid, updated_at = now()
   where id = p_plan;

  return jsonb_build_object('received', v_total, 'added', v_ins, 'suppressed', v_supp,
                            'duplicates', v_dupe, 'invalid', v_invalid);
end $$;

-- Claim the next p_limit undialled contacts for a batch. Suppression is checked
-- AGAIN here, because the list may have grown since upload (a STOP reply, a new
-- lender MIS row). Skip-locked so two overlapping ticks never share a person.
create or replace function crm.ivr_plan_claim(p_plan uuid, p_batch uuid, p_limit int)
returns jsonb language plpgsql security definer set search_path to 'crm','public'
set statement_timeout to '120s' as $$
declare v_lender text; v_out jsonb;
begin
  select lender into v_lender from crm.ivr_plan where id = p_plan;
  with pick as (
    select c.mobile10
      from crm.ivr_plan_contact c
     where c.plan_id = p_plan and c.batch_id is null
       and not exists (select 1 from crm.contact_suppression s where s.phone = c.mobile10 and s.released_at is null)
       and (v_lender is null or not exists (
             select 1 from crm.lender_campaign_dispatched x
              where x.lender = v_lender and x.mobile10 = c.mobile10 and x.dispatched_at > now() - interval '90 days'))
     order by c.mobile10
     limit greatest(coalesce(p_limit,0),0)
     for update skip locked
  ), upd as (
    update crm.ivr_plan_contact c set batch_id = p_batch
      from pick where c.plan_id = p_plan and c.mobile10 = pick.mobile10
    returning c.mobile10, c.customer_name
  )
  select coalesce(jsonb_agg(jsonb_build_object('mobile10', mobile10, 'customer_name', customer_name)), '[]'::jsonb)
    into v_out from upd;
  return v_out;
end $$;

-- A batch that failed to compose gives its people back, so the next hour can
-- try them. Nobody is marked dialled for a call that never went out.
create or replace function crm.ivr_plan_release(p_batch uuid)
returns int language sql security definer set search_path to 'crm' as $$
  with r as (update crm.ivr_plan_contact set batch_id = null, dispatched_at = null
              where batch_id = p_batch returning 1)
  select count(*)::int from r;
$$;

create or replace function crm.ivr_plan_mark_dispatched(p_batch uuid)
returns int language sql security definer set search_path to 'crm' as $$
  with r as (update crm.ivr_plan_contact set dispatched_at = now()
              where batch_id = p_batch returning 1)
  select count(*)::int from r;
$$;

-- Progress for the panel, one row per plan.
create or replace view crm.v_ivr_plan_progress as
select p.*,
       (select count(*) from crm.ivr_plan_contact c where c.plan_id = p.id and c.dispatched_at is not null) as dialled,
       (select count(*) from crm.ivr_plan_contact c where c.plan_id = p.id and c.batch_id is null)          as remaining,
       (select count(*) from crm.ivr_plan_batch b where b.plan_id = p.id and b.status = 'composed')          as batches_ok,
       (select count(*) from crm.ivr_plan_batch b where b.plan_id = p.id and b.status = 'failed')            as batches_failed,
       (select max(created_at) from crm.ivr_plan_batch b where b.plan_id = p.id)                             as last_batch_at
  from crm.ivr_plan p;

revoke all on function crm.ivr_plan_add_contacts(uuid, jsonb), crm.ivr_plan_claim(uuid, uuid, int),
  crm.ivr_plan_release(uuid), crm.ivr_plan_mark_dispatched(uuid) from public, anon, authenticated;
