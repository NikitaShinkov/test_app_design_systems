create index audit_time_id_idx on replacement_register.audit_events(occurred_at desc,id desc);
create index audit_subject_time_idx on replacement_register.audit_events(subject,occurred_at desc,id desc);
create index audit_action_time_idx on replacement_register.audit_events(action,occurred_at desc,id desc);
insert into replacement_register.schema_migrations(version) values('019_audit_pagination');
