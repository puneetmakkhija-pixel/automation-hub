-- Hero's daily disbursal report, and the outcome it unlocks.
--
-- THE PROBLEM THIS SOLVES
--
-- The Hero MIS we already ingest (crm.pl_lender_mis, lender 'herofincorp') is
-- an APPLICATION feed. All 2,464 rows it has ever sent carry a NULL sanction
-- and a NULL disbursal. It has identity and no outcome: Hero echoes our
-- customer_id, so crm.v_pl_mis decodes 100% of it to a mobile.
--
-- Hero's disbursal report is the mirror image -- sanction and disbursal
-- amounts, and no mobile, no PAN, no name. Its "App ID" is the same identifier
-- space as pl_lender_mis.lan_id, which is the only thing joining the halves.
--
-- So 007's pl_press1_mis_outcome reported every Hero lead as unconverted, and
-- that was never a fact about the customers. It was a column the feed does not
-- contain.
--
-- WHY A SEPARATE TABLE AND NOT A MERGE INTO pl_lender_mis
--
-- pl_lender_mis is written by the CRM's own MIS pipeline. Two writers on one
-- row is how one of them silently loses, and the loser would be whichever ran
-- second on a day the other reordered its columns. This lands beside it and the
-- view joins them.
CREATE TABLE IF NOT EXISTS crm.mis_hero_disbursal (
  lan_id            TEXT PRIMARY KEY,
  app_created_at    TIMESTAMPTZ,
  sanction_amount   NUMERIC,
  sanction_rate     NUMERIC,
  decision_date     DATE,
  current_city      TEXT,
  current_pincode   TEXT,
  cpv_action        TEXT,
  final_status      TEXT,
  decile            INTEGER,
  appsflyer_id      TEXT,
  media_source      TEXT,
  campaign          TEXT,
  campaign_id       TEXT,
  utm_medium        TEXT,
  utm_content       TEXT,
  channel           TEXT,
  partner_name      TEXT,
  disbursal_amount  NUMERIC,
  disbursal_date    DATE,
  source_file       TEXT,
  raw               JSONB,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE crm.mis_hero_disbursal IS
  'Hero Fincorp daily disbursal report, keyed on lan_id (the file calls it App ID - same identifier space as crm.pl_lender_mis.lan_id). Kept SEPARATE from pl_lender_mis on purpose: that table is written by the CRM MIS pipeline, and two writers on one row is how one of them silently loses. This holds the outcome half - sanction and disbursal amounts - which the Hero MIS application feed has never carried: all 2,464 Hero rows there have NULL sanction and disbursal. Join the two on lan_id to get identity and outcome together.';

CREATE INDEX IF NOT EXISTS idx_mis_hero_disbursal_disb_date ON crm.mis_hero_disbursal (disbursal_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_mis_hero_disbursal_campaign  ON crm.mis_hero_disbursal (campaign_id);

ALTER TABLE crm.mis_hero_disbursal ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON crm.mis_hero_disbursal TO service_role;

-- ── the outcome view now reads both halves ─────────────────────────────────
--
-- Replaces the view created in 007. The only change is the LEFT JOIN to
-- crm.mis_hero_disbursal on lan_id and the coalesce()s that prefer whichever
-- feed actually carries a value -- for Hero that is always the disbursal report,
-- because the application feed's sanction and disbursal columns are empty.
--
-- from_disbursal_report is appended LAST rather than placed beside the other
-- provenance column: CREATE OR REPLACE VIEW cannot insert a column into the
-- middle of an existing view, and dropping the view to reorder would take its
-- grants with it.
CREATE OR REPLACE VIEW public.pl_press1_mis_outcome AS
WITH per_lender AS (
  SELECT
    v.mobile10,
    v.lender,
    count(*)                                        AS applications,
    min(v.mis_date)                                 AS first_seen,
    max(v.mis_date)                                 AS last_seen,
    max(v.login_date)                               AS login_date,
    max(coalesce(v.sanction_date,  d.decision_date))      AS sanction_date,
    max(coalesce(v.sanction_amount, d.sanction_amount))   AS sanction_amount,
    max(coalesce(v.disbursal_date,  d.disbursal_date))    AS disbursal_date,
    max(coalesce(v.disbursal_amount, d.disbursal_amount)) AS disbursal_amount,
    max(CASE WHEN v.disbursal_date IS NOT NULL OR coalesce(v.disbursal_amount,0) > 0
              OR d.disbursal_date IS NOT NULL OR coalesce(d.disbursal_amount,0) > 0 THEN 4
             WHEN v.sanction_date  IS NOT NULL OR coalesce(v.sanction_amount,0)  > 0
              OR coalesce(d.sanction_amount,0) > 0                                  THEN 3
             WHEN v.login_date     IS NOT NULL                                      THEN 2
             ELSE 1 END)                            AS stage_rank,
    (array_agg(coalesce(d.final_status, v.current_stage) ORDER BY v.mis_date DESC NULLS LAST))[1] AS current_stage,
    (array_agg(coalesce(d.final_status, v.final_status)  ORDER BY v.mis_date DESC NULLS LAST))[1] AS final_status,
    (array_agg(v.rejection_reason ORDER BY v.mis_date DESC NULLS LAST) FILTER (WHERE v.rejection_reason IS NOT NULL))[1] AS rejection_reason,
    (array_agg(v.mobile_source  ORDER BY v.mis_date DESC NULLS LAST))[1] AS mobile_source,
    count(*) FILTER (WHERE d.lan_id IS NOT NULL)    AS disbursal_report_rows
  FROM crm.v_pl_mis v
  LEFT JOIN crm.mis_hero_disbursal d ON d.lan_id = v.lan_id
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
    sum(disbursal_report_rows)::int                         AS disbursal_report_rows,
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
  (o.mis_lenders IS NOT NULL AND o.mis_lenders LIKE '%' || e.lender || '%') AS mis_same_lender,
  o.mis_applications, o.mis_first_seen, o.mis_last_seen,
  CASE o.stage_rank WHEN 4 THEN 'disbursed' WHEN 3 THEN 'sanctioned'
                    WHEN 2 THEN 'logged in' WHEN 1 THEN 'applied' END AS furthest_stage,
  o.current_stage, o.final_status, o.rejection_reason,
  o.login_date, o.sanction_date, o.sanction_amount,
  o.disbursal_date, o.disbursal_amount,
  o.mobile_source                                            AS mis_mobile_source,
  (coalesce(o.disbursal_report_rows,0) > 0)                  AS from_disbursal_report
FROM public.pl_press1_enriched e
LEFT JOIN per_mobile o ON o.mobile10 = e.mobile;

COMMENT ON VIEW public.pl_press1_mis_outcome IS
  'Press-1 leads with whatever the lender MIS says happened to them. A VIEW, not columns on pl_press1_enriched: MIS advances daily and independently of pl_press1_enrich(). Sanction and disbursal for Hero come from crm.mis_hero_disbursal joined on lan_id - the Hero application feed carries NULL for both on all 2,464 rows it has ever sent, so without that join every Hero lead reads as unconverted. from_disbursal_report says which rows got their outcome that way. COVERAGE IS THE CAVEAT - mis_matched=false means "no MIS row we can tie to this mobile", never "did not convert".';

GRANT SELECT ON public.pl_press1_mis_outcome TO service_role;
