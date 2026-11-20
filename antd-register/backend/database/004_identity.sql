create table if not exists replacement_register.users (
  user_id uuid primary key,
  login text not null unique check (login = lower(trim(login))),
  display_name text not null,
  role text not null check (role in ('ADMINISTRATOR','SUPPLIER','CLIENT')),
  organization text not null default '',
  password_hash text not null,
  enabled boolean not null default true,
  must_change_password boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  check (role = 'ADMINISTRATOR' or length(trim(organization)) > 0)
);
create table if not exists replacement_register.user_order_access (
  user_id uuid not null references replacement_register.users(user_id),
  order_no text not null check (length(trim(order_no)) > 0),
  primary key(user_id, order_no)
);
create table if not exists replacement_register.sessions (
  token_hash text primary key,
  user_id uuid not null references replacement_register.users(user_id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on replacement_register.sessions(user_id);
create index if not exists sessions_expiry_idx on replacement_register.sessions(expires_at);
create or replace function replacement_register.reject_event_changes() returns trigger language plpgsql as $$
begin
  raise exception 'Historical events are append-only';
end;
$$;
drop trigger if exists audit_append_only on replacement_register.audit_events;
create trigger audit_append_only before update or delete or truncate on replacement_register.audit_events
for each statement execute function replacement_register.reject_event_changes();
insert into replacement_register.schema_migrations(version) values ('004_identity') on conflict do nothing;
