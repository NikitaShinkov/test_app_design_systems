import {roundDigest} from './workflow-rounds.js';
import {roundAdministrator,roundOwner,roundRequest,roundIdentifier,managedRoundId,managementSummary,planRoundManagement,requireRoundAccess} from './round-management.js';
import {httpError,lockNamedReleaseAccount,currentNamedReleaseContext} from './auth.js';
import {normalize} from './normalization.js';
import {createRoundReceipt,roundReceiptRequest} from './round-receipt-integrity.js';

const clone=value=>structuredClone(value);
export function withMemoryRoundMutation(storage,operation){
  const keys=['approvalRoundHeads','approvalRoundEvents','roundExchangeAssociations','roundAssociationEvents','roundManagementReceipts','audit','auditSequence','decisionEvents','decisionEventHeads','decisionEventSequence'],before=new Map(keys.map(key=>[key,{present:Object.hasOwn(storage.state,key),value:clone(storage.state[key])}]));
  try{return operation();}catch(error){for(const [key,snapshot] of before)if(snapshot.present)storage.state[key]=snapshot.value;else delete storage.state[key];throw error;}
}
export function memoryRoundCounts(state,id){return {observedExchangeCount:(state.workflowExchanges||[]).filter(row=>row.roundId===id).length,associationEventCount:(state.roundAssociationEvents||[]).filter(row=>row.fromRoundId===id||row.toRoundId===id).length};}
export function memoryRoundContext(state,id){const head=state.approvalRoundHeads?.find(row=>row.roundId===id)||null,observed=state.proposalRounds?.find(row=>row.roundId===id)||null,instance=state.workflowInstances?.find(row=>row.workflowId===(head?.workflowId||observed?.workflowId));return {head,observed,instance,counts:memoryRoundCounts(state,id)};}
const requestHash=request=>roundDigest(request);
function priorReceipt(receipt,hash,kind){if(!receipt)return null;roundReceiptRequest(receipt);if(receipt.requestHash!==hash||receipt.kind!==kind)throw httpError(409,'That request ID was already used for a different round operation.',{code:'ROUND_REQUEST_REUSED'});return {...clone(receipt.payload),duplicate:true};}
function memoryReceipt(state,context,request,kind){const ownerKey=roundOwner(context),hash=requestHash(request),receipt=state.roundManagementReceipts?.find(row=>row.ownerKey===ownerKey&&row.requestId===request.requestId);return {ownerKey,hash,prior:priorReceipt(receipt,hash,kind)};}
export function manageMemoryRound(storage,context,body){
  roundAdministrator(context);const request=roundRequest(body),receipt=memoryReceipt(storage.state,context,request,'LIFECYCLE');if(receipt.prior)return receipt.prior;
  const id=request.action==='CREATE'?managedRoundId(request.workflowId,normalize(request.roundLabel)):request.roundId,data=memoryRoundContext(storage.state,id);
  if(request.action==='CREATE')data.instance=storage.state.workflowInstances?.find(row=>row.workflowId===request.workflowId);
  const plan=planRoundManagement({...data,request,context}),payload=plan.result;
  storage.state.approvalRoundHeads||=[];storage.state.approvalRoundEvents||=[];storage.state.roundManagementReceipts||=[];
  if(data.head)Object.assign(data.head,plan.head);else storage.state.approvalRoundHeads.push({...plan.head,ordinal:String(storage.state.approvalRoundHeads.length+1)});
  storage.state.approvalRoundEvents.push({...plan.event,ordinal:String(storage.state.approvalRoundEvents.length+1)});
  storage.addAudit(context,'APPROVAL_ROUND_'+request.action,id,request.reason,plan.before,clone(plan.head));
  storage.state.roundManagementReceipts.push(createRoundReceipt(receipt.ownerKey,request,'LIFECYCLE',payload));
  return clone(payload);
}
export function getMemoryRoundManagement(storage,id,context){id=roundIdentifier(id);const data=memoryRoundContext(storage.state,id);requireRoundAccess(data.instance,context);return managementSummary(data);}

