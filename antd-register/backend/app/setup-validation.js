import {cleanText,normalize,originalKey,workflowKey,recordKey,NORMALIZATION_VERSION} from './normalization.js';
import {catalogHash,seedReferenceCatalog,validateCatalog,withCatalog,referenceKinds} from './reference-catalog.js';
import {classifyProposal,createHistoryIndex,recalculateProposal} from './domain.js';
import {validBusinessDate,validateDecision} from './validation.js';
import {verifyAttachmentReferences} from './artifact-integrity.js';
import {archiveReviewColumns} from './archive-review-schema.js';
import {roundManagementColumns} from './round-management-operations.js';
import {businessCommandColumns} from './business-command-operations.js';
import {sourceBomColumns} from './source-bom-operations.js';
import {registerGridColumns} from './register-grid-operations.js';
import {executionCoordinationSchemaColumns} from './execution-coordination-operations.js';
import {workingOrderColumns} from './working-order-operations.js';

// Source contract: Core.bas M90_ValidateSetup, latest approved workbook.
// JSON keys below are derived fields, not physical SQL column names.
const direct=(source,field,column)=>({source,field,column});
const derived=(source,field)=>({source,field,column:'normalized_json',jsonKey:field});
export const setupSourceFields={
  Check:[
    direct('Order_No','orderNo','order_no'),direct('Proposal_ID','proposalId','proposal_id'),direct('Product_Decimal_No','productDecimalNo','product_decimal_no'),direct('Product_1C_Code','productCode','product_code'),direct('Orig_PN','origPn','orig_pn'),direct('Alt_PN','altPn','alt_pn'),direct('Supplier_Reply','supplierReply','supplier_reply'),direct('Supplier_Comment','supplierComment','supplier_comment'),direct('Component_Status','componentStatus','component_status'),direct('Client_Decision','clientDecision','client_decision'),direct('Client_Comment','clientComment','client_comment'),direct('Production_Order','productionOrder','production_order'),direct('Manufacturer_Relationship','manufacturerRelationship','manufacturer_relationship'),direct('Responsible','responsible','responsible'),direct('Decision_Reference','decisionReference','decision_reference'),direct('Decision_Date','decisionDate','decision_date'),direct('Historical_Status','historicalStatus','historical_status'),direct('Historical_Reference','historicalReference','historical_reference'),direct('Historical_Date','historicalDate','historical_date'),direct('Workflow_Status','workflowStatus','workflow_status'),direct('Can_Record','canRecord','can_record'),derived('Product_Decimal_Norm','productDecimalNorm'),derived('Order_Norm','orderNorm'),derived('Orig_Mfr_Norm','origMfrNorm'),derived('Orig_PN_Norm','origPnNorm'),derived('Alt_Mfr_Norm','altMfrNorm'),derived('Alt_PN_Norm','altPnNorm'),derived('Pair_Key','pairKey'),derived('Product_Pair_Key','productPairKey'),derived('Approved_Status_Key','approvedStatusKey'),derived('Rejected_Status_Key','rejectedStatusKey')
  ],
  Database:[direct('Proposal_ID','proposalId','proposal_id'),direct('Product_Decimal_No','productDecimalNo','product_decimal_no'),direct('Product_1C_Code','productCode','product_code'),direct('Orig_PN','origPn','orig_pn'),direct('Alt_PN','altPn','alt_pn'),direct('Component_Status','componentStatus','component_status'),direct('Decision_Status','decisionStatus','decision_status'),direct('Production_Order','productionOrder','production_order'),direct('Responsible','responsible','responsible'),direct('Decision_Reference','decisionReference','decision_reference'),direct('Decision_Date','decisionDate','decision_date'),direct('Decision_Comment','decisionComment','decision_comment')]
};
const text=['text','varchar','bpchar'],integer=['int2','int4','int8'];
const columns=(names,type=text)=>Object.fromEntries(names.split(' ').filter(Boolean).map(name=>[name,type]));
export const setupSchemaRequirements={
  ...executionCoordinationSchemaColumns,
  ...registerGridColumns,
  ...sourceBomColumns,
  ...businessCommandColumns,
  ...roundManagementColumns,
  archive_reviews:archiveReviewColumns,
  proposals:{...workingOrderColumns.proposals,...columns('proposal_id order_no supplier product product_code product_decimal_no production_order position orig_code orig_mfr orig_pn alt_mfr alt_pn supplier_reply supplier_comment component_status manufacturer_relationship client_decision client_comment responsible decision_reference historical_status historical_reference workflow_status normalization_version notes source_sheet approval_round'),...columns('decision_date historical_date',['date']),...columns('can_record archived',['bool']),...columns('row_version source_row',integer),...columns('normalized_json raw_source_json',['jsonb'])},
  replacement_records:{...columns('record_id proposal_id order_no supplier product product_code product_decimal_no position orig_code orig_mfr orig_pn component_status alt_mfr alt_pn decision_status production_order responsible decision_reference decision_comment notes source_sheet'),decision_date:['date'],...columns('row_version ledger_position source_row',integer)},
  lifecycle_records:{...columns('record_id original_key supplier_key order_no supplier'),payload:['jsonb'],row_version:integer,created_at:['timestamptz']},
  reference_catalog:{singleton:['bool'],revision:integer,catalog_hash:text,catalog_json:['jsonb']},
  artifacts:{...columns('logical_key sha256 filename content_type kind module_id owner_actor scan_status scan_detail'),artifact_id:['uuid'],owner_user_id:['uuid'],...columns('version bytes',integer),scope_json:['jsonb'],attachment_json:['jsonb'],owner_only:['bool'],created_at:['timestamptz']}
};

