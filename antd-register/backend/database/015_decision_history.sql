-- Preserve existing legacy rows; the former proposal FK must not erase or
-- prevent retaining history after a current projection is removed.
alter table replacement_register.decision_events drop constraint if exists decision_events_proposal_id_fkey;
alter table replacement_register.decision_events alter column proposal_id drop not null;
alter table replacement_register.decision_events alter column decision_status drop not null;
alter table replacement_register.decision_events alter column responsible drop not null;
alter table replacement_register.decision_events alter column decision_date drop not null;
alter table replacement_register.decision_events add column event_id uuid not null default gen_random_uuid();
alter table replacement_register.decision_events add column stream_key text;
alter table replacement_register.decision_events add column event_sequence bigint;
alter table replacement_register.decision_events add column previous_event_id uuid;
alter table replacement_register.decision_events add column supersedes_event_id uuid;
alter table replacement_register.decision_events add column origin_key text;
alter table replacement_register.decision_events add column audit_id bigint references replacement_register.audit_events(id);
alter table replacement_register.decision_events add column event_json jsonb not null default '{}';
update replacement_register.decision_events set stream_key='PROPOSAL:'||proposal_id,origin_key='legacy:'||id,
  event_json=jsonb_build_object('eventId',event_id,'streamType','PROPOSAL','subjectId',proposal_id,'kind','LEGACY_ENTRY',
    'occurredAt',created_at,'actor','Original actor not recorded','role','SYSTEM','adminOnly',true,'scope','[]'::jsonb,
    'before',null,'after',jsonb_build_object('proposalId',proposal_id,'clientDecision',decision_status,'responsible',responsible,
      'decisionReference',decision_reference,'decisionDate',decision_date,'clientComment',decision_comment),
    'changesDecision',false,'snapshotComplete',false,'source',jsonb_build_object('legacyTableId',id,'description','Pre-migration decision_events row'));
with ranked as (select id,row_number() over(partition by stream_key order by id) as seq,
  lag(event_id) over(partition by stream_key order by id) as previous from replacement_register.decision_events)
update replacement_register.decision_events e set event_sequence=r.seq,previous_event_id=r.previous,
  event_json=event_json||jsonb_build_object('sequence',r.seq,'previousEventId',r.previous,'supersedesEventId',null)
from ranked r where r.id=e.id;
alter table replacement_register.decision_events alter column stream_key set not null;
alter table replacement_register.decision_events alter column event_sequence set not null;
alter table replacement_register.decision_events alter column origin_key set not null;
alter table replacement_register.decision_events add constraint decision_event_uuid_unique unique(event_id);
alter table replacement_register.decision_events add constraint decision_event_origin_unique unique(origin_key);
alter table replacement_register.decision_events add constraint decision_event_sequence_unique unique(stream_key,event_sequence);
alter table replacement_register.decision_events add constraint decision_event_stream_uuid_unique unique(stream_key,event_id);
alter table replacement_register.decision_events add constraint decision_event_positive_sequence check(event_sequence>0);
alter table replacement_register.decision_events add constraint decision_event_previous_fk foreign key(stream_key,previous_event_id)
  references replacement_register.decision_events(stream_key,event_id);
alter table replacement_register.decision_events add constraint decision_event_supersedes_fk foreign key(stream_key,supersedes_event_id)
  references replacement_register.decision_events(stream_key,event_id);
create index decision_events_time_idx on replacement_register.decision_events(created_at desc,id desc);
create index decision_events_related_proposal_idx on replacement_register.decision_events((event_json#>>'{related,proposalId}'));
create table replacement_register.decision_event_heads (
  stream_key text primary key,
  last_sequence bigint not null default 0 check(last_sequence>=0),
  latest_event_id uuid,
  decision_event_id uuid,
  foreign key(stream_key,latest_event_id) references replacement_register.decision_events(stream_key,event_id),
  foreign key(stream_key,decision_event_id) references replacement_register.decision_events(stream_key,event_id)
);
insert into replacement_register.decision_event_heads(stream_key,last_sequence,latest_event_id)
select distinct on(stream_key) stream_key,event_sequence,event_id from replacement_register.decision_events order by stream_key,event_sequence desc;
create trigger decision_events_append_only before update or delete or truncate on replacement_register.decision_events
for each statement execute function replacement_register.reject_event_changes();
insert into replacement_register.schema_migrations(version) values('015_decision_history');
