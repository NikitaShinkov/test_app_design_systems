-- Immutable projections of retained original BOM files. These source-derived
-- orders do not imply business lifecycle, completion or user access grants.
create table replacement_register.source_orders (
  order_no text primary key check(length(order_no)>0),
  created_at timestamptz not null default clock_timestamp()
);
create table replacement_register.source_production_orders (
  order_no text not null references replacement_register.source_orders(order_no),
  production_order text not null check(length(production_order)>0),
  created_at timestamptz not null default clock_timestamp(),
  primary key(order_no,production_order)
);
create table replacement_register.source_boms (
  artifact_id uuid primary key references replacement_register.artifacts(artifact_id),
  order_no text not null references replacement_register.source_orders(order_no),
  production_order text,
  supplier text not null check(length(supplier)>0),
  product_decimal_no text not null check(length(product_decimal_no)>0),
  projection_hash text not null check(projection_hash ~ '^[a-f0-9]{64}$'),
  summary_json jsonb not null check(jsonb_typeof(summary_json)='object' and not(summary_json ? 'rows')),
  row_count integer not null check(row_count between 1 and 250000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(order_no,production_order) references replacement_register.source_production_orders(order_no,production_order),
  constraint source_bom_summary_shape check(coalesce(
    summary_json->>'formatVersion'='1' and summary_json->>'sourceSha256' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(summary_json->'sourceBytes')='number'
    and jsonb_typeof(summary_json->'sourceFilename')='string'
    and jsonb_typeof(summary_json->'sourceSheet')='string'
    and jsonb_typeof(summary_json->'headers')='array'
    and jsonb_typeof(summary_json->'sourceMetadata')='object'
    and jsonb_typeof(summary_json->'metadata')='object'
    and jsonb_typeof(summary_json->'findings')='array'
    and (summary_json->>'headerRow')::integer between 1 and 20
    and (summary_json->>'lastDataRow')::integer between 2 and 250000
    and (summary_json->>'lastDataRow')::integer-(summary_json->>'headerRow')::integer=row_count
    and (summary_json->>'rowCount')::integer=row_count
    and summary_json->'metadata'->>'orderNo'=order_no
    and summary_json->'metadata'->>'supplier'=supplier
    and summary_json->'metadata'->>'productDecimalNo'=product_decimal_no
    and nullif(summary_json->'metadata'->>'productionOrder','') is not distinct from production_order,false))
);
create index source_boms_order_page_idx on replacement_register.source_boms(order_no,artifact_id);
create index source_boms_product_page_idx on replacement_register.source_boms(product_decimal_no,artifact_id);
create table replacement_register.source_bom_rows (
  artifact_id uuid not null references replacement_register.source_boms(artifact_id),
  source_row integer not null check(source_row between 2 and 250000),
  position text not null,
  orig_code text not null,
  orig_mfr text not null,
  orig_pn text not null,
  component_status text not null,
  row_json jsonb not null check(jsonb_typeof(row_json)='object' and jsonb_typeof(row_json->'cells')='array'
    and coalesce((row_json->>'sourceRow')::integer=source_row and row_json->>'position'=position
      and row_json->>'origCode'=orig_code and row_json->>'origMfr'=orig_mfr and row_json->>'origPn'=orig_pn
      and row_json->>'componentStatus'=component_status,false)),
  primary key(artifact_id,source_row)
);
create function replacement_register.check_source_bom() returns trigger language plpgsql as $$
declare a replacement_register.artifacts; b replacement_register.source_boms; count_rows integer;
begin
  if TG_TABLE_NAME='source_boms' then b=NEW;
  else select * into b from replacement_register.source_boms where artifact_id=NEW.artifact_id; end if;
  select * into a from replacement_register.artifacts where artifact_id=b.artifact_id;
  if a.artifact_id is null or a.kind is distinct from 'ORIGINAL_BOM' or a.module_id is distinct from 'M01'
     or a.sha256 is distinct from b.summary_json->>'sourceSha256'
     or a.bytes is distinct from (b.summary_json->>'sourceBytes')::bigint
     or a.scope_json->'orderNos' is distinct from jsonb_build_array(b.order_no)
     or a.scope_json->'suppliers' is distinct from jsonb_build_array(b.supplier)
     or a.scope_json->'productDecimalNos' is distinct from jsonb_build_array(b.product_decimal_no) then
    raise exception 'Source BOM does not match retained artifact identity/scope';
  end if;
  if TG_TABLE_NAME='source_boms' then
    select count(*) into count_rows from replacement_register.source_bom_rows where artifact_id=b.artifact_id;
    if count_rows<>b.row_count then raise exception 'Source BOM physical rows are incomplete'; end if;
  elsif NEW.source_row<=(b.summary_json->>'headerRow')::integer or NEW.source_row>(b.summary_json->>'lastDataRow')::integer
      or jsonb_array_length(NEW.row_json->'cells')<>jsonb_array_length(b.summary_json->'headers') then
    raise exception 'Source BOM physical row is outside its retained geometry';
  end if;
  return null;
end $$;
create constraint trigger source_bom_complete after insert on replacement_register.source_boms
  deferrable initially deferred for each row execute function replacement_register.check_source_bom();
create constraint trigger source_bom_row_complete after insert on replacement_register.source_bom_rows
  deferrable initially deferred for each row execute function replacement_register.check_source_bom();
create trigger source_orders_immutable before update or delete or truncate on replacement_register.source_orders
  for each statement execute function replacement_register.reject_event_changes();
create trigger source_production_orders_immutable before update or delete or truncate on replacement_register.source_production_orders
  for each statement execute function replacement_register.reject_event_changes();
create trigger source_boms_immutable before update or delete or truncate on replacement_register.source_boms
  for each statement execute function replacement_register.reject_event_changes();
create trigger source_bom_rows_immutable before update or delete or truncate on replacement_register.source_bom_rows
  for each statement execute function replacement_register.reject_event_changes();
-- The source projection binds the complete retained artifact identity. Scan
-- verdicts remain mutable and keep their existing audited verification path.
create function replacement_register.protect_source_bom_artifact() returns trigger language plpgsql as $$
begin
  if exists(select 1 from replacement_register.source_boms where artifact_id=OLD.artifact_id)
    and (to_jsonb(NEW)-array['scan_status','scan_detail']) is distinct from
        (to_jsonb(OLD)-array['scan_status','scan_detail']) then
    raise exception 'Indexed source BOM artifact identity is immutable';
  end if;
  return NEW;
end $$;
create trigger source_bom_artifact_identity before update on replacement_register.artifacts
  for each row execute function replacement_register.protect_source_bom_artifact();
insert into replacement_register.schema_migrations(version) values ('034_source_boms');
