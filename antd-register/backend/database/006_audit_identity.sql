alter table replacement_register.audit_events add column if not exists actor_user_id uuid;
alter table replacement_register.audit_events add column if not exists request_id uuid;
create index if not exists audit_events_actor_idx on replacement_register.audit_events(actor_user_id,occurred_at desc);
create index if not exists audit_events_request_idx on replacement_register.audit_events(request_id);
insert into replacement_register.schema_migrations(version) values ('006_audit_identity') on conflict do nothing;
