import {createHash} from 'node:crypto';
import {maintenanceIdentity} from './audit-provenance.js';
import {auditEventProvenance} from './audit-writer.js';

function maintenanceAuditMetadata(actor,auditRuntime){
 if(auditRuntime==null)return {};
 let context={};
 // The operation ID is a legacy correlation value, not an HTTP request ID.
 // Preserve its actor text separately when it cannot form a valid identity.
 try{maintenanceIdentity(actor);context={actor,role:'SYSTEM'};}catch{}
 return {provenance:auditEventProvenance(context,auditRuntime)};
}

const invalid=()=>Object.assign(new Error('Source refresh requires verified JSON source evidence and exact capture metadata.'),{status:422,code:'SOURCE_REFRESH_INPUT_INVALID'});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export function canonicalSourceJson(value){
 const active=new Set();
 const canonical=item=>{
  if(item===null||typeof item==='string'||typeof item==='boolean')return item;
  if(typeof item==='number'){if(!Number.isFinite(item))throw invalid();return item;}
  if(!Array.isArray(item)&&!plain(item)||active.has(item))throw invalid();active.add(item);
  const keys=Object.keys(item);if(Reflect.ownKeys(item).length!==keys.length+(Array.isArray(item)?1:0)||keys.some(key=>!Object.hasOwn(Object.getOwnPropertyDescriptor(item,key),'value')))throw invalid();
  let result;if(Array.isArray(item)){if(keys.length!==item.length||keys.some((key,index)=>key!==String(index)))throw invalid();result=item.map(canonical);}else{result=Object.create(null);for(const key of keys.sort())result[key]=canonical(item[key]);}
  active.delete(item);return result;
 };return JSON.stringify(canonical(value));
}
export const sourceJsonHash=value=>createHash('sha256').update(canonicalSourceJson(value)).digest('hex');
function capture(value,{incoming=false}={}){
 if(value!==null&&value!==undefined&&!plain(value))throw invalid();const result={sourceHash:value?.sourceHash??null,sourceSheet:value?.sourceSheet??null,sourceRow:value?.sourceRow??null};
 if(result.sourceHash!==null&&(typeof result.sourceHash!=='string'||!result.sourceHash)||result.sourceSheet!==null&&typeof result.sourceSheet!=='string'||result.sourceRow!==null&&(!Number.isSafeInteger(result.sourceRow)||result.sourceRow<0)||incoming&&(!result.sourceHash||!result.sourceSheet))throw invalid();return result;
}
/** Missing current raw evidence is distinct from a captured JSON null. Callers
 * verify source-file authority and immutable capture consistency separately. */
export function planSourceCapture({currentRaw,incomingRaw,currentCapture,incomingCapture,typedChangedFields=[]}){
 if(!plain(incomingRaw))throw Object.assign(new Error('The incoming source row must contain its captured rawSource object.'),{status:422,code:'SOURCE_REFRESH_RAW_REQUIRED'});
 if(!Array.isArray(typedChangedFields)||typedChangedFields.some(key=>typeof key!=='string'))throw invalid();
 const rawBeforeHash=currentRaw===undefined?null:sourceJsonHash(currentRaw),rawAfterHash=sourceJsonHash(incomingRaw),captureBeforeHash=sourceJsonHash(capture(currentCapture)),captureAfterHash=sourceJsonHash(capture(incomingCapture,{incoming:true})),rawChanged=rawBeforeHash!==rawAfterHash,captureChanged=captureBeforeHash!==captureAfterHash,businessChanged=typedChangedFields.length>0;
 return Object.freeze({rawChanged,captureChanged,businessChanged,rowVersionIncrement:rawChanged||businessChanged?1:0,rawBeforeHash,rawAfterHash,captureBeforeHash,captureAfterHash,action:rawChanged||captureChanged?'SOURCE_EVIDENCE_REFRESHED':'UNCHANGED'});
}

