-- A quiet night and a broken scope filter logged the same line. Now they don't.
--
-- THE PROBLEM
--
-- On the night of 05 Sep 2026 the enrichment cron ran clean and reported:
--
--   [enrich-press1] {"to":"2026-09-05","from":"2026-09-05",
--                    "note":"no personal-loan press-1 rows in range",
--                    "matched":0,"presses":0,"took_ms":151,"written":0}
--
-- That was correct. whatsapp_messages held 768 press-1 rows for the day, every
-- one of them a Business Loans campaign (AIBOAT_5SEP), and this function drops
-- businessloans on purpose because that product is enriched in the CRM.
--
-- But establishing that took a hand-written query against the source table. The
-- log line is identical whether:
--
--   1. nobody dialled a personal-loan campaign that day  (fine)
--   2. the IVR stopped recording presses at all          (an outage)
--   3. pl_press_lender() stopped recognising a lender    (a silent regression)
--
-- Case 3 is the one that bites. It has happened here before: until offerid=1351
-- was mapped, 3,740 Whistleloop presses read as 'unknown', and 04 Sep reported
-- ~952 Poonawalla presses against an actual ~4,568. A new offer id, a changed
-- shortener, a renamed campaign -- any of them silently empties this table while
-- the cron keeps exiting 0 and the log keeps saying the reassuring thing.
--
-- WHAT CHANGES
--
-- The counts either side of the filter are now reported, so the three cases read
-- differently without anyone querying anything:
--
--   press1_in_range   every digit='1' row in the window, before any filtering
--   presses           what survived, i.e. what was actually enriched
--   dropped_by_lender {"businessloans": 768} -- which product took them
--   dropped_bad_mobile rows whose number would not normalise to 10 digits
--
-- and `note` distinguishes "there was traffic, none of it ours" from "there was
-- no traffic at all", which is the distinction that matters at 4am.
--
-- Nothing about what gets enriched changes. This is reporting only: the same
-- rows go in and the same rows come out.

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
  -- Reporting only; see the header.
  v_all       bigint := 0;
  v_bad_mob   bigint := 0;
  v_by_lender jsonb  := '{}'::jsonb;
  v_note      text;
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

  -- Counted BEFORE the delete, because afterwards there is nothing left to
  -- count and "0 presses" is exactly the reading that needs explaining.
  SELECT count(*) INTO v_all FROM pl_press_scope;

  SELECT count(*) INTO v_bad_mob FROM pl_press_scope WHERE length(mobile) <> 10;

  SELECT coalesce(jsonb_object_agg(lender, n), '{}'::jsonb) INTO v_by_lender
    FROM (
      SELECT lender, count(*) AS n
        FROM pl_press_scope
       WHERE lender NOT IN ('poonawalla', 'herofincorp', 'unknown')
       GROUP BY lender
    ) d;

  DELETE FROM pl_press_scope
   WHERE lender NOT IN ('poonawalla', 'herofincorp', 'unknown')
      OR length(mobile) <> 10;

  SELECT count(*) INTO v_presses FROM pl_press_scope;

  IF v_presses = 0 THEN
    -- Three different facts, three different sentences.
    v_note := CASE
      WHEN v_all = 0 THEN
        'no press-1 rows AT ALL in range - nobody dialled, or the IVR stopped recording presses'
      WHEN v_by_lender <> '{}'::jsonb THEN
        'press-1 traffic existed but none of it was personal-loan; see dropped_by_lender'
      ELSE
        'press-1 traffic existed and every row was dropped on an unusable mobile number'
    END;

    RETURN jsonb_build_object(
      'from', v_from, 'to', v_to, 'presses', 0, 'written', 0, 'matched', 0,
      'press1_in_range',    v_all,
      'dropped_by_lender',  v_by_lender,
      'dropped_bad_mobile', v_bad_mob,
      'note', v_note,
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
    -- Reported on a good day too: a day where dropped_by_lender suddenly carries
    -- a lender that used to be enriched is the regression this exists to catch,
    -- and it would be invisible if the counts only appeared on an empty result.
    'press1_in_range',    v_all,
    'dropped_by_lender',  v_by_lender,
    'dropped_bad_mobile', v_bad_mob,
    'took_ms',    (extract(epoch from clock_timestamp() - v_started) * 1000)::int
  );
END;
$$;

COMMENT ON FUNCTION public.pl_press1_enrich(date, date, integer) IS
  'Rebuilds public.pl_press1_enriched for an IST day range from whatsapp_messages + fed.se_base. Idempotent; re-running refreshes the se_base snapshot. Reports press1_in_range and dropped_by_lender alongside presses so an empty result says WHY it is empty - a day nobody dialled personal loans reads differently from pl_press_lender() having stopped recognising a lender.';

GRANT EXECUTE ON FUNCTION public.pl_press1_enrich(date, date, integer) TO service_role;