/** Read-only metadata helper; the caller owns its repeatable-read transaction. */
export async function inspectSetupSchema(client){
  const result=await client.query('select table_name as "tableName",column_name as "columnName",udt_name as type from information_schema.columns where table_schema=$1 and table_name=any($2::text[]) order by table_name,ordinal_position',['replacement_register',Object.keys(setupSchemaRequirements)]);
  return {mode:'postgres',columns:result.rows};
}
const schemaColumn=row=>({tableName:row?.tableName??row?.table_name,columnName:row?.columnName??row?.column_name,type:String(row?.type??row?.udt_name??'').toLowerCase()});
export function setupSchemaUsable(schema,tableName){
  if(schema?.mode!=='postgres'||!Array.isArray(schema.columns)||!setupSchemaRequirements[tableName])return false;
  const actual=new Map(schema.columns.map(schemaColumn).filter(row=>row.tableName===tableName).map(row=>[row.columnName,row.type]));
  return Object.entries(setupSchemaRequirements[tableName]).every(([column,types])=>types.includes(actual.get(column)));
}

const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fieldFinding=(section,code,field,message,extra={})=>({section,code,field,message,severity:'ERROR',...extra});
const location=item=>({recordId:item.recordId||item.proposalId,sheet:item.sourceSheet,row:item.sourceRow});
function checkStatus(details){return details.some(item=>item.severity==='ERROR')?'FAILED':details.some(item=>item.severity==='WARNING')?'WARN':'PASSED';}
function addCheck(report,id,details,checked,message,status=checkStatus(details)){
  report.details.push(...details);report.checks.push({id,status,checked,message});
}

/** Recompute after optional filesystem or other adapter checks are appended. */
export function finalizeSetupReport(report){
  const details=(report.details||[]).map(item=>({...item,severity:item.severity||'ERROR'})),checks=report.checks||[];
  const errors=details.filter(item=>item.severity==='ERROR').length,warnings=details.filter(item=>item.severity==='WARNING').length,notChecked=checks.filter(check=>check.status==='NOT_CHECKED').length;
  const status=errors||checks.some(check=>check.status==='FAILED')?'VALIDATION_FAILED':notChecked?'VALIDATION_INCOMPLETE':warnings||checks.some(check=>check.status==='WARN')?'COMPLETED_WITH_FINDINGS':'COMPLETED';
  return {...report,details,checks,findings:details.length,errors,warnings,notChecked,status,message:`M90: ${errors} error(s), ${warnings} warning(s); ${notChecked} check(s) not run. ${status==='COMPLETED'?'All reported checks passed.':status==='VALIDATION_INCOMPLETE'?'Validation is incomplete; inspect the checks not run.':'Review the findings and their suggested actions.'}`};
}

