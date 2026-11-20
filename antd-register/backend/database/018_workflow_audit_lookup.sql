create index workflow_exchange_audit_idx on replacement_register.workflow_exchanges(audit_id);
insert into replacement_register.schema_migrations(version) values('018_workflow_audit_lookup');
