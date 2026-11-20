-- Rebuild only the derived search projection and its GIN indexes. Business
-- values, canonical keys, row versions and decision evidence remain untouched.
-- The service must be stopped: rebuilding stored generated columns takes an
-- exclusive table lock and reads every existing row.
alter table replacement_register.proposals drop column search_text;
alter table replacement_register.proposals add column search_text tsvector generated always as (
  to_tsvector('simple'::regconfig,lower((
    coalesce(proposal_id, '') || ' ' || coalesce(order_no, '') || ' ' || coalesce(supplier, '') || ' ' ||
    coalesce(product, '') || ' ' || coalesce(product_decimal_no, '') || ' ' || coalesce(position, '') || ' ' ||
    coalesce(orig_code, '') || ' ' || coalesce(orig_mfr, '') || ' ' || coalesce(orig_pn, '') || ' ' ||
    coalesce(alt_mfr, '') || ' ' || coalesce(alt_pn, '') || ' ' || coalesce(client_decision, '') || ' ' ||
    coalesce(decision_reference, '')
  ) collate replacement_register.search_unicode))
) stored;
create index proposals_search_idx on replacement_register.proposals using gin(search_text);

alter table replacement_register.replacement_records drop column search_text;
alter table replacement_register.replacement_records add column search_text tsvector generated always as (
  to_tsvector('simple'::regconfig,lower((
    coalesce(record_id, '') || ' ' || coalesce(order_no, '') || ' ' || coalesce(product, '') || ' ' ||
    coalesce(product_decimal_no, '') || ' ' || coalesce(orig_mfr, '') || ' ' || coalesce(orig_pn, '') || ' ' ||
    coalesce(alt_mfr, '') || ' ' || coalesce(alt_pn, '') || ' ' || coalesce(decision_reference, '')
  ) collate replacement_register.search_unicode))
) stored;
create index replacement_records_search_idx on replacement_register.replacement_records using gin(search_text);
insert into replacement_register.schema_migrations(version) values('021_register_unicode_search');
