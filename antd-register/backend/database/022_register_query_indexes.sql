-- Derived UI search/scope indexes only. Stop writers for this upgrade.
create extension if not exists pg_trgm with schema replacement_register;
create function replacement_register.scope_text(value text) returns text
language sql immutable parallel safe as $$
  select upper(btrim(regexp_replace(translate(coalesce(value,''),chr(160)||chr(13)||chr(10),'   '),' {2,}',' ','g'),' ') collate replacement_register.search_unicode)
$$;
create function replacement_register.register_search_text(variadic fields text[]) returns text
language sql immutable parallel safe as $$
  select lower(array_to_string(fields,chr(31)) collate replacement_register.search_unicode)
$$;

alter table replacement_register.proposals add column search_content text generated always as (
  replacement_register.register_search_text(proposal_id,order_no,supplier,product,product_code,product_decimal_no,production_order,position,orig_code,orig_mfr,orig_pn,alt_mfr,alt_pn,supplier_reply,supplier_comment,component_status,client_decision,client_comment,responsible,decision_reference,notes,workflow_status)
) stored;
alter table replacement_register.replacement_records add column search_content text generated always as (
  replacement_register.register_search_text(record_id,proposal_id,order_no,supplier,product,product_code,product_decimal_no,production_order,position,orig_code,orig_mfr,orig_pn,alt_mfr,alt_pn,component_status,decision_status,responsible,decision_reference,decision_comment,notes)
) stored;
alter table replacement_register.lifecycle_records add column search_content text generated always as (
  replacement_register.register_search_text(record_id,payload->>'proposalId',payload->>'orderNo',payload->>'supplier',payload->>'product',payload->>'productCode',payload->>'productDecimalNo',payload->>'productionOrder',payload->>'position',payload->>'origCode',payload->>'origMfr',payload->>'origPn',payload->>'altMfr',payload->>'altPn',payload->>'componentStatus',payload->>'decisionStatus',payload->>'responsible',payload->>'decisionReference',payload->>'decisionComment',payload->>'notes')
) stored;

-- Respect an extension already installed in another schema; never move it.
do $$ declare extension_schema text; begin
  select n.nspname into strict extension_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';
  execute format('create index proposals_content_trgm_idx on replacement_register.proposals using gin(search_content %I.gin_trgm_ops)',extension_schema);
  execute format('create index replacement_content_trgm_idx on replacement_register.replacement_records using gin(search_content %I.gin_trgm_ops)',extension_schema);
  execute format('create index lifecycle_content_trgm_idx on replacement_register.lifecycle_records using gin(search_content %I.gin_trgm_ops)',extension_schema);
end $$;

create index proposals_access_idx on replacement_register.proposals(replacement_register.scope_text(order_no),replacement_register.scope_text(supplier),proposal_id) where archived=false;
create index proposals_review_queue_idx on replacement_register.proposals(proposal_id) where archived=false and client_decision in ('APPROVED','REJECTED') and can_record=false;
create index replacement_access_idx on replacement_register.replacement_records(replacement_register.scope_text(order_no),replacement_register.scope_text(supplier),record_id);
create index lifecycle_access_idx on replacement_register.lifecycle_records(replacement_register.scope_text(coalesce(payload->>'orderNo','')),replacement_register.scope_text(coalesce(payload->>'supplier','')),record_id);
create index proposals_product_page_idx on replacement_register.proposals((lower(product_decimal_no collate replacement_register.search_unicode) collate "C"),proposal_id) where archived=false;
create index replacement_product_page_idx on replacement_register.replacement_records((lower(product_decimal_no collate replacement_register.search_unicode) collate "C"),record_id);
create index lifecycle_product_page_idx on replacement_register.lifecycle_records((lower(coalesce(payload->>'productDecimalNo','') collate replacement_register.search_unicode) collate "C"),record_id);
insert into replacement_register.schema_migrations(version) values('022_register_query_indexes');
