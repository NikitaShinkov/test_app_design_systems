import {createHash} from 'node:crypto';
import {validateBomProjection,validateBomProjectionSummary,validateBomRow,bomProjectionHash} from './bom-catalog.js';

const rr='replacement_register',object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function canonical(value){if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return value.map(canonical);if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
const json=value=>JSON.stringify(canonical(value)),insist=(test,detail)=>{if(!test)throw Error('Source-BOM integrity failed: '+detail);};
const typed=(names,type)=>Object.fromEntries(names.split(' ').map(name=>[name,[type]]));
export const sourceBomColumns={
  source_orders:{order_no:['text'],created_at:['timestamptz']},
  source_production_orders:{...typed('order_no production_order','text'),created_at:['timestamptz']},
  source_boms:{artifact_id:['uuid'],...typed('order_no production_order supplier product_decimal_no projection_hash','text'),summary_json:['jsonb'],row_count:['int4'],created_at:['timestamptz']},
  source_bom_rows:{artifact_id:['uuid'],source_row:['int4'],...typed('position orig_code orig_mfr orig_pn component_status','text'),row_json:['jsonb']}
};
export const sourceBomTables=Object.freeze(Object.keys(sourceBomColumns));

export async function verifySourceBomPrivileges(client,role=null){
  role||=(await client.query('select current_user as role')).rows[0].role;const missing=[];
  for(const table of sourceBomTables){const rights=(await client.query("select has_table_privilege($1,$2,'SELECT') as read,has_table_privilege($1,$2,'INSERT') as append,has_table_privilege($1,$2,'UPDATE') as edit,has_table_privilege($1,$2,'DELETE') as remove,has_table_privilege($1,$2,'TRUNCATE') as truncate",[role,rr+'.'+table])).rows[0];if(!rights.read||!rights.append||rights.edit||rights.remove||rights.truncate)missing.push(table+': SELECT/INSERT only');}
  return {ok:missing.length===0,missing};
}

export async function verifySourceBomSchema(client){
  const missing=[],columns=(await client.query('select table_name,column_name,udt_name,is_nullable from information_schema.columns where table_schema=$1 and table_name=any($2::text[])',[rr,sourceBomTables])).rows;
  for(const [table,required]of Object.entries(sourceBomColumns))for(const [column,types]of Object.entries(required)){const value=columns.find(row=>row.table_name===table&&row.column_name===column),nullable=table==='source_boms'&&column==='production_order';if(!value||!types.includes(value.udt_name)||value.is_nullable!==(nullable?'YES':'NO'))missing.push(table+'.'+column+' type/nullability');}
  const constraints=(await client.query("select c.relname as table,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid) as definition,array(select a.attname::text from unnest(k.conkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.n order by x.o) as columns,f.relname as target,array(select a.attname::text from unnest(k.confkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.n order by x.o) as target_columns from pg_constraint k join pg_class c on c.oid=k.conrelid left join pg_class f on f.oid=k.confrelid where c.relnamespace=to_regnamespace($1) and c.relname=any($2::text[])",[rr,sourceBomTables])).rows;
  for(const [table,fields]of [['source_orders',['order_no']],['source_production_orders',['order_no','production_order']],['source_boms',['artifact_id']],['source_bom_rows',['artifact_id','source_row']]])if(!constraints.some(row=>row.table===table&&row.contype==='p'&&row.convalidated&&same(row.columns,fields)))missing.push(table+' primary key('+fields.join(',')+')');
  const foreign=[['source_production_orders',['order_no'],'source_orders',['order_no']],['source_boms',['artifact_id'],'artifacts',['artifact_id']],['source_boms',['order_no'],'source_orders',['order_no']],['source_boms',['order_no','production_order'],'source_production_orders',['order_no','production_order']],['source_bom_rows',['artifact_id'],'source_boms',['artifact_id']]];
  for(const [table,fields,target,targetFields]of foreign)if(!constraints.some(row=>row.table===table&&row.contype==='f'&&row.convalidated&&same(row.columns,fields)&&row.target===target&&same(row.target_columns,targetFields)))missing.push(table+' validated foreign key('+fields.join(',')+')');
  for(const [table,fragments]of [['source_orders',['length(order_no)','> 0']],['source_production_orders',['length(production_order)','> 0']],['source_boms',['projection_hash','64']],['source_boms',['row_count','250000']],['source_boms',['summary_json','formatVersion','sourceSha256','sourceBytes','headerRow','lastDataRow','rowCount','productionOrder','false']],['source_bom_rows',['source_row','250000']],['source_bom_rows',['row_json','sourceRow','origCode','origMfr','origPn','componentStatus','false']]])if(!constraints.some(row=>row.table===table&&row.contype==='c'&&row.convalidated&&fragments.every(fragment=>row.definition.includes(fragment))))missing.push(table+' validated CHECK('+fragments.join('/')+')');
  const triggers=(await client.query('select c.relname as table,t.tgname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,n.nspname as function_schema,p.proname as function_name from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where c.relnamespace=to_regnamespace($1) and c.relname=any($2::text[]) and not t.tgisinternal',[rr,sourceBomTables])).rows;
  for(const table of sourceBomTables)if(!triggers.some(row=>row.table===table&&row.tgname===table+'_immutable'&&Number(row.tgtype)===58&&['O','A'].includes(row.tgenabled)&&row.function_schema===rr&&row.function_name==='reject_event_changes'))missing.push(table+' enabled immutable trigger');
  const artifactGuard=(await client.query("select t.tgtype,t.tgenabled,n.nspname as function_schema,p.proname as function_name from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid=to_regclass($1) and t.tgname='source_bom_artifact_identity' and not t.tgisinternal",[rr+'.artifacts'])).rows[0];
  if(!artifactGuard||Number(artifactGuard.tgtype)!==19||!['O','A'].includes(artifactGuard.tgenabled)||artifactGuard.function_schema!==rr||artifactGuard.function_name!=='protect_source_bom_artifact')missing.push('artifacts enabled source_bom_artifact_identity trigger');
  for(const [table,name]of [['source_boms','source_bom_complete'],['source_bom_rows','source_bom_row_complete']])if(!triggers.some(row=>row.table===table&&row.tgname===name&&Number(row.tgtype)===5&&['O','A'].includes(row.tgenabled)&&row.tgdeferrable&&row.tginitdeferred&&row.function_schema===rr&&row.function_name==='check_source_bom'))missing.push(name+' enabled initially-deferred publication trigger');
  const indexes=(await client.query('select indexname from pg_indexes where schemaname=$1 and tablename=any($2::text[])',[rr,sourceBomTables])).rows;for(const name of ['source_boms_order_page_idx','source_boms_product_page_idx'])if(!indexes.some(row=>row.indexname===name))missing.push(name);
  return {ok:missing.length===0,missing};
}

const sourceItem=row=>({artifactId:row.artifact_id,kind:row.kind,moduleId:row.module_id,sha256:row.sha256,bytes:Number(row.bytes),scope:row.scope_json});
function validateSummary(item,summary,rowCount){
  validateBomProjectionSummary(item,summary);
  const {rowCount:storedCount,...projection}=summary;insist(storedCount===rowCount,'source geometry/count differs');return projection;
}
function validateStoredRow(row,projection,expected){
  const value=row.row_json;insist(object(value)&&row.source_row===expected&&value.sourceRow===expected,'source rows are missing, duplicated or out of physical order');
  for(const [column,key]of [['position','position'],['orig_code','origCode'],['orig_mfr','origMfr'],['orig_pn','origPn'],['component_status','componentStatus']])insist(typeof row[column]==='string'&&row[column]===value[key],'source row query column differs from retained cells');
  validateBomRow(value,projection.headers,expected);
  return value;
}
function projectionDigest(projection){
  const hash=createHash('sha256'),keys=Object.keys({...projection,rows:[]}).sort();let firstRow=true;
  hash.update('{');for(let i=0;i<keys.indexOf('rows');i++){if(i)hash.update(',');hash.update(JSON.stringify(keys[i])+':'+json(projection[keys[i]]));}if(keys.indexOf('rows')>0)hash.update(',');hash.update('"rows":[');
  return {row(value){if(!firstRow)hash.update(',');firstRow=false;hash.update(json(value));},finish(){hash.update(']');for(let i=keys.indexOf('rows')+1;i<keys.length;i++)hash.update(','+JSON.stringify(keys[i])+':'+json(projection[keys[i]]));hash.update('}');return hash.digest('hex');}};
}

/** Caller owns a stable read transaction or writer quiescence. SQL pages stay bounded. */
export async function sourceBomInventory(client){
  const protection=await verifySourceBomSchema(client);insist(protection.ok,protection.missing.join('; '));
  const sourcesDigest=createHash('sha256'),rowsDigest=createHash('sha256');let cursor=null,sources=0,rows=0;
  for(;;){
    const batch=(await client.query(`select b.*,a.kind,a.module_id,a.sha256,a.bytes,a.scope_json from ${rr}.source_boms b left join ${rr}.artifacts a using(artifact_id) where ($1::uuid is null or b.artifact_id>$1::uuid) order by b.artifact_id limit 25`,[cursor])).rows;
    for(const source of batch){
      const projection=validateSummary(sourceItem(source),source.summary_json,source.row_count),meta=projection.metadata;
      insist(source.order_no===meta.orderNo&&source.supplier===meta.supplier&&source.product_decimal_no===meta.productDecimalNo&&(source.production_order??'')===meta.productionOrder,'source query columns differ from retained metadata');
      insist((await client.query(`select 1 from ${rr}.source_orders where order_no=$1`,[meta.orderNo])).rowCount===1,'source order reference is missing');
      if(meta.productionOrder)insist((await client.query(`select 1 from ${rr}.source_production_orders where order_no=$1 and production_order=$2`,[meta.orderNo,meta.productionOrder])).rowCount===1,'source production-order reference is missing');
      const digest=projectionDigest(projection);let rowCursor=0,count=0;
      for(;;){const page=(await client.query(`select * from ${rr}.source_bom_rows where artifact_id=$1 and source_row>$2 order by source_row limit 100`,[source.artifact_id,rowCursor])).rows;for(const row of page){const value=validateStoredRow(row,projection,projection.headerRow+count+1);digest.row(value);rowsDigest.update(json(row)+'\n');rowCursor=row.source_row;count++;rows++;}if(page.length<100)break;}
      insist(count===source.row_count&&digest.finish()===source.projection_hash,'retained source row count or projection SHA-256 differs');
      const {kind,module_id,sha256,bytes,scope_json,...stored}=source;sourcesDigest.update(json(stored)+'\n');sources++;cursor=source.artifact_id;
    }if(batch.length<25)break;
  }
  insist(Number((await client.query(`select count(*)::text as n from ${rr}.source_bom_rows`)).rows[0].n)===rows,'orphan source rows');
  const tables={source_boms:{records:sources,sha256:sourcesDigest.digest('hex')},source_bom_rows:{records:rows,sha256:rowsDigest.digest('hex')}};
  for(const table of ['source_orders','source_production_orders']){const digest=createHash('sha256');let previous=null,records=0;for(;;){const page=(await client.query(`select * from ${rr}.${table} where ($1::text is null or order_no>$1::text${table==='source_production_orders'?' or (order_no=$1::text and production_order>$2::text)':''}) order by order_no${table==='source_production_orders'?',production_order':''} limit 100`,table==='source_production_orders'?[previous?.order_no??null,previous?.production_order??null]:[previous?.order_no??null])).rows;for(const row of page){insist(typeof row.order_no==='string'&&row.order_no.length>0,'invalid source order');if(table==='source_production_orders')insist(typeof row.production_order==='string'&&row.production_order.length>0,'invalid source production order');digest.update(json(row)+'\n');records++;previous=row;}if(page.length<100)break;}tables[table]={records,sha256:digest.digest('hex')};}
  return {formatVersion:1,sources,rows,tables,sourceIdentityVerified:true,projectionHashesVerified:true};
}

export function localSourceBomInventory(catalog){
  insist(object(catalog)&&Array.isArray(catalog.items),'invalid local file catalog');const entries=catalog.boms??{};insist(object(entries),'invalid local source-BOM map');
  const items=new Map(catalog.items.map(item=>[item.artifactId,item])),digest=createHash('sha256');insist(items.size===catalog.items.length,'ambiguous local artifact IDs');let sources=0,rows=0;
  for(const id of Object.keys(entries).sort()){const entry=entries[id],item=items.get(id);insist(item&&object(entry)&&Object.keys(entry).length===2&&Object.hasOwn(entry,'projectionHash')&&Object.hasOwn(entry,'projection'),'orphan or invalid local source-BOM entry');validateBomProjection(item,entry.projection);insist(entry.projectionHash===bomProjectionHash(entry.projection),'local projection SHA-256 differs');digest.update(json({artifactId:id,...entry})+'\n');sources++;rows+=entry.projection.rows.length;}
  return {formatVersion:1,mode:'local-catalog',sources,rows,sha256:digest.digest('hex'),sourceIdentityVerified:true,projectionHashesVerified:true};
}
