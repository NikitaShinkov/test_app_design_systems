import {scanWithClamAV} from './artifacts.js';
import {httpError} from './auth.js';

const lease=signal=>{if(signal?.aborted)throw httpError(409,'Preparation lease lost.',{code:'PREPARATION_LEASE_LOST'});};
const quarantine=(item,infected=false)=>httpError(423,infected?'The import file has an infection finding. Ask an administrator to verify it before retrying.':'The import file could not be verified. Retry when the antivirus service is available.',{code:'FILE_QUARANTINED',details:[`File: ${item.filename}; archive ID: ${item.artifactId}; status: ${item.scanStatus}. No register rows were changed.`]});
export async function checkImportRetry(job,context,artifacts,client=null){
  if(job.descriptor.kind!=='IMPORT')return;
  const item=await artifacts.get(job.descriptor.input.artifactId,context);
  if(item.scanStatus==='INFECTED'||await artifacts.infectedContent(item.sha256,client||artifacts.pool))throw quarantine(item,true);
}
export async function verifyQueuedImport(job,{artifacts,preparations,context,control,currentContext,scanner=scanWithClamAV}){
  let archived=await artifacts.get(job.descriptor.input.artifactId,context);
  if(archived.sha256!==job.descriptor.input.sha256||archived.bytes!==job.descriptor.input.bytes||archived.moduleId!==job.descriptor.moduleId||archived.kind!=='WORKFLOW_INPUT')throw httpError(409,'The retained import input identity changed.',{code:'IMPORT_SOURCE_CHANGED'});
  if(archived.scanStatus==='INFECTED'||await artifacts.infectedContent(archived.sha256))throw quarantine(archived,true);
  lease(control.signal);
  await control.progress('Checking workbook for viruses');
  const bytes=await artifacts.read(archived,{internal:true});lease(control.signal);
  const scan=await scanner(bytes,{signal:control.signal});lease(control.signal);
  archived=await preparations.checkpoint(job,async client=>{const current=await currentContext(job,client);lease(control.signal);return artifacts.publishImportScan(archived,scan,current,{transaction:client,preparationId:job.jobId});});
  if(scan.status!=='CLEAN'&&!(artifacts.preview&&scan.status==='ERROR'))throw quarantine(archived,scan.status==='INFECTED');
  lease(control.signal);return {archived,input:await artifacts.read(archived)};
}
