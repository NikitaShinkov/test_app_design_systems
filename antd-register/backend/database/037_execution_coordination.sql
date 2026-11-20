-- Operational execution reservations, separate from durable business receipts.
-- No time-based expiry releases a reservation. No existing business data changes.
create table replacement_register.execution_instances (
  instance_id uuid primary key,
  host_id uuid not null,
  process_id integer not null check (process_id > 0),
  role text not null check (role in ('api','worker','combined')),
  application_hash text not null check (application_hash ~ '^[a-f0-9]{64}$'),
  store_id uuid not null,
  config_fingerprint text not null check (config_fingerprint ~ '^[a-f0-9]{64}$'),
  config_json jsonb not null check (jsonb_typeof(config_json) = 'object'),
  control_backend_pid integer not null check (control_backend_pid > 0),
  control_backend_start timestamptz not null,
  database_name text not null check (length(database_name) > 0),
  database_user text not null check (length(database_user) > 0),
  state text not null check (state in ('READY','DRAINING','STOPPED')),
  registered_at timestamptz not null default clock_timestamp(),
  heartbeat_at timestamptz not null default clock_timestamp(),
  stopped_at timestamptz,
  unique (control_backend_pid, control_backend_start, database_name),
  check ((state = 'STOPPED') = (stopped_at is not null))
);
create index execution_instances_readiness_idx on replacement_register.execution_instances(role, state, heartbeat_at);
create table replacement_register.execution_permits (
  permit_id uuid primary key,
  instance_id uuid not null references replacement_register.execution_instances(instance_id),
  owner_key text not null check (length(owner_key) between 1 and 256),
  permit_token uuid not null unique,
  state text not null check (state in ('ACTIVE','RELEASED','RECOVERED')),
  acquired_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  recovered_by_instance_id uuid references replacement_register.execution_instances(instance_id) deferrable initially deferred,
  check ((state = 'ACTIVE') = (released_at is null)),
  check ((state = 'RECOVERED') = (recovered_by_instance_id is not null))
);
create index execution_permits_active_idx on replacement_register.execution_permits(permit_id) where state = 'ACTIVE';
create index execution_permits_owner_idx on replacement_register.execution_permits(owner_key) where state = 'ACTIVE';
create index execution_permits_instance_idx on replacement_register.execution_permits(instance_id) where state = 'ACTIVE';
insert into replacement_register.schema_migrations(version) values ('037_execution_coordination');
