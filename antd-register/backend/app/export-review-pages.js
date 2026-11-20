import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {httpError} from './auth.js';
import {normalize} from './normalization.js';
import {validBusinessDate} from './validation.js';
import {reportModule,isRegisterReportNamespace} from './register-report-access.js';

// Process-local opaque positions expire on API restart. Saved reviews and ID
// links remain durable; multiple API hosts need their own explicit refresh.
const cursorKey=randomBytes(32),uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const invalid=()=>httpError(422,'Choose a page size from 1 to 100 and a valid history cursor.',{code:'EXPORT_HISTORY_PAGE_INVALID'});
const cursorInvalid=()=>httpError(422,'This export-history position expired or is invalid. Refresh the history.',{code:'EXPORT_HISTORY_CURSOR_INVALID'});
const changed=()=>httpError(403,'Your account or assigned scope changed. Refresh the export history.',{code:'EXPORT_HISTORY_ACCESS_CHANGED'});
const stateInvalid=()=>httpError(409,'Saved export-history metadata is inconsistent. Refresh or ask an administrator to check the review.',{code:'EXPORT_HISTORY_STATE_INVALID'});
const timestamp=value=>{
 if(typeof value!=='string')throw stateInvalid();
 const match=value.match(/^(\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.(\d{1,6}))?Z$/);
 if(!match||!validBusinessDate(value.slice(0,10)))throw stateInvalid();return match[1]+'.'+(match[2]||'').padEnd(6,'0')+'Z';
};
const contextBinding=(context,driver)=>{
 if(!context||!['ADMINISTRATOR','SUPPLIER','CLIENT'].includes(context.role)||context.authenticated&&(typeof context.userId!=='string'||!context.userId))throw changed();
 return createHash('sha256').update(JSON.stringify({driver,authenticated:Boolean(context.authenticated),role:context.role,userId:context.authenticated?context.userId:null,actor:context.authenticated?null:context.actor||'',organization:normalize(context.organization),orders:[...new Set((context.orders||[]).map(normalize))].sort()})).digest('hex');
};
function encode(binding,row){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey,nonce),body=Buffer.from(JSON.stringify({v:1,binding,at:row.created_at_key,id:row.job_id})),encrypted=Buffer.concat([cipher.update(body),cipher.final()]);
 return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
}
function decode(value,binding){
 let parsed;try{
  if(typeof value!=='string'||value.length>4096||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();const bytes=Buffer.from(value,'base64url');if(bytes.length<29||bytes.toString('base64url')!==value)throw Error();
  const decipher=createDecipheriv('aes-256-gcm',cursorKey,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));parsed=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  if(!plain(parsed)||Object.keys(parsed).length!==4||parsed.v!==1||!/^[a-f0-9]{64}$/.test(parsed.binding)||!uuid.test(parsed.id)||timestamp(parsed.at)!==parsed.at)throw Error();
 }catch{throw cursorInvalid();}
 if(parsed.binding!==binding)throw changed();return parsed;
}
export function exportReviewPageOptions(input,context,driver){
 if(!plain(input)||Object.keys(input).some(key=>!['limit','cursor'].includes(key)))throw invalid();
 const raw=input.limit??30;if(input.limit===null||!(typeof raw==='number'||typeof raw==='string'&&/^[1-9][0-9]*$/.test(raw)))throw invalid();
 const limit=Number(raw);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw invalid();
 const binding=contextBinding(context,driver),after=Object.hasOwn(input,'cursor')?decode(input.cursor,binding):null;return {limit,binding,after};
}
const integer=(value,min=0)=>{const result=Number(value);if(value===null||value===undefined||value===''||!Number.isSafeInteger(result)||result<min)throw stateInvalid();return result;};
const strings=value=>{if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw stateInvalid();return value;};
function minimalJob(row){
 return {jobId:row.job_id,moduleId:row.module_id,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,ownerRole:row.owner_role,status:row.status,snapshot:{scope:{orderNos:strings(row.order_nos),suppliers:strings(row.suppliers),reportOwnerRole:row.report_owner_role,productDecimalNos:row.products_empty===true?[]:row.products_empty===false?['NONEMPTY']:null,proposalIds:row.proposals_empty===true?[]:row.proposals_empty===false?['NONEMPTY']:null}}};
}
function summary(row){
 if(!uuid.test(row.job_id)||typeof row.module_id!=='string'||!['READY','APPROVED','COMPLETE'].includes(row.status)||typeof row.filename!=='string'||!row.filename||typeof row.data_as_of!=='string'||!Number.isFinite(Date.parse(row.data_as_of))||row.round!==null&&typeof row.round!=='string'&&!(typeof row.round==='number'&&Number.isFinite(row.round)))throw stateInvalid();
 const orders=strings(row.order_nos).filter(value=>row.module_id!==reportModule||!isRegisterReportNamespace(value));
 return {jobId:row.job_id,moduleId:row.module_id,status:row.status,createdAt:timestamp(row.created_at_key),dataAsOf:row.data_as_of,filename:row.filename,version:integer(row.version,1),round:row.round,rows:integer(row.affected),fileCount:integer(row.file_count),orderNos:orders.slice(0,3),orderCount:orders.length,orderNosTruncated:orders.length>3,...(row.module_id==='AUDIT'?{reportFormat:row.report_format==='xlsx'?'xlsx':'csv'}:{})};
}
const descending=(a,b)=>a.created_at_key===b.created_at_key?(a.job_id===b.job_id?0:a.job_id>b.job_id?-1:1):a.created_at_key>b.created_at_key?-1:1;
const below=(row,after)=>!after||row.created_at_key<after.at||row.created_at_key===after.at&&row.job_id<after.id;
function fromLocal(job,id){
 if(!plain(job)||job.jobId!==id||!plain(job.snapshot)||!Array.isArray(job.snapshot.drafts)||!job.snapshot.drafts.length||!plain(job.snapshot.scope))throw stateInvalid();
 const snapshot=job.snapshot,scope=snapshot.scope,main=snapshot.drafts.at(-1);
 return {job_id:id,module_id:job.moduleId,owner_user_id:job.ownerUserId,owner_actor:job.ownerActor,owner_role:job.ownerRole,status:job.status,created_at_key:timestamp(job.createdAt),data_as_of:snapshot.dataAsOf,filename:job.approvedFilename||main.filename,version:snapshot.version,round:snapshot.round??null,affected:snapshot.affected,file_count:snapshot.drafts.length-1,order_nos:scope.orderNos,suppliers:scope.suppliers,report_owner_role:scope.reportOwnerRole,products_empty:Array.isArray(scope.productDecimalNos)?scope.productDecimalNos.length===0:null,proposals_empty:Array.isArray(scope.proposalIds)?scope.proposalIds.length===0:null,...(job.moduleId==='AUDIT'?{report_format:snapshot.provenance?.reportFormat==='xlsx'?'xlsx':'csv'}:{})};
}
async function localCandidates(directory,options){
 let stream;try{stream=await fs.opendir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const candidates=[];
 // Legacy local files have no timestamp index: sequential O(file count) I/O,
 // retaining only limit+1 lightweight candidates and one parsed full journal.
 for await(const entry of stream){
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(entry.name))continue;if(!entry.isFile())throw stateInvalid();
  let job;try{job=JSON.parse(await fs.readFile(path.join(directory,entry.name),'utf8'));}catch{throw stateInvalid();}
  const row=fromLocal(job,entry.name.slice(0,-5));if(!below(row,options.after))continue;candidates.push(row);candidates.sort(descending);if(candidates.length>options.limit+1)candidates.pop();
 }
 return candidates;
}
async function sqlCandidates(pool,options,context){
 const values=[],where=[],add=value=>{values.push(value);return '$'+values.length;};
 if(context.role!=='ADMINISTRATOR'){
  if(context.authenticated)where.push('owner_user_id='+add(context.userId));
  else where.push('owner_user_id is null','owner_role='+add(context.role),'owner_actor='+add(context.actor||''));
 }
 if(options.after)where.push('(created_at,job_id)<('+add(options.after.at)+'::timestamptz,'+add(options.after.id)+'::uuid)');
 const limit=add(options.limit+1);
 return (await pool.query(`select job_id,module_id,owner_user_id,owner_actor,owner_role,status,
  to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_key,
  snapshot_json->>'dataAsOf' as data_as_of,coalesce(payload->>'approvedFilename',snapshot_json#>>'{drafts,-1,filename}') as filename,
  snapshot_json->>'version' as version,coalesce(snapshot_json->'round','null'::jsonb) as round,snapshot_json->>'affected' as affected,
  greatest(jsonb_array_length(snapshot_json->'drafts')-1,0) as file_count,
  case when module_id='AUDIT' then case when snapshot_json#>>'{provenance,reportFormat}'='xlsx' then 'xlsx' else 'csv' end else null end as report_format,
  snapshot_json#>'{scope,orderNos}' as order_nos,snapshot_json#>'{scope,suppliers}' as suppliers,snapshot_json#>>'{scope,reportOwnerRole}' as report_owner_role,
  case when jsonb_typeof(snapshot_json#>'{scope,productDecimalNos}')='array' then jsonb_array_length(snapshot_json#>'{scope,productDecimalNos}')=0 else null end as products_empty,
  case when jsonb_typeof(snapshot_json#>'{scope,proposalIds}')='array' then jsonb_array_length(snapshot_json#>'{scope,proposalIds}')=0 else null end as proposals_empty
  from replacement_register.export_jobs${where.length?' where '+where.join(' and '):''} order by created_at desc,job_id desc limit ${limit}`,values)).rows;
}
export async function readExportReviewPage({pool,directory,input,context,access}){
 const options=exportReviewPageOptions(input,context,pool?'postgres':'local'),rows=pool?await sqlCandidates(pool,options,context):await localCandidates(directory,options),page=rows.slice(0,options.limit),items=[];
 for(const row of page){row.created_at_key=timestamp(row.created_at_key);if(access(minimalJob(row),context))items.push(summary(row));}
 return {items,nextCursor:rows.length>options.limit&&page.length?encode(options.binding,page.at(-1)):null};
}