export const sqlRoundHead=row=>row?{roundId:row.round_id,workflowId:row.workflow_id,roundKey:row.round_key,roundLabel:row.round_label,status:row.status,version:Number(row.version),ordinal:String(row.ordinal),createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),lastEventId:row.last_event_id,closureBaseline:row.closure_baseline}:null;
export const sqlRoundInstance=row=>row?{workflowId:row.workflow_id,workflowKey:row.workflow_key,orderNo:row.order_no,supplier:row.supplier,productDecimalNo:row.product_decimal_no,product:row.product,orderKey:row.order_key,supplierKey:row.supplier_key,productKey:row.product_key}:null;
export async function sqlRoundCounts(client,id){const row=(await client.query('select (select count(*)::int from replacement_register.workflow_exchanges where round_id=$1) as observed, (select count(*)::int from replacement_register.round_association_events where from_round_id=$1 or to_round_id=$1) as associated',[id])).rows[0];return {observedExchangeCount:row.observed,associationEventCount:row.associated};}
export async function sqlRoundContext(client,id,{lock=false}={}){
  const head=sqlRoundHead((await client.query('select * from replacement_register.approval_round_heads where round_id=$1'+(lock?' for update':''),[id])).rows[0]),raw=(await client.query('select * from replacement_register.proposal_rounds where round_id=$1',[id])).rows[0],observed=raw?{roundId:raw.round_id,workflowId:raw.workflow_id,roundKey:raw.round_key,roundLabel:raw.round_label,createdAt:raw.created_at.toISOString(),ordinal:String(raw.ordinal)}:null;
  const instance=sqlRoundInstance((await client.query('select * from replacement_register.workflow_instances where workflow_id=$1',[head?.workflowId||observed?.workflowId||null])).rows[0]);
  return {head,observed,instance,counts:await sqlRoundCounts(client,id)};
}
export async function lockRoundAdministrator(client,context){
  roundAdministrator(context);if(!context.authenticated)return;
  await client.query('select pg_advisory_xact_lock_shared(78742002)');
  const row=(await client.query('select role,enabled,must_change_password from replacement_register.users where user_id=$1 for share',[context.userId])).rows[0];
  if(!row?.enabled||row.role!=='ADMINISTRATOR'||row.must_change_password)throw httpError(403,'Administrator access changed. Sign in again before managing a round.',{code:'ROUND_ADMIN_CHANGED'});
  await lockNamedReleaseAccount(client,context);
}
export async function currentRoundAdministrator(client,context){const current=context.authenticated?await currentNamedReleaseContext(client,context):context;roundAdministrator(current);return current;}
export async function lockRoundRequest(client,context,request){await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`round-request:${roundOwner(context)}:${request.requestId}`]);}
export async function lockRoundWorkflow(client,workflowId){await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`round-workflow:${workflowId}`]);}
export async function sqlRoundReceipt(client,context,request,kind){const row=(await client.query('select * from replacement_register.round_management_receipts where owner_key=$1 and request_id=$2',[roundOwner(context),request.requestId])).rows[0];return priorReceipt(row?{ownerKey:row.owner_key,requestId:row.request_id,requestHash:row.request_hash,requestJson:row.request_json,kind:row.kind,payload:row.payload}:null,requestHash(request),kind);}
export async function saveSqlRoundReceipt(client,context,request,kind,payload){const receipt=createRoundReceipt(roundOwner(context),request,kind,payload);await client.query('insert into replacement_register.round_management_receipts(owner_key,request_id,request_hash,request_json,kind,payload) values($1,$2,$3,$4,$5,$6)',[receipt.ownerKey,receipt.requestId,receipt.requestHash,receipt.requestJson,kind,receipt.payload]);}
export async function manageSqlRound(storage,context,body){
  roundAdministrator(context);const request=roundRequest(body),client=await storage.pool.connect();
  try{
    await client.query('begin');await lockRoundAdministrator(client,context);await lockRoundRequest(client,context,request);
    const id=request.action==='CREATE'?managedRoundId(request.workflowId,normalize(request.roundLabel)):request.roundId,initial=await sqlRoundContext(client,id),workflowId=request.workflowId||initial.instance?.workflowId;
    requireRoundAccess(request.action==='CREATE'?sqlRoundInstance((await client.query('select * from replacement_register.workflow_instances where workflow_id=$1',[workflowId])).rows[0]):initial.instance,context);
    await lockRoundWorkflow(client,workflowId);
    const data=await sqlRoundContext(client,id,{lock:true});if(request.action==='CREATE')data.instance=sqlRoundInstance((await client.query('select * from replacement_register.workflow_instances where workflow_id=$1',[workflowId])).rows[0]);
    const current=await currentRoundAdministrator(client,context),prior=await sqlRoundReceipt(client,current,request,'LIFECYCLE');if(prior){await client.query('commit');return prior;}
    const plan=planRoundManagement({...data,request,context:current}),head=plan.head;
    if(data.head)await client.query('update replacement_register.approval_round_heads set status=$2,version=$3,updated_at=$4,last_event_id=$5,closure_baseline=$6 where round_id=$1',[id,head.status,head.version,head.updatedAt,head.lastEventId,head.closureBaseline]);
    else await client.query('insert into replacement_register.approval_round_heads(round_id,workflow_id,round_key,round_label,status,version,created_at,updated_at,last_event_id,closure_baseline) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,head.workflowId,head.roundKey,head.roundLabel,head.status,head.version,head.createdAt,head.updatedAt,head.lastEventId,head.closureBaseline]);
    await client.query('insert into replacement_register.approval_round_events(event_id,round_id,version,event_json) values($1,$2,$3,$4)',[plan.event.eventId,id,head.version,plan.event]);
    await storage.writeAudit(client,current,'APPROVAL_ROUND_'+request.action,id,request.reason,plan.before,head);await saveSqlRoundReceipt(client,current,request,'LIFECYCLE',plan.result);await client.query('commit');return plan.result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
export async function getSqlRoundManagement(storage,id,context){id=roundIdentifier(id);const data=await sqlRoundContext(storage.rawPool||storage.pool,id);requireRoundAccess(data.instance,context);return managementSummary(data);}
