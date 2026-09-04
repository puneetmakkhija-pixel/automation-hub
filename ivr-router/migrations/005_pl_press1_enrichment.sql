-- Enrich the personal-loan press-1 leads against the SE base.
--
-- WHAT THIS IS FOR
--
-- Poonawalla and Hero Fincorp press-1 leads never enter the CRM: the press
-- hands the customer to that lender's own journey, so public.whatsapp_messages
-- is the only record we hold. A row there is a mobile number and a campaign
-- name and nothing else — no name, no bureau, no GST, no pincode. Which means
-- nobody can answer "which of yesterday's 6,000 presses were worth calling
-- back", and every one of them is treated the same.
--
-- public.se_base in the Database project (ggpkzlxxhqlyfhdaczij) already holds
-- exactly that, keyed by mobile, for 4.08M people. It reaches this project as
-- the foreign table fed.se_base over postgres_fdw. This migration joins the two
-- and lands the result in public.pl_press1_enriched.
--
-- WHY THE JOIN IS BATCHED AND NOT WRITTEN AS A JOIN
--
--   select ... from press p join fed.se_base s on s.mobile = p.mobile
--
-- reads as the obvious way to do this and is the reason for the timeout. The
-- planner has no remote statistics for a local CTE, so it drags all 4.08M
-- remote rows across the FDW and joins here. Only a qual made of constants is
-- shipped, which is why pl_press1_enrich() feeds mobiles to fed.se_base in
-- literal batches:
--
--   Remote SQL: SELECT ... FROM public.se_base WHERE mobile = ANY ('{...}')
--
-- Keep that shape. A refactor back to a plain join is correct SQL that does not
-- finish.

