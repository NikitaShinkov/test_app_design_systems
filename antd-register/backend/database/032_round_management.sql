-- Lifecycle/association overlays only. Observed history tables remain unchanged.
create table replacement_register.approval_round_heads (
  round_id uuid primary key,
  ordinal bigserial not null unique,
  workflow_id uuid not null references replacement_register.workflow_instances(workflow_id),
  round_key text not null check(length(round_key)>0),
  round_label text not null check(length(round_label) between 1 and 100),
  status text not null check(status in ('OPEN','CLOSED','CANCELLED')),
  version bigint not null check(version>0),
  created_at timestamptz not null,updated_at timestamptz not null,
  last_event_id uuid not null,
  closure_baseline jsonb,
  unique(workflow_id,round_key),
  check((status='OPEN' and closure_baseline is null) or
    (status<>'OPEN' and coalesce(jsonb_typeof(closure_baseline)='object'
      and (closure_baseline->>'observedExchangeCount') ~ '^\d+$'
      and (closure_baseline->>'associationEventCount') ~ '^\d+$',false)))
);
create table replacement_register.approval_round_events (
  event_id uuid primary key,ordinal bigserial not null unique,
  round_id uuid not null references replacement_register.approval_round_heads(round_id),
  version bigint not null check(version>0),event_json jsonb not null,
  unique(round_id,version),
  check(coalesce(jsonb_typeof(event_json)='object' and event_json->>'eventId'=event_id::text
    and event_json->>'roundId'=round_id::text and (event_json->>'version')::bigint=version
    and event_json->>'action' in ('CREATE','ADOPT','CLOSE','CANCEL','REOPEN')
    and length(event_json->>'reason') between 1 and 2000,false))
);
alter table replacement_register.approval_round_heads add constraint approval_round_last_event_fk
  foreign key(last_event_id) references replacement_register.approval_round_events(event_id) deferrable initially deferred;
create table replacement_register.round_exchange_associations (
  exchange_id uuid primary key references replacement_register.workflow_exchanges(exchange_id),
  round_id uuid references replacement_register.approval_round_heads(round_id),
  version bigint not null check(version>0),updated_at timestamptz not null,last_event_id uuid not null
);
create index round_association_target_idx on replacement_register.round_exchange_associations(round_id,exchange_id);
create table replacement_register.round_association_events (
  event_id uuid primary key,ordinal bigserial not null unique,
  exchange_id uuid not null references replacement_register.workflow_exchanges(exchange_id),
  workflow_id uuid not null references replacement_register.workflow_instances(workflow_id),
  from_round_id uuid references replacement_register.approval_round_heads(round_id),
  to_round_id uuid references replacement_register.approval_round_heads(round_id),
  version bigint not null check(version>0),event_json jsonb not null,
  unique(exchange_id,version),
  check(coalesce(jsonb_typeof(event_json)='object' and event_json->>'eventId'=event_id::text
    and event_json->>'exchangeId'=exchange_id::text and (event_json->>'version')::bigint=version
    and length(event_json->>'reason') between 1 and 2000,false))
);
alter table replacement_register.round_exchange_associations add constraint round_association_last_event_fk
  foreign key(last_event_id) references replacement_register.round_association_events(event_id) deferrable initially deferred;
create index round_association_activity_idx on replacement_register.round_association_events(to_round_id,from_round_id);
create table replacement_register.round_management_receipts (
  owner_key text not null,request_id uuid not null,request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  kind text not null check(kind in ('LIFECYCLE','ASSOCIATION')),request_json jsonb not null,payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),primary key(owner_key,request_id),
  check(jsonb_typeof(payload)='object'),
  constraint round_receipt_request_identity check(coalesce(jsonb_typeof(request_json)='object'
    and request_json->>'requestId'=request_id::text and payload->>'requestId'=request_id::text
    and payload->>'action'=request_json->>'action'
    and ((kind='LIFECYCLE' and request_json->>'action' in ('CREATE','ADOPT','CLOSE','CANCEL','REOPEN'))
      or (kind='ASSOCIATION' and request_json->>'action' in ('ASSOCIATE','UNASSIGN') and payload->>'requestHash'=request_hash)),false))
);
create function replacement_register.protect_round_management_head() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then raise exception 'Round management heads are retained'; end if;
  if NEW.version<>OLD.version+1 then raise exception 'Round management versions must advance exactly once'; end if;
  if TG_TABLE_NAME='approval_round_heads' then
    if (to_jsonb(NEW)-array['version','status','updated_at','last_event_id','closure_baseline']) is distinct from
       (to_jsonb(OLD)-array['version','status','updated_at','last_event_id','closure_baseline']) then
      raise exception 'Round management identity is immutable';
    end if;
    if not ((OLD.status='OPEN' and NEW.status in ('CLOSED','CANCELLED')) or
            (OLD.status in ('CLOSED','CANCELLED') and NEW.status='OPEN')) then
      raise exception 'Invalid round lifecycle transition';
    end if;
  elsif NEW.exchange_id<>OLD.exchange_id then raise exception 'Association source identity is immutable';
  end if;
  return NEW;
end $$;
create trigger approval_round_head_guard before update or delete on replacement_register.approval_round_heads for each row execute function replacement_register.protect_round_management_head();
create trigger round_association_head_guard before update or delete on replacement_register.round_exchange_associations for each row execute function replacement_register.protect_round_management_head();
create trigger approval_round_head_retained before truncate on replacement_register.approval_round_heads for each statement execute function replacement_register.reject_event_changes();
create trigger round_association_head_retained before truncate on replacement_register.round_exchange_associations for each statement execute function replacement_register.reject_event_changes();
create trigger approval_round_events_immutable before update or delete or truncate on replacement_register.approval_round_events for each statement execute function replacement_register.reject_event_changes();
create trigger round_association_events_immutable before update or delete or truncate on replacement_register.round_association_events for each statement execute function replacement_register.reject_event_changes();
create trigger round_management_receipts_immutable before update or delete or truncate on replacement_register.round_management_receipts for each statement execute function replacement_register.reject_event_changes();
insert into replacement_register.schema_migrations(version) values('032_round_management');
