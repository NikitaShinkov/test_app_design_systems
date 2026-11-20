alter table replacement_register.preparation_jobs drop constraint preparation_kind_module;
alter table replacement_register.preparation_jobs add constraint preparation_kind_module check (coalesce((
  (coalesce(descriptor->>'kind','EXPORT')='EXPORT' and descriptor->>'moduleId' in ('M01','M03','M05','M06','M07','M09'))
  or (descriptor->>'kind'='IMPORT' and descriptor->>'moduleId' in ('M02','M04','M08'))
  or (descriptor->>'kind' in ('INSPECT','REGISTER_BOM') and descriptor->>'moduleId'='M01')
  or (descriptor->>'kind' in ('ATTACHMENT','RESCAN') and descriptor->'moduleId'='null'::jsonb)
),false));

alter table replacement_register.preparation_jobs add constraint preparation_file_input check (
  coalesce(descriptor->>'kind','EXPORT') not in ('INSPECT','REGISTER_BOM','ATTACHMENT','RESCAN') or coalesce((
    jsonb_typeof(descriptor->'input')='object'
    and descriptor#>>'{input,artifactId}' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    and descriptor#>>'{input,sha256}' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(descriptor#>'{input,bytes}')='number'
    and descriptor#>>'{input,bytes}' ~ '^[1-9][0-9]*$'
    and (descriptor->>'kind'<>'ATTACHMENT' or length(btrim(descriptor->>'proposalId'))>0)
  ),false)
);

alter table replacement_register.preparation_jobs drop constraint preparation_result_identity;
alter table replacement_register.preparation_jobs add constraint preparation_result_identity check (
  status<>'SUCCEEDED' or (result is not null and jsonb_typeof(result)='object' and coalesce(
    case
    when descriptor->>'kind'='IMPORT' then
      result->>'kind'='IMPORT' and result->>'preparationId'=job_id::text
      and result->>'batchId'=coalesce(descriptor->>'batchId',job_id::text)
      and result->>'revision' ~ '^[1-9][0-9]*$'
    when descriptor->>'kind'='INSPECT' then
      result->>'kind'='INSPECT' and result->>'preparationId'=job_id::text
      and result->>'artifactId'=descriptor#>>'{input,artifactId}'
      and result->>'sourceArtifactId'=descriptor#>>'{input,artifactId}'
      and result->>'sha256'=descriptor#>>'{input,sha256}'
      and length(result->>'filename')>0 and jsonb_typeof(result->'contentType')='string'
      and jsonb_typeof(result->'inspection')='object'
    when descriptor->>'kind' in ('REGISTER_BOM','ATTACHMENT','RESCAN') then
      result->>'kind'=descriptor->>'kind' and result->>'preparationId'=job_id::text
      and result->>'artifactId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      and result->>'artifactId'=result#>>'{artifact,artifactId}'
      and result#>>'{artifact,sha256}'=descriptor#>>'{input,sha256}'
      and result#>'{artifact,bytes}'=descriptor#>'{input,bytes}'
      and case when descriptor->>'kind'='REGISTER_BOM' then
        result->>'sourceArtifactId'=descriptor#>>'{input,artifactId}'
        and result#>>'{artifact,kind}'='ORIGINAL_BOM' and result#>>'{artifact,moduleId}'='M01'
      else result->>'artifactId'=descriptor#>>'{input,artifactId}'
        and (descriptor->>'kind'='RESCAN' or (
          result#>>'{artifact,kind}'='ATTACHMENT' and result#>'{artifact,moduleId}'='null'::jsonb
          and result#>>'{artifact,scanStatus}' in ('CLEAN','ERROR')
          and result#>'{artifact,scope,proposalIds}' @> jsonb_build_array(descriptor->>'proposalId')
        )) end
    else result->>'jobId'=job_id::text end,false))
);

insert into replacement_register.schema_migrations(version) values('029_file_preparations');
