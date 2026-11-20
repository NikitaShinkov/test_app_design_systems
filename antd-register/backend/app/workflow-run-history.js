import {normalize} from './normalization.js';
import {canUseModule,moduleFor} from './workflow.js';
import {importResultMessage,importIgnoredCount} from './import-results.js';

const keys=values=>[...new Set(values.map(normalize))].sort();
const exportModules=new Set(['M01','M03','M05','M06','M07','M09']);
export function workflowRowScope(rows){
  if(!Array.isArray(rows)||!rows.length)return {scopeKnown:false,orderKeys:[],supplierKeys:[]};
  const orderKeys=keys(rows.map(row=>row?.orderNo)),supplierKeys=keys(rows.map(row=>row?.supplier));
  return {scopeKnown:!orderKeys.includes(''),orderKeys,supplierKeys};
}
export function workflowExportScope(result){
  const scopes=result?.files?.map(file=>file?.scope);
  if(!scopes?.length||scopes.some(scope=>!Array.isArray(scope?.orderNos)||!scope.orderNos.length||!Array.isArray(scope.suppliers)))return workflowRowScope([]);
  const orderKeys=keys(scopes.flatMap(scope=>scope.orderNos)),supplierKeys=keys(scopes.flatMap(scope=>scope.suppliers.length?scope.suppliers:['']));
  return {scopeKnown:!orderKeys.includes(''),orderKeys,supplierKeys};
}
export const workflowAttribution=(context,scope)=>({actorUserId:context.userId||null,requestId:context.requestId||null,...scope});
export function workflowRunQuery(options={}){
  const limit=options.limit===undefined?10:Number(options.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Object.assign(new Error('Workflow history page size must be between 1 and 100.'),{status:422,code:'WORKFLOW_HISTORY_LIMIT_INVALID'});
  return {limit,orderKey:normalize(options.orderNo)};
}
export function workflowRunAccess(run,context){
  if(!context.authenticated||context.role==='ADMINISTRATOR')return true;
  if(!context.userId||run.actorUserId!==context.userId||run.role!==context.role||!canUseModule(moduleFor(run.moduleId),context.role)||run.scopeKnown!==true||!run.orderKeys?.length)return false;
  const assigned=new Set((context.orders||[]).map(normalize));
  if(run.orderKeys.some(order=>!order||!assigned.has(order)))return false;
  return context.role!=='SUPPLIER'||Boolean(normalize(context.organization)&&run.supplierKeys?.length&&run.supplierKeys.every(supplier=>supplier===normalize(context.organization)));
}
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
export function workflowRunSummary(run,context){
  if(!context.authenticated||context.role==='ADMINISTRATOR')return structuredClone(run);
  const source=run.result||{},result={status:['COMPLETED','COMPLETED_WITH_FINDINGS','EXPORTED'].includes(source.status)?source.status:'COMPLETED'};
  if(exportModules.has(run.moduleId)){
    result.affected=count(source.affected);result.files=count(source.files?.length);
    result.message=`${result.affected} row(s) exported to ${result.files} archived file(s).`;
  }else{
    for(const field of ['imported','updated','skipped','skippedSheets','obsoleteRecorded'])result[field]=count(source[field]);
    if(run.moduleId==='M02'&&Object.hasOwn(source,'ignored'))result.ignored=importIgnoredCount(source);
    if(source.duplicate===true)result.duplicate=true;
    result.message=importResultMessage(result);
  }
  return {id:run.id,moduleId:run.moduleId,occurredAt:run.occurredAt,actor:run.actor,role:run.role,result};
}
export function memoryWorkflowRuns(runs,options,context){
  const {limit,orderKey}=workflowRunQuery(options);
  return runs.filter(run=>workflowRunAccess(run,context)&&(!orderKey||(run.scopeKnown?run.orderKeys?.includes(orderKey):normalize(run.result?.orderNo)===orderKey)))
    .sort((a,b)=>new Date(b.occurredAt)-new Date(a.occurredAt)||(BigInt(b.id)>BigInt(a.id)?1:BigInt(b.id)<BigInt(a.id)?-1:0))
    .slice(0,limit).map(run=>workflowRunSummary(run,context));
}
export async function insertSqlWorkflowRun(client,run){
  const row=(await client.query(`insert into replacement_register.workflow_runs(module_id,actor,actor_role,result_json,actor_user_id,request_id,scope_known,scope_orders,scope_suppliers)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id,occurred_at`,[run.moduleId,run.actor,run.role,run.result,run.actorUserId,run.requestId,run.scopeKnown,run.orderKeys,run.supplierKeys])).rows[0];
  return {...run,id:row.id,occurredAt:row.occurred_at};
}
export async function sqlWorkflowRuns(pool,options={},context={}){
  const {limit,orderKey}=workflowRunQuery(options),values=[],where=[],add=value=>{values.push(value);return `$${values.length}`;};
  const named=context.authenticated&&context.role!=='ADMINISTRATOR';
  if(named){
    if(!context.userId||!['CLIENT','SUPPLIER'].includes(context.role))return [];
    const assigned=keys(context.orders||[]),modules=['M02','M03','M04','M05','M06','M08','M09'].filter(id=>canUseModule(moduleFor(id),context.role));
    if(!assigned.length)return [];
    where.push(`actor_user_id=${add(context.userId)}::uuid`,`actor_role=${add(context.role)}`,`module_id=any(${add(modules)}::text[])`,'scope_known','cardinality(scope_orders)>0',`scope_orders<@${add(assigned)}::text[]`);
    if(context.role==='SUPPLIER'){
      const organization=normalize(context.organization);if(!organization)return [];
      where.push('cardinality(scope_suppliers)>0',`scope_suppliers<@${add([organization])}::text[]`);
    }
  }
  if(orderKey){const parameter=add([orderKey]);where.push(named?`scope_orders @> ${parameter}::text[]`:`(scope_orders @> ${parameter}::text[] or (not scope_known and replacement_register.scope_text(result_json->>'orderNo')=(${parameter}::text[])[1]))`);}
  const rows=(await pool.query(`select id,module_id as "moduleId",occurred_at as "occurredAt",actor,actor_role as role,result_json as result,actor_user_id as "actorUserId",request_id as "requestId",scope_known as "scopeKnown",scope_orders as "orderKeys",scope_suppliers as "supplierKeys"
    from replacement_register.workflow_runs${where.length?' where '+where.join(' and '):''} order by occurred_at desc,id desc limit ${add(limit)}`,values)).rows;
  return rows.map(run=>workflowRunSummary(run,context));
}

// Recover only exact retained audit + frozen export/import evidence. Display
// names, current proposal membership and current account assignments prove no
// historical ownership. Ambiguous/missing records remain administrator-only.
export async function migrateSqlWorkflowRunAccess(client){
  let cursor='0',updated=0;
  for(;;){
    const rows=(await client.query(`select id,module_id,occurred_at::text as occurred_at,actor,actor_role,result_json from replacement_register.workflow_runs
      where actor_user_id is null and not scope_known and id>$1 order by id limit 100`,[cursor])).rows;
    for(const row of rows){
      cursor=row.id;const result=row.result_json;let scope,audit;
      if(exportModules.has(row.module_id)&&result?.exportJobId){
        scope=workflowExportScope(result);
        audit=(await client.query(`select actor_user_id,request_id from replacement_register.audit_events where action=$1 and subject=$2 and occurred_at=$3 and actor_role=$4 and after_json=$5 and actor_user_id is not null`,[`WORKFLOW_${row.module_id}_EXPORTED`,row.module_id,row.occurred_at,row.actor_role,result])).rows;
      }else if(['M02','M04','M08'].includes(row.module_id)&&result?.batchId){
        const batch=(await client.query("select payload from replacement_register.import_batches where batch_id=$1 and module_id=$2 and status=$3 and payload->'result'=$4::jsonb",[result.batchId,row.module_id,'COMMITTED',result])).rows[0]?.payload;
        if(!batch)continue;
        scope=workflowRowScope(batch.scope);
        audit=(await client.query(`select actor_user_id,request_id from replacement_register.audit_events where action='IMPORT_REVIEW_COMMITTED' and subject=$1 and occurred_at=$2 and actor_role=$3 and actor_user_id is not null`,[result.batchId,row.occurred_at,row.actor_role])).rows;
      }
      if(!scope?.scopeKnown||audit?.length!==1)continue;
      await client.query(`update replacement_register.workflow_runs set actor_user_id=$2,request_id=$3,scope_known=true,scope_orders=$4,scope_suppliers=$5 where id=$1 and actor_user_id is null and not scope_known`,[row.id,audit[0].actor_user_id,audit[0].request_id,scope.orderKeys,scope.supplierKeys]);updated++;
    }
    if(rows.length<100)break;
  }
  return updated;
}
