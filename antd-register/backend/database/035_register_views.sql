-- Personal register preferences only; no proposal or historical rows are changed.
create table replacement_register.register_views (
  view_id uuid primary key,
  owner_key text not null check(length(owner_key)>0),
  owner_user_id uuid references replacement_register.users(user_id),
  owner_role text not null check(owner_role in ('ADMINISTRATOR','SUPPLIER','CLIENT')),
  register_kind text not null check(register_kind in ('proposals','database')),
  name text not null check(length(name) between 1 and 120),
  name_key text not null check(length(name_key)>0),
  version bigint not null check(version between 1 and 9007199254740991),
  view_json jsonb not null,
  active boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null check(updated_at>=created_at),
  last_event_id uuid not null,
  check((owner_user_id is not null and owner_key='USER:'||owner_user_id::text)
    or (owner_user_id is null and left(owner_key,8)='PREVIEW:')),
  constraint register_view_config_shape check(coalesce(jsonb_typeof(view_json)='object'
    and view_json ?& array['filters','sort','direction','pageSize']
    and view_json-array['filters','sort','direction','pageSize']='{}'::jsonb
    and jsonb_typeof(view_json->'filters')='object'
    and view_json->'filters' ?& array['search','orderNo','product','supplier','decision','columnFilters']
    and (view_json->'filters')-array['search','orderNo','product','supplier','decision','columnFilters']='{}'::jsonb
    and jsonb_typeof(view_json->'filters'->'search')='string'
    and jsonb_typeof(view_json->'filters'->'orderNo')='string'
    and jsonb_typeof(view_json->'filters'->'product')='string'
    and jsonb_typeof(view_json->'filters'->'supplier')='string'
    and jsonb_typeof(view_json->'filters'->'decision')='string'
    and jsonb_typeof(view_json->'filters'->'columnFilters')='array'
    and view_json->>'sort' in ('id','order','product','supplier','original','alternative','decision','date','workflow')
    and not(register_kind='proposals' and view_json->>'sort'='date')
    and not(register_kind='database' and view_json->>'sort'='workflow')
    and view_json->>'direction' in ('asc','desc')
    and jsonb_typeof(view_json->'pageSize')='number'
    and (view_json->>'pageSize')::integer between 1 and 200,false))
);
create unique index register_view_active_name_idx on replacement_register.register_views(owner_key,register_kind,name_key) where active;
create index register_view_owner_page_idx on replacement_register.register_views(owner_key,register_kind,view_id) where active;
create table replacement_register.register_view_events (
  event_id uuid primary key,
  owner_key text not null,
  request_id uuid not null,
  view_id uuid not null references replacement_register.register_views(view_id),
  version bigint not null check(version between 1 and 9007199254740991),
  action text not null check(action in ('CREATE','UPDATE','DELETE')),
  before_json jsonb,
  after_json jsonb not null check(jsonb_typeof(after_json)='object'),
  audit_event_id bigint not null references replacement_register.audit_events(id),
  actor_user_id uuid references replacement_register.users(user_id),
  actor_role text not null check(actor_role in ('ADMINISTRATOR','SUPPLIER','CLIENT')),
  created_at timestamptz not null,
  unique(view_id,version),unique(owner_key,request_id),
  check(coalesce(after_json->>'viewId'=view_id::text and (after_json->>'version')::bigint=version
    and ((version=1 and action='CREATE' and before_json is null and (after_json->>'active')::boolean)
      or (version>1 and action in ('UPDATE','DELETE') and jsonb_typeof(before_json)='object'
        and (before_json->>'version')::bigint=version-1
        and (before_json->>'active')::boolean
        and (after_json->>'active')::boolean=(action='UPDATE'))),false))
);
alter table replacement_register.register_views add constraint register_view_last_event_fk
  foreign key(last_event_id) references replacement_register.register_view_events(event_id) deferrable initially deferred;
