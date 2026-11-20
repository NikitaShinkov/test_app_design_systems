create table if not exists replacement_register.lifecycle_records (
  record_id text primary key,
  original_key text not null,
  supplier_key text not null,
  order_no text not null,
  supplier text not null,
  payload jsonb not null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(original_key,supplier_key),
  check(payload->>'decisionStatus'='OBSOLETE')
);
create index if not exists lifecycle_order_idx on replacement_register.lifecycle_records(order_no);
insert into replacement_register.schema_migrations(version) values ('009_lifecycle_records') on conflict do nothing;
