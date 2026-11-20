-- REVIEW CANDIDATE ONLY. Not applied to any database.
\set ON_ERROR_STOP on
-- The migration runner must execute this complete file in one transaction.
-- N reserved slots do not establish the order of any pre-040 proposal.
select pg_advisory_xact_lock(78742003);
lock table replacement_register.proposals in access exclusive mode;

alter table replacement_register.proposals add column working_ordinal bigint;
create sequence replacement_register.proposal_working_ordinal_seq as bigint
  increment by 1 minvalue 1 maxvalue 9223372036854775807 start with 1 cache 1 no cycle;
alter sequence replacement_register.proposal_working_ordinal_seq
  owned by replacement_register.proposals.working_ordinal;
do $$
declare reserved bigint;
begin
  select count(*) into reserved from replacement_register.proposals;
  execute pg_catalog.format('alter sequence replacement_register.proposal_working_ordinal_seq start with %s restart with %s',reserved+1,reserved+1);
end $$;
-- Adding the default AFTER the column preserves SQL NULL on every old row.
alter table replacement_register.proposals alter column working_ordinal
  set default pg_catalog.nextval('replacement_register.proposal_working_ordinal_seq'::pg_catalog.regclass);
alter table replacement_register.proposals add constraint proposal_working_ordinal_positive
  check (working_ordinal is null or working_ordinal > 0);
create unique index proposal_working_ordinal_unique
  on replacement_register.proposals(working_ordinal);

create function replacement_register.protect_proposal_working_order()
returns trigger language plpgsql security invoker set search_path = pg_catalog as $$
declare owner_call boolean;
begin
  select c.relowner = r.oid into owner_call
    from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.rolname = current_user
    where c.oid = tg_relid;
  if owner_call is null then raise exception 'Working order owner could not be verified'; end if;
  if tg_op = 'INSERT' then
    if not owner_call then
      -- Runtime never chooses a position. Even an explicit supplied ordinal is
      -- replaced by a fresh allocation. The column default may consume a gap.
      new.working_ordinal := pg_catalog.nextval('replacement_register.proposal_working_ordinal_seq'::pg_catalog.regclass);
    end if;
    -- Owner INSERT retains explicit values/NULL for faithful restore. An owner
    -- source import that omits the column receives the ordinary sequence default.
    return new;
  end if;
  if old.working_ordinal is not null and new.working_ordinal is distinct from old.working_ordinal then
    raise exception 'Known proposal working order is immutable';
  end if;
  if old.working_ordinal is null and new.working_ordinal is not null then
    if not owner_call then raise exception 'Legacy working order requires the table owner'; end if;
    if new.proposal_id is distinct from old.proposal_id then
      raise exception 'Legacy working order cannot change proposal identity';
    end if;
  end if;
  return new;
end $$;
create trigger proposal_working_order_guard before insert or update
  on replacement_register.proposals for each row
  execute function replacement_register.protect_proposal_working_order();
alter table replacement_register.proposals enable always trigger proposal_working_order_guard;

create function replacement_register.complete_proposal_working_order()
returns trigger language plpgsql security invoker set search_path = pg_catalog as $$
declare reserved bigint; unknown_count bigint; assigned_count bigint; transitioned_count bigint;
begin
  -- Statement transition tables make the full check once for a complete
  -- assignment, rather than once per proposal. Partial statements cannot commit.
  if exists(select 1 from old_working_order_rows o join new_working_order_rows n using(proposal_id)
    where o.working_ordinal is null and n.working_ordinal is not null) then
    select s.seqstart-1 into reserved from pg_catalog.pg_sequence s
      where s.seqrelid = 'replacement_register.proposal_working_ordinal_seq'::pg_catalog.regclass;
    if reserved is null then raise exception 'Working order reservation is unavailable'; end if;
    select count(*) into transitioned_count
      from old_working_order_rows o join new_working_order_rows n using(proposal_id)
      where o.working_ordinal is null and n.working_ordinal is not null;
    select count(*) filter(where working_ordinal is null),
      count(*) filter(where working_ordinal between 1 and reserved)
      into unknown_count,assigned_count from replacement_register.proposals;
    if transitioned_count <> reserved or unknown_count <> 0 or assigned_count <> reserved then
      raise exception 'Legacy working order requires one complete global assignment';
    end if;
  end if;
  return null;
