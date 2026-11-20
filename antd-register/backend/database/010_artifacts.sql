create table if not exists replacement_register.artifacts (
  artifact_id uuid primary key,
  logical_key text not null,
  version integer not null,
  sha256 text not null,
  filename text not null,
  content_type text not null,
  bytes bigint not null,
  kind text not null,
  module_id text,
  scope_json jsonb not null,
  owner_user_id uuid,
  owner_actor text not null,
  owner_only boolean not null default false,
  scan_status text not null check(scan_status in ('CLEAN','PENDING','INFECTED','ERROR','GENERATED')),
  scan_detail text not null default '',
  created_at timestamptz not null default now(),
  unique(logical_key,version)
);
create index if not exists artifacts_scope_idx on replacement_register.artifacts using gin(scope_json);
create index if not exists artifacts_hash_idx on replacement_register.artifacts(sha256);
insert into replacement_register.schema_migrations(version) values ('010_artifacts') on conflict do nothing;
