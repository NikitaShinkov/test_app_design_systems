-- Candidate selection only: JS still applies the approved aliases/key rules.
-- Include pipe-delimited product identities to preserve legacy key collisions.
create index replacement_history_product_idx on replacement_register.replacement_records(replacement_register.scope_text(product_decimal_no),ledger_position);
create index lifecycle_history_product_idx on replacement_register.lifecycle_records(replacement_register.scope_text(coalesce(payload->>'productDecimalNo','')),created_at,record_id);
create index replacement_history_delimiter_idx on replacement_register.replacement_records(ledger_position) where position('|' in product_decimal_no)>0;
create index lifecycle_history_delimiter_idx on replacement_register.lifecycle_records(created_at,record_id) where position('|' in coalesce(payload->>'productDecimalNo',''))>0;
insert into replacement_register.schema_migrations(version) values('024_decision_history_candidates');
