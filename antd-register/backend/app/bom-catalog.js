import {createHash} from 'node:crypto';
import {httpError} from './auth.js';
import {WORKBOOK_LIMITS} from './workbook-limits.js';

const metadataKeys=['orderNo','product','productCode','productDecimalNo','supplier','productionOrder'];
const own=(value,key)=>Object.hasOwn(value,key);
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const scalar=value=>value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);
const invalid=detail=>{throw httpError(422,'The source BOM projection does not match the retained workbook.',{code:'BOM_PROJECTION_INVALID',details:[detail]});};
export function canonicalBomValue(value){if(Array.isArray(value))return value.map(canonicalBomValue);if(record(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalBomValue(value[key])]));return value;}
const canonical=canonicalBomValue;
export const bomProjectionHash=projection=>createHash('sha256').update(JSON.stringify(canonical(projection))).digest('hex');
export function bomColumnAddress(column,row){let label='';for(let n=column;n>0;n=Math.floor((n-1)/26))label=String.fromCharCode(65+(n-1)%26)+label;return label+row;}
function metadata(value,label){if(!record(value)||Object.keys(value).length!==metadataKeys.length||!metadataKeys.every(key=>own(value,key)&&typeof value[key]==='string'))invalid(`${label} must contain exactly the six source metadata strings.`);}
export function validateBomProjectionSummary(item,projection){
  if(item.kind!=='ORIGINAL_BOM'||item.moduleId!=='M01')invalid('Only registered original BOM files may carry a projection.');
  if(!record(projection)||projection.formatVersion!==1||projection.sourceSha256!==item.sha256||projection.sourceBytes!==item.bytes||typeof projection.sourceFilename!=='string'||!projection.sourceFilename||typeof projection.sourceSheet!=='string'||!projection.sourceSheet)invalid('Source identity or projection format is invalid.');
  const allowed=['formatVersion','sourceSha256','sourceBytes','sourceFilename','sourceSheet','headerRow','lastDataRow','headers','sourceMetadata','metadata','rowCount','findings'];
  if(Object.keys(projection).some(key=>!allowed.includes(key)))invalid('Unknown projection fields.');
  metadata(projection.metadata,'metadata');metadata(projection.sourceMetadata,'sourceMetadata');
  for(const [key,scope] of [['orderNo','orderNos'],['supplier','suppliers'],['productDecimalNo','productDecimalNos']])if(!projection.metadata[key]?.trim()||item.scope[scope].length!==1||item.scope[scope][0]!==projection.metadata[key])invalid(`Effective ${key} differs from its registered file scope.`);
  const {headerRow,lastDataRow,headers,rowCount}=projection;
  if(!Number.isSafeInteger(headerRow)||headerRow<1||headerRow>20||!Number.isSafeInteger(lastDataRow)||lastDataRow<=headerRow||lastDataRow>WORKBOOK_LIMITS.maxRows||!Array.isArray(headers)||!headers.length||headers.length>WORKBOOK_LIMITS.maxColumns||rowCount!==lastDataRow-headerRow||rowCount*headers.length>WORKBOOK_LIMITS.maxCells)invalid('Source worksheet geometry exceeds the supported workbook bounds.');
  for(let i=0;i<headers.length;i++)if(!record(headers[i])||headers[i].column!==i+1||typeof headers[i].label!=='string'||Object.keys(headers[i]).some(key=>!['column','label'].includes(key)))invalid('Headers must retain their physical columns and labels.');
  if(!Array.isArray(projection.findings)||projection.findings.some(value=>!record(value)))invalid('Source findings must be structured records.');
  assertJsonSafe(projection);return true;
}
export function validateBomRow(row,headers,expectedSourceRow){
    if(!record(row)||row.sourceRow!==expectedSourceRow||Object.keys(row).some(key=>!['sourceRow','position','origCode','origMfr','origPn','quantity','componentStatus','cells'].includes(key))||!['position','origCode','origMfr','origPn','componentStatus'].every(key=>typeof row[key]==='string')||!scalar(row.quantity)||!Array.isArray(row.cells)||row.cells.length!==headers.length)invalid(`Invalid source row ${expectedSourceRow}.`);
    for(let j=0;j<row.cells.length;j++){
      const cell=row.cells[j];if(!record(cell)||cell.column!==j+1||cell.address!==bomColumnAddress(j+1,row.sourceRow)||!['z','b','n','s','e','d'].includes(cell.type)||!scalar(cell.value)||Object.keys(cell).some(key=>!['column','address','type','value','formula','formatted'].includes(key))||['formula','formatted'].some(key=>own(cell,key)&&typeof cell[key]!=='string'))invalid(`Invalid source cell ${bomColumnAddress(j+1,row.sourceRow)}.`);
      if(cell.type==='z'&&cell.value!==null||cell.type==='b'&&cell.value!==null&&typeof cell.value!=='boolean'||['n','e'].includes(cell.type)&&cell.value!==null&&typeof cell.value!=='number'||['s','d'].includes(cell.type)&&cell.value!==null&&typeof cell.value!=='string')invalid(`Source cell ${cell.address} has an inconsistent type.`);
    }
  assertJsonSafe(row);return true;
}
function assertJsonSafe(projection){
  // Fail rather than silently JSON-coerce a non-finite number, undefined,
  // prototype-bearing object or other non-JSON value in retained findings.
  const jsonSafe=value=>scalar(value)||Array.isArray(value)&&value.every(jsonSafe)||record(value)&&Object.values(value).every(jsonSafe);
  if(!jsonSafe(projection))invalid('The projection contains unsupported non-JSON values.');
}
export function validateBomProjection(item,projection){
  if(!record(projection)||!Array.isArray(projection.rows)||own(projection,'rowCount'))invalid('Source rows must be an array with no derived summary fields.');
  const {rows,...summary}=projection;validateBomProjectionSummary(item,{...summary,rowCount:rows.length});
  for(let i=0;i<rows.length;i++)validateBomRow(rows[i],projection.headers,projection.headerRow+i+1);
  return {projectionHash:bomProjectionHash(projection),projection:structuredClone(projection)};
}
export function projectionSummary(item,entry){
  if(!entry)return {...item,indexed:false,rowCount:null};
  const {rows,...projection}=entry.projection;
  return {...item,...projection,indexed:true,rowCount:rows.length,projectionHash:entry.projectionHash};
}
export function projectionSummaryJson(projection){const {rows,...summary}=projection;return {...summary,rowCount:rows.length};}
export function assertSameBomProjection(existing,entry){if(existing&&existing.projectionHash!==entry.projectionHash)throw httpError(409,'This original BOM version already has a different immutable source projection.',{code:'BOM_PROJECTION_CONFLICT'});}
export async function publishBomProjection(client,item,projection){
  const entry=validateBomProjection(item,projection);
  // Legacy indexing and normal artifact UPDATEs share the artifact row lock.
  // Taking this before inserting the projection prevents an UPDATE which
  // started before the immutable guard could see a source_boms row from
  // publishing a different artifact identity after the projection commits.
  const fresh=(await client.query('select * from replacement_register.artifacts where artifact_id=$1 for update',[item.artifactId])).rows[0];
  const expected={logicalKey:item.logicalKey,version:item.version,sha256:item.sha256,filename:item.filename,contentType:item.contentType,bytes:item.bytes,kind:item.kind,moduleId:item.moduleId,scope:item.scope,ownerUserId:item.ownerUserId,ownerActor:item.ownerActor,ownerOnly:item.ownerOnly};
  const current=fresh&&{logicalKey:fresh.logical_key,version:fresh.version,sha256:fresh.sha256,filename:fresh.filename,contentType:fresh.content_type,bytes:Number(fresh.bytes),kind:fresh.kind,moduleId:fresh.module_id,scope:fresh.scope_json,ownerUserId:fresh.owner_user_id,ownerActor:fresh.owner_actor,ownerOnly:fresh.owner_only};
  if(!current||JSON.stringify(canonical(current))!==JSON.stringify(canonical(expected)))throw httpError(409,'The original file identity changed before its source projection could be published.',{code:'BOM_SOURCE_CHANGED'});
  const prior=(await client.query('select projection_hash from replacement_register.source_boms where artifact_id=$1',[item.artifactId])).rows[0];
  if(prior){assertSameBomProjection({projectionHash:prior.projection_hash},entry);return false;}
  const meta=projection.metadata;
  await client.query('insert into replacement_register.source_orders(order_no) values($1) on conflict do nothing',[meta.orderNo]);
  if(meta.productionOrder)await client.query('insert into replacement_register.source_production_orders(order_no,production_order) values($1,$2) on conflict do nothing',[meta.orderNo,meta.productionOrder]);
  await client.query('insert into replacement_register.source_boms(artifact_id,order_no,production_order,supplier,product_decimal_no,projection_hash,summary_json,row_count) values($1,$2,$3,$4,$5,$6,$7,$8)',[item.artifactId,meta.orderNo,meta.productionOrder||null,meta.supplier,meta.productDecimalNo,entry.projectionHash,projectionSummaryJson(projection),projection.rows.length]);
  // Bounded parameter batches keep publication one transaction without the
  // PostgreSQL parameter limit or a round trip for every source component.
  for(let start=0;start<projection.rows.length;start+=250){const values=[],parameters=[];for(const row of projection.rows.slice(start,start+250)){const n=parameters.length;parameters.push(item.artifactId,row.sourceRow,row.position,row.origCode,row.origMfr,row.origPn,row.componentStatus,row);values.push(`(${Array.from({length:8},(_,i)=>'$'+(n+i+1)).join(',')})`);}await client.query(`insert into replacement_register.source_bom_rows(artifact_id,source_row,position,orig_code,orig_mfr,orig_pn,component_status,row_json) values ${values.join(',')}`,parameters);}
  return true;
}
export function bomPageOptions(filters={},rowMode=false){
  const allowed=rowMode?['limit','cursor','q']:['limit','cursor','orderNo','supplier','productDecimalNo'];
  if(!record(filters)||Object.keys(filters).some(key=>!allowed.includes(key)))throw httpError(422,'Unsupported BOM filter.',{code:'BOM_FILTER_INVALID'});
  const limit=filters.limit===undefined?50:Number(filters.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||filters.limit!==undefined&&!/^[1-9][0-9]*$/.test(String(filters.limit)))throw httpError(422,'Choose a page size from 1 to 100.',{code:'BOM_FILTER_INVALID'});
  if(filters.cursor!==undefined&&(typeof filters.cursor!=='string'||filters.cursor.length>100))throw httpError(422,'The BOM page cursor is invalid.',{code:'BOM_FILTER_INVALID'});
  const result={limit,cursor:filters.cursor||null};
  if(result.cursor&&(!rowMode?!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.cursor):!/^[1-9][0-9]*$/.test(result.cursor)||!Number.isSafeInteger(Number(result.cursor))||Number(result.cursor)>WORKBOOK_LIMITS.maxRows))throw httpError(422,'The BOM page cursor is invalid.',{code:'BOM_FILTER_INVALID'});
  for(const key of ['orderNo','supplier','productDecimalNo','q'])if(filters[key]!==undefined){if(typeof filters[key]!=='string'||filters[key].length>2000)throw httpError(422,'The BOM filter is invalid.',{code:'BOM_FILTER_INVALID'});result[key]=filters[key];}
  return result;
}
export const sourceBomId=id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export function bomRowSearchMatches(row,query){const needle=query.toLowerCase(),values=['sourceRow','position','origCode','origMfr','origPn','quantity','componentStatus'].map(key=>row[key]);for(const cell of row.cells)for(const key of ['value','formula','formatted','address'])values.push(cell[key]);return values.some(value=>value!==null&&value!==undefined&&String(value).toLowerCase().includes(needle));}
