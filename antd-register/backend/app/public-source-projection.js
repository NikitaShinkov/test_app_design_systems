// JSON transport only. Storage, fingerprints and exchange generators retain
// their complete captured rows; ordinary public rows have a finite DTO.
export const publicBusinessRowFields=Object.freeze(('recordType recordId proposalId orderNo supplier product productDecimalNo productCode position origCode origMfr origPn componentStatus altMfr altPn decisionStatus productionOrder responsible decisionReference decisionDate decisionComment notes sourceSheet sourceRow rowVersion round supplierReply supplierComment manufacturerRelationship clientDecision clientReplyRaw clientDecisionExportText clientComment historicalStatus historicalReference historicalDate workflowStatus canRecord archived normalizationVersion productDecimalNorm orderNorm origMfrNorm origPnNorm altMfrNorm altPnNorm pairKey productPairKey statusKey recordKey duplicateCheck approvedStatusKey rejectedStatusKey decisionClass hasHistoricalApproval currentOrderDatabaseStatus canRecordLabel').split(' '));
const own=(value,key)=>Object.hasOwn(value,key);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const scalar=value=>value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value:'';
const filename=value=>typeof value==='string'?value.replaceAll('\\','/').split('/').at(-1).replaceAll('\0',''):'';
const rowSignals=['origPn','origMfr','altPn','altMfr','clientDecision','decisionStatus','workflowStatus'];
// Event, scope, snapshot and selection wrappers also carry proposalId. An ID
// alone never makes those envelopes a business row.
const capturedRow=value=>['rawSource','raw_source_json','normalizedSource','sourceProvenance'].some(key=>own(value,key));
const businessRow=value=>object(value)&&(rowSignals.some(key=>own(value,key))||capturedRow(value))&&(
  own(value,'orderNo')&&own(value,'productDecimalNo')||capturedRow(value)&&(own(value,'proposalId')||own(value,'recordId')));

export function publicBusinessRow(value){
  if(!object(value))return value;
  const result=Object.fromEntries(publicBusinessRowFields.filter(key=>own(value,key)&&scalar(value[key])).map(key=>[key,value[key]]));
  if(object(value.selectionKey))result.selectionKey=Object.fromEntries(['kind','id','version','fingerprint'].filter(key=>own(value.selectionKey,key)&&scalar(value.selectionKey[key])).map(key=>[key,value.selectionKey[key]]));
  return result;
}

/** Source identity is public; local paths, receipts and backup objects are not. */
export function publicSourceInfo(value){
  const source=object(value)?value:{},result={sourceFile:filename(source.sourceFile),sourceSha256:hash(source.sourceSha256)};
  if(own(source,'bundledSourceSha256'))result.bundledSourceSha256=hash(source.bundledSourceSha256);
  for(const key of ['sourceModified','extractedAt'])if(typeof source[key]==='string'&&source[key].length<=64&&Number.isFinite(Date.parse(source[key])))result[key]=source[key];
  for(const key of ['checkRecordCount','databaseRecordCount'])if(Number.isSafeInteger(source[key])&&source[key]>=0)result[key]=source[key];
  for(const [key,allowed]of Object.entries({sourceState:['UNKNOWN','CURRENT_HASH','PREVIOUS_HASH'],provenanceKind:['ADOPTION_RECEIPT_RECORDED','LOADED_ENVELOPE_CLAIM'],persistenceState:['RELOAD_REQUIRED']}))if(allowed.includes(source[key]))result[key]=source[key];
  return result;
}

/** Called at the final HTTP JSON boundary, including error.current, histories,
 * dashboard and final-approval rows. Uploaded inspection cells are not records:
 * their native cell arrays, headers, findings and formatting remain intact. */
export function publicJsonResponse(value,{administratorRecordDetail=false,previewReviewState=false}={}){
  if(previewReviewState)return value; // Guarded preview ADMIN-only QA endpoint.
  if(administratorRecordDetail&&object(value)){
    const record=publicBusinessRow(value);
    // This is solely the separately authorized, curated record-detail reader's
    // result, never a flag accepted from an HTTP request or a persisted row.
    if(own(value,'recordDetail'))record.recordDetail=value.recordDetail;
    return record;
  }
  const visit=item=>{
    if(item===null||typeof item!=='object')return item;
    if(item instanceof Date)return item.toJSON();
    if(Array.isArray(item))return item.map(visit);
    if(businessRow(item))return publicBusinessRow(item);
    if(own(item,'sourceFile')&&(own(item,'sourceSha256')||own(item,'sourcePath')))return publicSourceInfo(item);
    return Object.fromEntries(Object.entries(item).map(([key,child])=>[key,visit(child)]));
  };
  return visit(value);
}
