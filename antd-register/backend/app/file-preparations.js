import {scanWithClamAV} from './artifacts.js';
import {httpError} from './auth.js';

export const filePreparationKinds=new Set(['INSPECT','REGISTER_BOM','ATTACHMENT','RESCAN']);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const lease=signal=>{if(signal?.aborted)throw httpError(409,'Preparation lease lost.',{code:'PREPARATION_LEASE_LOST'});};
export function filePreparationAllowed(descriptor,context){
  if(!filePreparationKinds.has(descriptor?.kind))return false;
  if(descriptor.kind==='ATTACHMENT')return descriptor.moduleId===null&&['ADMINISTRATOR','SUPPLIER','CLIENT'].includes(context.role);
  return context.role==='ADMINISTRATOR'&&(descriptor.kind==='RESCAN'?descriptor.moduleId===null:descriptor.moduleId==='M01');
}
export function filePreparationInputMatches(descriptor,item){
  if(!item||item.artifactId!==descriptor.input?.artifactId||item.sha256!==descriptor.input?.sha256||item.bytes!==descriptor.input?.bytes)return false;
  if(['INSPECT','REGISTER_BOM'].includes(descriptor.kind))return item.kind==='WORKFLOW_INPUT'&&item.moduleId==='M01';
  if(descriptor.kind==='ATTACHMENT')return item.kind==='ATTACHMENT'&&!item.moduleId&&item.scope?.proposalIds?.includes(descriptor.proposalId);
  return descriptor.kind==='RESCAN';
}
export function validateFilePreparationDescriptor(descriptor,context,item){
  if(!filePreparationAllowed(descriptor,context))throw httpError(403,'This file preparation is unavailable for your role.');
  if(!uuid(descriptor.input?.artifactId)||!/^[a-f0-9]{64}$/.test(descriptor.input?.sha256||'')||!Number.isSafeInteger(descriptor.input?.bytes)||descriptor.input.bytes<1)throw httpError(422,'A file preparation requires the exact retained input identity.');
  if(descriptor.kind==='ATTACHMENT'&&(typeof descriptor.proposalId!=='string'||!descriptor.proposalId))throw httpError(422,'An attachment preparation must identify its proposal.');
  if(!filePreparationInputMatches(descriptor,item))throw httpError(409,'The retained file does not match this preparation.',{code:'FILE_SOURCE_CHANGED'});
}
export function filePreparationResultMatches(job,result){
  const descriptor=job.descriptor;
  if(!result||result.kind!==descriptor.kind||result.preparationId!==job.jobId)return false;
  if(descriptor.kind==='INSPECT')return result.artifactId===descriptor.input.artifactId&&result.sourceArtifactId===descriptor.input.artifactId&&result.sha256===descriptor.input.sha256&&typeof result.filename==='string'&&result.filename.length>0&&typeof result.contentType==='string'&&result.inspection!==null&&typeof result.inspection==='object'&&!Array.isArray(result.inspection);
  const artifact=result.artifact;
  if(!artifact||!uuid(artifact.artifactId)||artifact.artifactId!==result.artifactId||artifact.sha256!==descriptor.input.sha256||artifact.bytes!==descriptor.input.bytes)return false;
  if(descriptor.kind==='REGISTER_BOM')return result.sourceArtifactId===descriptor.input.artifactId&&artifact.kind==='ORIGINAL_BOM'&&artifact.moduleId==='M01';
  return artifact.artifactId===descriptor.input.artifactId&&(descriptor.kind==='RESCAN'||artifact.kind==='ATTACHMENT'&&!artifact.moduleId&&['CLEAN','ERROR'].includes(artifact.scanStatus)&&artifact.scope?.proposalIds?.includes(descriptor.proposalId));
}
export const filePreparationProgress=kind=>({INSPECT:'Source inspection completed',REGISTER_BOM:'Original BOM registered',ATTACHMENT:'Attachment verification completed',RESCAN:'File verification completed'})[kind];
const quarantine=item=>httpError(423,item.scanStatus==='INFECTED'?'The retained file has an infection finding. Ask an administrator to verify it before retrying.':'The retained file could not be verified. Retry when the antivirus service is available.',{code:'FILE_QUARANTINED',details:[`File: ${item.filename}; archive ID: ${item.artifactId}; status: ${item.scanStatus}. No register rows or issued exports were changed.`]});

export async function checkFilePreparationRetry(job,context,artifacts,client=null){
  if(!filePreparationKinds.has(job.descriptor.kind))return;
  const item=await artifacts.get(job.descriptor.input.artifactId,context);validateFilePreparationDescriptor(job.descriptor,context,item);
  if(job.descriptor.kind!=='RESCAN'&&(item.scanStatus==='INFECTED'||await artifacts.infectedContent(item.sha256,client||artifacts.pool)))throw quarantine(item);
}

export async function verifyFilePreparation(job,{artifacts,preparations,context,control,currentContext,scanner=scanWithClamAV}){
  lease(control.signal);const current=await currentContext(job),capture=await artifacts.captureFileScan(job.descriptor.input.artifactId,current);validateFilePreparationDescriptor(job.descriptor,current,capture.item);
  if(job.descriptor.kind==='RESCAN'&&capture.item.scanStatus==='GENERATED')return {archived:capture.item,input:null};
  if(job.descriptor.kind!=='RESCAN'&&(capture.item.scanStatus==='INFECTED'||await artifacts.infectedContent(capture.item.sha256)))throw quarantine(capture.item);
  await control.progress(job.descriptor.kind==='RESCAN'?'Checking retained file for viruses':'Checking uploaded file for viruses');lease(control.signal);
  const bytes=await artifacts.read(capture.item,{internal:true});lease(control.signal);const scan=await scanner(bytes,{signal:control.signal});lease(control.signal);
  const archived=await preparations.checkpoint(job,async client=>{const account=await currentContext(job,client);lease(control.signal);validateFilePreparationDescriptor(job.descriptor,account,capture.item);return artifacts.publishFileScan(capture,scan,account,{transaction:client,preparationId:job.jobId,administrative:job.descriptor.kind==='RESCAN'});});
  if(job.descriptor.kind==='RESCAN')return {archived,input:null};
  if(archived.scanStatus!=='CLEAN'&&!(artifacts.preview&&archived.scanStatus==='ERROR'))throw quarantine(archived);
  lease(control.signal);return {archived,input:await artifacts.read(archived)};
}
