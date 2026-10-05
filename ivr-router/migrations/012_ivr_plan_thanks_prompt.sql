-- Optional thank-you recording that plays after the customer presses the key. The dialler's DTMF campaign already has a thanksPId slot;
-- the planner never filled it. A plan without one behaves exactly as before.
-- Applied to production via apply_migration; this file is the record.
alter table crm.ivr_plan add column if not exists thanks_prompt_id text, add column if not exists thanks_prompt_name text;

create or replace view crm.v_ivr_plan_progress as
 SELECT id, name, lender, variant, prompt_id, prompt_name, recording_source, dtmf, webhook_id, batch_size, window_start, window_end,
    days_of_week, start_date, end_date, status, pause_reason, total_contacts, suppressed, duplicates, invalid, consecutive_failures,
    created_by, approved_by, approved_at, created_at, updated_at,
    ( SELECT count(*) FROM crm.ivr_plan_contact c WHERE c.plan_id = p.id AND c.dispatched_at IS NOT NULL) AS dialled,
    ( SELECT count(*) FROM crm.ivr_plan_contact c WHERE c.plan_id = p.id AND c.batch_id IS NULL) AS remaining,
    ( SELECT count(*) FROM crm.ivr_plan_batch b WHERE b.plan_id = p.id AND b.status = 'composed'::text) AS batches_ok,
    ( SELECT count(*) FROM crm.ivr_plan_batch b WHERE b.plan_id = p.id AND b.status = 'failed'::text) AS batches_failed,
    ( SELECT max(b.created_at) FROM crm.ivr_plan_batch b WHERE b.plan_id = p.id) AS last_batch_at,
    thanks_prompt_id, thanks_prompt_name
   FROM crm.ivr_plan p;