const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const conflict=(reason,kind,targetId,fields=[])=>({reason,kind,targetId,fields});
function seedPair(bundle){
 if(!plain(bundle)||!plain(bundle.proposals)||!plain(bundle.replacements)||!Array.isArray(bundle.proposals.items)||!Array.isArray(bundle.replacements.items))throw invalid();
 const sourceHash=bundle.proposals.metadata?.sourceSha256;if(!validHash(sourceHash)||bundle.replacements.metadata?.sourceSha256!==sourceHash)throw invalid();sourceJsonHash(bundle);return sourceHash;
}
const receiptBody=receipt=>Object.fromEntries(Object.entries(receipt).filter(([key])=>key!=='receiptHash'));
function typedSourceSnapshot(item,kind,fieldMap,targetId){
 const keys=new Set([...Object.keys(fieldMap),'proposalId','archived','round','rowVersion','sourceSheet','sourceRow','clientReplyRaw','clientDecisionExportText',...(kind==='replacement'?['recordId','recordType']:[])]),result={};
 for(const key of keys)if(Object.hasOwn(item,key)){const value=item[key];if(value!==null&&!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw invalid();result[key]=value;}
 result[kind==='replacement'?'recordId':'proposalId']=targetId;return result;
}
export function verifiedRefreshReceipt(receipt){
 if(!plain(receipt)||receipt.version!==1||!validHash(receipt.receiptHash)||sourceJsonHash(receiptBody(receipt))!==receipt.receiptHash)throw Object.assign(new Error('The saved source refresh receipt failed its integrity check.'),{status:409,code:'SOURCE_REFRESH_RECEIPT_INVALID'});return receipt;
}

/** No filesystem, SQL, timestamps or source adoption occurs while planning.
 * The trusted caller supplies the existing semantic merge/identity contracts. */
export function planPreviewSourceRefresh({envelope,baseline,incoming,mergeRecord,identityFor,fields}){
 if(!plain(envelope)||!plain(envelope.state)||!Array.isArray(envelope.state.proposals)||!Array.isArray(envelope.state.replacements)||!Array.isArray(envelope.state.audit)||!Array.isArray(envelope.state.workflowRuns)||typeof mergeRecord!=='function'||typeof identityFor!=='function'||!plain(fields))throw invalid();
 const baselineHash=seedPair(baseline),sourceHash=seedPair(incoming),inputHash=sourceJsonHash({version:1,baseline,incoming}),prior=envelope.sourceProvenance?.receipts?.[inputHash];
 if(prior){verifiedRefreshReceipt(prior);if(prior.inputHash!==inputHash)throw invalid();return {version:1,inputHash,sourceHash,baselineHash,changed:false,replayed:true,receipt:structuredClone(prior),rows:[],conflicts:[],summary:structuredClone(prior.summary),planHash:prior.planHash};}
 if(envelope.sourceSha256!==baselineHash)throw Object.assign(new Error('The loaded preview source does not match the verified historical baseline.'),{status:409,code:'SOURCE_REFRESH_BASELINE_MISMATCH'});
 const rows=[],conflicts=[],bindings=envelope.sourceProvenance?.bindings||{},summary={rows:0,businessChanged:0,rawChanged:0,captureChanged:0,localEditsPreserved:0,localRowsPreserved:0,conflicts:0};
 for(const [kind,collection,idKey]of [['proposal','proposals','proposalId'],['replacement','replacements','recordId']]){
  const previous=baseline[collection].items,latest=incoming[collection].items,current=envelope.state[collection],map=new Map(),currentById=new Map(),oldIds=new Set();
  for(const item of latest){const identity=identityFor(kind,item);if(!identity||map.has(identity)){conflicts.push(conflict('AMBIGUOUS_INCOMING_IDENTITY',kind,item[idKey]||''));continue;}map.set(identity,item);}
  for(const item of current){if(typeof item[idKey]!=='string'||!item[idKey]||currentById.has(item[idKey])){conflicts.push(conflict('AMBIGUOUS_CURRENT_IDENTITY',kind,item[idKey]||''));continue;}currentById.set(item[idKey],item);}
  const identities=new Set();
  for(const old of previous){
   const identity=identityFor(kind,old),bindingKey=kind+':'+identity,targetId=bindings[bindingKey]?.targetId||old[idKey];oldIds.add(targetId);
   if(!identity||identities.has(identity)){conflicts.push(conflict('AMBIGUOUS_BASELINE_IDENTITY',kind,targetId));continue;}identities.add(identity);
   const item=currentById.get(targetId),next=map.get(identity);if(!item){conflicts.push(conflict('BOUND_TARGET_DELETED',kind,targetId));continue;}if(!next){conflicts.push(conflict('SOURCE_IDENTITY_REMOVED_OR_CHANGED',kind,targetId));continue;}
   if(!plain(old.rawSource)||!plain(next.rawSource))throw Object.assign(new Error('Source refresh requires actual captured raw cells for each bound row.'),{status:422,code:'SOURCE_REFRESH_RAW_REQUIRED',details:[`${kind==='proposal'?'Check':'Database'} ${targetId}: ${!plain(next.rawSource)?'incoming':'baseline'} rawSource object is required.`]});
   if(sourceHash===baselineHash&&(sourceJsonHash(old.rawSource)!==sourceJsonHash(next.rawSource)||old.sourceSheet!==next.sourceSheet||(old.sourceRow??null)!==(next.sourceRow??null)||mergeRecord(old,next,old,fields[kind]).changed.length)){conflicts.push(conflict('IMMUTABLE_SOURCE_CAPTURE_CHANGED',kind,targetId));continue;}
   const merge=mergeRecord(item,next,old,fields[kind]);if(merge.conflicts.length){conflicts.push(conflict('SEMANTIC_SOURCE_CONFLICT',kind,targetId,merge.conflicts.map(entry=>entry.field)));continue;}
   const existingBinding=bindings[bindingKey];if(existingBinding&&(existingBinding.targetId!==targetId||existingBinding.sourceHash!==baselineHash)){conflicts.push(conflict('SOURCE_BINDING_CHANGED',kind,targetId));continue;}
   if(Object.hasOwn(item,'rawSource')&&item.rawSource!==null&&sourceJsonHash(item.rawSource)!==sourceJsonHash(old.rawSource)){conflicts.push(conflict('UNVERIFIED_LOCAL_RAW_CHANGE',kind,targetId));continue;}
   const incomingCapture={sourceHash,sourceSheet:next.sourceSheet,sourceRow:next.sourceRow??null},currentCapture=existingBinding?{sourceHash:existingBinding.sourceHash,sourceSheet:existingBinding.sourceSheet,sourceRow:existingBinding.sourceRow}:null,capturePlan=planSourceCapture({currentRaw:item.rawSource,incomingRaw:next.rawSource,currentCapture,incomingCapture,typedChangedFields:merge.changed});
   const rowVersion=Number(item.rowVersion??1);if(!Number.isSafeInteger(rowVersion)||rowVersion<1||capturePlan.rowVersionIncrement&&rowVersion===Number.MAX_SAFE_INTEGER)throw invalid();
   const after={...structuredClone(item),...Object.fromEntries(merge.changed.map(key=>[key,merge.merged[key]])),rawSource:structuredClone(next.rawSource),sourceSheet:next.sourceSheet,sourceRow:next.sourceRow??null,rowVersion:rowVersion+capturePlan.rowVersionIncrement};
   rows.push({kind,collection,targetId,bindingKey,sourceIdentity:identity,beforeHash:sourceJsonHash(item),after,typedBefore:typedSourceSnapshot(item,kind,fields[kind],targetId),typedAfter:typedSourceSnapshot(after,kind,fields[kind],targetId),changedFields:merge.changed,preservedFields:merge.preserved,...capturePlan,incomingCapture});summary.rows++;summary.businessChanged+=Number(capturePlan.businessChanged);summary.rawChanged+=Number(capturePlan.rawChanged);summary.captureChanged+=Number(capturePlan.captureChanged);summary.localEditsPreserved+=Number(merge.preserved.length>0);
  }
  for(const item of current)if(!oldIds.has(item[idKey]))summary.localRowsPreserved++;
  for(const [identity,item]of map)if(!identities.has(identity))conflicts.push(conflict('NEW_SOURCE_IDENTITY_REQUIRES_REVIEW',kind,item[idKey]||''));
 }
 summary.conflicts=conflicts.length;const plan={version:1,inputHash,sourceHash,baselineHash,changed:rows.some(row=>row.rawChanged||row.captureChanged||row.businessChanged),replayed:false,rows,conflicts,summary,expectedEnvelopeHash:sourceJsonHash(envelope)};plan.planHash=sourceJsonHash(plan);return plan;
}

export function refreshedPreviewEnvelope(envelope,plan,{actor,occurredAt,operationId,evidence,beforeStateSha256=null,appendDecisionAudit,appendWorkflowAudit,auditRuntime=null}){
 if(typeof actor!=='string'||!actor.trim()||typeof occurredAt!=='string'||!Number.isFinite(Date.parse(occurredAt))||typeof operationId!=='string'||!operationId||!plain(evidence))throw invalid();
 if(plan.replayed)return {envelope:structuredClone(envelope),receipt:verifiedRefreshReceipt(plan.receipt),changed:false};
 const {planHash,...reviewed}=plan;if(planHash!==sourceJsonHash(reviewed)||plan.expectedEnvelopeHash!==sourceJsonHash(envelope))throw Object.assign(new Error('The source refresh plan or preview changed after review.'),{status:409,code:'SOURCE_REFRESH_PLAN_CHANGED'});
 if(plan.conflicts.length)throw Object.assign(new Error('Source refresh conflicts require review; no preview changes were applied.'),{status:409,code:'SOURCE_REFRESH_CONFLICT',details:plan.conflicts.map(entry=>`${entry.kind} ${entry.targetId}: ${entry.reason}${entry.fields.length?' ('+entry.fields.join(', ')+')':''}`)});
 if(plan.rows.some(row=>row.businessChanged)&&(typeof appendDecisionAudit!=='function'||typeof appendWorkflowAudit!=='function'))throw Object.assign(new Error('Typed source changes require the tracked decision and workflow audit appenders.'),{status:422,code:'SOURCE_REFRESH_HISTORY_REQUIRED'});
 const next=structuredClone(envelope);next.sourceProvenance||={version:1,bindings:{},receipts:{}};next.sourceProvenance.bindings||={};next.sourceProvenance.receipts||={};let sequence=Number(next.state.auditSequence)||0;for(const entry of next.state.audit)sequence=Math.max(sequence,Number(entry.id)||0);
 for(const row of plan.rows){
  const index=next.state[row.collection].findIndex(item=>item[row.kind==='proposal'?'proposalId':'recordId']===row.targetId);if(index<0||sourceJsonHash(next.state[row.collection][index])!==row.beforeHash)throw Object.assign(new Error('The preview changed after source review. Reload and prepare a new refresh plan.'),{status:409,code:'SOURCE_REFRESH_STATE_CHANGED'});
  next.state[row.collection][index]=structuredClone(row.after);next.sourceProvenance.bindings[row.bindingKey]={targetId:row.targetId,sourceHash:plan.sourceHash,sourceSheet:row.incomingCapture.sourceSheet,sourceRow:row.incomingCapture.sourceRow,rawHash:row.rawAfterHash};
  if(row.action!=='UNCHANGED'||row.businessChanged){
   const values=items=>[...new Set(items.filter(value=>value!==undefined&&value!==null&&value!=='').map(String))],scope={orderNos:values([row.typedBefore.orderNo,row.typedAfter.orderNo]),suppliers:values([row.typedBefore.supplier,row.typedAfter.supplier])},beforeCapture={captureHash:row.captureBeforeHash,rawHash:row.rawBeforeHash},afterCapture={captureHash:row.captureAfterHash,rawHash:row.rawAfterHash,sourceHash:plan.sourceHash,changedFields:row.changedFields,preservedFields:row.preservedFields,scope};
   const audit={id:++sequence,occurredAt,actor,role:'SYSTEM',requestId:operationId,action:row.businessChanged?'SOURCE_RECORD_UPDATED':'SOURCE_EVIDENCE_REFRESHED',subject:row.targetId,detail:'Verified source capture adopted; local business edits retained.',before:row.businessChanged?structuredClone(row.typedBefore):beforeCapture,after:row.businessChanged?structuredClone(row.typedAfter):afterCapture,...(row.businessChanged?{sourceEvidence:{before:beforeCapture,after:afterCapture},decisionSource:{sha256:plan.sourceHash,sheet:row.incomingCapture.sourceSheet,row:row.incomingCapture.sourceRow,description:'Verified source business update; preserved local fields remain application edits.'}}:{})};
   Object.assign(audit,maintenanceAuditMetadata(actor,auditRuntime));
   next.state.audit.unshift(audit);if(row.businessChanged){appendDecisionAudit(next.state,audit);appendWorkflowAudit(next.state,audit);}
  }
 }
 next.state.auditSequence=sequence;next.sourceSha256=plan.sourceHash;next.sourceProvenance.adoptedSourceHash=plan.sourceHash;next.sourceProvenance.evidence=structuredClone(evidence);
 if(beforeStateSha256!==null&&(!validHash(beforeStateSha256)||evidence.backup?.sha256!==beforeStateSha256))throw invalid();
 const targets=plan.rows.filter(row=>row.rawChanged||row.captureChanged||row.businessChanged).map(row=>({kind:row.kind,collection:row.collection,targetId:row.targetId,bindingKey:row.bindingKey,beforeHash:row.beforeHash,afterHash:sourceJsonHash(row.after),rawBeforeHash:row.rawBeforeHash,rawAfterHash:row.rawAfterHash,captureBeforeHash:row.captureBeforeHash,captureAfterHash:row.captureAfterHash,rawChanged:row.rawChanged,businessChanged:row.businessChanged,captureChanged:row.captureChanged}));
 const receipt={version:1,kind:'SOURCE_REFRESH_APPLY',inputHash:plan.inputHash,planHash:plan.planHash,sourceHash:plan.sourceHash,baselineHash:plan.baselineHash,operationId,actor,occurredAt,summary:structuredClone(plan.summary),beforeStateSha256,targets,appliedEnvelopeHash:sourceJsonHash(next)};receipt.receiptHash=sourceJsonHash(receipt);next.sourceProvenance.receipts[plan.inputHash]=receipt;return {envelope:next,receipt,changed:true};
}

const rollbackFailure=(code,message)=>Object.assign(new Error(message),{status:409,code});
const ownValue=(row,key)=>Object.hasOwn(row,key)?{present:true,value:row[key]}:{present:false};
const scopeValues=values=>[...new Set(values.filter(value=>value!==undefined&&value!==null&&value!=='').map(String))];
function rollbackIdentity({targetOperationId,targetReceiptHash,beforeStateSha256,appliedStateSha256}){
 if(typeof targetOperationId!=='string'||!targetOperationId||![targetReceiptHash,beforeStateSha256,appliedStateSha256].every(validHash))throw invalid();return sourceJsonHash({version:1,targetOperationId,targetReceiptHash,beforeStateSha256,appliedStateSha256});
}
function putOwn(object,key,value){Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});}

