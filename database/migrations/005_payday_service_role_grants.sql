-- 005_payday_service_role_grants.sql
-- On Supabase a new schema is not reachable through the API until its role is granted access.
-- payday-api connects with the service role, so grant that role, and ONLY that role.
--
-- Deliberately NOT granted: anon, authenticated. These tables hold PII (mobile, salary) and money
-- records; row-level security is on with no policies, and with no grants to those roles the public
-- API keys cannot read or write anything here even if the schema is exposed.
--
-- Guarded by a role check so it is a no-op on a plain Postgres (tests, scratch databases).
-- Also required, in the Supabase dashboard (not settable from SQL here): Project Settings -> Data API
-- -> Exposed schemas -> add `payday`, so PostgREST (and so supabase-js .schema('payday')) can see it.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema payday to service_role;
    grant all on all tables in schema payday to service_role;
    grant all on all sequences in schema payday to service_role;
    alter default privileges in schema payday grant all on tables to service_role;
    alter default privileges in schema payday grant all on sequences to service_role;
  end if;
end $$;
