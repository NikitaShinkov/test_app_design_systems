create table replacement_register.preparation_jobs (
  job_id uuid primary key,
  owner_key text not null,
  idempotency_key text not null,
  request_hash text not null,
  descriptor jsonb not null,
  status text not null check(status in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempts integer not null default 0 check(attempts between 0 and 3),
  lease_token uuid,
  lease_until timestamptz,
  progress jsonb not null default '{}',
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_key,idempotency_key)
);
create index preparation_claim_idx on replacement_register.preparation_jobs(created_at,job_id) where status in ('QUEUED','RUNNING');
create index preparation_owner_idx on replacement_register.preparation_jobs(owner_key,created_at desc);
create function replacement_register.protect_preparation_descriptor() returns trigger language plpgsql as $$
begin
  if new.descriptor is distinct from old.descriptor or new.owner_key is distinct from old.owner_key
    or new.idempotency_key is distinct from old.idempotency_key or new.request_hash is distinct from old.request_hash
    or new.created_at is distinct from old.created_at or new.job_id is distinct from old.job_id then
    raise exception 'Preparation request and ownership are immutable';
  end if;
  return new;
end;
$$;
create trigger preparation_descriptor_immutable before update on replacement_register.preparation_jobs for each row execute function replacement_register.protect_preparation_descriptor();
insert into replacement_register.schema_migrations(version) values('025_preparation_queue');