/** Compensation restores verified pre-apply data, never the old whole file.
 * Current audit/history survive, and changed row versions advance once. */
export function planPreviewSourceCompensation({envelope,beforeEnvelope,targetOperationId,targetReceiptHash,beforeStateSha256,appliedStateSha256,fields}){
 const inputHash=rollbackIdentity({targetOperationId,targetReceiptHash,beforeStateSha256,appliedStateSha256});
 if(!plain(envelope)||!plain(envelope.state)||!plain(beforeEnvelope)||!plain(beforeEnvelope.state)||!plain(fields))throw invalid();sourceJsonHash(envelope);sourceJsonHash(beforeEnvelope);
 const completed=envelope.sourceRefreshHistory?.compensations?.[targetOperationId];
 if(completed){verifiedRefreshReceipt(completed);const archived=envelope.sourceRefreshHistory?.appliedReceipts?.[targetOperationId];verifiedRefreshReceipt(archived);if(completed.kind!=='SOURCE_REFRESH_COMPENSATION'||completed.inputHash!==inputHash||completed.targetReceiptHash!==targetReceiptHash||archived.receiptHash!==targetReceiptHash||archived.operationId!==targetOperationId)throw rollbackFailure('SOURCE_ROLLBACK_REQUEST_CHANGED','The recorded compensation belongs to a different reviewed request.');return {version:1,mode:'COMPENSATION',inputHash,replayed:true,changed:false,receipt:structuredClone(completed),summary:structuredClone(completed.summary),rows:[],conflicts:[],planHash:completed.planHash};}
 const entries=Object.entries(envelope.sourceProvenance?.receipts||{}).filter(([,receipt])=>receipt?.operationId===targetOperationId);if(entries.length!==1)throw rollbackFailure('SOURCE_ROLLBACK_TARGET_INVALID','The target source refresh is not an active uniquely recorded operation.');
 const [receiptKey,receipt]=entries[0];verifiedRefreshReceipt(receipt);
 if(receipt.receiptHash!==targetReceiptHash||receiptKey!==receipt.inputHash)throw rollbackFailure('SOURCE_ROLLBACK_TARGET_INVALID','The target source refresh receipt does not match the reviewed identity.');
 if(receipt.kind!=='SOURCE_REFRESH_APPLY'||!validHash(receipt.beforeStateSha256)||!validHash(receipt.appliedEnvelopeHash)||!Array.isArray(receipt.targets))throw rollbackFailure('SOURCE_ROLLBACK_CHECKPOINT_MISSING','This historical receipt has no verified compensating-rollback checkpoint.');
 if(receipt.beforeStateSha256!==beforeStateSha256||beforeEnvelope.sourceSha256!==receipt.baselineHash)throw rollbackFailure('SOURCE_ROLLBACK_BACKUP_INVALID','The before-backup does not belong to the target source refresh.');
 if(envelope.sourceSha256!==receipt.sourceHash||envelope.sourceProvenance?.adoptedSourceHash!==receipt.sourceHash)throw rollbackFailure('SOURCE_ROLLBACK_LATER_EDITS','A later source adoption prevents compensation of this operation.');
 const applied=structuredClone(envelope);delete applied.sourceProvenance.receipts[receiptKey];if(sourceJsonHash(applied)!==receipt.appliedEnvelopeHash)throw rollbackFailure('SOURCE_ROLLBACK_LATER_EDITS','The preview has changes after the recorded apply. Compensation requires its unchanged applied state.');
 const rows=[],seen=new Set(),summary={rows:0,rawRestored:0,businessRestored:0,captureRestored:0,rowVersionsAdvanced:0};
 for(const target of receipt.targets){
  const collection=target.kind==='proposal'?'proposals':target.kind==='replacement'?'replacements':null,idKey=target.kind==='proposal'?'proposalId':'recordId';if(!collection||target.collection!==collection||typeof target.targetId!=='string'||!target.targetId||seen.has(target.kind+':'+target.targetId)||!Array.isArray(envelope.state[collection])||!Array.isArray(beforeEnvelope.state[collection]))throw invalid();seen.add(target.kind+':'+target.targetId);
  const current=envelope.state[collection].filter(row=>row[idKey]===target.targetId),previous=beforeEnvelope.state[collection].filter(row=>row[idKey]===target.targetId);if(current.length!==1||previous.length!==1||sourceJsonHash(current[0])!==target.afterHash||sourceJsonHash(previous[0])!==target.beforeHash)throw rollbackFailure('SOURCE_ROLLBACK_TARGET_CHANGED','An affected row does not match its recorded before/apply checkpoint.');
  const changedFields=Object.keys(fields[target.kind]).filter(key=>sourceJsonHash(ownValue(current[0],key))!==sourceJsonHash(ownValue(previous[0],key))),businessChanged=changedFields.length>0,rawChanged=sourceJsonHash(ownValue(current[0],'rawSource'))!==sourceJsonHash(ownValue(previous[0],'rawSource')),increment=Number(businessChanged||rawChanged),version=Number(current[0].rowVersion??1);if(!Number.isSafeInteger(version)||version<1||increment&&version===Number.MAX_SAFE_INTEGER)throw invalid();
  const after=structuredClone(previous[0]);after.rowVersion=version+increment;const typedBefore=typedSourceSnapshot(current[0],target.kind,fields[target.kind],target.targetId),typedAfter=typedSourceSnapshot(after,target.kind,fields[target.kind],target.targetId);
  rows.push({kind:target.kind,collection,targetId:target.targetId,beforeHash:target.afterHash,after,typedBefore,typedAfter,changedFields,businessChanged,rawChanged,captureChanged:Boolean(target.captureChanged),rowVersionIncrement:increment,rawBeforeHash:target.rawAfterHash,rawAfterHash:target.rawBeforeHash,captureBeforeHash:target.captureAfterHash,captureAfterHash:target.captureBeforeHash});summary.rows++;summary.rawRestored+=Number(rawChanged);summary.businessRestored+=Number(businessChanged);summary.captureRestored+=Number(Boolean(target.captureChanged));summary.rowVersionsAdvanced+=increment;
 }
 const plan={version:1,mode:'COMPENSATION',inputHash,replayed:false,changed:true,targetOperationId,targetReceiptHash,receiptKey,applyReceipt:structuredClone(receipt),beforeStateSha256,appliedStateSha256,expectedEnvelopeHash:sourceJsonHash(envelope),beforeEnvelopeHash:sourceJsonHash(beforeEnvelope),rows,summary,conflicts:[]};plan.planHash=sourceJsonHash(plan);return plan;
}