function validateSchema(schema){
  const findings=[];
  if(!schema)return {findings,checked:0,status:'NOT_CHECKED',message:'Storage schema metadata was not captured.'};
  if(schema.mode==='local')return {findings,checked:0,status:'NOT_APPLICABLE',message:'Local JSON review does not have a PostgreSQL schema; SQL setup must be checked in server mode.'};
  if(schema.mode!=='postgres'||!Array.isArray(schema.columns))return {findings:[fieldFinding('schema','SCHEMA_METADATA_INVALID','schema','Schema metadata is invalid; capture the current PostgreSQL schema again.')],checked:0,status:'FAILED',message:'Schema metadata cannot be used.'};
  const actual=new Map();for(const row of schema.columns){const item=schemaColumn(row);if(typeof item.tableName!=='string'||typeof item.columnName!=='string'||!item.type){findings.push(fieldFinding('schema','SCHEMA_METADATA_INVALID','schema.columns','A captured schema column has invalid table/name/type metadata. Capture the schema again.'));continue;}actual.set(`${item.tableName}.${item.columnName}`,item.type);}
  let checked=0;
  for(const [table,required] of Object.entries(setupSchemaRequirements))for(const [column,types] of Object.entries(required)){
    checked++;const value=actual.get(`${table}.${column}`);
    if(!value)findings.push(fieldFinding('schema','SCHEMA_COLUMN_MISSING',`${table}.${column}`,`Missing or inaccessible PostgreSQL column ${table}.${column}. Apply the ordered migrations and runtime grants; M90 does not change the schema.`,{table,column}));
    else if(!types.includes(value))findings.push(fieldFinding('schema','SCHEMA_COLUMN_TYPE',`${table}.${column}`,`PostgreSQL column ${table}.${column} has type ${value}; expected ${types.join(' / ')}. Repair through a reviewed migration.`,{table,column}));
  }
  return {findings,checked,status:checkStatus(findings),message:`Checked ${checked} physical storage columns, including the 31 Check / 12 Database source fields and their derived JSON storage.`};
}

