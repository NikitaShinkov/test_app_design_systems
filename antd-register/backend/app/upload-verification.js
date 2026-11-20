import {scanWithClamAV} from './artifacts.js';
import {httpError} from './auth.js';

const lease=signal=>{if(signal?.aborted)throw httpError(409,'Preparation lease lost.',{code:'PREPARATION_LEASE_LOST'});};
const quarantine=(item,infected=false)=>httpError(423,infected?'The M01 source file has an infection finding. Ask an administrator to verify it before retrying.':'The M01 source file could not be verified. Retry when the antivirus service is available.',{code:'FILE_QUARANTINED',details:[`File: ${item.filename}; archive ID: ${item.artifactId}; status: ${item.scanStatus}. No register rows, issued files or export numbers were changed.`]});
const matches=(job,item)=>item&&job.descriptor.moduleId==='M01'&&job.descriptor.kind!=='IMPORT'&&item.kind==='WORKFLOW_INPUT'&&item.moduleId==='M01'&&item.sha256===job.descriptor.input?.sha256&&item.bytes===job.descriptor.input?.bytes;

export async function checkUploadRetry(job,context,artifacts,client=null){
  if(job.descriptor.moduleId!=='M01'||job.descriptor.kind==='IMPORT')return;
  const item=await artifacts.get(job.descriptor.input?.artifactId,context);
  if(!matches(job,item))throw httpError(409,'The retained M01 source identity changed. Select the original workbook again.',{code:'M01_SOURCE_CHANGED'});
  if(item.scanStatus==='INFECTED'||await artifacts.infectedContent(item.sha256,client||artifacts.pool))throw quarantine(item,true);
}

// An export worker receives exact retained bytes only after its current lease,
// account and scan publication are checked together. Already-clean legacy jobs
// are rescanned; they do not get an implicit trusted-input exemption.
export async function verifyQueuedUpload(job,{artifacts,preparations,context,control,currentContext,scanner=scanWithClamAV}){
  let archived=await artifacts.get(job.descriptor.input?.artifactId,context);
  if(!matches(job,archived))throw httpError(409,'The retained M01 source identity changed. Select the original workbook again.',{code:'M01_SOURCE_CHANGED'});
  if(archived.scanStatus==='INFECTED'||await artifacts.infectedContent(archived.sha256))throw quarantine(archived,true);
  lease(control.signal);await control.progress('Checking M01 source workbook for viruses');
  const bytes=await artifacts.read(archived,{internal:true});lease(control.signal);
  const scan=await scanner(bytes,{signal:control.signal});lease(control.signal);
  archived=await preparations.checkpoint(job,async client=>{const current=await currentContext(job,client);lease(control.signal);return artifacts.publishUploadScan(archived,scan,current,{transaction:client,preparationId:job.jobId});});
  if(scan.status!=='CLEAN'&&!(artifacts.preview&&scan.status==='ERROR'))throw quarantine(archived,scan.status==='INFECTED');
  lease(control.signal);return {archived,input:await artifacts.read(archived)};
}
