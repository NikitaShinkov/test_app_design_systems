\set ON_ERROR_STOP on

alter table replacement_register.decision_events
  alter column decision_reference drop not null;

alter table replacement_register.decision_events
  drop constraint if exists decision_events_decision_reference_check;

insert into replacement_register.schema_migrations(version)
values ('003_rejected_reference_optional')
on conflict do nothing;
