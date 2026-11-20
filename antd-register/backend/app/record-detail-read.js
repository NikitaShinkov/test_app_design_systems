import {httpError} from './auth.js';
import {publishNamedRead} from './named-read.js';
import {validBusinessDate} from './validation.js';
import {sourceJsonHash,verifiedRefreshReceipt} from './source-refresh.js';

// A public business projection, deliberately separate from ordinary ledger DTOs.
// Never spread SQL rows, account/session context or arbitrary payload metadata.
export const recordDetailBusinessFields=Object.freeze(('recordType recordId proposalId orderNo supplier product productDecimalNo productCode position origCode origMfr origPn componentStatus altMfr altPn decisionStatus productionOrder responsible decisionReference decisionDate decisionComment notes sourceSheet sourceRow rowVersion round supplierReply supplierComment manufacturerRelationship clientDecision clientReplyRaw clientDecisionExportText clientComment historicalStatus historicalReference historicalDate workflowStatus canRecord archived normalizationVersion productDecimalNorm orderNorm origMfrNorm origPnNorm altMfrNorm altPnNorm pairKey productPairKey statusKey recordKey duplicateCheck approvedStatusKey rejectedStatusKey decisionClass hasHistoricalApproval currentOrderDatabaseStatus canRecordLabel').split(' '));
export const recordDetailNormalizedFields=Object.freeze(('normalizationVersion productDecimalNorm orderNorm origMfrNorm origPnNorm altMfrNorm altPnNorm pairKey productPairKey statusKey recordKey duplicateCheck approvedStatusKey rejectedStatusKey decisionClass clientReplyRaw clientDecisionExportText hasHistoricalApproval currentOrderDatabaseStatus canRecordLabel').split(' '));
export const recordDetailSourceHeaders=Object.freeze(('Proposal_ID Order_No Supplier Product Product_Decimal_No Product_1C_Code Production_Order Position Orig_Code Orig_Mfr Orig_PN Component_Status Alt_Mfr Alt_PN Decision_Status Responsible Decision_Reference Decision_Date Decision_Comment Notes Product_Decimal_Norm Order_Norm Orig_Mfr_Norm Orig_PN_Norm Alt_Mfr_Norm Alt_PN_Norm Pair_Key Product_Pair_Key Status_Key Record_Key Duplicate_Check Supplier_Reply Supplier_Comment Manufacturer_Relationship Client_Decision Client_Comment Historical_Status Historical_Reference Historical_Date Workflow_Status Can_Record Approved_Status_Key Rejected_Status_Key Round Client_Reply_Raw').split(' '));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const scalar=value=>value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);
const own=(value,key)=>Object.hasOwn(value,key);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value:null;
const timestamp=value=>value instanceof Date&&!Number.isNaN(value.valueOf())?value.toISOString():typeof value==='string'&&/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&validBusinessDate(value.slice(0,10))&&Number.isFinite(Date.parse(value))?value:null;
const projection=(value,fields)=>plain(value)?Object.fromEntries(fields.filter(key=>own(value,key)&&scalar(value[key])).map(key=>[key,value[key]])):{};
export function assertRecordDetailAdministrator(context){if(context?.role!=='ADMINISTRATOR')throw httpError(403,'Administrator access is required for full record details.',{code:'RECORD_DETAIL_FORBIDDEN'});}
const cellFields=new Set('error type value formula result text richText font bold italic underline color argb indexed family size vertAlign scheme strike outline shadow name'.split(' '));
function cell(value,summary){
  if(scalar(value))return value;
  // Excel error/formula/rich-text cell representations are literal evidence.
  if(Array.isArray(value))return value.map(item=>cell(item,summary));
  if(plain(value))return Object.fromEntries(Object.keys(value).filter(key=>{if(cellFields.has(key))return true;summary.omitted++;return false;}).map(key=>[key,cell(value[key],summary)]));
  summary.omitted++;
  return null;
}
function sourceCells(value){
  if(!plain(value))return {values:null,omitted:0};
  const allowed=new Set([...recordDetailSourceHeaders,...recordDetailBusinessFields]),summary={omitted:0};
  const values=Object.fromEntries(Object.keys(value).filter(key=>{if(allowed.has(key))return true;summary.omitted++;return false;}).map(key=>[key,cell(value[key],summary)]));
  return {values,omitted:summary.omitted};
}
export const recordDetailSourceCells=value=>sourceCells(value).values;
function detail(row,{storageKind,provenance={},sourceVersion=null,correlationStatus='UNRECORDED'}={}){
  if(!row)return null;
  const record=projection(row,recordDetailBusinessFields);
  record.recordType=row.recordType==='LIFECYCLE'||row.decisionStatus==='OBSOLETE'?'LIFECYCLE':'REPLACEMENT';
  const sourceHash=hash(provenance.sourceWorkbookHash);
  const raw=sourceCells(row.rawSource),normalized=plain(row.normalizedSource)?projection(row.normalizedSource,recordDetailNormalizedFields):null;
  const omittedBusinessFields=Object.keys(row).filter(key=>!recordDetailBusinessFields.includes(key)&&!['rawSource','normalizedSource'].includes(key)).length;
  return {...record,recordDetail:{version:1,storageKind,provenance:{...provenance,sourceWorkbookHash:sourceHash},
    rawSource:raw.values,rawSourceOmittedFields:raw.omitted,normalizedSource:normalized,normalizedSourceOmittedFields:normalized?Object.keys(row.normalizedSource).length-Object.keys(normalized).length:0,omittedBusinessFields,
    sourceCorrelation:{status:correlationStatus,recordId:record.recordId,rowVersion:record.rowVersion??null,sourceHash},sourceVersion}};
}
const sameHash=(left,right)=>Boolean(hash(left)&&hash(right)&&left.toLowerCase()===right.toLowerCase());
function localCapture(row,sourceContext){
  const metadata=sourceContext?.sourceProvenance;
  if(!row||row.recordType==='LIFECYCLE'||!plain(metadata)||!plain(metadata.bindings))return {};
  // Current business fields may have been edited after adoption. Resolve the
  // saved target binding without recalculating an identity from those edits.
  const bindings=Object.entries(metadata.bindings).filter(([key,value])=>key.startsWith('replacement:')&&plain(value)&&value.targetId===row.recordId);
  if(!bindings.length)return {};
  const unverified={provenance:{captureMeaning:'LATEST_ADOPTED_SOURCE_CAPTURE',verification:'UNVERIFIED_RECORDED_METADATA'},correlationStatus:'CAPTURE_METADATA_UNVERIFIED'};
  if(bindings.length!==1)return unverified;
  const [key,binding]=bindings[0],loaded=sourceContext.loadedSourceHash;
  try{
    const validRow=binding.sourceRow===null||Number.isSafeInteger(binding.sourceRow)&&binding.sourceRow>=0;
    if(metadata.version!==1||!/^replacement:[a-f0-9]{64}$/i.test(key)||!sameHash(loaded,metadata.adoptedSourceHash)||!sameHash(loaded,binding.sourceHash)||!plain(row.rawSource)||!sameHash(binding.rawHash,sourceJsonHash(row.rawSource))||typeof binding.sourceSheet!=='string'||!binding.sourceSheet||binding.sourceSheet!==row.sourceSheet||!validRow||binding.sourceRow!==row.sourceRow||!plain(metadata.receipts))return unverified;
    const receiptRecorded=Object.entries(metadata.receipts).some(([inputHash,receipt])=>{
      try{
        verifiedRefreshReceipt(receipt);
        return sameHash(inputHash,receipt.inputHash)&&sameHash(receipt.sourceHash,loaded)&&Boolean(hash(receipt.planHash)&&hash(receipt.baselineHash))&&typeof receipt.operationId==='string'&&Boolean(receipt.operationId)&&typeof receipt.actor==='string'&&Boolean(receipt.actor.trim())&&Boolean(timestamp(receipt.occurredAt))&&plain(receipt.summary)&&Number.isSafeInteger(receipt.summary.rows)&&receipt.summary.rows>0;
      }catch{return false;}
    });
    if(!receiptRecorded)return unverified;
    // This checks retained metadata against the loaded cells. It does not read
    // a source workbook, immutable capture file or backup, or establish the
    // original decision's origin. Never expose their private paths here.
    return {provenance:{sourceWorkbookHash:binding.sourceHash,sourceSheet:binding.sourceSheet,sourceRow:binding.sourceRow,captureMeaning:'LATEST_ADOPTED_SOURCE_CAPTURE',verification:'RECORDED_METADATA_SELF_CONSISTENCY'},correlationStatus:'RECORDED_CAPTURE_CONSISTENT'};
  }catch{return unverified;}
}
export function captureMemoryRecordDetail(row,context,sourceContext){assertRecordDetailAdministrator(context);return detail(row,{storageKind:'local',...localCapture(row,sourceContext)});}

