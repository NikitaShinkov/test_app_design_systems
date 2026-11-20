alter table replacement_register.replacement_records add column if not exists ledger_position bigserial;
create unique index if not exists replacement_ledger_position_idx on replacement_register.replacement_records(ledger_position);
insert into replacement_register.schema_migrations(version) values ('008_ledger_order') on conflict do nothing;
