\set ON_ERROR_STOP on

create schema if not exists replacement_register authorization current_user;

create table if not exists replacement_register.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists replacement_register.proposals (
  proposal_id text primary key,
  order_no text not null,
  supplier text not null,
  product text not null,
  product_code text not null default '',
  product_decimal_no text not null,
  production_order text not null default '',
  position text not null default '',
  orig_code text not null default '',
  orig_mfr text not null default '',
  orig_pn text not null,
  alt_mfr text not null default '',
  alt_pn text not null default '',
  supplier_reply text not null default '',
  supplier_comment text not null default '',
  component_status text not null default '',
  manufacturer_relationship text not null default '',
  client_decision text not null default '',
  client_comment text not null default '',
  responsible text not null default '',
  decision_reference text,
  decision_date date,
  historical_status text not null default 'NO HISTORY',
  workflow_status text not null default 'PRELIMINARY APPROVAL REQUIRED',
  can_record boolean not null default false,
  archived boolean not null default false,
  source_workbook_hash text,
  source_sheet text,
  source_row integer,
  normalization_version text not null default 'REPLACEMENT-REGISTER-CANONICAL-v1',
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(proposal_id, '') || ' ' || coalesce(order_no, '') || ' ' || coalesce(supplier, '') || ' ' ||
      coalesce(product, '') || ' ' || coalesce(product_decimal_no, '') || ' ' || coalesce(position, '') || ' ' ||
      coalesce(orig_code, '') || ' ' || coalesce(orig_mfr, '') || ' ' || coalesce(orig_pn, '') || ' ' ||
      coalesce(alt_mfr, '') || ' ' || coalesce(alt_pn, '') || ' ' || coalesce(client_decision, '') || ' ' ||
      coalesce(decision_reference, ''))
  ) stored,
  constraint proposals_decision_check check (client_decision in ('', 'APPROVED', 'REJECTED', 'DO NOT PURCHASE'))
);

create index if not exists proposals_order_idx on replacement_register.proposals(order_no);
create index if not exists proposals_product_idx on replacement_register.proposals(product_decimal_no);
create index if not exists proposals_decision_idx on replacement_register.proposals(client_decision);
create index if not exists proposals_search_idx on replacement_register.proposals using gin(search_text);

create table if not exists replacement_register.replacement_records (
  record_id text primary key,
  proposal_id text,
  order_no text not null,
  supplier text not null default '',
  product text not null default '',
  product_decimal_no text not null,
  product_code text not null default '',
  position text not null default '',
  orig_code text not null default '',
  orig_mfr text not null default '',
  orig_pn text not null,
  component_status text not null default '',
  alt_mfr text not null default '',
  alt_pn text not null default '',
  decision_status text not null check (decision_status in ('APPROVED', 'REJECTED')),
  production_order text not null default '',
  responsible text not null default '',
  decision_reference text,
  decision_date date,
  decision_comment text not null default '',
  notes text not null default '',
  source_workbook_hash text,
  source_sheet text,
  source_row integer,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_text tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(record_id, '') || ' ' || coalesce(order_no, '') || ' ' || coalesce(product, '') || ' ' ||
      coalesce(product_decimal_no, '') || ' ' || coalesce(orig_mfr, '') || ' ' || coalesce(orig_pn, '') || ' ' ||
      coalesce(alt_mfr, '') || ' ' || coalesce(alt_pn, '') || ' ' || coalesce(decision_reference, ''))
  ) stored
);

create index if not exists replacement_records_product_idx on replacement_register.replacement_records(product_decimal_no);
create index if not exists replacement_records_decision_idx on replacement_register.replacement_records(decision_status);
create index if not exists replacement_records_search_idx on replacement_register.replacement_records using gin(search_text);

create table if not exists replacement_register.decision_events (
  id bigserial primary key,
  proposal_id text not null references replacement_register.proposals(proposal_id),
  decision_status text not null check (decision_status in ('APPROVED', 'REJECTED')),
  responsible text not null check (length(trim(responsible)) > 0),
  decision_reference text,
  decision_date date not null,
  decision_comment text,
  created_at timestamptz not null default now()
);

create table if not exists replacement_register.audit_events (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor text not null,
  actor_role text not null default 'ADMINISTRATOR',
  action text not null,
  subject text not null,
  detail text not null default '',
  before_json jsonb,
  after_json jsonb
);

create index if not exists audit_events_time_idx on replacement_register.audit_events(occurred_at desc);

create table if not exists replacement_register.workflow_runs (
  id bigserial primary key,
  module_id text not null check (module_id ~ '^M(0[1-9]|1[01]|9[01])$'),
  occurred_at timestamptz not null default now(),
  actor text not null,
  actor_role text not null,
  result_json jsonb not null
);

insert into replacement_register.schema_migrations(version) values ('001_initial') on conflict do nothing;
