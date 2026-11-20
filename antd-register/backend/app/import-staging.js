import {createHash,randomUUID} from 'node:crypto';
import {canAccess,httpError} from './auth.js';
import {canUseModule,moduleFor} from './workflow.js';
import {currentReferenceContext} from './normalization.js';
import {M04_METADATA_VERSION} from './m04-metadata.js';
import {IMPORT_SOURCE_VERSION} from './import-source.js';
import {skippedSheetCount,importReceiptResult,importIgnoredCount} from './import-results.js';
import {captureProposalAllocationSnapshot,proposalAllocationFingerprint} from './proposal-id-allocation.js';
import {copyAuditContext} from './audit-provenance.js';

function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])]));
  return value;
}
const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const reviewFields=new Set(['orderNo','supplier','product','productCode','productDecimalNo','productionOrder','position','origCode','origMfr','origPn','altMfr','altPn','supplierReply','supplierComment','componentStatus','manufacturerRelationship','clientDecision','clientReplyRaw','clientDecisionExportText','clientComment','responsible','decisionReference','decisionDate','decisionStatus','decisionComment','historicalStatus','historicalReference','historicalDate','workflowStatus','canRecord','notes']);
export const importInputKey=(sourceHash,options,rows=null)=>hash({sourceHash,...(rows?{rows}:{options})});
function allocationFingerprint(memory,batch,snapshot=null) {
  if(!['M02','M04'].includes(batch.moduleId))return null;
  const allocation=snapshot??captureProposalAllocationSnapshot(memory.state.proposals,structuredClone(memory.proposalAllocationSnapshot??null));
  return proposalAllocationFingerprint(allocation,batch.rows.map(row=>row.orderNo));
}
export function importFingerprint(memory,context,allocation=null) {
  return hash({...(currentReferenceContext()?{referenceHash:currentReferenceContext().hash}:{}),...(allocation?{proposalAllocation:allocation}:{}),proposals:memory.state.proposals.filter(row=>!context.authenticated||canAccess(context,row)).sort((a,b)=>a.proposalId.localeCompare(b.proposalId)),replacements:memory.state.replacements});
}
export function batchAccess(batch,context) {
  if(!batch||!canUseModule(moduleFor(batch.moduleId),context.role))return false;
  if(context.role==='ADMINISTRATOR')return true;
  if(context.authenticated) {
    if(batch.ownerUserId!==context.userId)return false;
    return batch.scope.every(row=>canAccess(context,row));
  }
  return !batch.ownerUserId&&batch.ownerActor===context.actor&&batch.ownerRole===context.role;
}
export function requireBatch(batch,context) {
  if(!batchAccess(batch,context))throw httpError(404,'Import review not found.');
  return batch;
}
export function batchSummary(batch) {
  return {batchId:batch.batchId,moduleId:batch.moduleId,filename:batch.filename,artifactId:batch.artifactId,status:batch.status,revision:batch.revision,createdAt:batch.createdAt,updatedAt:batch.updatedAt,ownerActor:batch.ownerActor,summary:batch.review?.summary,error:batch.error,options:batch.options};
}
export function checkBatchRevision(batch,revision) {
  if(!Number.isSafeInteger(revision)||revision<1)throw httpError(428,'The reviewed import version is required.',{code:'IMPORT_REVIEW_REQUIRED'});
  if(batch.revision!==revision)throw httpError(409,'This import review has changed. Open its latest version before continuing.',{code:'IMPORT_REVIEW_CHANGED'});
}
export async function prepareImportBatch(memory,data,context,previous=null) {
  if(!['M02','M04','M08'].includes(data.moduleId)||!canUseModule(moduleFor(data.moduleId),context.role))throw httpError(403,'This import workflow is unavailable for your role.');
  const now=new Date().toISOString();
  const batch={batchId:previous?.batchId||randomUUID(),moduleId:data.moduleId,filename:data.filename,artifactId:data.artifactId,sourceHash:data.sourceHash,inputKey:importInputKey(data.sourceHash,data.options||{},data.error?null:data.rows||[]),ownerUserId:previous?.ownerUserId||context.userId||null,ownerActor:previous?.ownerActor||context.actor,ownerRole:previous?.ownerRole||context.role,createdAt:previous?.createdAt||now,updatedAt:now,revision:(previous?.revision||0)+1,status:'READY',options:data.options||{},inspection:data.inspection||null,rows:data.rows||[],scope:data.scope||[],error:data.error||null,review:null,history:previous?.history||[]};
  if(data.moduleId==='M04')batch.metadataVersion=M04_METADATA_VERSION;
  batch.sourceVersion=IMPORT_SOURCE_VERSION;
  batch.parseFindings=structuredClone(data.findings||[]);
  if(previous)batch.history=[...batch.history,{revision:previous.revision,status:previous.status,options:previous.options,review:previous.review,error:previous.error,updatedAt:previous.updatedAt,...(previous.preparedByJobId?{preparedByJobId:previous.preparedByJobId}:{})}];
  if(batch.error){batch.status='PARSE_FAILED';return batch;}
  for(const row of batch.rows) {
    if(context.authenticated&&(!canAccess(context,row)||(row.proposalId&&!canAccess(context,memory.state.proposals.find(item=>item.proposalId===row.proposalId))))) {
      batch.error={code:'IMPORT_SCOPE_DENIED',message:`Row ${row.sourceRow||'?'} is outside your assigned orders, supplier or available proposals.`,details:[]};batch.status='PARSE_FAILED';batch.rows=[];return batch;
    }
  }
  batch.scope=batch.rows.map(row=>({orderNo:row.orderNo,supplier:row.supplier}));
  // Numbering shares the complete private ID namespace, including inaccessible
  // and archived rows. Capture once before the review's scope filter/row loop.
  memory.proposalAllocationSnapshot=captureProposalAllocationSnapshot(memory.state.proposals,structuredClone(memory.proposalAllocationSnapshot??null));
  const fingerprint=importFingerprint(memory,context,allocationFingerprint(memory,batch,memory.proposalAllocationSnapshot));
  memory.proposalSequenceFloor=memory.state.proposals.reduce((maximum,item)=>Math.max(maximum,Number(String(item.proposalId).match(/-(\d{1,8})$/)?.[1]||0)),memory.proposalSequenceFloor);
  memory.state.proposals=memory.state.proposals.filter(row=>!context.authenticated||canAccess(context,row));
  memory.state.audit=[];
  const receipt=memory.importReceipts.get(`${batch.moduleId}:${batch.inputKey}:${context.userId||'preview'}`);
  const summary={imported:0,updated:0,skipped:0,skippedSheets:skippedSheetCount(batch.parseFindings),obsoleteRecorded:0,...(batch.moduleId==='M02'&&!receipt?{ignored:0}:{}),findings:structuredClone(batch.parseFindings),duplicate:Boolean(receipt)};
  const rowReviews=[];
  if(receipt)Object.assign(summary,importReceiptResult(receipt,batch.parseFindings));
  else for(const row of batch.rows) {
    const start=memory.state.audit.length;
    const result=await memory.importWorkflowRows(batch.moduleId,[row],copyAuditContext(context,{...context,sourceHash:undefined}),batch.filename);
    for(const field of ['imported','updated','skipped','obsoleteRecorded'])summary[field]+=result[field];
    if(batch.moduleId==='M02')summary.ignored+=importIgnoredCount(result);
    summary.findings.push(...result.findings);
    const changes=memory.state.audit.slice(0,memory.state.audit.length-start).reverse().map(event=>{
      const before=event.before||{};const after=event.after||{};
      const fields=Object.keys({...before,...after}).filter(field=>reviewFields.has(field)&&JSON.stringify(before[field]??'')!==JSON.stringify(after[field]??'')).map(field=>({field,before:before[field]??'',after:after[field]??''}));
      return {subject:event.subject,action:event.action,fields};
    });
    rowReviews.push({sheet:row.sourceSheet,row:row.sourceRow,origPn:row.origPn,altPn:row.altPn,proposalId:row.proposalId||'',disposition:result.skipped?'QUARANTINED':batch.moduleId==='M02'&&importIgnoredCount(result)?'IGNORED':result.imported?'NEW':result.updated?'UPDATE':'UNCHANGED',findings:result.findings,changes});
  }
  batch.review={fingerprint,summary,rows:rowReviews};
  return batch;
}
export function validateImportCommit(batch,body,memory,context) {
  checkBatchRevision(batch,body.revision);
  if(batch.status==='COMMITTED')return;
  if(batch.sourceVersion!==IMPORT_SOURCE_VERSION)throw httpError(409,'Import source rules changed after this review was prepared. Refresh and review the row changes before confirming; no rows were changed.',{code:'IMPORT_DATA_CHANGED'});
  if(batch.moduleId==='M04'&&batch.metadataVersion!==M04_METADATA_VERSION)throw httpError(409,'M04 import rules changed after this review was prepared. Refresh and review the row changes before confirming; no rows were changed.',{code:'IMPORT_DATA_CHANGED'});
  if(batch.status!=='READY')throw httpError(409,'Resolve the import errors and review the workbook before committing.',{code:'IMPORT_NOT_READY'});
  if(batch.review.summary.findings.length&&body.acceptFindings!==true)throw httpError(422,'Review and acknowledge the findings before importing valid rows.',{code:'IMPORT_FINDINGS_ACK_REQUIRED'});
  if(!batch.review.summary.duplicate&&importFingerprint(memory,context,allocationFingerprint(memory,batch))!==batch.review.fingerprint)throw httpError(409,'Register data or reference data changed after this import preview. Refresh the review before committing; no rows were changed.',{code:'IMPORT_DATA_CHANGED'});
  if(!batch.review.summary.duplicate&&!batch.review.summary.imported&&!batch.review.summary.updated&&!batch.review.summary.obsoleteRecorded)throw httpError(422,batch.moduleId==='M02'&&importIgnoredCount(batch.review.summary)>0&&!batch.review.summary.skipped?'This BOM has no replacement proposals; there is nothing to import. Ordinary rows are not errors.':'No valid rows are available to import. Correct the file or its column mapping.',{code:'IMPORT_NO_VALID_ROWS'});
}
