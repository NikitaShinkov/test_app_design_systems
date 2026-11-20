-- DOCUMENT_VERSION seek order for bounded file-library candidate scans.
-- Index and migration marker only; existing artifact content is unchanged.
create index if not exists artifacts_library_document_version_idx
  on replacement_register.artifacts(logical_key collate "C" asc,version desc,artifact_id desc);
insert into replacement_register.schema_migrations(version)
  values ('038_artifact_library_pages') on conflict do nothing;
