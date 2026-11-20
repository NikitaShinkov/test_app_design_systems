import {createHash,randomUUID} from 'node:crypto';
import {cleanText,normalize,currentReferenceContext,NORMALIZATION_VERSION} from './normalization.js';
import {splitDecisionComment} from './domain.js';
import {validBusinessDate} from './validation.js';
import {httpError} from './auth.js';

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const clone=value=>value==null?null:structuredClone(value);
function legacyId(value){const bytes=createHash('sha256').update(JSON.stringify(stable(value))).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const text=bytes.toString('hex');return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`;}
const asTime=value=>{if(value===null||value===undefined||value==='')return null;const date=new Date(value);return Number.isNaN(date.valueOf())?null:date.toISOString();};
export const historyKey=(type,id)=>`${type}:${id}`;
function decisionFingerprint(row){
  if(!row)return null;const reply=splitDecisionComment(row.clientDecision,row.clientComment);
  return digest({identity:['orderNo','productDecimalNo','origMfr','origPn','altMfr','altPn'].map(key=>normalize(row[key])),
    decision:cleanText(row.decisionStatus??reply.clientDecision),technicalReply:cleanText(row.clientReplyRaw),
    comment:cleanText(row.decisionComment??reply.clientComment),responsible:cleanText(row.responsible),reference:cleanText(row.decisionReference),date:cleanText(row.decisionDate)});
}
const meaningful=row=>Boolean(row&&[row.decisionStatus,row.clientDecision,row.clientReplyRaw,row.clientComment,row.decisionComment,row.responsible,row.decisionReference,row.decisionDate].some(cleanText));
function scopeFor(before,after){const snapshots=[before,after].filter(Boolean),scope=[];let adminOnly=!snapshots.length;for(const row of snapshots){if(!cleanText(row.orderNo))adminOnly=true;const item={orderNo:cleanText(row.orderNo),supplier:cleanText(row.supplier),orderKey:normalize(row.orderNo),supplierKey:normalize(row.supplier)};if(!scope.some(value=>value.orderKey===item.orderKey&&value.supplierKey===item.supplierKey))scope.push(item);}return {scope,adminOnly};}
export function historySource(context={},row=null){
  const supplied=context.decisionSource||{};const reference=currentReferenceContext();
  return {...Object.fromEntries(Object.entries({moduleId:context.sourceModule,filename:context.sourceFilename,sha256:context.sourceSha256,artifactId:context.sourceArtifactId,importBatchId:context.importBatchId,idempotencyKey:context.sourceHash,round:context.round,...supplied}).filter(([,value])=>value!==undefined&&value!==null&&value!=='')),
    ...(reference?{referenceRevision:reference.revision,referenceHash:reference.hash}:{}),normalizationVersion:NORMALIZATION_VERSION};
}
export function describeDecisionAudit(audit){
  const action=audit.action;let kind;
  if(action==='DECISION_UPDATED')kind='CLIENT_DECISION';
  else if(action==='DATABASE_RECORD_CREATED')kind='RECORDED';
  else if(action==='DATABASE_RECORD_MODERATED')kind='CORRECTED';
  else if(action==='DATABASE_RECORD_DELETED')kind='REMOVED';
  else if(action==='LIFECYCLE_REPORTED')kind='LIFECYCLE_REPORTED';
  else if(action==='SOURCE_RECORD_IMPORTED')kind='SOURCE_IMPORTED';
  else if(action==='SOURCE_RECORD_UPDATED')kind='SOURCE_UPDATED';
  else if(/^WORKFLOW_M02_ROW_(IMPORTED|UPDATED)$/.test(action))kind='SUPPLIER_REPLY';
  else if(/^WORKFLOW_M04_(ROW_IMPORTED|CLIENT_PROPOSAL_CREATED)$/.test(action))kind='CLIENT_REPLY';
  else if(action==='WORKFLOW_M08_ROW_IMPORTED')kind='FINAL_EVIDENCE';
  else if(action==='WORKFLOW_M11_ROW_UPDATED')kind=audit.after?.archived?'ARCHIVED':'RESTORED';
  else if(['WORKFLOW_M91_ROW_UPDATED','REFERENCE_PROJECTION_UPDATED'].includes(action))kind='NORMALIZED';
  else return null;
  const sample=audit.after||audit.before;if(!sample)return null;
  const record=Boolean(sample.recordId||Object.hasOwn(sample,'decisionStatus')),streamType=record?'RECORD':'PROPOSAL',subjectId=record?sample.recordId||audit.subject:sample.proposalId||audit.subject;
  if(!subjectId)return null;
  const prepare=row=>row?{...row,[record?'recordId':'proposalId']:subjectId}:null;
  const before=prepare(audit.before),after=prepare(audit.after),changed=decisionFingerprint(before)!==decisionFingerprint(after);
  if(['CLIENT_DECISION','NORMALIZED'].includes(kind)&&!changed)return null;
  return {streamType,subjectId,streamKey:historyKey(streamType,subjectId),kind,before,after,changesDecision:changed&&(meaningful(before)||meaningful(after)),
    related:{...(record?{recordId:subjectId}:{}),...(sample.proposalId?{proposalId:sample.proposalId}:{})},...scopeFor(before,after)};
}
function materialize(descriptor,audit,head,source,{baseline=false,legacy=false}={}){
  const snapshot=baseline?descriptor.before:descriptor.after;
  const kind=baseline?'BASELINE':descriptor.kind,origin=`audit:${audit.id}${baseline?':baseline':''}`;
  const entry={eventId:legacy?legacyId([origin,audit.occurredAt,audit.action,audit.subject,audit.before,audit.after]):randomUUID(),
    streamType:descriptor.streamType,subjectId:descriptor.subjectId,sequence:head.lastSequence+1,kind,occurredAt:asTime(audit.occurredAt),
    actor:baseline?'Original actor not recorded':audit.actor||'Original actor not recorded',actorUserId:baseline?null:audit.actorUserId||null,role:baseline?'SYSTEM':audit.role||'SYSTEM',
    requestId:baseline?null:audit.requestId||null,reason:baseline?'Existing state captured before this tracked action; the original action time and actor are not inferred.':audit.detail||'',
    historyFormatVersion:1,before:baseline?null:clone(descriptor.before),after:clone(snapshot),previousEventId:head.latestEventId||null,
    supersedesEventId:!baseline&&descriptor.changesDecision?head.decisionEventId||null:null,
    changesDecision:baseline?meaningful(snapshot):descriptor.changesDecision,snapshotComplete:true,related:descriptor.related,
    ...scopeFor(baseline?null:descriptor.before,snapshot),source:baseline?
      {observedDuringAuditId:String(audit.id),observedDuring:clone(source),...(snapshot?.sourceSheet?{sheet:snapshot.sourceSheet}:{}),...(snapshot?.sourceRow?{row:snapshot.sourceRow}:{}),...(legacy?{retainedAudit:true}:{})}:
      {...source,auditId:String(audit.id),...(legacy?{retainedAudit:true}:{})}};
  return {entry,origin};
}
const needsBaseline=(descriptor,last)=>Boolean(descriptor.before&&(!last||last.snapshotComplete===false||decisionFingerprint(last.after)!==decisionFingerprint(descriptor.before)));
export function appendMemoryDecisionAudit(state,audit,{legacy=false}={}){
  const descriptor=describeDecisionAudit(audit);if(!descriptor)return [];
  const events=state.decisionEvents||=[],heads=state.decisionEventHeads||={};
  if(events.some(event=>event.originKey===`audit:${audit.id}`))return [];
  if(!heads[descriptor.streamKey]){const previous=events.filter(event=>event.streamKey===descriptor.streamKey).sort((a,b)=>a.sequence-b.sequence);heads[descriptor.streamKey]={lastSequence:previous.at(-1)?.sequence||0,latestEventId:previous.at(-1)?.eventId||null,decisionEventId:previous.filter(event=>event.changesDecision).at(-1)?.eventId||null};}
  const head=heads[descriptor.streamKey],last=events.find(event=>event.eventId===head.latestEventId);
  const source=clone(audit.decisionSource||(legacy?{originalNormalizationVersion:null}:{normalizationVersion:NORMALIZATION_VERSION})),created=[];
  for(const baseline of needsBaseline(descriptor,last)?[true,false]:[false]){
    const {entry,origin}=materialize(descriptor,audit,head,source,{baseline,legacy});
    if(state.decisionEventSequence===undefined)state.decisionEventSequence=events.reduce((maximum,event)=>Math.max(maximum,Number(event.ordinal)||0),0);
    state.decisionEventSequence++;const event={...entry,originKey:origin,ordinal:String(state.decisionEventSequence),streamKey:descriptor.streamKey};events.push(event);created.push(event);
    head.lastSequence=entry.sequence;head.latestEventId=entry.eventId;if(entry.changesDecision)head.decisionEventId=entry.eventId;
  }
  return created;
}
export function migrateMemoryDecisionAudit(state){
  const before=state.decisionEvents?.length||0;
  for(const audit of [...state.audit].sort((a,b)=>String(a.occurredAt).localeCompare(String(b.occurredAt))||Number(a.id)-Number(b.id)))appendMemoryDecisionAudit(state,audit,{legacy:true});
  return (state.decisionEvents?.length||0)-before;
}
export async function appendSqlDecisionAudit(client,audit,{legacy=false}={}){
  const descriptor=describeDecisionAudit(audit);if(!descriptor)return [];
  if((await client.query('select 1 from replacement_register.decision_events where origin_key=$1',[`audit:${audit.id}`])).rowCount)return [];
  await client.query('insert into replacement_register.decision_event_heads(stream_key) values($1) on conflict do nothing',[descriptor.streamKey]);
  const stored=(await client.query('select * from replacement_register.decision_event_heads where stream_key=$1 for update',[descriptor.streamKey])).rows[0];
  if((await client.query('select 1 from replacement_register.decision_events where origin_key=$1',[`audit:${audit.id}`])).rowCount)return [];
  const head={lastSequence:Number(stored.last_sequence),latestEventId:stored.latest_event_id,decisionEventId:stored.decision_event_id};
  const last=head.latestEventId?(await client.query('select event_json from replacement_register.decision_events where event_id=$1',[head.latestEventId])).rows[0]?.event_json:null,created=[];
  for(const baseline of needsBaseline(descriptor,last)?[true,false]:[false]){
    const {entry,origin}=materialize(descriptor,audit,head,audit.decisionSource||(legacy?{originalNormalizationVersion:null}:{normalizationVersion:NORMALIZATION_VERSION}),{baseline,legacy}),snapshot=entry.after||entry.before||{},status=snapshot.decisionStatus||snapshot.clientDecision;
    const row=(await client.query(`insert into replacement_register.decision_events(event_id,stream_key,event_sequence,previous_event_id,supersedes_event_id,origin_key,audit_id,event_json,proposal_id,decision_status,responsible,decision_reference,decision_date,decision_comment,created_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,[entry.eventId,descriptor.streamKey,entry.sequence,entry.previousEventId,entry.supersedesEventId,origin,String(audit.id),entry,
      snapshot.proposalId||null,['APPROVED','REJECTED'].includes(status)?status:null,cleanText(snapshot.responsible)||null,cleanText(snapshot.decisionReference)||null,validBusinessDate(cleanText(snapshot.decisionDate))?snapshot.decisionDate:null,snapshot.decisionComment||snapshot.clientComment||null,entry.occurredAt||new Date().toISOString()])).rows[0];
    created.push({...entry,originKey:origin,ordinal:String(row.id),streamKey:descriptor.streamKey});head.lastSequence=entry.sequence;head.latestEventId=entry.eventId;if(entry.changesDecision)head.decisionEventId=entry.eventId;
  }
  await client.query('update replacement_register.decision_event_heads set last_sequence=$2,latest_event_id=$3,decision_event_id=$4 where stream_key=$1',[descriptor.streamKey,head.lastSequence,head.latestEventId,head.decisionEventId]);return created;
}
export async function migrateSqlDecisionAudit(client){
  let count=0,cursor='0';const maximum=(await client.query('select coalesce(max(id),0)::text as id from replacement_register.audit_events')).rows[0].id;
  while(true){const rows=(await client.query(`select id,occurred_at as "occurredAt",actor,actor_user_id as "actorUserId",actor_role as role,request_id as "requestId",action,subject,detail,before_json as before,after_json as after
    from replacement_register.audit_events a where id>$1 and id<=$2 and (a.before_json is not null or a.after_json is not null) and not exists(select 1 from replacement_register.decision_events e where e.origin_key='audit:'||a.id::text) order by id limit 500`,[cursor,maximum])).rows;
    if(!rows.length)break;for(const row of rows){const events=await appendSqlDecisionAudit(client,{...row,occurredAt:asTime(row.occurredAt)},{legacy:true});if(events.length)count++;}cursor=String(rows.at(-1).id);
  }return count;
}
function accessible(event,context){return context.role==='ADMINISTRATOR'||!context.authenticated||!event.adminOnly&&event.scope.length>0&&event.scope.every(scope=>context.orders.some(value=>normalize(value)===scope.orderKey)&&(context.role!=='SUPPLIER'||normalize(context.organization)===scope.supplierKey));}
function options(input,context){
  if(input.q!==undefined&&(typeof input.q!=='string'||input.q.length>2000))throw httpError(422,'Enter a history search of at most 2000 characters.');
  const limit=Number(input.limit||50);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw httpError(422,'Choose a history page size from 1 to 100.');
  if(!input.subjectId&&context.role!=='ADMINISTRATOR')throw httpError(403,'Choose an accessible proposal before viewing its history.');
  if(input.streamType&&!['PROPOSAL','RECORD'].includes(input.streamType))throw httpError(422,'Choose proposal or database record history.');
  let cursor=null;if(input.cursor)try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));if(!/^\d{1,19}$/.test(cursor.id)||BigInt(cursor.id)>9223372036854775807n||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(cursor.time)||!validBusinessDate(cursor.time.slice(0,10))||asTime(cursor.time)?.slice(0,23)!==cursor.time.slice(0,23))throw new Error();}catch{throw httpError(422,'The history page cursor is invalid. Refresh history.');}
  return {...input,q:cleanText(input.q),streamType:input.streamType||(input.subjectId?'PROPOSAL':undefined),limit,cursor};
}
const searchableHistoryFields=['proposalId','recordId','orderNo','product','productDecimalNo','supplier','position','origCode','origMfr','origPn','altMfr','altPn','decisionReference','responsible','clientComment','decisionComment'];
const matchesHistorySearch=(event,q)=>!q||[event.subjectId,...['before','after'].flatMap(side=>searchableHistoryFields.map(field=>event[side]?.[field]??''))].some(value=>normalize(value).includes(normalize(q)));
const cursorTime=value=>asTime(value)?asTime(value).replace(/\.(\d{3})Z$/,(_,milliseconds)=>`.${milliseconds}000Z`):'0001-01-01T00:00:00.000000Z';
const cursorFor=row=>Buffer.from(JSON.stringify({time:row.cursorTime||cursorTime(row.occurredAt),id:String(row.ordinal)})).toString('base64url');
const publicEvent=({originKey,streamKey,cursorTime,...event})=>clone(event);
export function memoryDecisionHistory(state,input,context){
  const filter=options(input,context),key=filter.subjectId?historyKey(filter.streamType||'PROPOSAL',filter.subjectId):null;
  let rows=(state.decisionEvents||[]).filter(event=>(!key?(!filter.streamType||event.streamType===filter.streamType):event.streamKey===key||filter.streamType==='PROPOSAL'&&event.related?.proposalId===filter.subjectId)&&accessible(event,context)&&(!filter.orderNo||event.scope.some(item=>item.orderKey===normalize(filter.orderNo)))&&matchesHistorySearch(event,filter.q));
  rows.sort((a,b)=>cursorTime(b.occurredAt).localeCompare(cursorTime(a.occurredAt))||(BigInt(b.ordinal)>BigInt(a.ordinal)?1:BigInt(b.ordinal)<BigInt(a.ordinal)?-1:0));
  if(filter.cursor)rows=rows.filter(row=>cursorTime(row.occurredAt)<filter.cursor.time||cursorTime(row.occurredAt)===filter.cursor.time&&BigInt(row.ordinal)<BigInt(filter.cursor.id));
  const page=rows.slice(0,filter.limit);return {items:page.map(publicEvent),nextCursor:rows.length>filter.limit?cursorFor(page.at(-1)):null};
}
export async function sqlDecisionHistory(pool,input,context){
  const filter=options(input,context),values=[],where=[],add=(text,value)=>{values.push(value);where.push(text.replaceAll('?',`$${values.length}`));};
  if(filter.subjectId){values.push(historyKey(filter.streamType||'PROPOSAL',filter.subjectId));let clause=`stream_key=$${values.length}`;if(filter.streamType==='PROPOSAL'){values.push(filter.subjectId);clause+=` or event_json#>>'{related,proposalId}'=$${values.length}`;}where.push(`(${clause})`);}
  else if(filter.streamType)add("event_json->>'streamType'=?",filter.streamType);
  if(filter.orderNo)add("exists(select 1 from jsonb_array_elements(event_json->'scope') s where s->>'orderKey'=?)",normalize(filter.orderNo));
  if(filter.q){values.push(normalize(filter.q));const number=values.length;where.push('('+["event_json->>'subjectId'",...['before','after'].flatMap(side=>searchableHistoryFields.map(field=>`event_json#>>'{${side},${field}}'`))].map(expression=>`strpos(upper(coalesce(${expression},'')),$${number})>0`).join(' or ')+')');}
  if(context.authenticated&&context.role!=='ADMINISTRATOR'){
    where.push("coalesce((event_json->>'adminOnly')::boolean,true)=false and jsonb_array_length(event_json->'scope')>0");values.push(context.orders.map(normalize));const orderIndex=values.length;let invalid=`not(coalesce(s->>'orderKey','')=any($${orderIndex}::text[]))`;
    if(context.role==='SUPPLIER'){values.push(normalize(context.organization));invalid+=` or coalesce(s->>'supplierKey','')<>$${values.length}`;}where.push(`not exists(select 1 from jsonb_array_elements(event_json->'scope') s where ${invalid})`);
  }
  if(filter.cursor){values.push(filter.cursor.time,filter.cursor.id);where.push(`(created_at,id)<($${values.length-1}::timestamptz,$${values.length}::bigint)`);}values.push(filter.limit+1);
  const rows=(await pool.query(`select id,event_json,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time from replacement_register.decision_events ${where.length?'where '+where.join(' and '):''} order by created_at desc,id desc limit $${values.length}`,values)).rows.map(row=>({...row.event_json,ordinal:String(row.id),cursorTime:row.cursor_time}));
  const page=rows.slice(0,filter.limit);return {items:page.map(publicEvent),nextCursor:rows.length>filter.limit?cursorFor(page.at(-1)):null};
}
export function existingStateHistory(type,row){return {eventId:null,sequence:null,ordinal:null,kind:'CURRENT_STATE',streamType:type,subjectId:row[type==='RECORD'?'recordId':'proposalId'],occurredAt:null,actor:'Original actor not recorded',role:'SYSTEM',reason:'Current register state. Earlier changes are shown only where retained audit evidence exists.',before:null,after:clone(row),source:{sheet:row.sourceSheet,row:row.sourceRow},snapshotComplete:true,...scopeFor(null,row)};}