function validateReferences(catalog){
  const findings=[];
  if(catalog===null||catalog===undefined)return {findings,checked:0,status:'NOT_CHECKED',usable:false,message:'Reference catalog was unavailable; canonical row checks cannot run.'};
  if(!object(catalog)||!object(catalog.entries))return {findings:[fieldFinding('references','REFERENCE_SHAPE','referenceCatalog','Reference catalog or its entries object is invalid. Restore a verified reference revision.')],checked:0,status:'FAILED',usable:false,message:'Reference catalog shape is invalid.'};
  if(!Number.isSafeInteger(catalog.revision)||catalog.revision<1)findings.push(fieldFinding('references','REFERENCE_REVISION','revision','Reference revision must be a positive integer.'));
  if(!object(catalog.source)||!/^[a-f0-9]{64}$/i.test(catalog.source.sourceSha256||''))findings.push(fieldFinding('references','REFERENCE_SOURCE','source','Reference source SHA-256 provenance is missing or invalid.'));
  let checked=0,shape=true;const source=seedReferenceCatalog();
  for(const [kind,fields] of Object.entries(referenceKinds)){
    const rows=catalog.entries[kind];if(!Array.isArray(rows)){shape=false;findings.push(fieldFinding('references','REFERENCE_COLLECTION',kind,`Reference collection ${kind} is missing or invalid.`));continue;}
    const seen=new Set();for(let index=0;index<rows.length;index++){
      const row=rows[index];checked++;
      if(!object(row)){shape=false;findings.push(fieldFinding('references','REFERENCE_ENTRY',kind,`Reference ${kind} entry ${index+1} is not an object.`));continue;}
      if(typeof row.id!=='string'||!row.id||seen.has(row.id))findings.push(fieldFinding('references','REFERENCE_ENTRY_ID',`${kind}.id`,`Reference ${kind} entry ${index+1} has a missing or duplicate ID.`,{recordId:row.id}));seen.add(row.id);
      if(typeof row.active!=='boolean')findings.push(fieldFinding('references','REFERENCE_ACTIVE',`${kind}.active`,`Reference entry ${row.id||index+1} requires a boolean active flag.`,{recordId:row.id}));
      for(const field of fields)if(row[field]!==undefined&&typeof row[field]!=='string'){shape=false;findings.push(fieldFinding('references','REFERENCE_FIELD_TYPE',`${kind}.${field}`,`${kind}.${field} must be text.`,{recordId:row.id}));}
      if(row.active)for(const field of fields.filter(field=>!['notes','effectiveDate'].includes(field)))if(!cleanText(row[field]))findings.push(fieldFinding('references','REFERENCE_REQUIRED',`${kind}.${field}`,`Active ${kind} entry ${row.id||index+1} requires ${field}.`,{recordId:row.id}));
      if(kind==='relationships'&&row.active&&row.effectiveDate&&!validBusinessDate(row.effectiveDate)&&!source.entries.relationships.some(original=>original.id===row.id&&original.effectiveDate===row.effectiveDate))findings.push(fieldFinding('references','REFERENCE_DATE',`${kind}.effectiveDate`,'New or changed relationship dates must use a valid YYYY-MM-DD calendar date. Inherited source date text may remain unchanged.',{recordId:row.id}));
    }
  }
  try{if(typeof catalog.hash!=='string'||catalogHash(catalog)!==catalog.hash)findings.push(fieldFinding('references','REFERENCE_INTEGRITY','hash','Reference catalog content does not match its recorded hash. Restore a verified reference revision; M90 does not repair it.'));}catch{findings.push(fieldFinding('references','REFERENCE_INTEGRITY','hash','Reference catalog cannot be hashed; restore a verified reference revision.'));}
  if(shape)try{validateCatalog(structuredClone(catalog));}catch(error){findings.push(fieldFinding('references',error.code||'REFERENCE_INVALID','referenceCatalog',`${error.message}${error.details?.length?' '+error.details.join('; '):''}`));}
  if(object(catalog.source)&&catalog.source.sourceSha256&&catalog.source.sourceSha256!==source.source.sourceSha256)findings.push(fieldFinding('references','REFERENCE_SOURCE_DIFFERENT','source.sourceSha256','The reference source hash differs from the currently bundled source. Reconcile reference-source provenance before cutover.',{severity:'WARNING'}));
  return {findings,checked,status:checkStatus(findings),usable:!findings.some(finding=>finding.severity==='ERROR'),message:`Checked ${checked} catalog entries, identity rules and hash. Original source-priority relationship duplicates and inherited source dates are preserved.`};
}