-- ── the lender resolver, in one place ──────────────────────────────────────
--
-- Both public.pl_ivr_tracker() and the enrichment below need to answer "whose
-- press is this", and they were about to answer it with two copies of the same
-- CASE. This is that answer, and ivr-router/lib/plTracker.js lenderOfLink() is
-- its counterpart in the service — the two must be changed together.
--
-- The link is what the customer actually opened, so the link is what decides.
-- metadata->>'variant' is only the slug the IVR panel was pointed at, and the
-- two have already disagreed in live data.
CREATE OR REPLACE FUNCTION public.pl_press_lender(p_link text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  select case
    when coalesce(p_link,'') ilike '%poonawallafincorp%' then 'poonawalla'
    when coalesce(p_link,'') ilike '%herofincorp%'       then 'herofincorp'
    when coalesce(p_link,'') ilike '%crmbusinessloans%'  then 'businessloans'
    -- Poonawalla behind the Whistleloop affiliate shortener. The lender's own
    -- domain never appears in these links, so the offer id is the only thing
    -- that identifies them: on 03-04 Sep 2026, 3,740 presses (3,616 of them in
    -- one day) landed as 'unknown' and dropped out of Poonawalla's numbers
    -- entirely, reading as ~952 presses against an actual ~4,568.
    --
    -- Matched on offerid, not on the PFL_% campaign prefix: every one of those
    -- 3,740 rows carries offerid=1351 and offerid=1351 only, while the campaign
    -- name is typed by hand in the panel (one of the 3,740 is not named PFL at
    -- all). A NEW offer id for the same lender will read as 'unknown' rather
    -- than be guessed at — which is the failure that is visible, not silent.
    when coalesce(p_link,'') ilike '%whistleloop%'
     and coalesce(p_link,'') ilike '%offerid=1351%'      then 'poonawalla'
    else 'unknown'
  end;
$$;

COMMENT ON FUNCTION public.pl_press_lender(text) IS
  'Which lender a press-1 belongs to, read off the link the customer was sent. Mirrored by lenderOfLink() in ivr-router/lib/plTracker.js.';

-- ── the enriched sheet ─────────────────────────────────────────────────────
--
-- One row per press, keyed by the whatsapp_messages row it came from. Not one
-- row per mobile: the same person pressing on two days is two leads to two
-- campaigns, and collapsing them loses the second.
--
-- The se_base columns are a SNAPSHOT taken at enrichment time, not a live view.
-- se_base is rescored continuously, and a callback sheet that changes its own
-- numbers between the morning it is pulled and the afternoon it is worked is
-- worse than a stale one. Re-running the enrichment refreshes them, and
-- enriched_at says when.
CREATE TABLE IF NOT EXISTS public.pl_press1_enriched (
  press_id        BIGINT PRIMARY KEY,
  pressed_at      TIMESTAMPTZ NOT NULL,
  ist_day         DATE        NOT NULL,
  mobile          TEXT        NOT NULL,
  lender          TEXT        NOT NULL,
  campaign        TEXT,
  variant         TEXT,
  send_status     TEXT,
  delivery_status TEXT,
  template        TEXT,
  link            TEXT,
  message_id      TEXT,
  customer_id     TEXT,

  -- Did this mobile exist in se_base at all. Kept explicitly: a NULL cibil on a
  -- matched row means "we hold no bureau for them", on an unmatched row it
  -- means "we have never heard of this number", and those are different
  -- conversations with the person who has to call them.
  se_matched      BOOLEAN     NOT NULL DEFAULT false,

  se_name                 TEXT,
  pan                     TEXT,
  cibil                   INTEGER,
  overdue                 NUMERIC,
  max_dpd                 INTEGER,
  writeoff_settled        INTEGER,
  active_unsecured_loans  INTEGER,
  gstin                   TEXT,
  gst_status              TEXT,
  constitution            TEXT,
  turnover                NUMERIC,
  turnover_slab           TEXT,
  vintage_months          INTEGER,
  abb                     NUMERIC,
  bto                     NUMERIC,
  age                     INTEGER,
  employment              TEXT,
  pincode                 TEXT,
  state                   TEXT,
  last_loan_status        TEXT,
  score                   INTEGER,
  grade                   TEXT,
  decision                TEXT,
  pre_score               INTEGER,
  pre_grade               TEXT,
  pre_decision            TEXT,
  pre_eligible_lenders    TEXT[],
  pre_eligible_count      INTEGER,
  final_score             INTEGER,
  final_grade             TEXT,
  final_decision          TEXT,
  eligible_lenders        TEXT[],
  eligible_count          INTEGER,
  red_flags               TEXT[],
  data_complete           BOOLEAN,
  is_lead                 BOOLEAN,
  lead_source             TEXT,
  se_status               TEXT,

  enriched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pl_press1_enriched IS
  'Personal-loan press-1 leads (Poonawalla / Hero Fincorp) joined to a snapshot of se_base. One row per press. Rebuilt by public.pl_press1_enrich().';

-- The three reads this table exists for: a lender desk pulling one day, a
-- callback list ordered by score, and a lookup by mobile when someone rings in.
CREATE INDEX IF NOT EXISTS idx_pl_press1_enriched_day_lender
  ON public.pl_press1_enriched (ist_day DESC, lender);
CREATE INDEX IF NOT EXISTS idx_pl_press1_enriched_mobile
  ON public.pl_press1_enriched (mobile);
CREATE INDEX IF NOT EXISTS idx_pl_press1_enriched_score
  ON public.pl_press1_enriched (ist_day DESC, coalesce(final_score, score, pre_score) DESC NULLS LAST);

-- Every row is a customer's mobile number. RLS on, no policy: PostgREST's anon
-- and authenticated roles get nothing, service_role bypasses it, and the API in
-- front of this is already behind CONSOLE_SECRET.
ALTER TABLE public.pl_press1_enriched ENABLE ROW LEVEL SECURITY;

-- ── the job ────────────────────────────────────────────────────────────────
--
--   select public.pl_press1_enrich();                          -- today (IST)
--   select public.pl_press1_enrich('2026-09-01', '2026-09-04'); -- a range
--   select public.pl_press1_enrich('2026-01-01', null);         -- everything
--
-- SECURITY DEFINER because the fed.se_base user mapping exists for postgres
-- only; called over PostgREST as service_role it would otherwise fail on the
-- foreign scan rather than on the permission.
--
-- statement_timeout is raised for this function alone. PostgREST connects as
-- `authenticator`, which carries statement_timeout=8s, and SET ROLE does not
-- clear it — a full day of presses measured 4-8s, so the job would have started
-- failing on whichever day was busiest rather than on anything it did wrong.
-- Set on the function, not on service_role, so nothing else inherits it.
CREATE OR REPLACE FUNCTION public.pl_press1_enrich(
  p_from  date DEFAULT NULL,
  p_to    date DEFAULT NULL,
  p_batch integer DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'fed', 'pg_temp'
SET statement_timeout TO '600s'
AS $$
DECLARE
  v_from      date;
  v_to        date;
  v_batch     integer := greatest(1, least(coalesce(p_batch, 1000), 5000));
  v_mobiles   text[];
  v_chunk     text[];
  v_i         integer;
  v_presses   bigint := 0;
  v_written   bigint := 0;
  v_matched   bigint := 0;
  v_started   timestamptz := clock_timestamp();
BEGIN
  v_to   := coalesce(p_to, (now() at time zone 'Asia/Kolkata')::date);
  v_from := coalesce(p_from, v_to);

  IF v_from > v_to THEN
    RAISE EXCEPTION 'p_from (%) is after p_to (%)', v_from, v_to;
  END IF;

  -- The presses in scope, resolved and normalised once. businessloans is left
  -- out on purpose: that product has the CRM, and its leads are enriched there.
  CREATE TEMP TABLE pl_press_scope ON COMMIT DROP AS
  SELECT
    w.id                                                                     AS press_id,
    w.created_at                                                             AS pressed_at,
    (w.created_at at time zone 'Asia/Kolkata')::date                         AS ist_day,
    right(regexp_replace(coalesce(w.phone_number,''), '[^0-9]', '', 'g'), 10) AS mobile,
    public.pl_press_lender(w.metadata->>'link')                              AS lender,
    coalesce(w.metadata->>'campaign_name', '(unnamed campaign)')             AS campaign,
    coalesce(w.metadata->>'variant', '')                                     AS variant,
    coalesce(w.metadata->>'status', 'sent')                                  AS send_status,
    lower(coalesce(w.metadata->>'delivery_status', ''))                      AS delivery_status,
    w.metadata->>'template'                                                  AS template,
    w.metadata->>'link'                                                      AS link,
    w.metadata->>'message_id'                                                AS message_id,
    w.metadata->>'customer_id'                                               AS customer_id
  FROM public.whatsapp_messages w
  WHERE coalesce(w.metadata->>'digit','') = '1'
    AND (w.created_at at time zone 'Asia/Kolkata')::date BETWEEN v_from AND v_to;

  DELETE FROM pl_press_scope
   WHERE lender NOT IN ('poonawalla', 'herofincorp', 'unknown')
      OR length(mobile) <> 10;

  SELECT count(*) INTO v_presses FROM pl_press_scope;

  IF v_presses = 0 THEN
    RETURN jsonb_build_object(
      'from', v_from, 'to', v_to, 'presses', 0, 'written', 0, 'matched', 0,
      'note', 'no personal-loan press-1 rows in range',
      'took_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int
    );
  END IF;

  -- The se_base snapshot for exactly these mobiles, pulled in literal batches
  -- so the qual ships to the remote side. See the note at the top of this file.
  CREATE TEMP TABLE pl_se_snapshot ON COMMIT DROP AS
    SELECT * FROM fed.se_base WITH NO DATA;

  SELECT array_agg(DISTINCT mobile) INTO v_mobiles FROM pl_press_scope;

  v_i := 1;
  WHILE v_i <= array_length(v_mobiles, 1) LOOP
    v_chunk := v_mobiles[v_i : v_i + v_batch - 1];
    EXECUTE format(
      'INSERT INTO pl_se_snapshot SELECT * FROM fed.se_base WHERE mobile = ANY (%L::text[])',
      v_chunk
    );
    v_i := v_i + v_batch;
  END LOOP;

  -- se_base is one row per mobile, but this is a foreign table and that is a
  -- promise made in another database. DISTINCT ON keeps the join from
  -- multiplying a press into two leads if it is ever broken upstream.
  CREATE TEMP TABLE pl_se_one ON COMMIT DROP AS
    SELECT DISTINCT ON (mobile) * FROM pl_se_snapshot ORDER BY mobile, scored_at DESC NULLS LAST;

  CREATE INDEX ON pl_se_one (mobile);

  INSERT INTO public.pl_press1_enriched AS t (
    press_id, pressed_at, ist_day, mobile, lender, campaign, variant,
    send_status, delivery_status, template, link, message_id, customer_id,
    se_matched, se_name, pan, cibil, overdue, max_dpd, writeoff_settled,
    active_unsecured_loans, gstin, gst_status, constitution, turnover,
    turnover_slab, vintage_months, abb, bto, age, employment, pincode, state,
    last_loan_status, score, grade, decision, pre_score, pre_grade,
    pre_decision, pre_eligible_lenders, pre_eligible_count, final_score,
    final_grade, final_decision, eligible_lenders, eligible_count, red_flags,
    data_complete, is_lead, lead_source, se_status, enriched_at
  )
  SELECT
    p.press_id, p.pressed_at, p.ist_day, p.mobile, p.lender, p.campaign,
    p.variant, p.send_status, p.delivery_status, p.template, p.link,
    p.message_id, p.customer_id,
    (s.mobile IS NOT NULL),
    s.name, s.pan, s.cibil, s.overdue, s.max_dpd, s.writeoff_settled,
    s.active_unsecured_loans, s.gstin, s.gst_status, s.constitution, s.turnover,
    s.turnover_slab, s.vintage_months, s.abb, s.bto, s.age, s.employment,
    s.pincode, s.state, s.last_loan_status, s.score, s.grade, s.decision,
    s.pre_score, s.pre_grade, s.pre_decision, s.pre_eligible_lenders,
    s.pre_eligible_count, s.final_score, s.final_grade, s.final_decision,
    s.eligible_lenders, s.eligible_count, s.red_flags, s.data_complete,
    s.is_lead, s.lead_source, s.status, now()
  FROM pl_press_scope p
  LEFT JOIN pl_se_one s ON s.mobile = p.mobile
  ON CONFLICT (press_id) DO UPDATE SET
    -- The press facts are re-stated because a delivery receipt lands after the
    -- press and a run before it would otherwise freeze delivery_status at ''.
    lender = excluded.lender,
    campaign = excluded.campaign,
    variant = excluded.variant,
    send_status = excluded.send_status,
    delivery_status = excluded.delivery_status,
    template = excluded.template,
    link = excluded.link,
    message_id = excluded.message_id,
    customer_id = excluded.customer_id,
    se_matched = excluded.se_matched,
    se_name = excluded.se_name, pan = excluded.pan, cibil = excluded.cibil,
    overdue = excluded.overdue, max_dpd = excluded.max_dpd,
    writeoff_settled = excluded.writeoff_settled,
    active_unsecured_loans = excluded.active_unsecured_loans,
    gstin = excluded.gstin, gst_status = excluded.gst_status,
    constitution = excluded.constitution, turnover = excluded.turnover,
    turnover_slab = excluded.turnover_slab,
    vintage_months = excluded.vintage_months, abb = excluded.abb,
    bto = excluded.bto, age = excluded.age, employment = excluded.employment,
    pincode = excluded.pincode, state = excluded.state,
    last_loan_status = excluded.last_loan_status, score = excluded.score,
    grade = excluded.grade, decision = excluded.decision,
    pre_score = excluded.pre_score, pre_grade = excluded.pre_grade,
    pre_decision = excluded.pre_decision,
    pre_eligible_lenders = excluded.pre_eligible_lenders,
    pre_eligible_count = excluded.pre_eligible_count,
    final_score = excluded.final_score, final_grade = excluded.final_grade,
    final_decision = excluded.final_decision,
    eligible_lenders = excluded.eligible_lenders,
    eligible_count = excluded.eligible_count, red_flags = excluded.red_flags,
    data_complete = excluded.data_complete, is_lead = excluded.is_lead,
    lead_source = excluded.lead_source, se_status = excluded.se_status,
    enriched_at = now();

  GET DIAGNOSTICS v_written = ROW_COUNT;

  SELECT count(*) INTO v_matched
    FROM pl_press_scope p JOIN pl_se_one s ON s.mobile = p.mobile;

  RETURN jsonb_build_object(
    'from',       v_from,
    'to',         v_to,
    'presses',    v_presses,
    'written',    v_written,
    'matched',    v_matched,
    'unmatched',  v_presses - v_matched,
    'match_rate', round((v_matched::numeric / nullif(v_presses,0)) * 100, 1),
    'took_ms',    (extract(epoch from clock_timestamp() - v_started) * 1000)::int
  );
END;
$$;

COMMENT ON FUNCTION public.pl_press1_enrich(date, date, integer) IS
  'Rebuilds public.pl_press1_enriched for an IST day range from whatsapp_messages + fed.se_base. Idempotent; re-running refreshes the se_base snapshot.';

GRANT EXECUTE ON FUNCTION public.pl_press_lender(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pl_press1_enrich(date, date, integer) TO service_role;

-- ── the tracker now reads the same resolver ────────────────────────────────
--
-- Unchanged apart from the CASE becoming a call to pl_press_lender(), so the
-- Whistleloop presses stop being counted as 'unknown' here too. Leaving this
-- alone would have the tracker and the enriched sheet disagree about the same
-- day, which is the specific failure that makes people stop trusting both.
CREATE OR REPLACE FUNCTION public.pl_ivr_tracker(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with bounds as (
  select coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date) as day
),
b as (
  select day, date_trunc('month', day)::date as month_start from bounds
),
press as (
  select
    (w.created_at at time zone 'Asia/Kolkata')::date            as ist_day,
     w.created_at at time zone 'Asia/Kolkata'                   as ist_at,
    right(regexp_replace(coalesce(w.phone_number,''), '[^0-9]', '', 'g'), 10) as mobile10,
    coalesce(w.metadata->>'campaign_name', '(unnamed campaign)') as campaign,
    coalesce(w.metadata->>'variant', '')                        as variant,
    coalesce(w.metadata->>'status', 'sent')                     as status,
    lower(coalesce(w.metadata->>'delivery_status', ''))         as delivery_status,
    public.pl_press_lender(w.metadata->>'link')                 as lender
  from public.whatsapp_messages w
  where w.metadata ? 'digit'
    and coalesce(w.metadata->>'digit','') = '1'
),
pl as (
  select * from press where lender in ('poonawalla', 'herofincorp', 'unknown')
),
scoped as (
  select pl.*, b.day, b.month_start
  from pl cross join b
  where pl.ist_day between b.month_start and b.day
),
per_lender as (
  select
    lender,
    count(*) filter (where ist_day = day)                                   as ftd_presses,
    count(distinct mobile10) filter (where ist_day = day)                   as ftd_phones,
    count(*) filter (where ist_day = day and status = 'failed')             as ftd_failed,
    count(*)                                                                as mtd_presses,
    count(distinct mobile10)                                                as mtd_phones,
    count(*) filter (where status = 'failed')                               as mtd_failed,
    count(*) filter (where variant <> '' and variant <> lender)             as mtd_variant_mismatch,
    -- read implies delivered; the receipts do not promise their own order.
    count(*) filter (where ist_day = day and delivery_status in ('delivered','read')) as ftd_delivered,
    count(*) filter (where ist_day = day and delivery_status = 'read')                as ftd_read,
    count(*) filter (where delivery_status in ('delivered','read'))                   as mtd_delivered,
    count(*) filter (where delivery_status = 'read')                                  as mtd_read,
    -- How many rows carry any receipt at all. Without this a zero above cannot
    -- be told apart from "we were not listening yet".
    count(*) filter (where delivery_status <> '')                                     as mtd_receipts_seen
  from scoped group by lender
),
per_campaign as (
  select lender, campaign,
         count(*)                       as presses,
         count(distinct mobile10)       as phones,
         count(*) filter (where ist_day = day) as ftd_presses,
         count(*) filter (where delivery_status in ('delivered','read')) as delivered,
         count(*) filter (where delivery_status = 'read')                as read_count,
         min(ist_at)::timestamp(0)      as first_at,
         max(ist_at)::timestamp(0)      as last_at
  from scoped group by lender, campaign
),
per_day as (
  select ist_day, lender, count(*) as presses from scoped group by ist_day, lender
)
select jsonb_build_object(
  'day',         (select day from b),
  'month_start', (select month_start from b),
  'generated_at', (now() at time zone 'Asia/Kolkata')::timestamp(0),
  'lenders', coalesce((
    select jsonb_agg(to_jsonb(l) order by l.mtd_presses desc) from per_lender l), '[]'::jsonb),
  'campaigns', coalesce((
    select jsonb_agg(to_jsonb(c) order by c.presses desc) from per_campaign c), '[]'::jsonb),
  'daily', coalesce((
    select jsonb_agg(to_jsonb(d) order by d.ist_day, d.lender) from per_day d), '[]'::jsonb)
);
$function$;
