-- What the lender actually did with a press-1 lead.
--
-- 005 gave a press a name and a bureau; 006 said which lender would take them.
-- This closes the loop: crm.pl_lender_mis is what Hero and Poonawalla send back,
-- and crm.v_pl_mis already resolves those rows to a mobile. This joins that to
-- the presses, so a lead can be asked "did they apply, and what happened".
--
-- WHY A VIEW AND NOT COLUMNS ON pl_press1_enriched
--
-- The MIS advances every day, on the lenders' schedule, and independently of
-- pl_press1_enrich(). Columns filled at enrichment time would report "not
-- sanctioned" for someone sanctioned that morning, and would keep reporting it
-- until the next nightly run. pl_press1_enriched is also documented as a
-- SNAPSHOT of se_base at enrichment time; outcomes that move on someone else's
-- clock do not belong inside that contract. The join costs ~600ms across the
-- whole book, so there is nothing to buy by freezing it.
--
-- COVERAGE IS THE CAVEAT, AND IT IS NOT SYMMETRIC
--
-- Hero echoes our customer_id, so crm.v_pl_mis decodes 1,711 of 1,711 of its
-- rows. Poonawalla does not: our alias reaches its MIS only in
-- UTM_Partner_AgentCode, shaped `4773_alias_<7 chars>_`, and only for publisher
-- 4773 -- 60 of 6,424 rows. The other publishers in that feed (4636 with 1,695
-- distinct tokens, plus 1309, 4154 and 681) carry 10-character mixed-case
-- tokens that match neither our codec nor any alias in crm.v_alias_sent, under
-- campaign names like BDL_HeroCL_LBD_Aug1 that make them look like ours. They
-- are another affiliate's scheme. Matching on them would attach other partners'
-- applications to our leads, which is why v_pl_mis rejects them and why this
-- view does not try to be cleverer than it.
--
-- So mis_matched = false means "no MIS row we can tie to this mobile". It does
-- NOT mean the person did not convert. Any conversion rate read off this view
-- is a floor, and for Poonawalla a floor about a hundred times below the truth.
-- The durable fix is Poonawalla echoing client_reference_id the way Hero does.
CREATE OR REPLACE VIEW public.pl_press1_mis_outcome AS
WITH per_lender AS (
  SELECT
    v.mobile10,
    v.lender,
    count(*)                                        AS applications,
    min(v.mis_date)                                 AS first_seen,
    max(v.mis_date)                                 AS last_seen,
    max(v.login_date)                               AS login_date,
    max(v.sanction_date)                            AS sanction_date,
    max(v.sanction_amount)                          AS sanction_amount,
    max(v.disbursal_date)                           AS disbursal_date,
    max(v.disbursal_amount)                         AS disbursal_amount,
    -- One person can hold several applications with the same lender. The sheet
    -- wants how far they got, not how far the newest row got, so rank the
    -- stages and keep the maximum rather than the latest.
    max(CASE WHEN v.disbursal_date IS NOT NULL OR coalesce(v.disbursal_amount,0) > 0 THEN 4
             WHEN v.sanction_date  IS NOT NULL OR coalesce(v.sanction_amount,0)  > 0 THEN 3
             WHEN v.login_date     IS NOT NULL                                       THEN 2
             ELSE 1 END)                            AS stage_rank,
    (array_agg(v.current_stage  ORDER BY v.mis_date DESC NULLS LAST))[1] AS current_stage,
    (array_agg(v.final_status   ORDER BY v.mis_date DESC NULLS LAST))[1] AS final_status,
    (array_agg(v.rejection_reason ORDER BY v.mis_date DESC NULLS LAST) FILTER (WHERE v.rejection_reason IS NOT NULL))[1] AS rejection_reason,
    (array_agg(v.mobile_source  ORDER BY v.mis_date DESC NULLS LAST))[1] AS mobile_source
  FROM crm.v_pl_mis v
  WHERE v.mobile10 IS NOT NULL
  GROUP BY v.mobile10, v.lender
),
per_mobile AS (
  SELECT
    mobile10,
    string_agg(DISTINCT lender, ', ' ORDER BY lender)      AS mis_lenders,
    sum(applications)::int                                  AS mis_applications,
    min(first_seen)                                         AS mis_first_seen,
    max(last_seen)                                          AS mis_last_seen,
    max(stage_rank)                                         AS stage_rank,
    max(login_date)                                         AS login_date,
    max(sanction_date)                                      AS sanction_date,
    max(sanction_amount)                                    AS sanction_amount,
    max(disbursal_date)                                     AS disbursal_date,
    max(disbursal_amount)                                   AS disbursal_amount,
    (array_agg(current_stage    ORDER BY stage_rank DESC, last_seen DESC))[1] AS current_stage,
    (array_agg(final_status     ORDER BY stage_rank DESC, last_seen DESC))[1] AS final_status,
    (array_agg(rejection_reason ORDER BY stage_rank DESC, last_seen DESC) FILTER (WHERE rejection_reason IS NOT NULL))[1] AS rejection_reason,
    (array_agg(mobile_source    ORDER BY stage_rank DESC, last_seen DESC))[1] AS mobile_source
  FROM per_lender GROUP BY mobile10
)
SELECT
  e.press_id, e.pressed_at, e.ist_day, e.mobile, e.lender AS ivr_lender,
  e.campaign, e.se_name, e.cibil, e.se_matched,
  (o.mobile10 IS NOT NULL)                                   AS mis_matched,
  o.mis_lenders,
  -- Did they turn up in the MIS of the lender whose journey we sent them into?
  -- 30 presses currently appear in the OTHER lender's book -- 26 Poonawalla
  -- presses in Hero's, 4 the other way. Those are real outcomes but they are
  -- not this campaign converting, and one blended number would hide them.
  (o.mis_lenders IS NOT NULL AND o.mis_lenders LIKE '%' || e.lender || '%') AS mis_same_lender,
  o.mis_applications, o.mis_first_seen, o.mis_last_seen,
  CASE o.stage_rank WHEN 4 THEN 'disbursed' WHEN 3 THEN 'sanctioned'
                    WHEN 2 THEN 'logged in' WHEN 1 THEN 'applied' END AS furthest_stage,
  o.current_stage, o.final_status, o.rejection_reason,
  o.login_date, o.sanction_date, o.sanction_amount,
  o.disbursal_date, o.disbursal_amount,
  o.mobile_source                                            AS mis_mobile_source
FROM public.pl_press1_enriched e
LEFT JOIN per_mobile o ON o.mobile10 = e.mobile;

COMMENT ON VIEW public.pl_press1_mis_outcome IS
  'Press-1 leads with whatever the lender MIS says happened to them. A VIEW, not columns on pl_press1_enriched: MIS advances daily and independently of pl_press1_enrich(), so a snapshot taken at enrichment time would report "not sanctioned" for someone sanctioned that morning. Aggregated to one row per press; a mobile with several applications shows the furthest stage reached. COVERAGE IS THE CAVEAT - Hero maps 100% of its MIS via decoded cuid, Poonawalla only ~1% because the alias survives to the MIS for publisher 4773 alone, so mis_matched=false means "no MIS row we can tie to this mobile", never "did not convert".';

GRANT SELECT ON public.pl_press1_mis_outcome TO service_role;
