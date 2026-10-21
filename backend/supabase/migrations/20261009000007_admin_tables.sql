-- ===========================================================================
-- 07_admin_tables.sql
-- audit_logs, login_attempts
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- audit_logs
-- Deliberately has NO foreign key on actor_id. If an account is deleted, the
-- audit trail of what that account did must survive - that is the whole point
-- of an audit log.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid,
  actor_role public.user_role,
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_created_idx
  on public.audit_logs (created_at desc);
create index if not exists audit_logs_entity_idx
  on public.audit_logs (entity, entity_id, created_at desc);

-- ---------------------------------------------------------------------------
-- login_attempts
-- Backs the brute-force lockout: count failures for an email in the last N
-- minutes. The index is shaped for exactly that query.
-- ---------------------------------------------------------------------------
create table if not exists public.login_attempts (
  id         uuid primary key default gen_random_uuid(),
  email      extensions.citext,
  succeeded  boolean not null,
  ip         inet,
  created_at timestamptz not null default now()
);

create index if not exists login_attempts_email_time_idx
  on public.login_attempts (email, created_at desc);

create index if not exists login_attempts_cleanup_idx
  on public.login_attempts (created_at);
