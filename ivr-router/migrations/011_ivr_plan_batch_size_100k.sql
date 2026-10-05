-- A plan's hourly batch was capped at 20,000 people. A one-lakh base dialled in a single hourly batch needs 100,000.
-- Applied to production via apply_migration; this file is the record. The panel's input limit (public/campaigns.html) matches.
alter table crm.ivr_plan drop constraint ivr_plan_batch_size_check;
alter table crm.ivr_plan add constraint ivr_plan_batch_size_check check (batch_size between 1 and 100000);
