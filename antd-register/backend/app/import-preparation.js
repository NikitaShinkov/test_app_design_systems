import {createHash} from 'node:crypto';
import {inspectImportWorkbook,parseWorkflowWorkbook,WorkflowFileError} from './workbook.js';
import {prepareImportBatch,checkBatchRevision,batchSummary} from './import-staging.js';

export function parsedImport(moduleId,input,filename,options,artifact,context) {
  const data={moduleId,filename,artifactId:artifact.artifactId,sourceHash:createHash('sha256').update(input).digest('hex'),options,scope:[{orderNo:context.orders?.[0]||options.orderNo||'Unassigned',supplier:context.organization||options.supplier||''}]};
  try {data.inspection=inspectImportWorkbook(input,moduleId);const parsed=parseWorkflowWorkbook(moduleId,input,filename,options);data.rows=parsed.rows;data.findings=parsed.findings;}
  catch(error){if(!(error instanceof WorkflowFileError)&&!error.status)throw error;data.error={code:error.code||'IMPORT_PARSE_ERROR',message:error.message,details:error.details||[]};}
  return data;
}

export function checkImportRefresh(previous,revision) {
  if(!previous)return;
  checkBatchRevision(previous,revision);
  if(previous.status==='COMMITTED')throw Object.assign(new Error('A committed import cannot be changed. Upload a new file for another round.'),{status:409,code:'IMPORT_ALREADY_COMMITTED'});
}

export async function prepareImportInWorker(snapshot,data,context,jobId) {
  const {MemoryStorage}=await import('./storage.js');
  const memory=new MemoryStorage({trackDecisionEvents:false});
  Object.assign(memory.state,snapshot.state);memory.importReceipts=new Map(snapshot.receipts);memory.proposalSequenceFloor=snapshot.proposalSequenceFloor||0;memory.proposalAllocationSnapshot=structuredClone(snapshot.proposalAllocationSnapshot??null);
  const batch=await prepareImportBatch(memory,data,context,snapshot.previous);
  if(!snapshot.previous)batch.batchId=jobId;
  batch.preparedByJobId=jobId;
  return batch;
}

export function importPreparationResult(batch,jobId) {
  const version=batch.preparedByJobId===jobId?batch:batch.history?.find(row=>row.preparedByJobId===jobId);
  return version?{kind:'IMPORT',preparationId:jobId,batchId:batch.batchId,revision:version.revision,status:version.status}:null;
}

export function importReviewAudit(batch,previous=null) {
  return ['IMPORT_REVIEW_SAVED',batch.batchId,`${batch.moduleId}: ${batch.status}; revision ${batch.revision}`,previous?batchSummary(previous):null,batchSummary(batch)];
}
