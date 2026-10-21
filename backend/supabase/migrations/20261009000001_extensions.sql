-- ===========================================================================
-- 01_extensions.sql
--
-- btree_gist : required for the EXCLUDE constraint that makes double-booking
--              impossible at the storage layer.
-- citext     : case-insensitive codes and emails, so "SAVE10" == "save10".
--
-- Both live in the `extensions` schema, which is Supabase's convention. The
-- `postgres` role's search_path is `"$user", public, extensions`, so the
-- unqualified type names below resolve during DDL. Types are still written
-- fully qualified in table definitions to stay correct under any search_path.
-- ===========================================================================

create extension if not exists btree_gist with schema extensions;
create extension if not exists citext     with schema extensions;