export async function captureSqlRecordDetail({pool,id,context,toReplacement,toLifecycle}){
  assertRecordDetailAdministrator(context);
  const client=await pool.connect();
  try{
    await client.query('begin isolation level repeatable read read only');
    const lifecycle=id.startsWith('LC-'),table=lifecycle?'lifecycle_records':'replacement_records';
    const stored=(await client.query(`select * from replacement_register.${table} where record_id=$1`,[id])).rows[0];
    if(!stored){await client.query('commit');return null;}
    const row=lifecycle?toLifecycle(stored):toReplacement(stored),sourceHash=hash(stored.source_workbook_hash);
    const provenance={sourceWorkbookHash:sourceHash,createdAt:timestamp(stored.created_at),updatedAt:timestamp(stored.updated_at),...(!lifecycle?{ledgerPosition:stored.ledger_position==null?null:String(stored.ledger_position)}:{}),...(sourceHash?{captureMeaning:'LATEST_ADOPTED_SOURCE_CAPTURE'}:{})};
    let sourceVersion=null,correlationStatus=sourceHash?'NO_MATCH':'UNRECORDED';
    if(!lifecycle&&sourceHash){
      // Match the row's current capture pointer and bound identity, rather than
      // a later binding hash. Reconciliation may advance this pointer to an
      // adopted capture; it does not prove the original decision's origin.
      const version=(await client.query(`select v.source_hash,v.source_sheet,v.source_row,v.source_json,v.raw_json,v.created_at
        from replacement_register.source_bindings b join replacement_register.source_versions v
        on v.entity_kind=b.entity_kind and v.source_identity=b.source_identity and v.source_hash=$2
        where b.entity_kind='replacement' and b.target_id=$1`,[id,sourceHash])).rows[0];
      if(version){const raw=sourceCells(version.raw_json);provenance.verification='LINKED_STORED_VERSION';sourceVersion={sourceHash:version.source_hash,sourceSheet:version.source_sheet,sourceRow:version.source_row,capturedAt:timestamp(version.created_at),
        values:projection(version.source_json,recordDetailBusinessFields),rawSource:raw.values,rawSourceOmittedFields:raw.omitted};correlationStatus='MATCHED';}
    }
    const result=detail({...row,rawSource:lifecycle?row.rawSource:stored.raw_source_json,normalizedSource:lifecycle?null:stored.normalized_json},{storageKind:'postgres',provenance,sourceVersion,correlationStatus});
    await client.query('commit');return result;
  }catch(error){await client.query('rollback').catch(()=>{});throw error;}
  finally{client.release();}
}

export async function readAdministratorRecordDetail(storage,id,context){
  assertRecordDetailAdministrator(context);
  return publishNamedRead(storage.rawPool||storage.pool,context,()=>storage.captureReplacementDetail(id,context),{code:'RECORD_DETAIL_ACCESS_CHANGED'});
}
