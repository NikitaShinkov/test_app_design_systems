alter table replacement_register.preparation_jobs add constraint preparation_lease_state check (
  (status='RUNNING' and lease_token is not null and lease_until is not null)
  or (status<>'RUNNING' and lease_token is null and lease_until is null)
);
alter table replacement_register.preparation_jobs add constraint preparation_result_identity check (
  status<>'SUCCEEDED' or (result is not null and jsonb_typeof(result)='object' and coalesce(result->>'jobId'=job_id::text,false))
);
insert into replacement_register.schema_migrations(version) values('026_preparation_invariants');
