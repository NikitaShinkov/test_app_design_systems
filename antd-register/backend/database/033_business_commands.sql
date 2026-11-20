-- Confirmed business intent. No cookies, session verifiers or credentials are stored.
create table replacement_register.business_command_jobs (
  command_id uuid primary key,
  ordinal bigserial not null unique,
  owner_key text not null check(length(owner_key) between 1 and 200),
  owner_json jsonb not null check(jsonb_typeof(owner_json)='object'
    and owner_json-array['authenticated','userId','role','actor','organization','orders']='{}'::jsonb),
  idempotency_key text not null check(idempotency_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  descriptor jsonb not null check(jsonb_typeof(descriptor)='object'),
  module_id text not null check(module_id in ('M02','M04','M08','M10','M90','M91')),
  status text not null check(status in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempts integer not null default 0 check(attempts between 0 and 3),
  lease_token uuid,
  lease_until timestamptz,
  progress jsonb not null default '{"phase":"Queued"}' check(jsonb_typeof(progress)='object'),
  result_json jsonb,
  error_json jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(owner_key,idempotency_key),
  constraint business_command_descriptor_kind check(coalesce(
    (descriptor->>'kind'='IMPORT_COMMIT' and module_id in ('M02','M04','M08')
      and (descriptor->>'batchId') ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      and jsonb_typeof(descriptor->'revision')='number' and (descriptor->>'revision') ~ '^[1-9][0-9]*$'
      and (descriptor->>'revision')::numeric<=2147483647
      and jsonb_typeof(descriptor->'acceptFindings')='boolean'
      and descriptor-array['kind','batchId','revision','acceptFindings']='{}'::jsonb)
    or (descriptor->>'kind'='WORKFLOW' and module_id in ('M10','M90','M91')
      and descriptor->>'moduleId'=module_id and jsonb_typeof(descriptor->'options')='object'
      and (descriptor->'options')-'orderNo'='{}'::jsonb
      and descriptor-array['kind','moduleId','options']='{}'::jsonb),false)),
  constraint business_command_lease_state check((status='RUNNING' and lease_token is not null and lease_until is not null)
    or (status<>'RUNNING' and lease_token is null and lease_until is null)),
  constraint business_command_result_state check((status='SUCCEEDED' and result_json is not null and jsonb_typeof(result_json)='object')
    or (status<>'SUCCEEDED' and result_json is null)),
  constraint business_command_error_state check((status='FAILED' and error_json is not null and jsonb_typeof(error_json)='object')
    or (status<>'FAILED' and error_json is null)),
  check(attempts>0 or status in ('QUEUED','CANCELLED')),
  check(updated_at>=created_at)
);
create index business_command_queue_idx on replacement_register.business_command_jobs(created_at,command_id)
  where status in ('QUEUED','RUNNING');
create index business_command_owner_page_idx on replacement_register.business_command_jobs(owner_key,ordinal desc);
create table replacement_register.business_command_receipts (
  command_id uuid primary key references replacement_register.business_command_jobs(command_id),
  owner_key text not null,
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  request_json jsonb not null check(jsonb_typeof(request_json)='object'),
  result_hash text not null check(result_hash ~ '^[a-f0-9]{64}$'),
  result_json jsonb not null check(jsonb_typeof(result_json)='object'),
  occurred_at timestamptz not null default clock_timestamp()
);
create function replacement_register.protect_business_command_job() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then raise exception 'Business commands are retained'; end if;
  if (to_jsonb(NEW)-array['status','attempts','lease_token','lease_until','progress','result_json','error_json','updated_at']) is distinct from
     (to_jsonb(OLD)-array['status','attempts','lease_token','lease_until','progress','result_json','error_json','updated_at']) then
    raise exception 'Confirmed business command intent is immutable';
  end if;
  if OLD.status in ('SUCCEEDED','CANCELLED') then raise exception 'Terminal business commands are retained'; end if;
  if NEW.attempts<>OLD.attempts then
    if NEW.status<>'RUNNING' or NEW.attempts<>OLD.attempts+1 or
       not (OLD.status='QUEUED' or (OLD.status='RUNNING' and OLD.lease_until<=clock_timestamp())) then
      raise exception 'Business command attempts advance only on a valid claim';
    end if;
  elsif OLD.status='QUEUED' and NEW.status='RUNNING' then raise exception 'Business command claim must advance its attempt';
  end if;
  if not ((OLD.status='QUEUED' and NEW.status in ('RUNNING','CANCELLED'))
    or (OLD.status='RUNNING' and NEW.status in ('RUNNING','SUCCEEDED','FAILED','CANCELLED'))
    or (OLD.status='FAILED' and NEW.status='QUEUED')) then raise exception 'Invalid business command transition'; end if;
  if OLD.status='RUNNING' and NEW.status='RUNNING' and NEW.attempts=OLD.attempts and NEW.lease_token is distinct from OLD.lease_token then
    raise exception 'A heartbeat cannot replace a command lease';
  end if;
  if OLD.status='FAILED' and NEW.status='QUEUED' and
     (not coalesce((OLD.error_json->>'retryable')::boolean,false) or OLD.attempts>=3) then
    raise exception 'Only an eligible interrupted command can be retried';
  end if;
  return NEW;
end $$;
create trigger business_command_job_guard before update or delete on replacement_register.business_command_jobs
  for each row execute function replacement_register.protect_business_command_job();
create trigger business_command_jobs_retained before truncate on replacement_register.business_command_jobs
  for each statement execute function replacement_register.reject_event_changes();
create trigger business_command_receipts_immutable before update or delete or truncate on replacement_register.business_command_receipts
  for each statement execute function replacement_register.reject_event_changes();
create function replacement_register.check_business_command_receipt() returns trigger language plpgsql as $$
begin
  if NEW.status='SUCCEEDED' and not exists(select 1 from replacement_register.business_command_receipts r
    where r.command_id=NEW.command_id and r.owner_key=NEW.owner_key and r.request_hash=NEW.request_hash
      and r.request_json=NEW.descriptor and r.result_json=NEW.result_json) then
    raise exception 'Succeeded business command requires its matching immutable receipt';
  end if;
  return null;
end $$;
create constraint trigger business_command_success_receipt after insert or update on replacement_register.business_command_jobs
  deferrable initially deferred for each row execute function replacement_register.check_business_command_receipt();
create function replacement_register.check_business_command_publication() returns trigger language plpgsql as $$
begin
  if not exists(select 1 from replacement_register.business_command_jobs j where j.command_id=NEW.command_id
    and j.status='SUCCEEDED' and j.owner_key=NEW.owner_key and j.request_hash=NEW.request_hash
    and j.descriptor=NEW.request_json and j.result_json=NEW.result_json) then
    raise exception 'Business command receipt requires its matching succeeded command';
  end if;
  return null;
end $$;
create constraint trigger business_command_receipt_success after insert on replacement_register.business_command_receipts
  deferrable initially deferred for each row execute function replacement_register.check_business_command_publication();
insert into replacement_register.schema_migrations(version) values ('033_business_commands');
