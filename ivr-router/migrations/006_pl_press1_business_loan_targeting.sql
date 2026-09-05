-- Which press-1 leads could carry a business loan, and who would lend to them.
--
-- 005 answered "who is this person" by joining the presses to se_base. This
-- answers the question that follows: of a day's ~6,000 personal-loan presses,
-- which are businesses worth a business-loan callback, and which lenders would
-- actually take them.
--
-- TWO PROJECTS, TWO SECTIONS
--
-- Part A runs in the Database project (ggpkzlxxhqlyfhdaczij). Part B runs in
-- smecircle (ymdkcaedwnnhszhzirli), which is what SUPABASE_URL resolves to.
-- Running either in the wrong project is the failure data-jobs/run.js exists to
-- catch, so the split is stated rather than implied.
--
-- WHY sme_user_master AND NOT JUST se_base
--
-- se_base has no banking turnover, no average bank balance, no GST turnover
-- slab and no tradeline detail — the four things that decide whether someone
-- can service a business loan. sme_user_master has all four, and matches 7,301
-- of the 13,434 press-1 mobiles against se_base's 5,174 (54% vs 39%).
--
-- ============================================================================
-- PART A — in the Database project (ggpkzlxxhqlyfhdaczij), NOT in smecircle
-- ============================================================================
--
-- smecircle reads this project over postgres_fdw as crm_fdw_reader, which had
-- SELECT on se_base but not on sme_user_master; the first snapshot run failed
-- with "permission denied for table sme_user_master" from the remote side.
-- Read-only, one table: the FDW reader exists to be read from, never written
-- through.
--
--   GRANT SELECT ON public.sme_user_master TO crm_fdw_reader;
--
-- (Left commented so a careless run of this file against smecircle cannot fail
-- half way. Run that one line in the Database project by hand.)

-- ============================================================================
-- PART B — in smecircle (ymdkcaedwnnhszhzirli)
-- ============================================================================

-- The BRE, read live rather than copied. 14 rows, so the foreign scan costs
-- nothing, and a threshold changed upstream takes effect here without anyone
-- remembering to re-copy it. A local copy is how two lists of the same lender
-- rules drift apart, which is the mistake sync-pincodes-from-crm.js was written
-- to undo.
CREATE FOREIGN TABLE IF NOT EXISTS fed.se_lender_bre (
  lender text,
  cibil_min integer,
  turnover_min numeric,
  vintage_min_months integer,
  abb_min numeric,
  overdue_max numeric,
  age_min integer,
  age_max integer,
  writeoff_settled_max integer,
  active_unsecured_loans_max integer,
  max_dpd_6m integer,
  gst_status_required text,
  pincode_key text
) SERVER db_bases OPTIONS (schema_name 'public', table_name 'se_lender_bre');

CREATE FOREIGN TABLE IF NOT EXISTS fed.sme_user_master (
  mobile_number text,
  customer_name text,
  pan_no text,
  business_name text,
  company_type text,
  business_industry_type text,
  business_vintage_years numeric,
  business_pincode text,
  gst_turnover_slab text,
  bureau_score_cibil integer,
  dpd_count_max integer,
  current_overdue_amount numeric,
  average_bank_balance numeric,
  banking_turnover numeric,
  active_emi_count integer,
  active_tradelines_count integer,
  tradeline_details jsonb,
  gstin text,
  master_generated_at timestamptz
) SERVER db_bases OPTIONS (schema_name 'public', table_name 'sme_user_master');

