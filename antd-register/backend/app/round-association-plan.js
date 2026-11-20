import {roundDigest} from './workflow-rounds.js';
import {roundAdministrator,roundIdentifier,roundText,roundVersion} from './round-management.js';
import {httpError} from './auth.js';

const fail=(status,code,message)=>{throw httpError(status,message,{code});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const copy=value=>structuredClone(value);
const unavailable=()=>fail(404,'ROUND_ASSOCIATION_SOURCE_UNAVAILABLE','The selected workflow exchange or approval round is unavailable.');
const digest=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))fail(422,'ROUND_ASSOCIATION_HASH_REQUIRED','Provide the exact source hash from the current exchange view.');return value.toLowerCase();};
function fields(value,allowed,label){if(!object(value))fail(422,'ROUND_ASSOCIATION_REQUEST_INVALID',`${label} must be an object.`);for(const key of Object.keys(value))if(!allowed.includes(key))fail(422,'ROUND_ASSOCIATION_FIELD_INVALID',`${label} contains an unsupported field: ${key}.`);}

/** Canonical whole intent: selection order and UUID/hash case do not change a receipt. */
export function associationRequest(body){
  fields(body,['action','targetRoundId','selections','reason','requestId'],'Association request');
  if(!['ASSOCIATE','UNASSIGN'].includes(body.action))fail(422,'ROUND_ASSOCIATION_ACTION_INVALID','Choose ASSOCIATE or UNASSIGN.');
  let targetRoundId=null;
  if(body.action==='ASSOCIATE')targetRoundId=roundIdentifier(body.targetRoundId,'Target round ID');
  else if(body.targetRoundId!==null&&body.targetRoundId!==undefined)fail(422,'ROUND_ASSOCIATION_TARGET_INVALID','UNASSIGN must have no target round.');
  if(!Array.isArray(body.selections)||body.selections.length<1||body.selections.length>100)fail(422,'ROUND_ASSOCIATION_SELECTION_INVALID','Select between 1 and 100 individual workflow exchanges.');
  const seen=new Set(),selections=body.selections.map(item=>{
    fields(item,['exchangeId','expectedVersion','sourceHash'],'Exchange selection');
    const exchangeId=roundIdentifier(item.exchangeId,'Exchange ID');if(seen.has(exchangeId))fail(422,'ROUND_ASSOCIATION_DUPLICATE','Select each workflow exchange only once.');seen.add(exchangeId);
    return {exchangeId,expectedVersion:roundVersion(item.expectedVersion),sourceHash:digest(item.sourceHash)};
  }).sort((a,b)=>a.exchangeId.localeCompare(b.exchangeId));
  return {action:body.action,targetRoundId,selections,reason:roundText(body.reason,'Reason',2000),requestId:roundIdentifier(body.requestId,'Request ID')};
}
export const associationIntentHash=body=>roundDigest(associationRequest(body));

