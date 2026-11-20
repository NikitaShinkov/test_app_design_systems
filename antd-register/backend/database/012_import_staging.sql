create table if not exists replacement_register.import_batches (
  batch_id uuid primary key,
  module_id text not null check(module_id in ('M02','M04','M08')),
  artifact_id uuid not null references replacement_register.artifacts(artifact_id),
  owner_user_id uuid,
  status text not null check(status in ('READY','PARSE_FAILED','COMMITTED')),
  revision integer not null check(revision>0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists import_batches_owner_idx on replacement_register.import_batches(owner_user_id,created_at desc);
create table if not exists replacement_register.import_batch_reviews (
  batch_id uuid not null references replacement_register.import_batches(batch_id),
  revision integer not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key(batch_id,revision)
);
create trigger import_reviews_append_only before update or delete or truncate on replacement_register.import_batch_reviews
  for each statement execute function replacement_register.reject_event_changes();
insert into replacement_register.schema_migrations(version) values ('012_import_staging') on conflict do nothing;