CREATE TABLE IF NOT EXISTS public.pl_press1_sme (
  mobile                   TEXT PRIMARY KEY,
  customer_name            TEXT,
  pan_no                   TEXT,
  business_name            TEXT,
  company_type             TEXT,
  business_industry_type   TEXT,
  business_vintage_years   NUMERIC,
  business_pincode         TEXT,
  gst_turnover_slab        TEXT,
  bureau_score_cibil       INTEGER,
  dpd_count_max            INTEGER,
  current_overdue_amount   NUMERIC,
  average_bank_balance     NUMERIC,
  banking_turnover         NUMERIC,
  active_emi_count         INTEGER,
  active_tradelines_count  INTEGER,
  gstin                    TEXT,
  bl_tradeline_count       INTEGER,
  bl_max_origination       NUMERIC,
  bl_sum_origination       NUMERIC,
  bl_sum_balance           NUMERIC,
  snapshot_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pl_press1_sme IS
  'sme_user_master snapshot for the mobiles that pressed 1 on the personal-loan IVR. Richer than the se_base snapshot in pl_press1_enriched: it carries banking_turnover, average_bank_balance, gst_turnover_slab and the tradeline detail that se_base does not. bl_* columns are business-loan tradelines only, summed from tradeline_details at snapshot time.';

ALTER TABLE public.pl_press1_sme ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_pl_press1_sme_cibil ON public.pl_press1_sme (bureau_score_cibil DESC NULLS LAST);

-- Same literal-batch shape as pl_press1_enrich(), for the same reason: a join
-- against a local mobile list drags the whole 4.31M-row remote table across the
-- FDW. See the note at the top of 005 before changing it.
CREATE OR REPLACE FUNCTION public.pl_press1_sme_refresh(p_batch integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'fed', 'pg_temp'
SET statement_timeout TO '600s'
AS $$
DECLARE
  v_batch integer := greatest(1, least(coalesce(p_batch, 2000), 5000));
  v_mobiles text[];
  v_chunk text[];
  v_i integer;
  v_written bigint := 0;
  v_started timestamptz := clock_timestamp();
BEGIN
  CREATE TEMP TABLE sme_raw ON COMMIT DROP AS
    SELECT * FROM fed.sme_user_master WITH NO DATA;

  SELECT array_agg(DISTINCT mobile) INTO v_mobiles FROM public.pl_press1_enriched;

  v_i := 1;
  WHILE v_i <= array_length(v_mobiles, 1) LOOP
    v_chunk := v_mobiles[v_i : v_i + v_batch - 1];
    EXECUTE format(
      'INSERT INTO sme_raw SELECT * FROM fed.sme_user_master WHERE mobile_number = ANY (%L::text[])',
      v_chunk
    );
    v_i := v_i + v_batch;
  END LOOP;

  INSERT INTO public.pl_press1_sme AS t (
    mobile, customer_name, pan_no, business_name, company_type,
    business_industry_type, business_vintage_years, business_pincode,
    gst_turnover_slab, bureau_score_cibil, dpd_count_max, current_overdue_amount,
    average_bank_balance, banking_turnover, active_emi_count,
    active_tradelines_count, gstin,
    bl_tradeline_count, bl_max_origination, bl_sum_origination, bl_sum_balance,
    snapshot_at
  )
  SELECT DISTINCT ON (s.mobile_number)
    s.mobile_number, s.customer_name, s.pan_no, s.business_name, s.company_type,
    s.business_industry_type, s.business_vintage_years, s.business_pincode,
    s.gst_turnover_slab, s.bureau_score_cibil, s.dpd_count_max, s.current_overdue_amount,
    s.average_bank_balance, s.banking_turnover, s.active_emi_count,
    s.active_tradelines_count, s.gstin,
    bl.n, bl.max_orig, bl.sum_orig, bl.sum_bal,
    now()
  FROM sme_raw s
  LEFT JOIN LATERAL (
    SELECT count(*)::int                           AS n,
           max((e->>'origination_amount')::numeric) AS max_orig,
           sum((e->>'origination_amount')::numeric) AS sum_orig,
           sum((e->>'current_balance')::numeric)    AS sum_bal
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(s.tradeline_details) = 'array'
                THEN s.tradeline_details ELSE '[]'::jsonb END) e
    WHERE e->>'product' ILIKE '%business loan%'
  ) bl ON true
  ORDER BY s.mobile_number, s.master_generated_at DESC NULLS LAST
  ON CONFLICT (mobile) DO UPDATE SET
    customer_name = excluded.customer_name, pan_no = excluded.pan_no,
    business_name = excluded.business_name, company_type = excluded.company_type,
    business_industry_type = excluded.business_industry_type,
    business_vintage_years = excluded.business_vintage_years,
    business_pincode = excluded.business_pincode,
    gst_turnover_slab = excluded.gst_turnover_slab,
    bureau_score_cibil = excluded.bureau_score_cibil,
    dpd_count_max = excluded.dpd_count_max,
    current_overdue_amount = excluded.current_overdue_amount,
    average_bank_balance = excluded.average_bank_balance,
    banking_turnover = excluded.banking_turnover,
    active_emi_count = excluded.active_emi_count,
    active_tradelines_count = excluded.active_tradelines_count,
    gstin = excluded.gstin,
    bl_tradeline_count = excluded.bl_tradeline_count,
    bl_max_origination = excluded.bl_max_origination,
    bl_sum_origination = excluded.bl_sum_origination,
    bl_sum_balance = excluded.bl_sum_balance,
    snapshot_at = now();

  GET DIAGNOSTICS v_written = ROW_COUNT;

  RETURN jsonb_build_object(
    'press1_mobiles', array_length(v_mobiles, 1),
    'matched_in_sme_user_master', v_written,
    'took_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pl_press1_sme_refresh(integer) TO service_role;

-- ── who would lend to them ─────────────────────────────────────────────────
--
-- Every press-1 lead with an active GSTIN, scored against all 14 lender BREs.
--
-- A lender is CONFIRMED only when every threshold it sets can be evaluated;
-- where a threshold's input is missing the lead is PROVISIONAL for that lender
-- rather than passed or failed. Reading a NULL ABB as a low ABB would reject
-- people we simply hold no banking for, and reading it as a pass would send the
-- desk to a lender that is going to decline them.
--
-- TWO SENTINELS, READ AS UNKNOWN
--
-- writeoff_settled = 99 (211 rows) and max_dpd = 180 (103 rows) are placeholder
-- values in the source, not measurements — real write-off counts elsewhere run
-- 0-14. Taken literally they fail every lender with a write-off or DPD cap, so
-- they are nulled here and surfaced as wo_sentinel / dpd_sentinel rather than
-- silently dropped.
--
-- turnover in se_base is a 3-value slab (40L / 150L / 500L), not a measured
-- figure. Filtering it like a continuous amount silently drops a whole band.
CREATE OR REPLACE VIEW public.pl_press1_bl_candidate AS
WITH lead AS (
  SELECT DISTINCT ON (mobile)
    mobile, se_name, lender AS ivr_lender, ist_day, pressed_at,
    cibil, turnover, abb, vintage_months, age, overdue,
    active_unsecured_loans AS aul, pincode, state, constitution, gstin, gst_status,
    NULLIF(writeoff_settled, 99) AS wo,
    NULLIF(max_dpd, 180)         AS dpd,
    (writeoff_settled = 99)      AS wo_sentinel,
    (max_dpd = 180)              AS dpd_sentinel
  FROM public.pl_press1_enriched
  WHERE se_matched
    AND gstin IS NOT NULL AND gstin <> ''
    AND lower(coalesce(gst_status,'')) LIKE 'active%'
  ORDER BY mobile, pressed_at DESC
),
ev AS (
  SELECT l.mobile, b.lender,
    ((b.cibil_min IS NOT NULL AND l.cibil IS NOT NULL AND l.cibil < b.cibil_min)
  OR (b.turnover_min IS NOT NULL AND l.turnover IS NOT NULL AND l.turnover < b.turnover_min)
  OR (b.vintage_min_months IS NOT NULL AND l.vintage_months IS NOT NULL AND l.vintage_months < b.vintage_min_months)
  OR (b.abb_min IS NOT NULL AND l.abb IS NOT NULL AND l.abb < b.abb_min)
  OR (b.overdue_max IS NOT NULL AND l.overdue IS NOT NULL AND l.overdue > b.overdue_max)
  OR (b.age_min IS NOT NULL AND l.age IS NOT NULL AND l.age < b.age_min)
  OR (b.age_max IS NOT NULL AND l.age IS NOT NULL AND l.age > b.age_max)
  OR (b.writeoff_settled_max IS NOT NULL AND l.wo IS NOT NULL AND l.wo > b.writeoff_settled_max)
  OR (b.active_unsecured_loans_max IS NOT NULL AND l.aul IS NOT NULL AND l.aul > b.active_unsecured_loans_max)
  OR (b.max_dpd_6m IS NOT NULL AND l.dpd IS NOT NULL AND l.dpd > b.max_dpd_6m)) AS fails,
    (CASE WHEN b.cibil_min IS NOT NULL AND l.cibil IS NULL THEN 1 ELSE 0 END
   + CASE WHEN b.vintage_min_months IS NOT NULL AND l.vintage_months IS NULL THEN 1 ELSE 0 END
   + CASE WHEN b.abb_min IS NOT NULL AND l.abb IS NULL THEN 1 ELSE 0 END
   + CASE WHEN b.overdue_max IS NOT NULL AND l.overdue IS NULL THEN 1 ELSE 0 END
   + CASE WHEN b.age_min IS NOT NULL AND l.age IS NULL THEN 1 ELSE 0 END
   + CASE WHEN b.writeoff_settled_max IS NOT NULL AND l.wo IS NULL THEN 1 ELSE 0 END
   + CASE WHEN b.active_unsecured_loans_max IS NOT NULL AND l.aul IS NULL THEN 1 ELSE 0 END
   + CASE WHEN b.max_dpd_6m IS NOT NULL AND l.dpd IS NULL THEN 1 ELSE 0 END) AS unknowns
  FROM lead l CROSS JOIN fed.se_lender_bre b
),
agg AS (
  SELECT mobile,
    count(*) FILTER (WHERE NOT fails)                    AS lenders_open,
    count(*) FILTER (WHERE NOT fails AND unknowns = 0)   AS lenders_confirmed,
    string_agg(lender, ', ' ORDER BY lender) FILTER (WHERE NOT fails AND unknowns = 0) AS confirmed_lenders,
    string_agg(lender, ', ' ORDER BY lender) FILTER (WHERE NOT fails AND unknowns > 0) AS provisional_lenders
  FROM ev GROUP BY mobile
)
SELECT
  CASE WHEN l.turnover >= 10000000 THEN '10L+ comfortable'
       WHEN l.turnover >= 4000000  THEN '10L at the edge'
       ELSE 'below 10L' END                        AS ticket_band,
  a.lenders_confirmed, a.lenders_open,
  l.mobile, l.se_name, l.ivr_lender, l.ist_day,
  l.cibil, l.turnover, l.abb, l.vintage_months, l.age, l.overdue, l.aul,
  l.wo AS writeoff_settled, l.dpd AS max_dpd, l.wo_sentinel, l.dpd_sentinel,
  l.pincode, l.state, l.constitution, l.gstin,
  a.confirmed_lenders, a.provisional_lenders,
  NULLIF(concat_ws(', ',
    CASE WHEN l.abb IS NULL THEN 'ABB' END,
    CASE WHEN l.vintage_months IS NULL THEN 'vintage' END,
    CASE WHEN l.age IS NULL THEN 'age' END,
    CASE WHEN l.cibil IS NULL THEN 'CIBIL' END,
    CASE WHEN l.overdue IS NULL THEN 'overdue' END,
    CASE WHEN l.pincode IS NULL OR l.pincode = '' THEN 'pincode' END), '') AS missing_for_bre
FROM agg a JOIN lead l USING (mobile);

COMMENT ON VIEW public.pl_press1_bl_candidate IS
  'Business-loan candidates among the personal-loan press-1 leads, scored against fed.se_lender_bre. Sentinel values (writeoff_settled=99, max_dpd=180) are read as unknown, not as measurements, and flagged in wo_sentinel / dpd_sentinel. turnover is a 3-value slab (40L/150L/500L), not a measured figure. Pincode serviceability is NOT applied.';

GRANT SELECT ON public.pl_press1_bl_candidate TO service_role;

-- ── the callable target list ───────────────────────────────────────────────
--
-- Self-employed, bureau above 730, and at least one sign of being able to carry
-- a business loan. The four signals are an OR, and each is read only where it
-- exists.
--
-- THIS VIEW IS A FLOOR, NOT A POOL SIZE
--
-- Of the 2,616 self-employed press-1 users above 730, only 426 actually fail
-- these four tests. The other 1,824 hold no data on any of them and are absent
-- for lack of evidence, not lack of quality. Coverage across all 13,434 press-1
-- users: ABB and banking turnover 835 each (6.2%), business-loan tradelines 538
-- (4.0%), GST slab 215 (1.6%). Anyone reading a count off this view and calling
-- it the addressable market will be wrong by roughly 3x.
CREATE OR REPLACE VIEW public.pl_press1_bl_target AS
WITH u AS (
  SELECT DISTINCT ON (mobile)
    mobile, se_name, employment, lender AS ivr_lender, ist_day,
    cibil AS se_cibil, abb AS se_abb, bto AS se_bto, turnover AS se_turnover,
    pincode AS se_pincode, state, constitution
  FROM public.pl_press1_enriched
  ORDER BY mobile, pressed_at DESC
),
j AS (
  SELECT u.*, s.customer_name, s.business_name, s.company_type,
    s.business_industry_type, s.business_vintage_years, s.business_pincode,
    s.gst_turnover_slab, s.gstin, s.dpd_count_max, s.current_overdue_amount,
    s.active_emi_count, s.bl_tradeline_count, s.bl_max_origination, s.bl_sum_origination,
    coalesce(s.bureau_score_cibil, u.se_cibil) AS cibil,
    coalesce(s.average_bank_balance, u.se_abb) AS abb,
    coalesce(s.banking_turnover, u.se_bto)     AS banking_turnover,
    -- Present in an SME master with a business identity is itself self-employed;
    -- se_base's employment field only covers the 5,174 it matches.
    (u.employment ILIKE 'self employed%'
       OR (s.mobile IS NOT NULL AND (s.business_name IS NOT NULL OR s.gstin IS NOT NULL))) AS self_emp
  FROM u LEFT JOIN public.pl_press1_sme s ON s.mobile = u.mobile
),
q AS (
  SELECT *,
    coalesce(abb > 50000, false)                  AS arm_abb,
    coalesce(banking_turnover > 5000000, false)   AS arm_banking,
    ((gst_turnover_slab IS NOT NULL AND gst_turnover_slab NOT ILIKE '%0 to 40 lakh%')
       OR coalesce(se_turnover, 0) >= 4000000)    AS arm_gst,
    coalesce(bl_max_origination > 1000000, false) AS arm_bl
  FROM j WHERE self_emp
)
SELECT
  mobile,
  coalesce(customer_name, se_name)                       AS name,
  business_name, company_type, business_industry_type,
  ivr_lender, ist_day AS press_day,
  cibil, abb, banking_turnover, gst_turnover_slab,
  bl_tradeline_count, bl_max_origination, bl_sum_origination,
  business_vintage_years, active_emi_count, dpd_count_max, current_overdue_amount,
  coalesce(business_pincode, se_pincode)                 AS pincode,
  state, constitution, gstin,
  (arm_abb::int + arm_banking::int + arm_gst::int + arm_bl::int) AS arms_matched,
  nullif(concat_ws(' + ',
    CASE WHEN arm_banking THEN 'banking>50L' END,
    CASE WHEN arm_abb     THEN 'ABB>50k' END,
    CASE WHEN arm_gst     THEN 'GST>40L' END,
    CASE WHEN arm_bl      THEN 'BL tradeline>10L' END), '')  AS qualified_on
FROM q
WHERE cibil > 730 AND (arm_abb OR arm_banking OR arm_gst OR arm_bl);

COMMENT ON VIEW public.pl_press1_bl_target IS
  'Self-employed press-1 users, bureau > 730, meeting at least one of: ABB > 50k, banking turnover > 50L, GST slab > 40L, largest business-loan tradeline > 10L. A FLOOR, not a ceiling: of the 2,616 self-employed users above 730, only 426 fail these tests - 1,824 have no data on any of the four signals and are absent for that reason alone. Coverage: ABB and banking turnover 6% of users, tradelines 4%, GST slab 2%.';

GRANT SELECT ON public.pl_press1_bl_target TO service_role;
