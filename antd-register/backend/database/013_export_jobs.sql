create table if not exists replacement_register.export_jobs (
  job_id uuid primary key,
  module_id text not null,
  owner_user_id uuid,
  owner_actor text not null,
  owner_role text not null,
  status text not null check(status in ('READY','APPROVED','COMPLETE')),
  snapshot_json jsonb not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists export_jobs_owner_idx on replacement_register.export_jobs(owner_user_id,created_at desc);
create or replace function replacement_register.protect_export_snapshot() returns trigger language plpgsql as $$
begin
  if new.snapshot_json is distinct from old.snapshot_json or new.module_id is distinct from old.module_id
    or new.owner_user_id is distinct from old.owner_user_id or new.owner_actor is distinct from old.owner_actor
    or new.owner_role is distinct from old.owner_role or new.created_at is distinct from old.created_at then
    raise exception 'Export snapshot and ownership are immutable';
  end if;
  return new;
end;
$$;
create trigger export_snapshot_immutable before update on replacement_register.export_jobs for each row execute function replacement_register.protect_export_snapshot();
insert into replacement_register.schema_migrations(version) values ('013_export_jobs') on conflict do nothing;
