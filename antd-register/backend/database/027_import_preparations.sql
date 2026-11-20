alter table replacement_register.preparation_jobs drop constraint preparation_result_identity;
alter table replacement_register.preparation_jobs add constraint preparation_kind_module check (coalesce((
  (coalesce(descriptor->>'kind','EXPORT')='EXPORT' and descriptor->>'moduleId' in ('M01','M03','M05','M06','M07','M09'))
  or (descriptor->>'kind'='IMPORT' and descriptor->>'moduleId' in ('M02','M04','M08'))
),false));
alter table replacement_register.preparation_jobs add constraint preparation_result_identity check (
  status<>'SUCCEEDED' or (result is not null and jsonb_typeof(result)='object' and coalesce(
    case when descriptor->>'kind'='IMPORT' then
      result->>'kind'='IMPORT' and result->>'preparationId'=job_id::text
      and result->>'batchId'=coalesce(descriptor->>'batchId',job_id::text)
      and result->>'revision' ~ '^[1-9][0-9]*$'
    else result->>'jobId'=job_id::text end,false))
);
insert into replacement_register.schema_migrations(version) values('027_import_preparations');
