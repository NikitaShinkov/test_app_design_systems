-- The latest explicitly supplied file metadata is a projection, distinct from
-- immutable round exchanges. Existing values not previously persisted stay unknown.
alter table replacement_register.proposals add column approval_round text not null default '';
insert into replacement_register.schema_migrations(version) values('017_current_proposal_round');
