-- 013 — IVR planner: build a plan's audience from a base already in Supabase
-- (crm.lender_campaign_base) instead of a file. Additive: two functions, no table change.
--
-- ivr_audiences()        -> [{key,label,count}] the panel shows in its "From Supabase" tab.
-- ivr_plan_add_from_base -> a RANDOM sample of p_limit people from one audience into a DRAFT plan.
--   Skips anyone already in the plan, anyone on crm.contact_suppression (unreleased), and — when the
--   plan names a lender — anyone that lender's send-block refuses. Random (not sorted) so a batch is
--   not one narrow number series. The regex has no "$" anchor on purpose: the Supabase SQL tool hangs
--   on the "$'" sequence inside a function body, so the 10-digit check is length() instead.

create or replace function crm.ivr_audiences()
returns jsonb language sql security definer set search_path to 'crm' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', lender, 'label', lender, 'count', n) order by n desc), '[]'::jsonb)
    from (select lender, count(*) n from crm.lender_campaign_base group by lender) t;
$$;

create or replace function crm.ivr_plan_add_from_base(p_plan uuid, p_audience text, p_limit int, p_min_score numeric default null)
returns jsonb language plpgsql security definer set search_path to 'crm','public'
set statement_timeout to '120s' as $$
declare
  v_lender text; v_status text; v_lim int; v_picked int; v_kept int;
begin
  select lender, status into v_lender, v_status from crm.ivr_plan where id = p_plan for update;
  if not found then raise exception 'plan % not found', p_plan; end if;
  if v_status <> 'draft' then raise exception 'people can only be added to a draft plan (this one is %)', v_status; end if;
  v_lim := least(greatest(coalesce(p_limit, 0), 0), 100000);
  if v_lim = 0 then raise exception 'limit must be at least 1'; end if;

  create temp table _pick on commit drop as
  select b.mobile10 as m
    from crm.lender_campaign_base b
   where b.lender = p_audience
     and length(b.mobile10) = 10 and b.mobile10 ~ '^[6-9][0-9]{9}'
     and (p_min_score is null or b.best_score >= p_min_score)
     and not exists (select 1 from crm.ivr_plan_contact c where c.plan_id = p_plan and c.mobile10 = b.mobile10)
     and not exists (select 1 from crm.contact_suppression s where s.phone = b.mobile10 and s.released_at is null)
   order by random()
   limit v_lim;
  select count(*) into v_picked from _pick;

  create temp table _keep on commit drop as
  select m from _pick where v_lender is null or not crm.lender_campaign_send_blocked(v_lender, m);

  insert into crm.ivr_plan_contact (plan_id, mobile10) select p_plan, m from _keep;
  get diagnostics v_kept = row_count;

  update crm.ivr_plan
     set total_contacts = total_contacts + v_kept, suppressed = suppressed + (v_picked - v_kept), updated_at = now()
   where id = p_plan;

  return jsonb_build_object('received', v_picked, 'added', v_kept, 'suppressed', v_picked - v_kept, 'duplicates', 0, 'invalid', 0);
end $$;

revoke all on function crm.ivr_audiences(), crm.ivr_plan_add_from_base(uuid, text, int, numeric) from public, anon, authenticated;
