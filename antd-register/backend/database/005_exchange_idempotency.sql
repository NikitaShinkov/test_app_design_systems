create table if not exists replacement_register.import_receipts (
  module_id text not null,
  source_hash text not null,
  scope text not null,
  filename text not null,
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key(module_id, source_hash, scope)
);
insert into replacement_register.schema_migrations(version) values ('005_exchange_idempotency') on conflict do nothing;
