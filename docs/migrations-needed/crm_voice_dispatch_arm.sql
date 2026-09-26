-- crm.voice_dispatch: the bot A/B split's labels as real columns.
--
-- OPTIONAL. Not applied by ivr-router and nothing depends on it. Since the
-- split (BOT_SPLIT_MODE=split in ivr-router) every dispatch row already carries
-- its labels in the existing `raw` jsonb column:
--
--   raw->>'arm'              'ours' | 'oriserve'   -- the ASSIGNED arm
--   raw->>'voice_variant'    'A' | 'B'             -- our arm only
--   raw->>'fallback_reason'  why a press assigned to our arm was handed to
--                            Oriserve: dial_queue_full, daily_cap,
--                            not_configured, or journey-run's own refusal
--
-- The keys are absent on rows written without the split, so these columns
-- read NULL there. Intent-to-treat: group by `arm`, not by `provider` -- a
-- fallback row is provider='oriserve', arm='ours'.
--
-- Generated from raw rather than written by ivr-router, so an insert can never
-- fail on a column one environment has and another does not, and the columns
-- are populated for rows written before this ran.

alter table crm.voice_dispatch
  add column if not exists arm text
    generated always as (raw->>'arm') stored,
  add column if not exists voice_variant text
    generated always as (raw->>'voice_variant') stored,
  add column if not exists fallback_reason text
    generated always as (raw->>'fallback_reason') stored;

create index if not exists voice_dispatch_arm_created_at_idx
  on crm.voice_dispatch (arm, created_at)
  where arm is not null;