function validRows(value,kind,findings){
  if(!Array.isArray(value)){if(value!==null&&value!==undefined)findings.push(fieldFinding('rows','DATA_COLLECTION_INVALID',kind,`${kind} must be an array; the captured collection is malformed.`));return null;}
  return value.filter((row,index)=>{if(object(row))return true;findings.push(fieldFinding('rows','ROW_SHAPE',kind,`${kind} row ${index+1} is not an object.`,{row:index+1}));return false;});
}
function validateRows(proposals,replacements,orderNo){
  const findings=[],allProposals=validRows(proposals,'proposals',findings),allRecords=validRows(replacements,'replacements',findings);
  if(!allProposals||!allRecords)return {findings,checked:0,status:findings.length?'FAILED':'NOT_CHECKED',message:'Proposal/history data was unavailable or invalid; canonical row validation was not run.'};
  const order=normalize(orderNo),selected=row=>!order||normalize(row.orderNo)===order,working=allProposals.filter(row=>!row.archived&&selected(row)),records=allRecords.filter(selected),history=createHistoryIndex(allRecords);
  const add=(row,code,field,message,severity='ERROR')=>findings.push(fieldFinding('rows',code,field,message,{...location(row),severity}));
  const proposalsById=new Map(),workflowIds=new Map(),recordIds=new Map(),decisionIds=new Map(),lifecycleIds=new Map();
  for(const row of working){
    for(const field of ['proposalId','orderNo','productDecimalNo','origPn'])if(!cleanText(row[field]))add(row,'REQUIRED_FIELD',field,`${field} is required on a working proposal.`);
    if(row.proposalId&&proposalsById.has(row.proposalId))add(row,'DUPLICATE_PROPOSAL_ID','proposalId',`Proposal_ID also occurs in ${proposalsById.get(row.proposalId)}.`);else proposalsById.set(row.proposalId,row.sourceRow||row.proposalId);
    const classification=classifyProposal(row);
    if(!cleanText(row.altPn)&&normalize(row.componentStatus)!=='OBSOLETE'&&classification!=='DO NOT PURCHASE')add(row,'ALTERNATIVE_REQUIRED','altPn','An alternative part number, an obsolete status or a do-not-purchase decision is required.');
    if(classification==='UNKNOWN')add(row,'UNKNOWN_CLIENT_REPLY','clientReplyRaw','Technical client reply is pending review and blocks final approval.','WARNING');
    if(row.clientDecision&&!['APPROVED','REJECTED','DO NOT PURCHASE'].includes(row.clientDecision))add(row,'INVALID_DECISION_STATUS','clientDecision','Stored Client_Decision must be APPROVED, REJECTED, DO NOT PURCHASE or blank; technical text belongs to the separate pending reply.');
    if(row.decisionDate&&!validBusinessDate(row.decisionDate))add(row,'INVALID_DATE','decisionDate','Decision date is not a valid YYYY-MM-DD calendar date.');
    const identity=workflowKey(row);if(workflowIds.has(identity))add(row,'DUPLICATE_PROPOSAL','proposalId',`The same replacement identity occurs in ${workflowIds.get(identity)}.`);else workflowIds.set(identity,row.proposalId);
    const expected=recalculateProposal(row,history),derivedFields=[...setupSourceFields.Check.filter(field=>field.jsonKey).map(field=>field.field),'normalizationVersion','workflowStatus','canRecord','historicalStatus','historicalReference','historicalDate','manufacturerRelationship','componentStatus','canRecordLabel'];
    for(const field of derivedFields){
      if(row[field]===undefined){if(expected[field]!==''&&expected[field]!==undefined)add(row,'DERIVED_FIELD_MISSING',field,`${field} is not stored. Run M91 to rebuild the current projection.`,'WARNING');}
      else if(row[field]!==expected[field])add(row,'STALE_CALCULATION',field,`${field} differs from the current reference/history calculation. Run M91.`);
    }
    if(row.normalizationVersion&&row.normalizationVersion!==NORMALIZATION_VERSION)add(row,'NORMALIZATION_VERSION','normalizationVersion','The stored normalization version is not the approved current version. Run M91 after reviewing migration compatibility.');
  }
  for(const row of records){
    if(!cleanText(row.recordId))add(row,'REQUIRED_FIELD','recordId','A stable historical record ID is required.');
    if(recordIds.has(row.recordId))add(row,'DUPLICATE_RECORD_ID','recordId','The historical record ID is repeated.');else recordIds.set(row.recordId,true);
    const lifecycle=row.recordType==='LIFECYCLE'||row.decisionStatus==='OBSOLETE';
    if(lifecycle){
      if(row.decisionStatus!=='OBSOLETE')add(row,'INVALID_LIFECYCLE_STATUS','decisionStatus','A lifecycle record must have OBSOLETE status.');
      if(!originalKey(row))add(row,'LIFECYCLE_IDENTITY','origPn','Lifecycle record requires product decimal number and original component identity.');
      if(!validBusinessDate(row.decisionDate))add(row,'INVALID_DATE','decisionDate','Lifecycle report date is not a valid calendar date.');
      const key=JSON.stringify([originalKey(row),normalize(row.supplier)]);if(lifecycleIds.has(key))add(row,'DUPLICATE_LIFECYCLE_REPORT','recordId',`Lifecycle report duplicates ${lifecycleIds.get(key)}.`);else lifecycleIds.set(key,row.recordId);
      continue;
    }
    if(!['APPROVED','REJECTED'].includes(row.decisionStatus))add(row,'INVALID_DECISION_STATUS','decisionStatus','Reusable historical replacements must have APPROVED or REJECTED status.');
    const validation=validateDecision({...row,clientDecision:row.decisionStatus,clientComment:row.decisionComment});for(const [field,message] of Object.entries(validation.errors))add(row,'DECISION_EVIDENCE',field==='clientDecision'?'decisionStatus':field,message);
    for(const field of ['orderNo','productDecimalNo','origPn','altPn'])if(!cleanText(row[field]))add(row,'REQUIRED_FIELD',field,`${field} is required on a recorded replacement.`);
    const key=recordKey(row);if(key&&decisionIds.has(key))add(row,'DUPLICATE_RECORDED_DECISION','recordId',`Recorded decision duplicates ${decisionIds.get(key)}.`);else if(key)decisionIds.set(key,row.recordId);
  }
  return {findings,checked:working.length+records.length,status:checkStatus(findings),message:`Checked ${working.length} active proposals and ${records.length} historical rows${orderNo?' in order '+cleanText(orderNo):' across all orders'}; calculations use the full captured history.`};
}

