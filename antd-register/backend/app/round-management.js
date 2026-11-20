import {randomUUID} from 'node:crypto';
import {roundDigest} from './workflow-rounds.js';
import {cleanText,normalize} from './normalization.js';
import {httpError} from './auth.js';

const clone=value=>structuredClone(value);
const fail=(status,code,message)=>{throw httpError(status,message,{code});};
export function roundAdministrator(context){if(context?.role!=='ADMINISTRATOR'||context.authenticated&&!context.userId)fail(403,'ROUND_ADMIN_REQUIRED','Only an administrator can manage approval rounds.');}
export const roundOwner=context=>context.authenticated?`USER:${context.userId}`:`LOCAL:${roundDigest([context.role,context.actor||'Local administrator'])}`;
export function roundIdentifier(value,label='Round ID') {if(typeof value!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))fail(422,'ROUND_ID_INVALID',`${label} must be a UUID.`);return value.toLowerCase();}
export function roundText(value,label,max=250){if(typeof value!=='string'||!cleanText(value)||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail(422,'ROUND_FIELD_INVALID',`${label} is required and must be text of at most ${max} characters without control characters.`);return cleanText(value);}
export function roundVersion(value){if(!Number.isSafeInteger(value)||value<0)fail(422,'ROUND_VERSION_REQUIRED','Provide the exact nonnegative integer round version from the current view.');return value;}
export function managedRoundId(workflowId,roundKey){const text=roundDigest(['round',workflowId,roundKey]);return `${text.slice(0,8)}-${text.slice(8,12)}-8${text.slice(13,16)}-a${text.slice(17,20)}-${text.slice(20,32)}`;}
export function roundRequest(body){
  if(!body||typeof body!=='object'||Array.isArray(body))fail(422,'ROUND_REQUEST_INVALID','Round management requires an object.');
  const action=body.action;
  if(!['CREATE','ADOPT','CLOSE','CANCEL','REOPEN'].includes(action))fail(422,'ROUND_ACTION_INVALID','Choose CREATE, ADOPT, CLOSE, CANCEL or REOPEN.');
  const allowed=['action','expectedVersion','reason','requestId',...(action==='CREATE'?['workflowId','roundLabel']:['roundId'])];
  for(const key of Object.keys(body))if(!allowed.includes(key))fail(422,'ROUND_FIELD_INVALID',`The round field ${key} is not available for ${action}.`);
  const result={action,expectedVersion:roundVersion(body.expectedVersion),reason:roundText(body.reason,'Reason',2000),requestId:roundIdentifier(body.requestId,'Request ID')};
  if(action==='CREATE'){result.workflowId=roundIdentifier(body.workflowId,'Workflow ID');result.roundLabel=roundText(body.roundLabel,'Round name',100);}
  else result.roundId=roundIdentifier(body.roundId);
  return result;
}
export function roundAccessible(instance,context){return Boolean(instance&&(context?.role==='ADMINISTRATOR'||!context?.authenticated||(context.orders||[]).some(order=>normalize(order)===normalize(instance.orderNo))&&(context.role!=='SUPPLIER'||normalize(context.organization)===normalize(instance.supplier))));}
export function requireRoundAccess(instance,context){if(!roundAccessible(instance,context))fail(404,'ROUND_NOT_FOUND','Approval round not found.');}
export function managementSummary({head=null,observed=null,instance,counts={observedExchangeCount:0,associationEventCount:0}}){
  const baseline=head?.closureBaseline||null;
  return {...clone(instance),roundId:head?.roundId||observed?.roundId,roundLabel:head?.roundLabel??observed?.roundLabel??null,roundKey:head?.roundKey??observed?.roundKey??'',status:head?.status||(observed?.roundKey?'UNMANAGED':'UNASSIGNED'),lifecycleStatus:head?.status||'UNKNOWN',managed:Boolean(head),version:head?.version||0,createdAt:head?.createdAt??observed?.createdAt??null,updatedAt:head?.updatedAt??null,closureBaseline:clone(baseline),...clone(counts),activityAfterClosure:Boolean(baseline&&(counts.observedExchangeCount>baseline.observedExchangeCount||counts.associationEventCount>baseline.associationEventCount)),...(head?{lastEventId:head.lastEventId}:{})};
}
export function planRoundManagement({request,head=null,observed=null,instance,counts,context,now=new Date().toISOString(),eventId=randomUUID()}){
  roundAdministrator(context);requireRoundAccess(instance,context);
  if(head&&(!Number.isSafeInteger(head.version)||head.version>=Number.MAX_SAFE_INTEGER))fail(409,'ROUND_VERSION_CHANGED','The retained round version cannot be advanced. Contact an administrator.');
  if(request.expectedVersion!==(head?.version||0))fail(409,'ROUND_VERSION_CHANGED','The approval round changed. Refresh its current state before retrying.');
  let roundId=head?.roundId||observed?.roundId,roundLabel=head?.roundLabel??observed?.roundLabel,roundKey=head?.roundKey??observed?.roundKey;
  const {action}=request;
  if(action==='CREATE'){
    roundLabel=request.roundLabel;roundKey=normalize(roundLabel);roundId=managedRoundId(instance.workflowId,roundKey);
    if(head)fail(409,'ROUND_ALREADY_MANAGED','That named approval round already exists.');
    if(observed)fail(409,'ROUND_ADOPTION_REQUIRED','That round has observed history. Explicitly adopt it before managing its lifecycle.');
  }else if(action==='ADOPT'){
    if(head)fail(409,'ROUND_ALREADY_MANAGED','That approval round is already managed.');
    if(!observed?.roundKey||!observed.roundLabel)fail(422,'ROUND_UNASSIGNED_BUCKET','The unassigned history bucket is not a named business round. Create a named round and associate individual exchanges.');
  }else if(!head)fail(409,'ROUND_ADOPTION_REQUIRED','Explicitly adopt the named observed round before changing its lifecycle.');
  const status=action==='CLOSE'?'CLOSED':action==='CANCEL'?'CANCELLED':'OPEN';
  if(head&&(action==='REOPEN'?!['CLOSED','CANCELLED'].includes(head.status):head.status!=='OPEN'))fail(409,'ROUND_TRANSITION_INVALID','The requested lifecycle transition is not available from the current round status.');
  const version=(head?.version||0)+1,closureBaseline=status==='OPEN'?null:clone(counts);
  const after={roundId,workflowId:instance.workflowId,roundLabel,roundKey,status,version,createdAt:head?.createdAt||now,updatedAt:now,lastEventId:eventId,closureBaseline};
  const event={eventId,roundId,workflowId:instance.workflowId,action,fromStatus:head?.status||'UNKNOWN',toStatus:status,expectedVersion:request.expectedVersion,version,reason:request.reason,actor:context.actor||'Local administrator',actorUserId:context.userId||null,occurredAt:now,closureBaseline,requestId:request.requestId};
  return {before:head?clone(head):null,head:after,event,result:{...managementSummary({head:after,observed,instance,counts}),eventId,action,reason:request.reason,requestId:request.requestId}};
}
export function roundPage(input={}) {const limit=input.limit===undefined?30:Number(input.limit),cursor=input.cursor===undefined||input.cursor===null||input.cursor===''?null:String(input.cursor);if(!Number.isSafeInteger(limit)||limit<1||limit>100||cursor!==null&&(!/^[1-9]\d{0,18}$/.test(cursor)||BigInt(cursor)>9223372036854775807n))fail(422,'ROUND_PAGE_INVALID','Round management page size must be 1–100 and its cursor a positive PostgreSQL bigint ordinal.');return {limit,cursor};}
