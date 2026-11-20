import {auditBasisForWriter,bindAuditContext,copyAuditContext,createAcceptedInitiator,identityFromTrustedContext,inspectStoredInitiator,maintenanceIdentity,serializeAcceptedInitiator} from './audit-provenance.js';

const labels={PREPARATION:'Preparation worker',BUSINESS_COMMAND:'Business command worker'};
export const queueJobReference=(job,kind)=>({id:kind==='PREPARATION'?job.jobId:job.commandId,kind});
const ownerOf=(job,kind)=>kind==='PREPARATION'?job.descriptor.owner:job.owner;
export function captureQueueInitiator(context,job,kind,auditRuntime=null){
  const basis=auditBasisForWriter(context);
  if(!basis?.eventRequest){
    if(auditRuntime&&(context?.requestId||context?.authenticated===true))throw Object.assign(new Error('Audit request provenance is unavailable. Retry the request before saving.'),{code:'AUDIT_PROVENANCE_CONTEXT_MISSING',status:500});
    return null;
  }
  return serializeAcceptedInitiator(createAcceptedInitiator({identity:identityFromTrustedContext(context),request:basis.eventRequest,job:queueJobReference(job,kind)}));
}
export function inspectQueueInitiator(job,kind){
  const read=inspectStoredInitiator(job.initiatorProvenance??null),ref=queueJobReference(job,kind);
  // An otherwise valid envelope for a different job is also corrupt storage.
  return read.status==='VALID'&&(read.value.job.id!==ref.id||read.value.job.kind!==ref.kind)?inspectStoredInitiator('null'):read;
}
const systemContext=kind=>({authenticated:false,userId:null,role:'SYSTEM',actor:labels[kind]});
const legacyIdentity=(job,kind)=>{try{return identityFromTrustedContext(ownerOf(job,kind));}catch{return undefined;}};
export function queueEventContext(context,job,kind,phase,auditRuntime){
  if(!auditRuntime)return copyAuditContext(context,{...context});
  const origin=inspectQueueInitiator(job,kind);
  if(origin.status==='INVALID')throw queueOriginRefusalError();
  const jobRef=queueJobReference(job,kind),basis=auditBasisForWriter(context);
  if(phase==='QUEUE'&&origin.status==='VALID')return bindAuditContext({...context},auditRuntime.queued({initiator:origin.value}));
  if(phase==='CONTROL'&&basis?.eventRequest)return bindAuditContext({...context},auditRuntime.control({actor:identityFromTrustedContext(context),request:basis.eventRequest,job:jobRef,attempt:job.attempts,origin,legacyOwner:legacyIdentity(job,kind)}));
  if(phase==='WORKER')return queueWorkerContext(context,job,kind,auditRuntime);
  const internal=systemContext(kind);
  return bindAuditContext(internal,auditRuntime.maintenance({actor:maintenanceIdentity(internal.actor)}));
}
export function queueWorkerContext(context,job,kind,auditRuntime){
  if(!auditRuntime)return copyAuditContext(context,{...context});
  const origin=inspectQueueInitiator(job,kind);
  if(origin.status==='INVALID')throw queueOriginRefusalError();
  const actor=context.role==='SYSTEM'?maintenanceIdentity(context.actor):identityFromTrustedContext(context);
  return bindAuditContext({...context},auditRuntime.worker({actor,job:queueJobReference(job,kind),attempt:job.attempts,origin,legacyOwner:legacyIdentity(job,kind)}));
}
export const queueInternalContext=(job,kind,auditRuntime)=>queueWorkerContext(systemContext(kind),job,kind,auditRuntime);
export function queueOriginRefusalError(){return Object.assign(new Error('Stored queue audit provenance failed validation. Operator review is required.'),{status:503,code:'AUDIT_PROVENANCE_INVALID',retryable:false,stopClaimLoop:true,requiresOperatorReview:true});}
export function queueRefusalStatus(job,kind){return Object.freeze({code:'AUDIT_PROVENANCE_INVALID',job: Object.freeze(queueJobReference(job,kind)),attempt:job.attempts,retryable:false,stopClaimLoop:true,requiresOperatorReview:true});}
export function queueRefusalContext(job,kind,auditRuntime){
  const context=systemContext(kind);
  if(!auditRuntime)return context;
  const refusal=auditRuntime.corruptOriginRefusal({origin:inspectQueueInitiator(job,kind),job:queueJobReference(job,kind),attempt:job.attempts,actor:maintenanceIdentity(context.actor)});
  return bindAuditContext(context,refusal.auditEnvelope);
}