create table replacement_register.register_view_receipts (
  owner_key text not null,
  request_id uuid not null,
  event_id uuid not null unique references replacement_register.register_view_events(event_id),
  request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
  request_json jsonb not null check(jsonb_typeof(request_json)='object'),
  result_hash text not null check(result_hash ~ '^[a-f0-9]{64}$'),
  result_json jsonb not null check(jsonb_typeof(result_json)='object'),
  created_at timestamptz not null,
  primary key(owner_key,request_id),
  check(coalesce(request_json->>'requestId'=request_id::text and result_json->>'requestId'=request_id::text
    and request_json->>'action'=result_json->>'action'
    and request_json->>'action' in ('CREATE','UPDATE','DELETE')
    and request_json->>'viewId'=result_json->'item'->>'viewId'
    and (request_json->>'expectedVersion')::bigint+1=(result_json->'item'->>'version')::bigint,false))
);
create function replacement_register.register_view_snapshot(v replacement_register.register_views) returns jsonb language sql immutable as $$
  select jsonb_build_object('viewId',v.view_id::text,'registerKind',v.register_kind,'name',v.name,
    'version',v.version,'view',v.view_json,'active',v.active,
    'createdAt',to_char(v.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt',to_char(v.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
$$;
create function replacement_register.register_view_audit_snapshot(v jsonb) returns jsonb language sql immutable as $$
  select case when v is null then null else jsonb_build_object('viewId',v->'viewId',
    'registerKind',v->'registerKind','version',v->'version','active',v->'active') end;
$$;
create function replacement_register.protect_register_view_head() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then raise exception 'Saved register view history is retained'; end if;
  if not OLD.active then raise exception 'Deleted register views are retained'; end if;
  if NEW.version<>OLD.version+1 then raise exception 'Register view versions advance exactly once'; end if;
  if NEW.updated_at<OLD.updated_at then raise exception 'Register view timestamps cannot move backwards'; end if;
  if (to_jsonb(NEW)-array['name','name_key','version','view_json','active','updated_at','last_event_id']) is distinct from
     (to_jsonb(OLD)-array['name','name_key','version','view_json','active','updated_at','last_event_id']) then
    raise exception 'Register view owner and target identity are immutable';
  end if;
  return NEW;
end $$;
create trigger register_view_head_guard before update or delete on replacement_register.register_views
  for each row execute function replacement_register.protect_register_view_head();
create trigger register_views_retained before truncate on replacement_register.register_views
  for each statement execute function replacement_register.reject_event_changes();
create trigger register_view_events_immutable before update or delete or truncate on replacement_register.register_view_events
  for each statement execute function replacement_register.reject_event_changes();
create trigger register_view_receipts_immutable before update or delete or truncate on replacement_register.register_view_receipts
  for each statement execute function replacement_register.reject_event_changes();
create function replacement_register.check_register_view_head() returns trigger language plpgsql as $$
declare e replacement_register.register_view_events;
begin
  select * into e from replacement_register.register_view_events where event_id=NEW.last_event_id;
  if e.event_id is null or e.view_id is distinct from NEW.view_id or e.owner_key is distinct from NEW.owner_key
    or e.version is distinct from NEW.version or e.after_json is distinct from replacement_register.register_view_snapshot(NEW) then
    raise exception 'Saved register view requires its matching immutable event';
  end if;
  if TG_OP='INSERT' then
    if e.action<>'CREATE' or NEW.version<>1 or not NEW.active then raise exception 'A saved view starts at its create event'; end if;
  elsif e.before_json is distinct from replacement_register.register_view_snapshot(OLD) then
    raise exception 'Saved register view previous version differs from its event';
  end if;
  return null;
end $$;
create constraint trigger register_view_head_publication after insert or update on replacement_register.register_views
  deferrable initially deferred for each row execute function replacement_register.check_register_view_head();
create function replacement_register.check_register_view_event() returns trigger language plpgsql as $$
declare h replacement_register.register_views; a replacement_register.audit_events; r replacement_register.register_view_receipts; previous jsonb;
begin
  select * into h from replacement_register.register_views where view_id=NEW.view_id;
  select * into a from replacement_register.audit_events where id=NEW.audit_event_id;
  select * into r from replacement_register.register_view_receipts where event_id=NEW.event_id;
  if h.view_id is null or NEW.owner_key is distinct from h.owner_key or NEW.version>h.version
    or NEW.after_json->>'registerKind' is distinct from h.register_kind
    or NEW.actor_user_id is distinct from h.owner_user_id
    or (h.owner_user_id is null and NEW.actor_role is distinct from h.owner_role) then raise exception 'Saved view event owner or version is invalid'; end if;
  if NEW.version>1 then
    select after_json into previous from replacement_register.register_view_events where view_id=NEW.view_id and version=NEW.version-1;
    if previous is null or previous is distinct from NEW.before_json then raise exception 'Saved view event chain is incomplete'; end if;
  end if;
  if a.id is null or a.action is distinct from 'REGISTER_VIEW_'||NEW.action or a.subject is distinct from NEW.view_id::text
    or a.actor_user_id is distinct from NEW.actor_user_id or a.actor_role is distinct from NEW.actor_role
    or a.request_id is distinct from NEW.request_id
    or a.before_json is distinct from replacement_register.register_view_audit_snapshot(NEW.before_json)
    or a.after_json is distinct from replacement_register.register_view_audit_snapshot(NEW.after_json) then
    raise exception 'Saved register view event requires its exact audit entry';
  end if;
  if r.event_id is null or r.owner_key is distinct from NEW.owner_key or r.request_id is distinct from NEW.request_id
    or r.request_json->>'viewId' is distinct from NEW.view_id::text or r.request_json->>'action' is distinct from NEW.action
    or (r.request_json->>'expectedVersion')::bigint is distinct from NEW.version-1
    or (NEW.action<>'DELETE' and (r.request_json->>'name' is distinct from NEW.after_json->>'name'
      or r.request_json->>'registerKind' is distinct from NEW.after_json->>'registerKind'
      or r.request_json->'view' is distinct from NEW.after_json->'view'))
    or r.result_json is distinct from jsonb_build_object('requestId',NEW.request_id::text,'action',NEW.action,'item',NEW.after_json) then
    raise exception 'Saved register view event requires its matching idempotent receipt';
  end if;
  return null;
end $$;
create constraint trigger register_view_event_publication after insert on replacement_register.register_view_events
  deferrable initially deferred for each row execute function replacement_register.check_register_view_event();
create function replacement_register.check_register_view_receipt() returns trigger language plpgsql as $$
declare e replacement_register.register_view_events;
begin
  select * into e from replacement_register.register_view_events where event_id=NEW.event_id;
  if e.event_id is null or NEW.owner_key is distinct from e.owner_key or NEW.request_id is distinct from e.request_id
    or NEW.result_json is distinct from jsonb_build_object('requestId',e.request_id::text,'action',e.action,'item',e.after_json) then
    raise exception 'Saved register view receipt requires its matching immutable event';
  end if;
  return null;
end $$;
create constraint trigger register_view_receipt_publication after insert on replacement_register.register_view_receipts
  deferrable initially deferred for each row execute function replacement_register.check_register_view_receipt();
insert into replacement_register.schema_migrations(version) values('035_register_views');