/** Accept stored raw exchange evidence, never a projected response payload. */
export function associationSourceHash(exchange){
  if(!object(exchange)||!object(exchange.payload))fail(409,'ROUND_ASSOCIATION_SOURCE_INVALID','The retained exchange evidence is invalid.');
  const exchangeId=roundIdentifier(exchange.exchangeId,'Exchange ID'),workflowId=roundIdentifier(exchange.workflowId,'Workflow ID'),observedRoundId=roundIdentifier(exchange.observedRoundId,'Observed round ID');
  if(typeof exchange.roundKey!=='string'||roundIdentifier(exchange.payload.exchangeId,'Payload exchange ID')!==exchangeId||roundIdentifier(exchange.payload.roundId,'Payload observed round ID')!==observedRoundId)fail(409,'ROUND_ASSOCIATION_SOURCE_INVALID','The retained exchange identity does not match its original workflow evidence.');
  // Local ordinals are pagination projections absent from SQL payload JSON.
  // All other stored raw payload fields, including nested source evidence, count.
  const {ordinal,...payload}=exchange.payload;
  return roundDigest({exchangeId,workflowId,observedRoundId,roundKey:exchange.roundKey,payload});
}
function eventUuid(value){const hash=roundDigest(value);return `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;}
function timestamp(value){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value)||!Number.isFinite(Date.parse(value)))fail(422,'ROUND_ASSOCIATION_TIME_INVALID','Association planning requires an ISO timestamp.');return value;}
function one(rows,id,key,missing=false){const matches=rows.filter(row=>row?.[key]===id);if(matches.length>1)fail(409,'ROUND_ASSOCIATION_STATE_INVALID','The retained association state is ambiguous. Refresh or contact an administrator.');if(!matches.length&&missing)unavailable();return matches[0]||null;}

/** Pure, all-or-nothing append plan. Persistence owns authorization/locking/receipts. */
export function planRoundAssociations({request:body,exchanges=[],heads=[],roundHeads=[],target=null,context,now,eventIds={}}){
  roundAdministrator(context);
  const request=associationRequest(body),requestHash=associationIntentHash(request),occurredAt=timestamp(now);
  if(![exchanges,heads,roundHeads].every(Array.isArray)||!object(eventIds))fail(422,'ROUND_ASSOCIATION_STATE_INVALID','Association planning requires captured exchange, head and round arrays.');
  const captures=request.selections.map(selection=>{
    const exchange=one(exchanges,selection.exchangeId,'exchangeId',true);
    if(exchange.roundKey!=='')fail(409,'ROUND_ASSOCIATION_EXPLICIT_SOURCE','Only exchanges whose original round was unspecified may be manually associated. Original named-round evidence is retained.');
    const sourceHash=associationSourceHash(exchange);
    if(sourceHash!==selection.sourceHash||exchange.rawHash!==undefined&&digest(exchange.rawHash)!==sourceHash)fail(409,'ROUND_ASSOCIATION_SOURCE_CHANGED','The selected exchange evidence changed. Refresh its current source hash before retrying.');
    const before=one(heads,selection.exchangeId,'exchangeId');
    if(before&&(!Number.isSafeInteger(before.version)||before.version<1||before.roundId!==null&&(typeof before.roundId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(before.roundId))))fail(409,'ROUND_ASSOCIATION_STATE_INVALID','The retained association head is invalid.');
    if(selection.expectedVersion!==(before?.version||0))fail(409,'ROUND_ASSOCIATION_VERSION_CHANGED','A selected association changed. Refresh its current version before retrying.');
    return {selection,exchange,sourceHash,before};
  });
  const workflowId=captures[0].exchange.workflowId;
  if(captures.some(item=>item.exchange.workflowId!==workflowId))unavailable();
  if(request.action==='ASSOCIATE'){
    if(!target||target.roundId!==request.targetRoundId||target.workflowId!==workflowId)unavailable();
    if(target.status!=='OPEN')fail(409,'ROUND_ASSOCIATION_TARGET_NOT_OPEN','Reopen the target approval round before manually associating exchanges.');
  }
  const changes=[],associations=[],unchangedExchangeIds=[],usedEvents=new Set();
  for(const {selection,exchange,sourceHash,before} of captures){
    const fromRoundId=before?.roundId||null,toRoundId=request.targetRoundId;
    if(fromRoundId===toRoundId){unchangedExchangeIds.push(selection.exchangeId);associations.push(before?copy(before):{exchangeId:selection.exchangeId,roundId:null,version:0});continue;}
    if(before?.version===Number.MAX_SAFE_INTEGER)fail(409,'ROUND_ASSOCIATION_VERSION_CHANGED','The retained association version cannot be advanced. Contact an administrator.');
    if(fromRoundId){
      const old=target?.roundId===fromRoundId?target:one(roundHeads,fromRoundId,'roundId',true);
      if(old.workflowId!==workflowId)unavailable();
      if(old.status!=='OPEN')fail(409,'ROUND_ASSOCIATION_CURRENT_NOT_OPEN','Reopen the currently associated approval round before changing or clearing this association.');
    }
    const version=(before?.version||0)+1,eventId=eventIds[selection.exchangeId]===undefined?eventUuid(['round-association',requestHash,context.userId||context.actor||'Local administrator',selection.exchangeId,version]):roundIdentifier(eventIds[selection.exchangeId],'Association event ID');
    if(usedEvents.has(eventId))fail(422,'ROUND_ASSOCIATION_EVENT_INVALID','Each changed association requires a distinct event ID.');usedEvents.add(eventId);
    const head={exchangeId:selection.exchangeId,roundId:toRoundId,version,updatedAt:occurredAt,lastEventId:eventId};
    const event={eventId,exchangeId:selection.exchangeId,workflowId,action:request.action,fromRoundId,toRoundId,expectedVersion:selection.expectedVersion,version,reason:request.reason,actor:context.actor||'Local administrator',actorUserId:context.userId||null,occurredAt,requestId:request.requestId,sourceHash,observedRoundId:exchange.observedRoundId};
    changes.push({before:before?copy(before):null,head,event});associations.push(copy(head));
  }
  return {changes,result:{requestId:request.requestId,requestHash,action:request.action,targetRoundId:request.targetRoundId,workflowId,selected:request.selections.length,changed:changes.length,unchanged:unchangedExchangeIds.length,exchangeIds:request.selections.map(item=>item.exchangeId),changedExchangeIds:changes.map(item=>item.head.exchangeId),unchangedExchangeIds,associations}};
}
