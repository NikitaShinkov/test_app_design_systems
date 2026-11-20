-- Search must not inherit an ASCII-only database C locale. This affects
-- display/search matching only, never the approved business identity algorithm.
create collation replacement_register.search_unicode(provider=icu,locale='und',deterministic=true);
insert into replacement_register.schema_migrations(version) values('020_unicode_search');
