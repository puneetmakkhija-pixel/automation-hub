-- 006_payday_function_search_path.sql
-- Pins the trigger function's search_path (Supabase advisor: function_search_path_mutable).
-- 003 now creates the function this way; this migration fixes databases where 003 already ran.
alter function payday.set_updated_at() set search_path = '';
