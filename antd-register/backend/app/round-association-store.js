import {associationRequest,associationSourceHash,planRoundAssociations} from './round-association-plan.js';
import {roundAdministrator,roundOwner} from './round-management.js';
import {roundDigest} from './workflow-rounds.js';
import {lockRoundAdministrator,currentRoundAdministrator,lockRoundRequest,lockRoundWorkflow,sqlRoundReceipt,saveSqlRoundReceipt,sqlRoundHead} from './round-management-store.js';
import {httpError} from './auth.js';
import {createRoundReceipt,roundReceiptRequest} from './round-receipt-integrity.js';

const clone=value=>structuredClone(value);
const missing=()=>{throw httpError(404,'The selected workflow exchange or managed round is unavailable.',{code:'ROUND_ASSOCIATION_SOURCE_UNAVAILABLE'});};
export function memoryAssociationSources(state,ids){return ids.map(id=>{const event=state.workflowExchanges?.find(row=>row.exchangeId===id),round=event&&state.proposalRounds?.find(row=>row.roundId===event.roundId);if(!round)missing();const {ordinal,...payload}=event;const result={exchangeId:id,workflowId:round.workflowId,observedRoundId:round.roundId,roundKey:round.roundKey,payload};return {...result,rawHash:associationSourceHash(result)};});}
export async function sqlAssociationSources(client,ids){const rows=(await client.query('select e.exchange_id,e.round_id,e.payload,r.workflow_id,r.round_key from replacement_register.workflow_exchanges e join replacement_register.proposal_rounds r using(round_id) where e.exchange_id=any($1::uuid[])',[ids])).rows;if(rows.length!==ids.length)missing();return rows.map(row=>{const result={exchangeId:row.exchange_id,workflowId:row.workflow_id,observedRoundId:row.round_id,roundKey:row.round_key,payload:row.payload};return {...result,rawHash:associationSourceHash(result)};});}
export function associateMemoryRoundExchanges(storage,context,body){
  roundAdministrator(context);const request=associationRequest(body),ownerKey=roundOwner(context),requestHash=roundDigest(request),receipt=storage.state.roundManagementReceipts?.find(row=>row.ownerKey===ownerKey&&row.requestId===request.requestId);
  if(receipt){roundReceiptRequest(receipt);if(receipt.kind!=='ASSOCIATION'||receipt.requestHash!==requestHash)throw httpError(409,'That request ID was already used for a different round operation.',{code:'ROUND_REQUEST_REUSED'});return {...clone(receipt.payload),duplicate:true};}
  const exchanges=memoryAssociationSources(storage.state,request.selections.map(row=>row.exchangeId)),heads=(storage.state.roundExchangeAssociations||[]).filter(head=>request.selections.some(row=>row.exchangeId===head.exchangeId)),roundHeads=storage.state.approvalRoundHeads||[],target=request.targetRoundId?roundHeads.find(row=>row.roundId===request.targetRoundId)||null:null;
  const plan=planRoundAssociations({request,exchanges,heads,roundHeads,target,context,now:new Date().toISOString()});
  storage.state.roundExchangeAssociations||=[];storage.state.roundAssociationEvents||=[];storage.state.roundManagementReceipts||=[];
  for(const change of plan.changes){const old=storage.state.roundExchangeAssociations.find(row=>row.exchangeId===change.head.exchangeId);if(old)Object.assign(old,change.head);else storage.state.roundExchangeAssociations.push(clone(change.head));storage.state.roundAssociationEvents.push({...clone(change.event),ordinal:String(storage.state.roundAssociationEvents.length+1)});storage.addAudit(context,'ROUND_EXCHANGE_'+request.action,change.head.exchangeId,request.reason,change.before,clone({...change.head,sourceHash:change.event.sourceHash,observedRoundId:change.event.observedRoundId}));}
  storage.addAudit(context,'ROUND_ASSOCIATION_COMMITTED',request.requestId,request.reason,null,clone(plan.result));storage.state.roundManagementReceipts.push(createRoundReceipt(ownerKey,request,'ASSOCIATION',plan.result));return clone(plan.result);
}
export const sqlAssociationHead=row=>({exchangeId:row.exchange_id,roundId:row.round_id,version:Number(row.version),updatedAt:row.updated_at.toISOString(),lastEventId:row.last_event_id});
export async function associateSqlRoundExchanges(storage,context,body){
  roundAdministrator(context);const request=associationRequest(body),ids=request.selections.map(row=>row.exchangeId),client=await storage.pool.connect();
  try{
    await client.query('begin');await lockRoundAdministrator(client,context);await lockRoundRequest(client,context,request);
    const exchanges=await sqlAssociationSources(client,ids),workflowId=exchanges[0].workflowId;if(exchanges.some(row=>row.workflowId!==workflowId))missing();await lockRoundWorkflow(client,workflowId);
    const heads=(await client.query('select * from replacement_register.round_exchange_associations where exchange_id=any($1::uuid[]) order by exchange_id for update',[ids])).rows.map(sqlAssociationHead),roundIds=[...new Set([request.targetRoundId,...heads.map(row=>row.roundId)].filter(Boolean))].sort();
    const roundHeads=(await client.query('select * from replacement_register.approval_round_heads where round_id=any($1::uuid[]) order by round_id for update',[roundIds])).rows.map(sqlRoundHead),target=roundHeads.find(row=>row.roundId===request.targetRoundId)||null,current=await currentRoundAdministrator(client,context),prior=await sqlRoundReceipt(client,current,request,'ASSOCIATION');
    if(prior){await client.query('commit');return prior;}
    const plan=planRoundAssociations({request,exchanges,heads,roundHeads,target,context:current,now:new Date().toISOString()});
    for(const change of plan.changes){const {head,event}=change;
      if(change.before)await client.query('update replacement_register.round_exchange_associations set round_id=$2,version=$3,updated_at=$4,last_event_id=$5 where exchange_id=$1',[head.exchangeId,head.roundId,head.version,head.updatedAt,head.lastEventId]);
      else await client.query('insert into replacement_register.round_exchange_associations(exchange_id,round_id,version,updated_at,last_event_id) values($1,$2,$3,$4,$5)',[head.exchangeId,head.roundId,head.version,head.updatedAt,head.lastEventId]);
      await client.query('insert into replacement_register.round_association_events(event_id,exchange_id,workflow_id,from_round_id,to_round_id,version,event_json) values($1,$2,$3,$4,$5,$6,$7)',[event.eventId,event.exchangeId,event.workflowId,event.fromRoundId,event.toRoundId,event.version,event]);
      await storage.writeAudit(client,current,'ROUND_EXCHANGE_'+request.action,head.exchangeId,request.reason,change.before,{...head,sourceHash:event.sourceHash,observedRoundId:event.observedRoundId});
    }
    await storage.writeAudit(client,current,'ROUND_ASSOCIATION_COMMITTED',request.requestId,request.reason,null,plan.result);await saveSqlRoundReceipt(client,current,request,'ASSOCIATION',plan.result);await client.query('commit');return plan.result;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
}