function validateAttachments(artifacts,proposals){
  const findings=[];
  if(!Array.isArray(artifacts)||!Array.isArray(proposals)){
    if(artifacts!==null&&artifacts!==undefined&&!Array.isArray(artifacts))findings.push(fieldFinding('attachments','DATA_COLLECTION_INVALID','artifacts','File catalog must be an array; the captured collection is malformed.'));
    if(proposals!==null&&proposals!==undefined&&!Array.isArray(proposals))findings.push(fieldFinding('attachments','DATA_COLLECTION_INVALID','proposals','Full proposal identity collection must be an array.'));
    return {findings,checked:0,status:findings.length?'FAILED':'NOT_CHECKED',message:'File catalog or full proposal identity snapshot was unavailable or invalid; attachment links were not checked.'};
  }
  const proposalMap=new Map(),duplicates=new Set();for(const row of proposals.filter(object)){if(proposalMap.has(row.proposalId))duplicates.add(row.proposalId);proposalMap.set(row.proposalId,row);}
  const ids=new Set(),versions=new Set();let checked=0;
  for(const artifact of artifacts){
    checked++;if(!object(artifact)){findings.push(fieldFinding('attachments','ARTIFACT_SHAPE','artifacts','A file catalog entry is not an object.'));continue;}
    const add=(code,field,message,severity='ERROR')=>findings.push(fieldFinding('attachments',code,field,message,{recordId:artifact.artifactId,severity}));
    if(!uuid(artifact.artifactId)||ids.has(artifact.artifactId))add('ARTIFACT_ID','artifactId','A file ID is invalid or duplicated.');ids.add(artifact.artifactId);
    if(!/^[a-f0-9]{64}$/.test(artifact.sha256||''))add('ARTIFACT_HASH','sha256','File metadata requires a valid lowercase SHA-256 hash.');
    if(!Number.isSafeInteger(artifact.bytes)||artifact.bytes<1)add('ARTIFACT_SIZE','bytes','File byte count must be a positive safe integer.');
    if(!Number.isSafeInteger(artifact.version)||artifact.version<1||!cleanText(artifact.logicalKey))add('ARTIFACT_VERSION','version','File logical identity and a positive version are required.');
    const versionKey=JSON.stringify([artifact.logicalKey,artifact.version]);if(versions.has(versionKey))add('ARTIFACT_DUPLICATE_VERSION','version','The same logical file/version occurs more than once.');versions.add(versionKey);
    if(!['ATTACHMENT','ORIGINAL_BOM','WORKFLOW_INPUT','WORKFLOW_OUTPUT'].includes(artifact.kind))add('ARTIFACT_KIND','kind','Unknown file kind.');
    if(!['CLEAN','PENDING','ERROR','INFECTED','GENERATED'].includes(artifact.scanStatus))add('ARTIFACT_SCAN_STATUS','scanStatus','Unknown file verification status.');
    else if(['ERROR','INFECTED'].includes(artifact.scanStatus))add('ARTIFACT_QUARANTINED','scanStatus','This retained file is not verified for use; review its quarantine/verification status.','WARNING');
    if(typeof artifact.ownerOnly!=='boolean'||(artifact.ownerUserId&&!uuid(artifact.ownerUserId)))add('ARTIFACT_OWNER','ownerUserId','File owner metadata is invalid.');
    if(artifact.ownerOnly&&!artifact.ownerUserId&&!cleanText(artifact.ownerActor))add('ARTIFACT_OWNER','ownerActor','A private retained file must identify its owning account or local actor.');
    const scope=artifact.scope;let validScope=object(scope);
    for(const field of ['orderNos','suppliers','productDecimalNos','proposalIds'])if(!object(scope)||!Array.isArray(scope[field])||scope[field].some(value=>typeof value!=='string'||!cleanText(value))){validScope=false;add('ARTIFACT_SCOPE',`scope.${field}`,`File scope.${field} must be an array of nonblank text values.`);}
    if(!validScope)continue;
    if(!scope.orderNos.length)add('ARTIFACT_ORDER','scope.orderNos','A file must be linked to at least one order.');
    // Failed/raw workflow inputs can legitimately contain unknown incoming IDs.
    // Ordinary proposal attachments must keep a current or archived target.
    if(artifact.kind!=='ATTACHMENT')continue;
    if(!scope.proposalIds.length)add('ATTACHMENT_LINK_MISSING','scope.proposalIds','An ordinary attachment must be linked to a proposal.');
    for(const id of scope.proposalIds){
      const row=proposalMap.get(id);if(!row||duplicates.has(id)){add('ATTACHMENT_TARGET','scope.proposalIds',`Attachment target ${id} is missing or ambiguous; restore or reconcile its proposal linkage.`);continue;}
      for(const [field,value] of [['orderNos',row.orderNo],['suppliers',row.supplier],['productDecimalNos',row.productDecimalNo]])if(cleanText(value)&&!scope[field].some(item=>normalize(item)===normalize(value)))add('ATTACHMENT_SCOPE_MISMATCH',`scope.${field}`,`Attachment target ${id} is outside its declared ${field} scope.`);
    }
  }
  findings.push(...verifyAttachmentReferences(artifacts.filter(object)).map(item=>fieldFinding('attachments',item.code,'attachmentMetadata',item.error,{recordId:item.artifactId})));
  return {findings,checked,status:checkStatus(findings),message:`Checked ${checked} file metadata records, immutable attachment version chains and ordinary attachment links against all current/archived proposal IDs. Retained raw workflow IDs are not treated as attachment targets. Object bytes/antivirus health are separate checks.`};
}

