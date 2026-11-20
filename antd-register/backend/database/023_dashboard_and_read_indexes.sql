-- Read-side helpers mirror existing JS classification/validation, without
-- changing source text or the approved canonical business-key algorithm.
create function replacement_register.ui_trim(value text) returns text
language sql immutable parallel safe as $$
  select btrim(coalesce(value,''),U&' \0009\000a\000b\000c\000d\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff')
$$;
create function replacement_register.reply_kind(value text) returns text
language plpgsql immutable parallel safe as $$
declare cleaned text:=replacement_register.scope_text(value); tokens text;
begin
  if cleaned='' then return ''; end if;
  if cleaned like any(array['%DO NOT PURCHASE%','%DON''T PURCHASE%','%DONT PURCHASE%','%DO NOT BUY%']) then return 'DO NOT PURCHASE'; end if;
  if cleaned like any(array['%REJECT%','%NOT OK%','%NOT APPROVED%','%НЕ СОГЛАС%']) then return 'REJECTED'; end if;
  tokens:=replacement_register.ui_trim(regexp_replace(translate(cleaned,E'.,;:/\\()[]','          '),' {2,}',' ','g'));
  if tokens in ('OK','ОК') or left(tokens,3) in ('OK ','ОК ') then return 'APPROVED'; end if;
  if cleaned like any(array['%APPROVED%','%ACCEPTED%','%СОГЛАС%']) then return 'APPROVED'; end if;
  return 'UNKNOWN';
end $$;
revoke execute on function replacement_register.ui_trim(text),replacement_register.reply_kind(text) from public;

-- Sort thin keys first, then fetch only the selected native rows by PK.
create index proposals_id_page_idx on replacement_register.proposals((lower(proposal_id collate replacement_register.search_unicode) collate "C"),proposal_id) where archived=false;
create index replacement_id_page_idx on replacement_register.replacement_records((lower(record_id collate replacement_register.search_unicode) collate "C"),record_id);
create index lifecycle_id_page_idx on replacement_register.lifecycle_records((lower(record_id collate replacement_register.search_unicode) collate "C"),record_id);
-- Status-only counts can avoid the large source/search payload. Missing
-- references use sparse predicates; long reference/comment text is not a key.
create index proposals_active_decision_idx on replacement_register.proposals(client_decision) where archived=false;
create index proposals_missing_reference_idx on replacement_register.proposals(proposal_id) where archived=false and client_decision='APPROVED' and coalesce(decision_reference,'')='';
create index replacement_missing_reference_idx on replacement_register.replacement_records(record_id) where decision_status='APPROVED' and coalesce(decision_reference,'')='';
insert into replacement_register.schema_migrations(version) values('023_dashboard_and_read_indexes');
