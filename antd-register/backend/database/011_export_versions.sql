create table if not exists replacement_register.export_sequences (
  export_key text primary key,
  last_version integer not null check(last_version > 0)
);
insert into replacement_register.schema_migrations(version) values ('011_export_versions') on conflict do nothing;
