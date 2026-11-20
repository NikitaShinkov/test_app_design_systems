import {createHash} from 'node:crypto';
import {archiveReviewIntegrity,archiveReceiptIntegrity} from './archive-review.js';

export const archiveReviewColumns={review_id:['uuid'],owner_key:['text'],created_at:['timestamptz'],expires_at:['timestamptz'],digest:['text'],snapshot:['jsonb'],receipt:['jsonb']};
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value??null);
export async function verifyArchiveReviewSchema(client){
  const columns=(await client.query("select column_name,udt_name from information_schema.columns where table_schema='replacement_register' and table_name='archive_reviews'")).rows,actual=new Map(columns.map(row=>[row.column_name,row.udt_name])),missing=Object.entries(archiveReviewColumns).filter(([column,types])=>!types.includes(actual.get(column))).map(([column])=>`archive_reviews.${column}`);
  const checks=(await client.query("select conname from pg_constraint where conrelid=to_regclass('replacement_register.archive_reviews') and conname in ('archive_review_snapshot_identity','archive_review_receipt_identity') and contype='c' and convalidated")).rows;if(checks.length!==2)missing.push('validated archive review snapshot/receipt constraints');
  if(!(await client.query("select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid=to_regclass('replacement_register.archive_reviews') and t.tgname='archive_review_immutable' and not t.tgisinternal and t.tgenabled in ('O','A') and (t.tgtype & 27)=27 and n.nspname='replacement_register' and p.proname='protect_archive_review'")).rowCount)missing.push('enabled archive review immutability trigger');
  if(!(await client.query("select 1 from pg_indexes where schemaname='replacement_register' and tablename='archive_reviews' and indexname='archive_review_owner_time_idx'")).rowCount)missing.push('archive review owner/time index');return {ok:missing.length===0,missing};
}
export async function archiveReviewInventory(client){
  const digest=createHash('sha256');let cursor=null,records=0,committed=0;
  for(;;){const rows=(await client.query('select review_id::text,owner_key,created_at,expires_at,digest,snapshot,receipt from replacement_register.archive_reviews where ($1::uuid is null or review_id>$1::uuid) order by review_id limit 100',[cursor])).rows;
    for(const row of rows){const review={...row.snapshot,receipt:row.receipt},createdAt=new Date(row.created_at).toISOString(),expiresAt=new Date(row.expires_at).toISOString();if(review.reviewId!==row.review_id||review.ownerKey!==row.owner_key||review.createdAt!==createdAt||review.expiresAt!==expiresAt||review.digest!==row.digest||!archiveReviewIntegrity(review)||(row.receipt&&!archiveReceiptIntegrity(review,row.receipt)))throw Error(`Workspace review integrity failed: ${row.review_id}`);digest.update(canonical({...row,created_at:createdAt,expires_at:expiresAt})+'\n');records++;if(row.receipt)committed++;cursor=row.review_id;}
    if(rows.length<100)break;
  }
  return {formatVersion:1,records,committed,sha256:digest.digest('hex')};
}
