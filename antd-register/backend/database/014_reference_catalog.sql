create table replacement_register.reference_catalog (
  singleton boolean primary key default true check(singleton),
  revision integer not null check(revision>0),
  catalog_hash text not null check(catalog_hash ~ '^[a-f0-9]{64}$'),
  catalog_json jsonb not null,
  updated_at timestamptz not null default now()
);
create table replacement_register.reference_revisions (
  revision integer primary key check(revision>0),
  catalog_hash text not null check(catalog_hash ~ '^[a-f0-9]{64}$'),
  catalog_json jsonb not null,
  actor text not null,
  actor_user_id uuid,
  reason text not null check(length(trim(reason))>0),
  change_json jsonb not null,
  created_at timestamptz not null default now()
);
create trigger reference_revisions_append_only before update or delete or truncate on replacement_register.reference_revisions
for each statement execute function replacement_register.reject_event_changes();
insert into replacement_register.schema_migrations(version) values('014_reference_catalog');
