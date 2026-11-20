create table replacement_register.workflow_instances (
  workflow_id uuid primary key,
  workflow_key text not null unique,
  order_no text not null,order_key text not null,
  supplier text not null,supplier_key text not null,
  product_decimal_no text not null,product_key text not null,
  product text not null,
  check(length(order_key)>0 and length(product_key)>0)
);
create index workflow_instance_scope_idx on replacement_register.workflow_instances(order_key,supplier_key,product_key);
create table replacement_register.proposal_rounds (
  round_id uuid primary key,
  ordinal bigserial not null unique,
  workflow_id uuid not null references replacement_register.workflow_instances(workflow_id),
  round_key text not null,
  round_label text,
  created_at timestamptz not null,
  unique(workflow_id,round_key)
);
create table replacement_register.workflow_exchanges (
  exchange_id uuid primary key,
  ordinal bigserial not null unique,
  round_id uuid not null references replacement_register.proposal_rounds(round_id),
  origin_key text not null unique,
  audit_id bigint not null references replacement_register.audit_events(id),
  module_id text,
  kind text not null,
  occurred_at timestamptz not null,
  payload jsonb not null
);
create index workflow_exchange_round_idx on replacement_register.workflow_exchanges(round_id,ordinal desc);
create table replacement_register.proposal_alternatives (
  alternative_id uuid primary key,
  workflow_id uuid not null references replacement_register.workflow_instances(workflow_id),
  original_key text not null,
  alternative_key text not null,
  orig_mfr text not null,orig_pn text not null,
  alt_mfr text not null,alt_pn text not null,
  unique(workflow_id,original_key,alternative_key)
);
create table replacement_register.proposal_snapshots (
  snapshot_id uuid primary key,
  ordinal bigserial not null unique,
  exchange_id uuid not null references replacement_register.workflow_exchanges(exchange_id),
  proposal_id text not null,
  phase text not null check(phase in ('BEFORE','AFTER','EXPORTED')),
  alternative_id uuid references replacement_register.proposal_alternatives(alternative_id),
  snapshot_hash text not null check(length(snapshot_hash)=64),
  snapshot_json jsonb not null,
  unique(exchange_id,proposal_id,phase)
);
create index proposal_snapshot_subject_idx on replacement_register.proposal_snapshots(proposal_id,ordinal desc);
create index proposal_snapshot_exchange_idx on replacement_register.proposal_snapshots(exchange_id,ordinal);
create trigger workflow_instances_immutable before update or delete or truncate on replacement_register.workflow_instances for each statement execute function replacement_register.reject_event_changes();
create trigger proposal_rounds_immutable before update or delete or truncate on replacement_register.proposal_rounds for each statement execute function replacement_register.reject_event_changes();
create trigger workflow_exchanges_immutable before update or delete or truncate on replacement_register.workflow_exchanges for each statement execute function replacement_register.reject_event_changes();
create trigger proposal_alternatives_immutable before update or delete or truncate on replacement_register.proposal_alternatives for each statement execute function replacement_register.reject_event_changes();
create trigger proposal_snapshots_immutable before update or delete or truncate on replacement_register.proposal_snapshots for each statement execute function replacement_register.reject_event_changes();
insert into replacement_register.schema_migrations(version) values('016_workflow_rounds');
