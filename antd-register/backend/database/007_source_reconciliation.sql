alter table replacement_register.proposals add column if not exists raw_source_json jsonb;
alter table replacement_register.proposals add column if not exists normalized_json jsonb not null default '{}';
alter table replacement_register.proposals add column if not exists historical_reference text not null default '';
alter table replacement_register.proposals add column if not exists historical_date date;
alter table replacement_register.proposals add column if not exists notes text not null default '';
alter table replacement_register.replacement_records add column if not exists raw_source_json jsonb;
alter table replacement_register.replacement_records add column if not exists normalized_json jsonb not null default '{}';
create table if not exists replacement_register.source_bindings (
  entity_kind text not null check(entity_kind in ('proposal','replacement')),
  source_identity text not null,
  target_id text not null,
  baseline_json jsonb not null,
  source_hash text not null,
  primary key(entity_kind,source_identity),
  unique(entity_kind,target_id)
);
create table if not exists replacement_register.source_versions (
  entity_kind text not null,
  source_identity text not null,
  source_hash text not null,
  source_sheet text not null,
  source_row integer,
  source_json jsonb not null,
  raw_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key(entity_kind,source_identity,source_hash)
);
create table if not exists replacement_register.migration_conflicts (
  conflict_id uuid primary key,
  source_hash text not null,
  entity_kind text not null,
  source_identity text not null,
  target_id text,
  findings_json jsonb not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_json jsonb
);
insert into replacement_register.schema_migrations(version) values ('007_source_reconciliation') on conflict do nothing;