end $$;
create trigger proposal_working_order_complete after update
  on replacement_register.proposals
  referencing old table as old_working_order_rows new table as new_working_order_rows
  for each statement execute function replacement_register.complete_proposal_working_order();
alter table replacement_register.proposals enable always trigger proposal_working_order_complete;

create function replacement_register.assign_legacy_proposal_working_order(ordered_ids text[])
returns bigint language plpgsql security invoker set search_path = pg_catalog as $$
declare owner_call boolean; reserved bigint; unknown_count bigint; matches bigint;
begin
  select c.relowner = r.oid into owner_call
    from pg_catalog.pg_class c join pg_catalog.pg_roles r on r.rolname = current_user
    where c.oid = 'replacement_register.proposals'::pg_catalog.regclass;
  if owner_call is distinct from true then raise exception 'Legacy working order requires the table owner'; end if;
  perform pg_catalog.pg_advisory_xact_lock(78742003);
  lock table replacement_register.proposals in share row exclusive mode;
  select s.seqstart-1 into reserved from pg_catalog.pg_sequence s
    where s.seqrelid = 'replacement_register.proposal_working_ordinal_seq'::pg_catalog.regclass;
  if reserved is null or ordered_ids is null or pg_catalog.cardinality(ordered_ids) <> reserved
    or (reserved > 0 and (pg_catalog.array_ndims(ordered_ids) <> 1 or pg_catalog.array_lower(ordered_ids,1) <> 1)) then
    raise exception 'Complete legacy working order mapping is required';
  end if;
  select count(distinct id) into matches from pg_catalog.unnest(ordered_ids) as m(id)
    where id is not null and pg_catalog.octet_length(id) between 1 and 4096;
  if matches <> reserved then raise exception 'Legacy mapping identities must be complete and unique'; end if;
  select count(*) into unknown_count from replacement_register.proposals where working_ordinal is null;
  if unknown_count = 0 then
    select count(*) into matches from pg_catalog.unnest(ordered_ids) with ordinality as m(id,ordinal)
      join replacement_register.proposals p on p.proposal_id=m.id and p.working_ordinal=m.ordinal;
    if matches <> reserved then raise exception 'Legacy mapping differs from the retained order'; end if;
    return reserved;
  end if;
  if unknown_count <> reserved then raise exception 'Legacy mapping cannot be partially assigned'; end if;
  select count(*) into matches from pg_catalog.unnest(ordered_ids) as m(id)
    join replacement_register.proposals p on p.proposal_id=m.id and p.working_ordinal is null;
  if matches <> reserved then raise exception 'Legacy mapping does not match all unknown proposals'; end if;
  -- Evidence is reviewed outside SQL; this function enforces the exact complete
  -- identity set and one atomic assignment. It never derives order from IDs,
  -- timestamps, source_row or historical snapshot ordinals.
  update replacement_register.proposals p set working_ordinal=m.ordinal
    from pg_catalog.unnest(ordered_ids) with ordinality as m(id,ordinal)
    where p.proposal_id=m.id and p.working_ordinal is null;
  get diagnostics matches = row_count;
  if matches <> reserved then raise exception 'Legacy mapping changed during assignment'; end if;
  return reserved;
end $$;

revoke all on function replacement_register.protect_proposal_working_order() from public;
revoke all on function replacement_register.complete_proposal_working_order() from public;
revoke all on function replacement_register.assign_legacy_proposal_working_order(text[]) from public;
insert into replacement_register.schema_migrations(version) values('040_proposal_working_order');
