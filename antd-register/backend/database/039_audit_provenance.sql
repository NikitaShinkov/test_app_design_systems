-- Additive audit metadata only. SQL NULL means historical metadata was not
-- recorded; JSONB literal null is invalid. No existing row is rewritten.
-- The database bound is UTF8 bytes of JSONB::text (including its whitespace),
-- which can exceed the helper's compact canonical representation.
create function replacement_register.audit_provenance_shape(value jsonb, keys text[])
returns boolean language plpgsql immutable as $$
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  return coalesce(value ?& keys and value-keys='{}'::jsonb,false);
end $$;

create function replacement_register.audit_provenance_uuid(value jsonb)
returns boolean language plpgsql immutable as $$
begin
  if jsonb_typeof(value) is distinct from 'string' then return false; end if;
  return coalesce(value#>>'{}' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$',false);
end $$;

-- Node net.isIP syntax, including an optional IPv6 zone. PostgreSQL inet
-- accepts some non-Node IPv4 forms and rejects zones, so do not cast to inet.
create function replacement_register.audit_provenance_ip(value jsonb)
returns boolean language plpgsql immutable as $$
declare
  address text; tail text; left_side text; right_side text; groups integer;
  ipv4 constant text := '^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$';
  hexgroups constant text := '^[a-fA-F0-9]{1,4}(:[a-fA-F0-9]{1,4})*$';
begin
  if jsonb_typeof(value) is distinct from 'string' then return false; end if;
  address := value#>>'{}';
  if address ~ ipv4 then return true; end if;
  if address !~ '^[a-fA-F0-9:.]+(%[0-9a-zA-Z.:-]+)?$' or position(':' in address)=0 then return false; end if;
  address := split_part(address,'%',1);
  if position('.' in address)>0 then
    tail := substring(address from '[^:]+$');
    if coalesce(tail ~ ipv4,false) is not true then return false; end if;
    address := left(address,length(address)-length(tail)) || '0:0';
  end if;
  if position('::' in address)=0 then
    return coalesce(address ~ hexgroups and cardinality(string_to_array(address,':'))=8,false);
  end if;
  left_side := split_part(address,'::',1); right_side := split_part(address,'::',2);
  if length(address)-length(replace(address,'::',''))<>2 then return false; end if;
  if (left_side<>'' and left_side !~ hexgroups) or (right_side<>'' and right_side !~ hexgroups) then return false; end if;
  groups := case when left_side='' then 0 else cardinality(string_to_array(left_side,':')) end
    + case when right_side='' then 0 else cardinality(string_to_array(right_side,':')) end;
  return groups<8;
end $$;

create function replacement_register.audit_provenance_label(value jsonb)
returns boolean language plpgsql immutable as $$
declare
  label text; units integer; point integer;
  -- Exact ECMAScript trim whitespace/line terminators; NUL and invalid
  -- surrogate scalar values cannot be represented in PostgreSQL JSONB.
  whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if jsonb_typeof(value) is distinct from 'string' then return false; end if;
  label := value#>>'{}'; units := length(label);
  if units>250 or length(btrim(label,whitespace))=0 then return false; end if;
  for point in 1..length(label) loop
    if ascii(substr(label,point,1))>65535 then units := units+1; end if;
  end loop;
  return units<=250;
end $$;

create function replacement_register.audit_provenance_identity(value jsonb)
returns boolean language plpgsql immutable as $$
begin
  if not replacement_register.audit_provenance_shape(value,array['kind','userId','role','label']) then return false; end if;
  case value->>'kind'
    when 'NAMED' then return coalesce(replacement_register.audit_provenance_uuid(value->'userId')
      and value->>'role' in ('ADMINISTRATOR','SUPPLIER','CLIENT') and replacement_register.audit_provenance_label(value->'label'),false);
    when 'PREVIEW' then return coalesce(value->'userId'='null'::jsonb
      and value->>'role' in ('ADMINISTRATOR','SUPPLIER','CLIENT') and replacement_register.audit_provenance_label(value->'label'),false);
    when 'MAINTENANCE' then return coalesce(value->'userId'='null'::jsonb
      and value->>'role'='SYSTEM' and replacement_register.audit_provenance_label(value->'label'),false);
    when 'UNKNOWN' then return coalesce(value->'userId'='null'::jsonb and value->'role'='null'::jsonb and value->'label'='null'::jsonb,false);
    else return false;
  end case;
end $$;

create function replacement_register.audit_provenance_agent(value jsonb)
returns boolean language plpgsql immutable as $$
declare agent text; point integer; codepoint integer;
begin
  if not replacement_register.audit_provenance_shape(value,array['value','state','sanitized','truncated']) then return false; end if;
  if (value->'sanitized' in ('true'::jsonb,'false'::jsonb) and value->'truncated' in ('true'::jsonb,'false'::jsonb)) is not true then return false; end if;
  if value->>'state' in ('ABSENT','INVALID') then
    return coalesce(value->'value'='null'::jsonb and value->'sanitized'='false'::jsonb and value->'truncated'='false'::jsonb,false);
  end if;
  if value->>'state' is distinct from 'PRESENT' or jsonb_typeof(value->'value') is distinct from 'string' then return false; end if;
  agent := value->>'value';
  if octet_length(convert_to(agent,'UTF8'))>512 then return false; end if;
  for point in 1..length(agent) loop
    codepoint := ascii(substr(agent,point,1));
    if codepoint<=31 or codepoint between 127 and 159 or codepoint in (8232,8233)
      or codepoint between 8234 and 8238 or codepoint between 8294 and 8297 then return false; end if;
  end loop;
  return true;
end $$;

create function replacement_register.audit_provenance_request(value jsonb)
returns boolean language plpgsql immutable as $$
begin
  if not replacement_register.audit_provenance_shape(value,array['serverRequestId','requestIdState','peerIp','peerState','sourceIp','addressSource','forwardedState','userAgent']) then return false; end if;
  if value->>'requestIdState'='VALID' then
    if not replacement_register.audit_provenance_uuid(value->'serverRequestId') then return false; end if;
  elsif value->>'requestIdState' in ('ABSENT','INVALID') then
    if value->'serverRequestId' is distinct from 'null'::jsonb then return false; end if;
  else return false; end if;
  if value->>'peerState'='VALID' then
    if not replacement_register.audit_provenance_ip(value->'peerIp') then return false; end if;
  elsif value->>'peerState' in ('ABSENT','INVALID') then
    if value->'peerIp' is distinct from 'null'::jsonb then return false; end if;
  else return false; end if;
  if (value->'sourceIp'='null'::jsonb or replacement_register.audit_provenance_ip(value->'sourceIp')) is not true then return false; end if;
  if (value->>'forwardedState' in ('USED','ABSENT','INVALID','IGNORED')) is not true then return false; end if;
  case value->>'addressSource'
    when 'TRUSTED_LOOPBACK_X_REAL_IP' then
      if (value->>'peerIp' in ('127.0.0.1','::1','::ffff:127.0.0.1') and value->>'forwardedState'='USED'
        and replacement_register.audit_provenance_ip(value->'sourceIp')) is not true then return false; end if;
    when 'SOCKET_PEER' then
      if (value->>'forwardedState'<>'USED' and replacement_register.audit_provenance_ip(value->'peerIp')
        and value->'sourceIp'=value->'peerIp') is not true then return false; end if;
    when 'UNKNOWN' then
      if (value->>'forwardedState'<>'USED' and value->'peerIp'='null'::jsonb and value->'sourceIp'='null'::jsonb) is not true then return false; end if;
    else return false;
  end case;
  return replacement_register.audit_provenance_agent(value->'userAgent');
end $$;

create function replacement_register.audit_provenance_job(value jsonb)
returns boolean language plpgsql immutable as $$
begin
  if not replacement_register.audit_provenance_shape(value,array['id','kind']) then return false; end if;
  return coalesce(replacement_register.audit_provenance_uuid(value->'id') and value->>'kind' in ('PREPARATION','BUSINESS_COMMAND'),false);
end $$;

create function replacement_register.audit_provenance_bounded(value jsonb)
returns boolean language plpgsql immutable as $$
begin
  return coalesce(octet_length(convert_to(value::text,'UTF8'))<=8192,false);
end $$;

create function replacement_register.audit_provenance_initiator_valid(value jsonb, accepted_only boolean default false)
returns boolean language plpgsql immutable as $$
begin
  if not replacement_register.audit_provenance_bounded(value)
    or not replacement_register.audit_provenance_shape(value,array['version','kind','identity','request','job']) then return false; end if;
  if (value->'version'='1'::jsonb and replacement_register.audit_provenance_identity(value->'identity')
    and replacement_register.audit_provenance_job(value->'job')) is not true then return false; end if;
  if value->>'kind'='HTTP_ACCEPTANCE' then
    return coalesce(value#>>'{identity,kind}' in ('NAMED','PREVIEW') and replacement_register.audit_provenance_request(value->'request'),false);
  elsif value->>'kind'='LEGACY_OWNER_ONLY' then
    return coalesce(accepted_only is false and value->'request'='null'::jsonb,false);
  end if;
  return false;
end $$;

create function replacement_register.audit_provenance_envelope_valid(value jsonb)
returns boolean language plpgsql immutable as $$
declare execution jsonb; initiator jsonb; actor jsonb; phase text;
begin
  if not replacement_register.audit_provenance_bounded(value)
    or not replacement_register.audit_provenance_shape(value,array['version','phase','actor','eventRequest','initiator','execution','originState']) then return false; end if;
  if (value->'version'='1'::jsonb and replacement_register.audit_provenance_identity(value->'actor')) is not true then return false; end if;
  execution := value->'execution'; initiator := value->'initiator'; actor := value->'actor'; phase := value->>'phase';
  if not replacement_register.audit_provenance_shape(execution,array['processRole','instanceId','traceId','job','attempt']) then return false; end if;
  if (execution->>'processRole' in ('api','worker','combined','maintenance')
    and replacement_register.audit_provenance_uuid(execution->'instanceId')
    and replacement_register.audit_provenance_uuid(execution->'traceId')) is not true then return false; end if;
  if execution->'job'='null'::jsonb then
    if execution->'attempt' is distinct from 'null'::jsonb then return false; end if;
  elsif (replacement_register.audit_provenance_job(execution->'job')
    and execution->'attempt' in ('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb)) is not true then return false;
  end if;
  if initiator<>'null'::jsonb then
    if (replacement_register.audit_provenance_initiator_valid(initiator,false) and execution->'job'<>'null'::jsonb
      and initiator->'job'=execution->'job') is not true then return false; end if;
  end if;
  if phase in ('DIRECT','QUEUE','CONTROL') then
    if (execution->>'processRole' in ('api','combined') and replacement_register.audit_provenance_request(value->'eventRequest')
      and value->>'originState'='HTTP_CAPTURED') is not true then return false; end if;
    if phase='DIRECT' then
      return coalesce(initiator='null'::jsonb and execution->'job'='null'::jsonb and actor->>'kind' in ('NAMED','PREVIEW','UNKNOWN'),false);
    end if;
    if (actor->>'kind' in ('NAMED','PREVIEW') and initiator<>'null'::jsonb and execution->'job'<>'null'::jsonb) is not true then return false; end if;
    if phase='QUEUE' then
      return coalesce(execution->'attempt'='0'::jsonb and initiator->>'kind'='HTTP_ACCEPTANCE'
        and actor->'kind'=initiator#>'{identity,kind}' and actor->'role'=initiator#>'{identity,role}'
        and case when actor->>'kind'='NAMED' then actor->'userId'=initiator#>'{identity,userId}' else actor=initiator->'identity' end
        and value->'eventRequest'=initiator->'request',false);
    end if;
    return true;
  end if;
  if value->'eventRequest' is distinct from 'null'::jsonb then return false; end if;
  if phase='MAINTENANCE' then
    return coalesce(value->>'originState'='NON_HTTP' and initiator='null'::jsonb and execution->'job'='null'::jsonb
      and actor->>'kind' in ('MAINTENANCE','UNKNOWN'),false);
  elsif phase='REFUSAL' then
    return coalesce(execution->>'processRole' in ('worker','combined') and execution->'job'<>'null'::jsonb
      and value->>'originState'='CORRUPT_REFUSED' and initiator='null'::jsonb,false);
  elsif phase='WORKER' then
    return coalesce(execution->>'processRole' in ('worker','combined') and execution->'job'<>'null'::jsonb
      and execution->'attempt' in ('1'::jsonb,'2'::jsonb,'3'::jsonb) and initiator<>'null'::jsonb
      and value->>'originState'=case when initiator->>'kind'='HTTP_ACCEPTANCE' then 'RETAINED_ACCEPTANCE' else 'LEGACY_NOT_RECORDED' end
      and case when actor->>'kind'='NAMED' and initiator#>>'{identity,kind}'='NAMED'
        then actor->'userId'=initiator#>'{identity,userId}' else true end,false);
  end if;
  return false;
end $$;

alter table replacement_register.audit_events add column provenance_json jsonb;
alter table replacement_register.audit_events add constraint audit_provenance_valid
  check (provenance_json is null or replacement_register.audit_provenance_envelope_valid(provenance_json));
alter table replacement_register.preparation_jobs add column initiator_provenance_json jsonb;
alter table replacement_register.preparation_jobs add constraint preparation_initiator_provenance_valid
  check (initiator_provenance_json is null or (replacement_register.audit_provenance_initiator_valid(initiator_provenance_json,true)
    and initiator_provenance_json#>>'{job,id}'=job_id::text and initiator_provenance_json#>>'{job,kind}'='PREPARATION'));
alter table replacement_register.business_command_jobs add column initiator_provenance_json jsonb;
alter table replacement_register.business_command_jobs add constraint business_command_initiator_provenance_valid
  check (initiator_provenance_json is null or (replacement_register.audit_provenance_initiator_valid(initiator_provenance_json,true)
    and initiator_provenance_json#>>'{job,id}'=command_id::text and initiator_provenance_json#>>'{job,kind}'='BUSINESS_COMMAND'));

-- Preserve every previous explicit immutable guard and add the new origin.
create or replace function replacement_register.protect_preparation_descriptor() returns trigger language plpgsql as $$
begin
  if new.descriptor is distinct from old.descriptor or new.owner_key is distinct from old.owner_key
    or new.idempotency_key is distinct from old.idempotency_key or new.request_hash is distinct from old.request_hash
    or new.created_at is distinct from old.created_at or new.job_id is distinct from old.job_id
    or new.initiator_provenance_json is distinct from old.initiator_provenance_json then
    raise exception 'Preparation request and ownership are immutable';
  end if;
  return new;
end;
$$;
-- The existing business-command guard compares to_jsonb(NEW/OLD) minus its
-- eight mutable columns. It already protects this added origin column.
-- Existing audit/receipt append-only triggers are untouched.
insert into replacement_register.schema_migrations(version) values ('039_audit_provenance');
