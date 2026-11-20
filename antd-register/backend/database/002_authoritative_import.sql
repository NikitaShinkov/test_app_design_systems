\set ON_ERROR_STOP on

-- The row data is loaded by app/import-authoritative-data.mjs so that the
-- exact read-only JSON extraction can be reused by memory and PostgreSQL modes.
insert into replacement_register.schema_migrations(version)
values ('002_authoritative_import')
on conflict do nothing;
