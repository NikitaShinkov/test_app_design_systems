import {createHash} from 'node:crypto';
import {httpError} from './auth.js';
import {validBusinessDate} from './validation.js';
import {publishNamedRead} from './named-read.js';
import {inspectStoredEnvelope} from './audit-provenance.js';
import {auditReportColumns,auditReportValues,auditReportSourceSummary,parseAuditReportFormat} from './audit-report-fields.js';
import {createAuditReportCapture} from './audit-report-spool.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const admin=context=>{if(context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can view or export the audit log.');};
export function auditFilters(input={}){
  const result={};for(const [key,maximum] of [['search',200],['actor',200],['action',100],['subject',200],['from',10],['through',10]]){if(input[key]!=null&&typeof input[key]!=='string')throw httpError(422,`Invalid audit ${key} filter.`);const value=(input[key]||'').trim();if(value.length>maximum)throw httpError(422,`Shorten the audit ${key} filter to ${maximum} characters.`);result[key]=value;}
  for(const field of ['from','through'])if(result[field]&&(!validBusinessDate(result[field])||Number(result[field].slice(0,4))<1))throw httpError(422,'Choose valid audit dates (YYYY-MM-DD, UTC).');
  if(result.from&&result.through&&result.from>result.through)throw httpError(422,'The first audit date must be on or before the last date.');result.action=result.action.toUpperCase();return result;
}
const instant=value=>value instanceof Date?value.toISOString():new Date(value).toISOString();
function cursorOptions(input,mode,filters){
  const limit=Number(input.limit||50);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw httpError(422,'Choose an audit page size from 1 to 100.');let cursor=null;
  if(input.cursor)try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(cursor.mode!==mode||cursor.filters!==hash(filters)||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(cursor.at)||!validBusinessDate(cursor.at.slice(0,10))||instant(cursor.at).slice(0,23)!==cursor.at.slice(0,23))throw new Error();
    if(mode==='sql'){for(const key of ['ceiling','id'])if(!/^[0-9]{1,19}$/.test(cursor[key])||BigInt(cursor[key])>9223372036854775807n)throw new Error();if(BigInt(cursor.id)>BigInt(cursor.ceiling))throw new Error();}
    else if(!/^[BEFJ]:[a-zA-Z0-9:-]{1,120}$/.test(cursor.key)||typeof cursor.ceiling!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.ceiling)||instant(cursor.ceiling)!==cursor.ceiling)throw new Error();
  }catch{throw httpError(422,'The audit page cursor is invalid or its filters changed. Refresh the log.');}
  return {limit,cursor};
}
export function auditProvenanceProjection(raw){const read=inspectStoredEnvelope(raw);return {provenance:read.status==='VALID'?read.value:null,provenanceState:read.status==='VALID'?'RECORDED':read.status==='LEGACY'?'NOT_RECORDED':'INVALID'};}
const publicEvent=({_key,_at,provenance,...event})=>({...structuredClone(event),...auditProvenanceProjection(provenance)});
const token=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function localRow(event,stream){const id=String(event.id),key=stream==='B'?`B:${id.padStart(20,'0')}`:stream==='F'?`F:${String(event.sequence).padStart(20,'0')}`:`${stream}:${event.jobId}:${String(event.sequence).padStart(4,'0')}`;return {...event,id:`${stream}:${id}`,stream:stream==='B'?'register':stream==='F'?'files':stream==='J'?'jobs':'exports',_key:key,_at:instant(event.occurredAt),occurredAt:instant(event.occurredAt)};}
const sortEvents=(a,b)=>b._at.localeCompare(a._at)||b._key.localeCompare(a._key);
function matches(event,filters){
  if(filters.action&&event.action!==filters.action)return false;if(filters.subject&&String(event.subject)!==filters.subject)return false;
  if(filters.actor&&!String(event.actor).toUpperCase().includes(filters.actor.toUpperCase()))return false;
  if(filters.from&&event._at<`${filters.from}T00:00:00.000Z`)return false;if(filters.through&&event._at.slice(0,10)>filters.through)return false;
  const text=[event.actor,event.action,event.subject,event.detail,event.before?.orderNo,event.after?.orderNo,event.after?.options?.orderNo,JSON.stringify(event.after?.scope?.orderNos||[])].join(' ').toUpperCase();return !filters.search||text.includes(filters.search.toUpperCase());
}
export function auditCSVCell(value){let text=String(value??'');if(/^[\s\uFEFF]*[=+\-@]/u.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`;}
const csvRow=event=>auditReportValues(event).map(auditCSVCell).join(',')+'\r\n';
const reportTooLarge=()=>httpError(422,'The complete audit report exceeds the file size limit. Narrow its dates or filters and prepare it again; no truncated report was created.',{code:'AUDIT_REPORT_TOO_LARGE'});
const xlsxUnavailable=()=>httpError(503,'The audit workbook generator is unavailable. Try again when file processing is available.',{code:'AUDIT_XLSX_UNAVAILABLE'});
const xlsxType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export class AuditFeed {
  constructor(storage,artifacts,exports,jobs=null,{generator=null}={}){this.storage=storage;this.artifacts=artifacts;this.exports=exports;this.jobs=jobs;this.generator=generator;this.pool=storage.rawPool||storage.pool||null;}
  async localEvents(){const business=await this.storage.listAudit(),files=await this.artifacts.listAuditEvents(),exports=await this.exports.listAuditEvents(),jobs=await this.jobs?.listAuditEvents()||[];return [...business.map(row=>localRow(row,'B')),...files.map(row=>localRow(row,'F')),...exports.map(row=>localRow(row,'E')),...jobs.map(row=>localRow(row,'J'))].sort(sortEvents);}
  async list(input,context){admin(context);const filters=auditFilters(input);return publishNamedRead(this.pool,context,async()=>this.pool?this.sqlPage(this.pool,input,filters):this.localPage(await this.localEvents(),input,filters),{code:'AUDIT_ACCOUNT_CHANGED'});}
  localPage(events,input,filters){const {limit,cursor}=cursorOptions(input,'local',filters),ceiling=cursor?.ceiling||new Date().toISOString();let rows=events.filter(event=>event._at<=ceiling&&matches(event,filters));if(cursor)rows=rows.filter(event=>event._at<cursor.at||event._at===cursor.at&&event._key<cursor.key);const page=rows.slice(0,limit),last=page.at(-1);return {items:page.map(publicEvent),nextCursor:rows.length>limit?token({mode:'local',filters:hash(filters),ceiling,at:last._at,key:last._key}):null,filters};}
  async sqlPage(client,input,filters){
    const {limit,cursor}=cursorOptions(input,'sql',filters),ceiling=cursor?.ceiling||(await client.query('select coalesce(max(id),0)::text as id from replacement_register.audit_events')).rows[0].id;
    const values=[ceiling],where=['id<=$1'];const add=(clause,value)=>{values.push(value);where.push(clause.replaceAll('?',`$${values.length}`));};
    if(filters.action)add('action=?',filters.action);if(filters.subject)add('subject=?',filters.subject);if(filters.actor)add('strpos(upper(actor collate replacement_register.search_unicode),upper(?::text collate replacement_register.search_unicode))>0',filters.actor);
    if(filters.search)add("strpos(upper(concat_ws(' ',actor,action,subject,detail,before_json->>'orderNo',after_json->>'orderNo',after_json#>>'{options,orderNo}',after_json#>>'{scope,orderNos}') collate replacement_register.search_unicode),upper(?::text collate replacement_register.search_unicode))>0",filters.search);
    if(filters.from)add("occurred_at>=(?::date::timestamp at time zone 'UTC')",filters.from);if(filters.through)add("occurred_at<((?::date+interval '1 day') at time zone 'UTC')",filters.through);
    if(cursor){values.push(cursor.at,cursor.id);where.push(`(occurred_at,id)<($${values.length-1}::timestamptz,$${values.length}::bigint)`);}values.push(limit+1);
    const rows=(await client.query(`select id,occurred_at as "occurredAt",actor,actor_user_id as "actorUserId",actor_role as role,request_id as "requestId",action,subject,detail,before_json as before,after_json as after,provenance_json::text as provenance,to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time from replacement_register.audit_events where ${where.join(' and ')} order by occurred_at desc,id desc limit $${values.length}`,values)).rows;
    const page=rows.slice(0,limit),last=page.at(-1);return {items:page.map(({cursor_time,...row})=>({...row,id:`S:${row.id}`,stream:'database',occurredAt:instant(row.occurredAt),...auditProvenanceProjection(row.provenance)})),nextCursor:rows.length>limit?token({mode:'sql',filters:hash(filters),ceiling,at:last.cursor_time,id:String(last.id)}):null,filters};
  }
  async *reportRows(filters,capture={},{signal}={}){
    signal?.throwIfAborted();
    if(!this.pool){capture.startedAt=new Date().toISOString();const events=await this.localEvents();capture.asOf=new Date().toISOString();capture.consistency='Committed local sources captured during this interval';for(const row of events.filter(row=>matches(row,filters))){signal?.throwIfAborted();yield publicEvent(row);}return;}
    const client=await this.pool.connect();let success=false;try{await client.query('begin isolation level repeatable read read only');capture.asOf=instant((await client.query('select transaction_timestamp() as at')).rows[0].at);capture.consistency='PostgreSQL repeatable-read snapshot';let cursor;do{signal?.throwIfAborted();const page=await this.sqlPage(client,{limit:100,...(cursor?{cursor}:{})},filters);for(const row of page.items){signal?.throwIfAborted();yield row;}cursor=page.nextCursor;}while(cursor);success=true;}finally{try{await client.query(success?'commit':'rollback');}finally{client.release();}}
  }
  async prepareReport(input,context,{format='csv',signal}={}){
    admin(context);format=parseAuditReportFormat(format,{defaultFormat:'csv'});signal?.throwIfAborted();
    if(format==='xlsx'&&(!this.generator||typeof this.generator.run!=='function'||this.generator.closed))throw xlsxUnavailable();
    const filters=auditFilters(input),capture={},maximum=this.artifacts.maxBytes;let spool=null;
    try{
      let rows,buffer;
      if(format==='csv'){
        const parts=[Buffer.from('\uFEFF'+auditReportColumns.join(',')+'\r\n')];let bytes=parts[0].length;rows=0;if(bytes>maximum)throw reportTooLarge();
        for await(const event of this.reportRows(filters,capture,{signal})){signal?.throwIfAborted();const part=Buffer.from(csvRow(event));bytes+=part.length;if(bytes>maximum)throw reportTooLarge();parts.push(part);rows++;}buffer=Buffer.concat(parts);
      }else{
        const events=this.reportRows(filters,capture,{signal});
        const values=async function*(){for await(const event of events){signal?.throwIfAborted();yield auditReportValues(event);}};
        spool=await createAuditReportCapture({root:this.artifacts.root,rows:values(),maxBytes:maximum,signal,storageLimits:this.artifacts.storageLimits,...(typeof this.artifacts.checkSpace==='function'?{checkSpace:this.artifacts.checkSpace}:{})});rows=spool.rows;
      }
      const asOf=capture.asOf,key=JSON.stringify({report:'AUDIT',filters,...(format==='xlsx'?{reportFormat:'xlsx'}:{})}),version=await this.artifacts.exportVersion(key),filename=`Audit_Log_UTC_${asOf.slice(0,10).replaceAll('-','')}_v${version}.${format}`;
      const reportCapture=format==='xlsx'?{...capture,filters:structuredClone(filters),rows,reportFormat:format,source:auditReportSourceSummary(spool.source)}:capture;
      if(format==='xlsx'){
        let file;try{file=await this.generator.run({operation:'AUDIT_REPORT',source:spool.source,directory:spool.directory,capture:reportCapture,filename,maxBytes:maximum,storageLimits:this.artifacts.storageLimits},null,{signal});}catch(error){if(error.code==='FILE_WORKER_CLOSED'||this.generator.closed&&!error.status&&!error.code)throw xlsxUnavailable();throw error;}
        if(!Buffer.isBuffer(file?.buffer)||!file.buffer.length||file.buffer.length>maximum||file.filename!==filename||file.contentType!==xlsxType||file.affected!==rows)throw httpError(500,'The audit workbook generator returned an invalid result.',{code:'AUDIT_REPORT_OUTPUT_INVALID'});buffer=file.buffer;
      }
      signal?.throwIfAborted();await publishNamedRead(this.pool,context,async()=>null,{code:'AUDIT_ACCOUNT_CHANGED'});signal?.throwIfAborted();
      // Keep the original private named-session binding through the actual
      // repository's in-transaction authority check after its object write.
      return await this.exports.prepare({moduleId:'AUDIT',key,version,options:{filters,reportFormat:format},provenance:{asOf,filters,rows,capture:reportCapture,reportFormat:format,format:format==='csv'?'CSV UTF-8 BOM':'XLSX; explicit text cells',completeFilteredReport:true,...(spool?{sourceHash:spool.source.sha256,sourceBytes:spool.source.bytes}:{})},files:[{filename,buffer,contentType:format==='csv'?'text/csv; charset=utf-8':xlsxType,kind:'WORKFLOW_OUTPUT',scope:{orderNos:['SYSTEM-AUDIT'],suppliers:[],productDecimalNos:[],proposalIds:[]},ownerOnly:true,affected:rows}]},context);
    }finally{if(spool)await spool.cleanup();}
  }
}
