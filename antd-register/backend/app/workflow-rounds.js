import {createHash} from 'node:crypto';
import {cleanText,normalize} from './normalization.js';
import {httpError} from './auth.js';
import {roundExchangeProjection} from './round-exchange-visibility.js';

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
export const roundDigest=value=>createHash('sha256').update(JSON.stringify(stable(value))??'null').digest('hex');
function uuid(value){const text=roundDigest(value);return `${text.slice(0,8)}-${text.slice(8,12)}-8${text.slice(13,16)}-a${text.slice(17,20)}-${text.slice(20,32)}`;}
const clone=value=>structuredClone(value);
const sameScope=(a,b)=>['orderNo','supplier','productDecimalNo'].every(key=>normalize(a?.[key])===normalize(b?.[key]));
function workflow(row){
  const orderNo=cleanText(row.orderNo),supplier=cleanText(row.supplier),productDecimalNo=cleanText(row.productDecimalNo);
  if(!orderNo||!productDecimalNo)return null;
  const scope={orderNo,supplier,productDecimalNo,product:cleanText(row.product)},key=roundDigest([normalize(orderNo),normalize(supplier),normalize(productDecimalNo)]);
  return {...scope,workflowId:uuid(['workflow',key]),workflowKey:key,orderKey:normalize(orderNo),supplierKey:normalize(supplier),productKey:normalize(productDecimalNo)};
}
function auditKind(action){
  const imported=action.match(/^WORKFLOW_(M02|M04|M08)_(?:ROW_(?:IMPORTED|UPDATED)|CLIENT_PROPOSAL_CREATED)$/);
  if(imported)return {moduleId:imported[1],kind:'IMPORTED'};
  if(/^WORKFLOW_M\d\d_EXPORTED$/.test(action))return {moduleId:action.slice(9,12),kind:'EXPORTED'};
  if(action==='DECISION_UPDATED')return {moduleId:null,kind:'DECISION'};
  if(action==='DATABASE_RECORD_CREATED')return {moduleId:'M10',kind:'RECORDED'};
  if(action==='WORKFLOW_M11_ROW_UPDATED')return {moduleId:'M11',kind:'WORKSPACE_CHANGED'};
  if(action==='SOURCE_RECORD_IMPORTED'||action==='SOURCE_RECORD_UPDATED')return {moduleId:null,kind:'SOURCE'};
  if(action==='M07_PRODUCT_CODE_UPDATED')return {moduleId:'M07',kind:'PRODUCT_CODE'};
  if(action==='WORKFLOW_M91_ROW_UPDATED'||action==='REFERENCE_PROJECTION_UPDATED')return {moduleId:'M91',kind:'RECALCULATED'};
  return null;
}
function filesFor(files,scope){
  return (files||[]).filter(file=>{const value=file.scope;return value&&['orderNos','suppliers','productDecimalNos'].every((key,index)=>value[key]?.length===1&&normalize(value[key][0])===normalize(scope[['orderNo','supplier','productDecimalNo'][index]]));}).map(file=>({artifactId:file.artifactId,filename:file.filename,sha256:file.sha256,version:file.version}));
}
function plans(audit){
  const type=auditKind(audit.action);if(!type)return [];
  if(type.kind==='DECISION'&&roundDigest(audit.before)===roundDigest(audit.after))return [];
  const exportEvidence=audit.workflowExchange,source=audit.decisionSource||{},rawSample=audit.after||audit.before;
  const sample=rawSample&&type.kind==='SOURCE'&&!rawSample.proposalId&&!Object.hasOwn(rawSample,'decisionStatus')&&audit.subject?{...rawSample,proposalId:audit.subject}:rawSample;
  // Older export logs do not prove the product/supplier tuples or their rows.
  // Retain their general audit rather than inventing a Cartesian scope.
  if(type.kind==='EXPORTED'&&!exportEvidence?.rows)return [];
  const rows=type.kind==='EXPORTED'?exportEvidence.rows:sample?[sample]:[];
  const groups=new Map();
  for(const row of rows){
    const instance=workflow(row);if(!instance)continue;
    const rawRound=type.kind==='EXPORTED'?exportEvidence.round:source.round??(type.kind==='IMPORTED'?row.round:null);
    const label=cleanText(rawRound)||null,roundKey=label?normalize(label):'',roundId=uuid(['round',instance.workflowId,roundKey]);
    const key=roundId;let group=groups.get(key);
    if(!group){group={instance,round:{roundId,workflowId:instance.workflowId,roundKey,roundLabel:label,createdAt:audit.occurredAt},snapshots:[]};groups.set(key,group);}
    if(row.proposalId&&!Object.hasOwn(row,'decisionStatus')){
      if(type.kind!=='EXPORTED'&&audit.before&&sameScope(audit.before,row))group.snapshots.push({proposalId:row.proposalId,phase:'BEFORE',row:audit.before});
      group.snapshots.push({proposalId:row.proposalId,phase:type.kind==='EXPORTED'?'EXPORTED':'AFTER',row});
    }
  }
  return [...groups.values()].map(group=>{
    const originKey=`audit:${audit.id}:${group.round.roundId}`,exchangeId=uuid(['exchange',originKey]);
    const evidence=type.kind==='EXPORTED'?{exportJobId:exportEvidence.exportJobId,snapshotHash:exportEvidence.snapshotHash,dataAsOf:exportEvidence.dataAsOf,provenance:exportEvidence.provenance,inputs:exportEvidence.inputs||[],files:filesFor(audit.after?.files,group.instance)}:{...source};
    const payload={exchangeId,roundId:group.round.roundId,...type,occurredAt:audit.occurredAt,actor:audit.actor||'Original actor not recorded',actorUserId:audit.actorUserId||null,role:audit.role||'SYSTEM',reason:audit.detail||'',source:evidence,auditId:String(audit.id),recordId:sample?.recordId||null,proposalId:sample?.proposalId||null,snapshotCount:group.snapshots.length,normalizationVersion:source.normalizationVersion||null};
    const snapshots=group.snapshots.map(item=>{
      const originalKey=roundDigest([normalize(item.row.origMfr),normalize(item.row.origPn)]),alternativeKey=roundDigest([normalize(item.row.altMfr),normalize(item.row.altPn)]);
      const alternative=cleanText(item.row.altPn)?{alternativeId:uuid(['alternative',group.instance.workflowId,originalKey,alternativeKey]),workflowId:group.instance.workflowId,originalKey,alternativeKey,origMfr:cleanText(item.row.origMfr),origPn:cleanText(item.row.origPn),altMfr:cleanText(item.row.altMfr),altPn:cleanText(item.row.altPn)}:null;
      return {...item,snapshotId:uuid(['snapshot',exchangeId,item.proposalId,item.phase]),exchangeId,alternativeId:alternative?.alternativeId||null,snapshotHash:roundDigest(item.row),alternative};
    });
    return {...group,exchange:{...payload,originKey},snapshots};
  });
}
export function appendMemoryWorkflowAudit(state,audit){
  let count=0;for(const plan of plans(audit)){
    for(const key of ['workflowInstances','proposalRounds','workflowExchanges','proposalSnapshots','proposalAlternatives'])state[key]||=[];
    if(state.workflowExchanges.some(item=>item.originKey===plan.exchange.originKey))continue;
    if(!state.workflowInstances.some(item=>item.workflowId===plan.instance.workflowId))state.workflowInstances.push(clone(plan.instance));
    if(!state.proposalRounds.some(item=>item.roundId===plan.round.roundId))state.proposalRounds.push({...clone(plan.round),ordinal:String(state.proposalRounds.length+1)});
    state.workflowExchanges.push({...clone(plan.exchange),ordinal:String(state.workflowExchanges.length+1)});
    for(const {alternative,...snapshot} of plan.snapshots){if(alternative&&!state.proposalAlternatives.some(item=>item.alternativeId===alternative.alternativeId))state.proposalAlternatives.push(clone(alternative));state.proposalSnapshots.push({...clone(snapshot),ordinal:String(state.proposalSnapshots.length+1)});}count++;
  }return count;
}
export function migrateMemoryWorkflowAudit(state){let count=0;for(const audit of [...state.audit].sort((a,b)=>Number(a.id)-Number(b.id)))count+=appendMemoryWorkflowAudit(state,audit);return count;}
export async function appendSqlWorkflowAudit(client,audit){
  let count=0;for(const {instance,round,exchange,snapshots} of plans(audit)){
    await client.query('insert into replacement_register.workflow_instances(workflow_id,workflow_key,order_no,order_key,supplier,supplier_key,product_decimal_no,product_key,product) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing',[instance.workflowId,instance.workflowKey,instance.orderNo,instance.orderKey,instance.supplier,instance.supplierKey,instance.productDecimalNo,instance.productKey,instance.product]);
    await client.query('insert into replacement_register.proposal_rounds(round_id,workflow_id,round_key,round_label,created_at) values($1,$2,$3,$4,$5) on conflict do nothing',[round.roundId,round.workflowId,round.roundKey,round.roundLabel,round.createdAt]);
    const written=await client.query('insert into replacement_register.workflow_exchanges(exchange_id,round_id,origin_key,audit_id,module_id,kind,occurred_at,payload) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(origin_key) do nothing returning ordinal',[exchange.exchangeId,exchange.roundId,exchange.originKey,String(audit.id),exchange.moduleId,exchange.kind,exchange.occurredAt,exchange]);if(!written.rowCount)continue;
    for(const snapshot of snapshots){const alternative=snapshot.alternative;if(alternative)await client.query('insert into replacement_register.proposal_alternatives(alternative_id,workflow_id,original_key,alternative_key,orig_mfr,orig_pn,alt_mfr,alt_pn) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing',[alternative.alternativeId,alternative.workflowId,alternative.originalKey,alternative.alternativeKey,alternative.origMfr,alternative.origPn,alternative.altMfr,alternative.altPn]);
      await client.query('insert into replacement_register.proposal_snapshots(snapshot_id,exchange_id,proposal_id,phase,alternative_id,snapshot_hash,snapshot_json) values($1,$2,$3,$4,$5,$6,$7)',[snapshot.snapshotId,exchange.exchangeId,snapshot.proposalId,snapshot.phase,snapshot.alternativeId,snapshot.snapshotHash,snapshot.row]);}count++;
  }return count;
}
export async function migrateSqlWorkflowAudit(client){
  let count=0,cursor='0';const maximum=(await client.query('select coalesce(max(id),0)::text as id from replacement_register.audit_events')).rows[0].id;
  while(true){const rows=(await client.query(`select a.id,a.occurred_at as "occurredAt",a.actor,a.actor_user_id as "actorUserId",a.actor_role as role,a.action,a.subject,a.detail,a.before_json as before,a.after_json as after,(select event_json->'source' from replacement_register.decision_events d where d.audit_id=a.id and origin_key='audit:'||a.id::text limit 1) as "decisionSource" from replacement_register.audit_events a where a.id>$1 and a.id<=$2 and (a.before_json is not null or a.after_json is not null)
    and (a.action in ('DECISION_UPDATED','DATABASE_RECORD_CREATED','SOURCE_RECORD_IMPORTED','SOURCE_RECORD_UPDATED','WORKFLOW_M11_ROW_UPDATED','M07_PRODUCT_CODE_UPDATED','WORKFLOW_M91_ROW_UPDATED','REFERENCE_PROJECTION_UPDATED') or a.action ~ '^WORKFLOW_M(02|04|08)_(ROW_(IMPORTED|UPDATED)|CLIENT_PROPOSAL_CREATED)$')
    and not exists(select 1 from replacement_register.workflow_exchanges e where e.audit_id=a.id)
    order by a.id limit 500`,[cursor,maximum])).rows;
    if(!rows.length)break;for(const row of rows)count+=await appendSqlWorkflowAudit(client,{...row,occurredAt:row.occurredAt.toISOString()});cursor=String(rows.at(-1).id);
  }return count;
}
const accessible=(instance,context)=>context.role==='ADMINISTRATOR'||!context.authenticated||context.orders.some(value=>normalize(value)===instance.orderKey)&&(context.role!=='SUPPLIER'||normalize(context.organization)===instance.supplierKey);
function pageOptions(input){const limit=Number(input.limit||30),cursor=String(input.cursor||'');if(!Number.isSafeInteger(limit)||limit<1||limit>100||cursor&&!/^[0-9]{1,18}$/.test(cursor))throw httpError(422,'Invalid round page size or cursor.');return {limit,cursor};}
export function memoryRounds(state,input,context){
  const {limit,cursor}=pageOptions(input);const rows=(state.proposalRounds||[]).map(round=>({...round,...state.workflowInstances.find(instance=>instance.workflowId===round.workflowId)})).filter(item=>accessible(item,context)&&(!input.orderNo||item.orderKey===normalize(input.orderNo))&&(!input.productDecimalNo||item.productKey===normalize(input.productDecimalNo))&&(!cursor||BigInt(item.ordinal)<BigInt(cursor))).sort((a,b)=>BigInt(a.ordinal)>BigInt(b.ordinal)?-1:1);
  return {items:clone(rows.slice(0,limit).map(row=>{const events=state.workflowExchanges.filter(event=>event.roundId===row.roundId);return {...row,exchangeCount:events.length,lastActivity:events.at(-1)?.kind,lastModule:events.at(-1)?.moduleId};})),nextCursor:rows.length>limit?rows[limit-1].ordinal:null};
}
export function memoryRoundEvents(state,id,input,context){
  const round=state.proposalRounds?.find(row=>row.roundId===id),instance=round&&state.workflowInstances.find(row=>row.workflowId===round.workflowId);if(!instance||!accessible(instance,context))throw httpError(404,'Approval round not found.');const {limit,cursor}=pageOptions(input),rows=state.workflowExchanges.filter(row=>row.roundId===id&&(!cursor||BigInt(row.ordinal)<BigInt(cursor))).slice().reverse();
  return {round:clone({...round,...instance}),items:rows.slice(0,limit).map(row=>roundExchangeProjection(row,context)),nextCursor:rows.length>limit?rows[limit-1].ordinal:null};
}
export function memoryExchangeSnapshots(state,id,input,context){
  const event=state.workflowExchanges?.find(row=>row.exchangeId===id);if(!event)throw httpError(404,'Workflow exchange not found.');memoryRoundEvents(state,event.roundId,{limit:1},context);const {limit,cursor}=pageOptions(input),rows=state.proposalSnapshots.filter(row=>row.exchangeId===id&&(!cursor||BigInt(row.ordinal)<BigInt(cursor))).slice().reverse();
  return {items:clone(rows.slice(0,limit)),nextCursor:rows.length>limit?rows[limit-1].ordinal:null};
}
function sqlScope(context,values){if(context.role==='ADMINISTRATOR'||!context.authenticated)return 'true';values.push(context.orders.map(normalize));let text=`w.order_key=any($${values.length}::text[])`;if(context.role==='SUPPLIER'){values.push(normalize(context.organization));text+=` and w.supplier_key=$${values.length}`;}return text;}
const roundRow=row=>({roundId:row.round_id,ordinal:String(row.ordinal),workflowId:row.workflow_id,roundLabel:row.round_label,roundKey:row.round_key,createdAt:row.created_at?.toISOString(),orderNo:row.order_no,supplier:row.supplier,product:row.product,productDecimalNo:row.product_decimal_no,...(row.exchange_count!==undefined?{exchangeCount:Number(row.exchange_count),lastActivity:row.last_activity,lastModule:row.last_module}:{})});
export async function sqlRounds(pool,input,context){
  const {limit,cursor}=pageOptions(input),values=[],where=[sqlScope(context,values)];for(const [field,column] of [['orderNo','order_key'],['productDecimalNo','product_key']])if(input[field]){values.push(normalize(input[field]));where.push(`w.${column}=$${values.length}`);}if(cursor){values.push(cursor);where.push(`r.ordinal<$${values.length}::bigint`);}values.push(limit+1);
  const rows=(await pool.query(`select r.*,w.order_no,w.supplier,w.product,w.product_decimal_no,(select count(*) from replacement_register.workflow_exchanges e where e.round_id=r.round_id) as exchange_count,(select kind from replacement_register.workflow_exchanges e where e.round_id=r.round_id order by ordinal desc limit 1) as last_activity,(select module_id from replacement_register.workflow_exchanges e where e.round_id=r.round_id order by ordinal desc limit 1) as last_module from replacement_register.proposal_rounds r join replacement_register.workflow_instances w using(workflow_id) where ${where.join(' and ')} order by r.ordinal desc limit $${values.length}`,values)).rows;
  return {items:rows.slice(0,limit).map(roundRow),nextCursor:rows.length>limit?String(rows[limit-1].ordinal):null};
}
export async function sqlRoundEvents(pool,id,input,context){
  const {limit,cursor}=pageOptions(input),values=[id],scope=sqlScope(context,values);const round=(await pool.query(`select r.*,w.order_no,w.supplier,w.product,w.product_decimal_no from replacement_register.proposal_rounds r join replacement_register.workflow_instances w using(workflow_id) where r.round_id=$1 and ${scope}`,values)).rows[0];if(!round)throw httpError(404,'Approval round not found.');
  const rows=(await pool.query('select payload,ordinal from replacement_register.workflow_exchanges where round_id=$1 and ($2::bigint is null or ordinal<$2) order by ordinal desc limit $3',[id,cursor||null,limit+1])).rows;return {round:roundRow(round),items:rows.slice(0,limit).map(row=>roundExchangeProjection({...row.payload,ordinal:String(row.ordinal)},context)),nextCursor:rows.length>limit?String(rows[limit-1].ordinal):null};
}
export async function sqlExchangeSnapshots(pool,id,input,context){
  const {limit,cursor}=pageOptions(input),found=(await pool.query('select round_id from replacement_register.workflow_exchanges where exchange_id=$1',[id])).rows[0];if(!found)throw httpError(404,'Workflow exchange not found.');await sqlRoundEvents(pool,found.round_id,{limit:1},context);
  const rows=(await pool.query('select * from replacement_register.proposal_snapshots where exchange_id=$1 and ($2::bigint is null or ordinal<$2) order by ordinal desc limit $3',[id,cursor||null,limit+1])).rows;return {items:rows.slice(0,limit).map(row=>({snapshotId:row.snapshot_id,ordinal:String(row.ordinal),proposalId:row.proposal_id,phase:row.phase,alternativeId:row.alternative_id,snapshotHash:row.snapshot_hash,row:row.snapshot_json})),nextCursor:rows.length>limit?String(rows[limit-1].ordinal):null};
}