/** Pure validation: callers capture global configuration/files and full history. */
export function validateSetup(input={}){
  const report={moduleId:'M90',capturedAt:input.capturedAt??null,scope:{orderNo:cleanText(input.orderNo),rows:input.orderNo?'SELECTED_ORDER':'ALL_ACTIVE',configuration:'GLOBAL',attachments:'GLOBAL'},requiredSourceFields:{Check:31,Database:12},details:[],checks:[],affected:0};
  const schema=validateSchema(input.schema);addCheck(report,'schema',schema.findings,schema.checked,schema.message,schema.status);
  const references=validateReferences(input.catalog);addCheck(report,'references',references.findings,references.checked,references.message,references.status);
  if(input.catalog&&object(input.catalog)){report.referenceRevision=input.catalog.revision;report.referenceHash=input.catalog.hash;}
  if(references.usable){
    try{const rows=withCatalog(input.catalog,()=>validateRows(input.proposals,input.replacements,input.orderNo));addCheck(report,'rows',rows.findings,rows.checked,rows.message,rows.status);report.affected=rows.checked;}
    catch(error){addCheck(report,'rows',[fieldFinding('rows','ROW_VALIDATION_FAILED','rows',`Canonical row validation could not complete: ${error.message}`)],0,'Canonical row validation failed.','FAILED');}
  }else addCheck(report,'rows',[],0,'Canonical row validation was not run because the reference catalog is unavailable or invalid.','NOT_CHECKED');
  const attachments=validateAttachments(input.artifacts,input.proposals);addCheck(report,'attachments',attachments.findings,attachments.checked,attachments.message,attachments.status);
  report.details.push(...structuredClone(input.extraFindings||[]));report.checks.push(...structuredClone(input.extraChecks||[]));
  return finalizeSetupReport(report);
}
