alter table replacement_register.artifacts add column attachment_json jsonb;
alter table replacement_register.artifacts add constraint artifact_attachment_metadata check (
  attachment_json is null or coalesce((
    kind='ATTACHMENT' and module_id is null and jsonb_typeof(attachment_json)='object'
    and attachment_json ?& array['attachmentRole','source','description','confidentiality','supersedesArtifactId']
    and attachment_json - array['attachmentRole','source','description','confidentiality','supersedesArtifactId']='{}'::jsonb
    and attachment_json->>'attachmentRole' in ('Supplier_Datasheet','Client_Datasheet','Supporting_Document')
    and attachment_json->>'source' in ('ADMINISTRATOR','SUPPLIER','CLIENT')
    and jsonb_typeof(attachment_json->'description')='string' and length(attachment_json->>'description')<=2000
    and attachment_json->>'confidentiality' in ('ORDER_PARTICIPANTS','ADMINISTRATORS')
    and (attachment_json->'supersedesArtifactId'='null'::jsonb or
      (jsonb_typeof(attachment_json->'supersedesArtifactId')='string' and attachment_json->>'supersedesArtifactId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'))
  ),false)
);
create function replacement_register.protect_attachment_metadata() returns trigger language plpgsql as $$
begin
  if new.attachment_json is distinct from old.attachment_json then
    raise exception 'Attachment metadata is immutable; publish a new file version.';
  end if;
  return new;
end $$;
create trigger attachment_metadata_immutable before update of attachment_json on replacement_register.artifacts
for each row execute function replacement_register.protect_attachment_metadata();
insert into replacement_register.schema_migrations(version) values ('030_attachment_metadata') on conflict do nothing;
