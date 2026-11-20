alter table replacement_register.workflow_runs add column actor_user_id uuid;
alter table replacement_register.workflow_runs add column request_id uuid;
alter table replacement_register.workflow_runs add column scope_known boolean not null default false;
alter table replacement_register.workflow_runs add column scope_orders text[] not null default '{}';
alter table replacement_register.workflow_runs add column scope_suppliers text[] not null default '{}';
alter table replacement_register.workflow_runs add constraint workflow_run_scope_valid check (
  array_position(scope_orders,null) is null and array_position(scope_suppliers,null) is null
  and (not scope_known or (cardinality(scope_orders)>0 and not (''=any(scope_orders))))
);
create index workflow_run_actor_time_idx on replacement_register.workflow_runs(actor_user_id,actor_role,occurred_at desc,id desc) where actor_user_id is not null;
create index workflow_run_orders_idx on replacement_register.workflow_runs using gin(scope_orders);
create index workflow_run_time_idx on replacement_register.workflow_runs(occurred_at desc,id desc);
-- The migration runner may recover exact audit-bound legacy ownership. Runtime
-- grants remain SELECT/INSERT only; no UPDATE or DELETE permission is added.
insert into replacement_register.schema_migrations(version) values('028_workflow_run_access');