export function compensatedPreviewEnvelope(envelope,beforeEnvelope,plan,{actor,occurredAt,operationId,evidence,appendDecisionAudit,appendWorkflowAudit,auditRuntime=null}){
 if(typeof actor!=='string'||!actor.trim()||typeof occurredAt!=='string'||!Number.isFinite(Date.parse(occurredAt))||typeof operationId!=='string'||!operationId||!plain(evidence))throw invalid();
 if(plan.replayed)return {envelope:structuredClone(envelope),receipt:verifiedRefreshReceipt(plan.receipt),changed:false};
 const {planHash,...reviewed}=plan;if(planHash!==sourceJsonHash(reviewed)||sourceJsonHash(envelope)!==plan.expectedEnvelopeHash||sourceJsonHash(beforeEnvelope)!==plan.beforeEnvelopeHash)throw rollbackFailure('SOURCE_ROLLBACK_PLAN_CHANGED','The compensation plan or its state changed after review.');
 if(plan.rows.some(row=>row.businessChanged)&&(typeof appendDecisionAudit!=='function'||typeof appendWorkflowAudit!=='function'))throw Object.assign(new Error('Typed compensation requires the tracked decision and workflow audit appenders.'),{status:422,code:'SOURCE_REFRESH_HISTORY_REQUIRED'});
 const next=structuredClone(envelope);let sequence=Number(next.state.auditSequence)||0;for(const audit of next.state.audit)sequence=Math.max(sequence,Number(audit.id)||0);
 for(const row of plan.rows){
  const idKey=row.kind==='proposal'?'proposalId':'recordId',index=next.state[row.collection].findIndex(item=>item[idKey]===row.targetId);if(index<0||sourceJsonHash(next.state[row.collection][index])!==row.beforeHash)throw rollbackFailure('SOURCE_ROLLBACK_TARGET_CHANGED','An affected row changed after compensation review.');next.state[row.collection][index]=structuredClone(row.after);
  const scope={orderNos:scopeValues([row.typedBefore.orderNo,row.typedAfter.orderNo]),suppliers:scopeValues([row.typedBefore.supplier,row.typedAfter.supplier])},before={captureHash:row.captureBeforeHash,rawHash:row.rawBeforeHash},after={captureHash:row.captureAfterHash,rawHash:row.rawAfterHash,scope,compensatesOperationId:plan.targetOperationId};
  const audit={id:++sequence,occurredAt,actor,role:'SYSTEM',requestId:operationId,action:row.businessChanged?'SOURCE_RECORD_UPDATED':'SOURCE_EVIDENCE_COMPENSATED',subject:row.targetId,detail:'Compensated a recorded source refresh from its verified pre-apply backup.',before:row.businessChanged?structuredClone(row.typedBefore):before,after:row.businessChanged?structuredClone(row.typedAfter):after,...(row.businessChanged?{sourceEvidence:{before,after},decisionSource:{sha256:plan.beforeStateSha256,kind:'PRE_APPLY_STATE_BACKUP',compensatesOperationId:plan.targetOperationId,targetReceiptHash:plan.targetReceiptHash,description:'Tracked compensation; restored source hash is a prior state claim, not newly verified original origin.'}}:{})};Object.assign(audit,maintenanceAuditMetadata(actor,auditRuntime));next.state.audit.unshift(audit);if(row.businessChanged){appendDecisionAudit(next.state,audit);appendWorkflowAudit(next.state,audit);}
 }
 const oldProvenance=next.sourceProvenance;if(Object.hasOwn(beforeEnvelope,'sourceSha256'))next.sourceSha256=structuredClone(beforeEnvelope.sourceSha256);else delete next.sourceSha256;if(Object.hasOwn(beforeEnvelope,'sourceProvenance'))next.sourceProvenance=structuredClone(beforeEnvelope.sourceProvenance);else delete next.sourceProvenance;
 next.sourceRefreshHistory||={version:1,appliedReceipts:{},compensations:{},evidence:{}};const history=next.sourceRefreshHistory;for(const key of ['appliedReceipts','compensations','evidence']){history[key]||={};if(!plain(history[key]))throw invalid();}
 putOwn(history.appliedReceipts,plan.targetOperationId,structuredClone(plan.applyReceipt));putOwn(history.evidence,plan.targetOperationId,{apply:structuredClone(oldProvenance?.evidence||null),compensation:structuredClone(evidence)});
 next.state.audit.unshift({id:++sequence,occurredAt,actor,role:'SYSTEM',requestId:operationId,action:'SOURCE_REFRESH_COMPENSATED',subject:plan.targetOperationId,detail:'Source refresh compensated; original audits, receipts and evidence retained.',before:{sourceHash:plan.applyReceipt.sourceHash,receiptHash:plan.targetReceiptHash},after:{sourceHash:next.sourceSha256??null,summary:structuredClone(plan.summary),beforeBackupSha256:plan.beforeStateSha256},...maintenanceAuditMetadata(actor,auditRuntime)});next.state.auditSequence=sequence;
 const receipt={version:1,kind:'SOURCE_REFRESH_COMPENSATION',inputHash:plan.inputHash,planHash:plan.planHash,targetOperationId:plan.targetOperationId,targetReceiptHash:plan.targetReceiptHash,appliedStateSha256:plan.appliedStateSha256,beforeStateSha256:plan.beforeStateSha256,sourceHash:next.sourceSha256??null,operationId,actor,occurredAt,summary:structuredClone(plan.summary),compensatedEnvelopeHash:sourceJsonHash(next)};receipt.receiptHash=sourceJsonHash(receipt);putOwn(history.compensations,plan.targetOperationId,receipt);return {envelope:next,receipt,changed:true};
}
