create table replacement_register.archive_reviews (
  review_id uuid primary key,
  owner_key text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null,
  receipt jsonb,
  constraint archive_review_snapshot_identity check (coalesce(
    jsonb_typeof(snapshot)='object' and snapshot->>'reviewId'=review_id::text
    and snapshot->>'ownerKey'=owner_key and snapshot->>'digest'=digest
    and snapshot->>'moduleId'='M11' and snapshot->>'action' in ('ARCHIVE','RESTORE')
    and jsonb_typeof(snapshot->'snapshot')='array' and jsonb_typeof(snapshot->'targets')='array'
    and snapshot->'receipt'='null'::jsonb and expires_at>created_at
    and (snapshot->>'createdAt')::timestamptz=created_at and (snapshot->>'expiresAt')::timestamptz=expires_at,false)),
  constraint archive_review_receipt_identity check (receipt is null or coalesce(
    jsonb_typeof(receipt)='object' and receipt->>'moduleId'='M11'
    and receipt#>>'{result,reviewId}'=review_id::text and receipt#>>'{result,status}'='COMPLETED'
    and receipt#>>'{result,reviewDigest}'=digest and receipt#>>'{result,action}'=snapshot->>'action'
    and receipt#>'{result,scope}'=snapshot->'scope' and receipt#>>'{result,reason}'=snapshot->>'reason'
    and receipt#>'{result,affected}'=snapshot->'count'
    and case when snapshot->>'action'='RESTORE' then receipt#>'{result,restored}'=snapshot->'count' else receipt#>'{result,archived}'=snapshot->'count' end,false))
);
create index archive_review_owner_time_idx on replacement_register.archive_reviews(owner_key,created_at desc);
create function replacement_register.protect_archive_review() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then raise exception 'Workspace reviews and receipts are retained; deletion is not permitted'; end if;
  if (to_jsonb(NEW)-'receipt') is distinct from (to_jsonb(OLD)-'receipt') then raise exception 'Workspace review snapshots are immutable'; end if;
  if OLD.receipt is not null and NEW.receipt is distinct from OLD.receipt then raise exception 'Workspace review receipts are immutable'; end if;
  return NEW;
end $$;
create trigger archive_review_immutable before update or delete on replacement_register.archive_reviews for each row execute function replacement_register.protect_archive_review();
insert into replacement_register.schema_migrations(version) values('031_archive_reviews');
