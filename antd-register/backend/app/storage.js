import {replacePrivateFile} from './atomic-file.js';
import {auditEventProvenance,serializeEventProvenance} from './audit-writer.js';
import {copyAuditContext} from './audit-provenance.js';
import { cloneDemoState, sourceMetadata } from "./demo-data.js";
import { previewWorkflow, recalculateProposal } from "./workflow.js";
import { validateDecision, validBusinessDate } from "./validation.js";
import { canAccess } from "./auth.js";
import { randomUUID,createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, cleanText, workflowKey, originalKey, productPairKey, canonicalManufacturer, cleanPartNumber, manufacturerKey, partNumberKey,currentReferenceContext } from "./normalization.js";
import {seedReferenceCatalog,planReferenceChange,withCatalog,catalogHash} from './reference-catalog.js';
import {appendMemoryDecisionAudit,appendSqlDecisionAudit,migrateMemoryDecisionAudit,memoryDecisionHistory,sqlDecisionHistory,historySource} from './decision-history.js';
import { updateProposal, normalizedProjection, classifyReply, classifyProposal, isObsoleteReply, splitDecisionComment, historyFor, createHistoryIndex } from "./domain.js";
import {planDecisionRecording,decisionRecordingResult} from './decision-recording-summary.js';
import {prepareImportBatch,requireBatch,batchAccess,batchSummary,checkBatchRevision,validateImportCommit,importInputKey} from './import-staging.js';
import {checkImportRefresh,importReviewAudit} from './import-preparation.js';
import {preliminaryClientMetadata,newClientProposalMetadata} from './m04-metadata.js';
import {withImportFindings,importReceiptResult} from './import-results.js';
import {captureProposalAllocationSnapshot,allocateProposalIdFromSnapshot} from './proposal-id-allocation.js';
import {validatePermitMetadata,permitPlanDigest} from './permit-metadata.js';
import {appendMemoryWorkflowAudit,appendSqlWorkflowAudit,migrateMemoryWorkflowAudit,memoryRounds,memoryRoundEvents,memoryExchangeSnapshots,sqlRounds,sqlRoundEvents,sqlExchangeSnapshots} from './workflow-rounds.js';
import {workflowRowScope,workflowExportScope,workflowAttribution,memoryWorkflowRuns,sqlWorkflowRuns,insertSqlWorkflowRun} from './workflow-run-history.js';
import {referenceIdentityImpact} from './reference-identity-impact.js';
import {validateSetup} from './setup-validation.js';
import {prepareMemoryArchiveReview,getMemoryArchiveReview,confirmMemoryArchiveReview,prepareSqlArchiveReview,getSqlArchiveReview,confirmSqlArchiveReview} from './archive-review-store.js';
import {withMemoryRoundMutation,manageMemoryRound,getMemoryRoundManagement,manageSqlRound,getSqlRoundManagement} from './round-management-store.js';
import {associateMemoryRoundExchanges,associateSqlRoundExchanges} from './round-association-store.js';
import {createSqlExecution,sqlExecutionConfig} from './sql-execution.js';
import {assertRecordDetailAdministrator,captureMemoryRecordDetail,captureSqlRecordDetail} from './record-detail-read.js';
import {bindProposalWorkingOrder,copyProposalWorkingOrder,requireKnownWorkingOrder,assertProposalWorkingOrderSchema} from './working-order-operations.js';

const rr = "replacement_register";
const referenceOperation = plan => plan.action ? {action:plan.action,changes:structuredClone(plan.changes||[]),impact:structuredClone(plan.impact||{})} : {};
function referencePlan(catalog,body,context,proposals,replacements){
  const plan=planReferenceChange(catalog,body,context);
  if(plan.action&&plan.changed){const impact=referenceIdentityImpact(catalog,plan.catalog,proposals,replacements);plan.impact={...plan.impact,business:impact.summary};plan.lifecycleUpdates=impact.lifecycleUpdates;}
  plan.reviewHash=createHash('sha256').update(JSON.stringify({revision:catalog.revision,hash:catalog.hash,action:plan.action,changes:plan.changes,impact:plan.impact,before:plan.before,after:plan.after})).digest('hex');
  if(body.reviewHash&&body.reviewHash!==plan.reviewHash)throw Object.assign(new Error('The reference change impact changed after review. Review the current impact before saving.'),{status:409,code:'REFERENCE_REVIEW_CHANGED'});
  return plan;
}
const referencePreview=(plan,catalog)=>({revision:catalog.revision,catalogHash:catalog.hash,changed:plan.changed,reviewHash:plan.reviewHash,...referenceOperation(plan)});
export function rowToLifecycle(row) { return { ...row.payload, recordId:row.record_id, recordType: 'LIFECYCLE', rowVersion: Number(row.row_version) }; }
async function loadLedger(client) {
  const normal = (await client.query(`select * from ${rr}.replacement_records order by ledger_position`)).rows.map(rowToReplacement);
  const lifecycle = (await client.query(`select * from ${rr}.lifecycle_records order by created_at,record_id`)).rows.map(rowToLifecycle);
  return [...normal,...lifecycle];
}
async function loadProposalHistory(client, item) {
  const history = createHistoryIndex([]), pair = productPairKey(item), original = originalKey(item);
  if (!pair && !original) return history;
  const product = normalize(item.productDecimalNo);
  // The approved keys concatenate with '|'. Preserve even cross-product
  // delimiter collisions; never silently replace that legacy identity rule.
  const candidates = field => product.includes('|') ? '' : ` where replacement_register.scope_text(${field})=$1 or position('|' in ${field})>0`;
  const values = product.includes('|') ? [] : [product];
  const queries = [
    [`select product_decimal_no,orig_mfr,orig_pn,alt_mfr,alt_pn,decision_status,order_no,decision_date,decision_reference from ${rr}.replacement_records${candidates('product_decimal_no')} order by ledger_position`, rowToReplacement],
    [`select record_id,jsonb_build_object('productDecimalNo',payload->>'productDecimalNo','origMfr',payload->>'origMfr','origPn',payload->>'origPn','decisionStatus',payload->>'decisionStatus') as payload from ${rr}.lifecycle_records${candidates("coalesce(payload->>'productDecimalNo','')")} order by created_at,record_id`, rowToLifecycle]
  ];
  for (const [sql, convert] of queries) {
    const cursor = `rr_history_${randomUUID().replaceAll('-', '')}`;
    await client.query(`declare ${cursor} no scroll cursor for ${sql}`, values);
    try {
      for (;;) {
        const rows = (await client.query(`fetch forward 1000 from ${cursor}`)).rows;
        for (const raw of rows) {
          const row = convert(raw);
          if ((pair && productPairKey(row) === pair) || (original && originalKey(row) === original && normalize(row.decisionStatus) === 'OBSOLETE')) history.add(row);
        }
        if (rows.length < 1000) break;
      }
    } catch (error) { await client.query(`close ${cursor}`).catch(() => {}); throw error; }
    await client.query(`close ${cursor}`);
  }
  return history;
}
async function insertLifecycle(client,item) {
  await client.query(`insert into ${rr}.lifecycle_records(record_id,original_key,supplier_key,order_no,supplier,payload,row_version) values($1,$2,$3,$4,$5,$6,$7)`,[item.recordId,originalKey(item),normalize(item.supplier),item.orderNo,item.supplier||'',item,item.rowVersion||1]);
}

function businessDate(value) {
  if (!value) return "";
  if (value instanceof Date) return `${String(value.getFullYear()).padStart(4,'0')}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  return String(value).slice(0, 10);
}

function checkVersion(item, context) {
  if (context.expectedVersion !== undefined && Number(context.expectedVersion) !== Number(item.rowVersion || 1)) {
    throw Object.assign(new Error("This record was changed by another user. Review the current values before saving again."), { status: 409, code: "STALE_RECORD", current: item });
  }
}

export function rowToProposal(row) {
  return {
    ...(row.normalized_json || {}),
    proposalId: row.proposal_id,
    round:row.approval_round||'',
    orderNo: row.order_no,
    supplier: row.supplier,
    product: row.product,
    productCode: row.product_code,
    productDecimalNo: row.product_decimal_no,
    productionOrder: row.production_order,
    position: row.position,
    origCode: row.orig_code,
    origMfr: row.orig_mfr,
    origPn: row.orig_pn,
    altMfr: row.alt_mfr,
    altPn: row.alt_pn,
    supplierReply: row.supplier_reply,
    supplierComment: row.supplier_comment,
    componentStatus: row.component_status,
    manufacturerRelationship: row.manufacturer_relationship,
    clientDecision: row.client_decision,
    clientComment: row.client_comment,
    responsible: row.responsible,
    decisionReference: row.decision_reference,
    decisionDate: businessDate(row.decision_date),
    historicalStatus: row.historical_status,
    historicalReference: row.historical_reference || "",
    historicalDate: businessDate(row.historical_date),
    notes: row.notes || "",
    rawSource: row.raw_source_json || undefined,
    workflowStatus: row.workflow_status,
    canRecord: row.can_record,
    archived: Boolean(row.archived),
    sourceSheet: row.source_sheet,
    sourceRow: row.source_row,
    rowVersion: Number(row.row_version || 1)
  };
}

export function rowToReplacement(row) {
  return {
    recordType: 'REPLACEMENT',
    recordId: row.record_id,
    proposalId: row.proposal_id || "",
    orderNo: row.order_no,
    supplier: row.supplier,
    product: row.product,
    productDecimalNo: row.product_decimal_no,
    productCode: row.product_code,
    position: row.position,
    origCode: row.orig_code,
    origMfr: row.orig_mfr,
    origPn: row.orig_pn,
    componentStatus: row.component_status,
    altMfr: row.alt_mfr,
    altPn: row.alt_pn,
    decisionStatus: row.decision_status,
    productionOrder: row.production_order,
    responsible: row.responsible,
    decisionReference: row.decision_reference || "",
    decisionDate: businessDate(row.decision_date),
    decisionComment: row.decision_comment,
    notes: row.notes,
    sourceSheet: row.source_sheet,
    sourceRow: row.source_row,
    rowVersion: Number(row.row_version || 1)
  };
}

function matchesSearch(item, search, fields) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return fields.some((field) => String(item[field] || "").toLowerCase().includes(needle));
}

function same(left, right) {
  return normalize(left) === normalize(right);
}

function normalizeImportedDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString().slice(0, 10);
}

function compatibleIdentity(item, row) {
  for (const field of ['orderNo', 'productDecimalNo']) if (row[field] && !same(item[field], row[field])) return false;
  for (const field of ['origPn', 'altPn']) if (row[field] && partNumberKey(item[field]) !== partNumberKey(row[field])) return false;
  for (const field of ['origMfr', 'altMfr']) if (row[field] && manufacturerKey(item[field]) !== manufacturerKey(row[field])) return false;
  return true;
}
function sameOriginal(item, row) {
  return same(item.orderNo,row.orderNo) && same(item.productDecimalNo,row.productDecimalNo) && partNumberKey(item.origPn) === partNumberKey(row.origPn) && (!row.origMfr || !item.origMfr || manufacturerKey(item.origMfr) === manufacturerKey(row.origMfr));
}
function findImportMatches(proposals, row) {
  if (row.proposalId) {
    const byId = proposals.filter((item) => item.proposalId === row.proposalId);
    if (byId.length) return byId.filter(item => compatibleIdentity(item,row));
  }
  if (!row.orderNo || !row.productDecimalNo || !row.origPn) return [];
  const exact = row.position ? proposals.filter(item => workflowKey(item,true) === workflowKey(row,true)) : [];
  return exact.length ? exact : proposals.filter(item => workflowKey(item) === workflowKey(row));
}

function importedDecision(row, finalImport) {
  const sourceDecision = cleanText(row.clientDecision);
  const split = splitDecisionComment(row.clientDecision, row.clientComment);
  const decision = classifyReply(split.clientDecision);
  if (decision === 'UNKNOWN' && !finalImport) return { value: { clientDecision: '', clientReplyRaw: split.clientDecision, clientDecisionExportText:sourceDecision, clientComment: split.clientComment, ...preliminaryClientMetadata(row) }, pendingReview: true };
  if (decision === 'UNKNOWN') return { error: "Client reply is not recognized. Resolve the technical request before final approval." };
  if (decision === "REJECTED" && !split.clientComment) return { error: "A rejected decision requires a rejection reason." };
  const value = {
    clientDecision: decision,
    clientComment: split.clientComment,
    responsible: row.responsible || "",
    decisionReference: row.decisionReference || "",
    decisionDate: normalizeImportedDate(row.decisionDate)
  };
  if (finalImport) {
    const validation = validateDecision(value);
    if (Object.keys(validation.errors).length) return { error: Object.values(validation.errors).join(" ") };
    return { value: {...validation.value,clientDecisionExportText:sourceDecision} };
  }
  const preliminary = { clientDecision: value.clientDecision, clientReplyRaw: '', clientDecisionExportText:sourceDecision, clientComment: value.clientComment, ...preliminaryClientMetadata(row) };
  return { value: preliminary };
}

export class MemoryStorage {
  constructor({trackDecisionEvents=true,auditRuntime=null}={}) {
    this.state = cloneDemoState();
    this.trackDecisionEvents=trackDecisionEvents;
    this.auditRuntime=auditRuntime;
    if(currentReferenceContext()?.catalog)this.state.referenceCatalog=structuredClone(currentReferenceContext().catalog);
    this.state.importBatches=[];
    this.importReceipts = new Map();
    this.proposalSequenceFloor = 0;
    this.proposalAllocationSnapshot = null;
  }

  allocateProposalId(orderNo) {
    // The scalar remains a legacy transport/rollback field, not a namespace
    // floor. Private snapshots include every retained ID before role scoping.
    this.proposalAllocationSnapshot ||= captureProposalAllocationSnapshot(this.state.proposals);
    return allocateProposalIdFromSnapshot(this.proposalAllocationSnapshot,orderNo);
  }

  referenceSnapshot(){const catalog=structuredClone(this.state.referenceCatalog||seedReferenceCatalog());if(catalogHash(catalog)!==catalog.hash)throw Object.assign(new Error('Reference catalog integrity check failed. Restore a verified catalog backup before continuing.'),{status:409,code:'REFERENCE_INTEGRITY'});return catalog;}
  async getReferenceCatalog(){return this.referenceSnapshot();}
  assertReferenceCurrent(){const expected=currentReferenceContext()?.revision,current=this.state.referenceCatalog?.revision||1;if(expected&&expected!==current)throw Object.assign(new Error('Reference data changed during this request. Refresh the page and review before retrying.'),{status:409,code:'REFERENCE_CHANGED',current:{revision:current}});}
  async listReferenceHistory(){const rows=this.state.referenceHistory||[{revision:1,actor:'Authoritative workbook',reason:'Initial source snapshot',hash:seedReferenceCatalog().hash,change:{kind:'SOURCE_IMPORT'}}];return structuredClone(rows).reverse().map(({catalog,...row})=>row);}
  async getReferenceRevision(revision){return structuredClone(this.state.referenceHistory?.find(row=>row.revision===revision)?.catalog||(revision===1?seedReferenceCatalog():null));}
  async previewReferenceEntry(body,context){const catalog=this.referenceSnapshot();return referencePreview(referencePlan(catalog,body,context,this.state.proposals,this.state.replacements),catalog);}
  async changeReferenceEntry(body,context){
    auditEventProvenance(context,this.auditRuntime);
    const catalog=this.referenceSnapshot(),plan=referencePlan(catalog,body,context,this.state.proposals,this.state.replacements);if(!plan.changed)return {catalog:plan.catalog,affected:0,changed:false};
    const changed=[];withCatalog(plan.catalog,()=>{const history=createHistoryIndex(this.state.replacements);this.state.proposals=this.state.proposals.map(row=>{const next=updateProposal(row,{},history);if(next.rowVersion!==Number(row.rowVersion||1))changed.push({before:row,after:next});return next;});});
    this.state.referenceCatalog=plan.catalog;
    this.state.referenceHistory||=[{revision:1,actor:'Authoritative workbook',reason:'Initial source snapshot',hash:seedReferenceCatalog().hash,change:{kind:'SOURCE_IMPORT'},catalog:seedReferenceCatalog()}];
    this.state.referenceHistory.push({revision:plan.catalog.revision,hash:plan.catalog.hash,actor:context.actor||'Local administrator',actorUserId:context.userId||null,reason:plan.reason,createdAt:new Date().toISOString(),change:{kind:plan.kind,before:plan.before,after:plan.after,affected:changed.length,...referenceOperation(plan)},catalog:structuredClone(plan.catalog)});
    for(const row of changed)this.addAudit(context,'REFERENCE_PROJECTION_UPDATED',row.after.proposalId,`Reference revision ${plan.catalog.revision}`,row.before,row.after);
    this.addAudit(context,'REFERENCE_UPDATED',plan.after.id,plan.reason,{revision:body.revision,entry:plan.before},{revision:plan.catalog.revision,entry:plan.after,affected:changed.length,...referenceOperation(plan)});
    return {catalog:structuredClone(plan.catalog),affected:changed.length,changed:true,...referenceOperation(plan)};
  }

  async health() {
    return { storage: "memory", database: "authoritative workbook preview", source: sourceMetadata };
  }
  async exportState(context,options={}) {this.assertReferenceCurrent();return {asOf:new Date().toISOString(),proposals:structuredClone(this.state.proposals.filter(row=>(!context.authenticated||canAccess(context,row))&&(!options.orderNo||normalize(row.orderNo)===normalize(options.orderNo)))),replacements:structuredClone(this.state.replacements)};}

  async sourceInfo() {
    return sourceMetadata;
  }

  async listProposals(filters = {}) {
    return this.state.proposals.filter((item) => {
      if (!filters.includeArchived && item.archived) return false;
      if (filters.decision && item.clientDecision !== filters.decision) return false;
      if (filters.product && item.productDecimalNo !== filters.product) return false;
      if (filters.orderNo && item.orderNo !== filters.orderNo) return false;
      if (filters.supplier && item.supplier !== filters.supplier) return false;
      return matchesSearch(item, filters.search, ["proposalId", "product", "productDecimalNo", "origMfr", "origPn", "altMfr", "altPn", "supplier"]);
    });
  }

  async getProposal(id) {
    return this.state.proposals.find((item) => item.proposalId === id) || null;
  }

  addAudit(context, action, subject, detail, before = null, after = null) {
    const provenance=auditEventProvenance(context,this.auditRuntime);
    this.state.auditSequence??=this.state.audit.reduce((maximum,row)=>Math.max(maximum,Number(row.id)||0),0);
    const event = {
      id: ++this.state.auditSequence,
      occurredAt: new Date().toISOString(),
      actor: context.actor || "Local user",
      actorUserId: context.userId || null,
      requestId: context.requestId || null,
      role: context.role || "ADMINISTRATOR",
      action,
      subject,
      detail,
      before,
      after,
      provenance,
      decisionSource:historySource(context,after||before)
    };
    this.state.audit.unshift(event);
    if(this.trackDecisionEvents){appendMemoryDecisionAudit(this.state,event);appendMemoryWorkflowAudit(this.state,{...event,workflowExchange:context.workflowExchange});}
    return event;
  }
  async listDecisionHistory(filters,context){return memoryDecisionHistory(this.state,filters,context);}
  async listRounds(filters,context){return memoryRounds(this.state,filters,context);}
  async getRoundEvents(id,filters,context){return memoryRoundEvents(this.state,id,filters,context);}
  async getExchangeSnapshots(id,filters,context){return memoryExchangeSnapshots(this.state,id,filters,context);}

  async saveDecision(id, decision, context = {}) {
    auditEventProvenance(context,this.auditRuntime);
    this.assertReferenceCurrent();
    const item = await this.getProposal(id);
    if (!item) return null;
    checkVersion(item, context);
    const before = structuredClone(item);
    Object.assign(item, updateProposal(item, decision, this.state.replacements));
    this.addAudit(context, "DECISION_UPDATED", id, `${decision.clientDecision} · ${decision.decisionReference || "no reference"}`, before, structuredClone(item));
    return item;
  }

  async listReplacements(filters = {}) {
    return this.state.replacements.filter((item) => {
      if (filters.decision && item.decisionStatus !== filters.decision) return false;
      if (filters.product && item.productDecimalNo !== filters.product) return false;
      if (filters.orderNo && item.orderNo !== filters.orderNo) return false;
      return matchesSearch(item, filters.search, ["recordId", "orderNo", "product", "productDecimalNo", "origMfr", "origPn", "altMfr", "altPn", "decisionReference"]);
    });
  }

  async getReplacement(id) {
    return this.state.replacements.find((item) => item.recordId === id) || null;
  }

  async captureReplacementDetail(id,context) {
    assertRecordDetailAdministrator(context);
    if(this.queue)await this.queue;
    const sourceContext=this.envelopeMetadata?{loadedSourceHash:this.envelopeMetadata.sourceSha256,sourceProvenance:this.envelopeMetadata.sourceProvenance}:undefined;
    return captureMemoryRecordDetail(await this.getReplacement(id),context,sourceContext);
  }

  async updateReplacement(id, changes, context = {}) {
    auditEventProvenance(context,this.auditRuntime);
    this.assertReferenceCurrent();
    const item = await this.getReplacement(id);
    if (!item) return null;
    if (item.recordType === 'LIFECYCLE' && changes.decisionStatus && changes.decisionStatus !== 'OBSOLETE') throw Object.assign(new Error('A lifecycle record cannot become a replacement approval.'),{status:422});
    checkVersion(item, context);
    const before = structuredClone(item);
    Object.assign(item, changes, { rowVersion: Number(item.rowVersion || 1) + 1 });
    this.addAudit(context, "DATABASE_RECORD_MODERATED", id, context.reason, before, structuredClone(item));
    return item;
  }

  async deleteReplacement(id, context = {}) {
    auditEventProvenance(context,this.auditRuntime);
    this.assertReferenceCurrent();
    const index = this.state.replacements.findIndex((item) => item.recordId === id);
    if (index < 0) return null;
    checkVersion(this.state.replacements[index], context);
    const [deleted] = this.state.replacements.splice(index, 1);
    this.addAudit(context, "DATABASE_RECORD_DELETED", id, context.reason, structuredClone(deleted), null);
    return deleted;
  }

  recordObsolete(proposal, context, history = null) {
    auditEventProvenance(context,this.auditRuntime);
    if (normalize(proposal.componentStatus) !== 'OBSOLETE') return false;
    const key = originalKey(proposal);
    if (!key || this.state.replacements.some(item => item.decisionStatus === 'OBSOLETE' && originalKey(item) === key && normalize(item.supplier) === normalize(proposal.supplier))) return false;
    const date = context.businessDate || new Intl.DateTimeFormat('en-CA',{ timeZone: process.env.RR_BUSINESS_TIMEZONE || 'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
    // A lifecycle report records the original component, not its proposal's
    // client decision or approval evidence (Workflow WF_RecordObsoleteComponent).
    const record = Object.fromEntries(['proposalId','orderNo','supplier','product','productDecimalNo','productCode','position','origCode','origMfr','origPn','productionOrder'].map(field=>[field,proposal[field]??'']));
    for(const field of ['round','sourceSheet','sourceRow','rawSource','supplierReply','supplierComment'])if(Object.hasOwn(proposal,field))record[field]=structuredClone(proposal[field]);
    Object.assign(record,{recordId:`LC-${randomUUID()}`,recordType:'LIFECYCLE',altMfr:'',altPn:'',decisionStatus:'OBSOLETE',componentStatus:'OBSOLETE',responsible:'',decisionDate:date,decisionReference:'',decisionComment:proposal.supplierComment||'',notes:'Lifecycle status reported by supplier.',rowVersion:1});
    this.state.replacements.push(record);
    history?.add(record);
    this.addAudit(context,'LIFECYCLE_REPORTED',record.recordId,'Supplier reported obsolete / end of life original',null,structuredClone(record));
    return true;
  }

  importSnapshot() {
    const memory=new MemoryStorage({trackDecisionEvents:false,auditRuntime:this.auditRuntime});memory.state=structuredClone(this.state);memory.importReceipts=new Map(this.importReceipts);memory.proposalSequenceFloor=this.proposalSequenceFloor;memory.proposalAllocationSnapshot=captureProposalAllocationSnapshot(this.state.proposals,structuredClone(this.proposalAllocationSnapshot));return memory;
  }
  async listImportBatches(context) {return this.state.importBatches.filter(batch=>batchAccess(batch,context)).slice().reverse().slice(0,100).map(batchSummary);}
  async getImportBatch(id,context) {return requireBatch(this.state.importBatches.find(batch=>batch.batchId===id),context);}
  async captureImportPreparation(data,context,previousId=null,revision=null) {
    this.assertReferenceCurrent();
    const previous=previousId?await this.getImportBatch(previousId,context):null;checkImportRefresh(previous,revision);
    const key=`${data.moduleId}:${importInputKey(data.sourceHash,data.options||{},data.error?null:data.rows||[])}:${context.userId||'preview'}`;
    return structuredClone({state:{proposals:this.state.proposals,replacements:this.state.replacements},proposalSequenceFloor:this.proposalSequenceFloor,proposalAllocationSnapshot:captureProposalAllocationSnapshot(this.state.proposals,structuredClone(this.proposalAllocationSnapshot)),receipts:this.importReceipts.has(key)?[[key,this.importReceipts.get(key)]]:[],previous});
  }
  async savePreparedImport(batch,context) {
    auditEventProvenance(context,this.auditRuntime);
    this.assertReferenceCurrent();
    const stored=this.state.importBatches.find(row=>row.batchId===batch.batchId);
    if(stored?.preparedByJobId===batch.preparedByJobId)return requireBatch(stored,context);
    const previous=batch.revision>1?requireBatch(stored,context):null;
    if(batch.revision===1&&stored)throw Object.assign(new Error('This import identity already exists.'),{status:409,code:'IMPORT_REVIEW_CHANGED'});
    checkImportRefresh(previous,batch.revision-1);
    if(previous)this.state.importBatches[this.state.importBatches.findIndex(row=>row.batchId===batch.batchId)]=batch;else this.state.importBatches.push(batch);
    this.addAudit(context,...importReviewAudit(batch,previous));return batch;
  }
  async stageImport(data,context,previousId=null,revision=null) {
    auditEventProvenance(context,this.auditRuntime);
    this.assertReferenceCurrent();
    const previous=previousId?await this.getImportBatch(previousId,context):null;
    if(previous){checkBatchRevision(previous,revision);if(previous.status==='COMMITTED')throw Object.assign(new Error('A committed import cannot be changed. Upload a new file for another round.'),{status:409,code:'IMPORT_ALREADY_COMMITTED'});}
    const batch=await prepareImportBatch(this.importSnapshot(),data,context,previous);
    if(previous)this.state.importBatches[this.state.importBatches.findIndex(item=>item.batchId===previousId)]=batch;else this.state.importBatches.push(batch);
    this.addAudit(context,'IMPORT_REVIEW_SAVED',batch.batchId,`${batch.moduleId}: ${batch.status}; revision ${batch.revision}`,previous?batchSummary(previous):null,batchSummary(batch));
    return batch;
  }
  async commitImportBatch(id,body,context) {
    auditEventProvenance(context,this.auditRuntime);
    this.assertReferenceCurrent();
    const batch=await this.getImportBatch(id,context);validateImportCommit(batch,body,this,context);
    if(batch.status==='COMMITTED')return {...importReceiptResult(batch.result),batchId:id};
    const result=await MemoryStorage.prototype.importWorkflowRows.call(this,batch.moduleId,batch.rows,copyAuditContext(context,{...context,sourceHash:batch.inputKey,sourceSha256:batch.sourceHash,sourceArtifactId:batch.artifactId,importBatchId:batch.batchId,round:batch.options.round,importFindings:batch.parseFindings||[]}),batch.filename);
    Object.assign(batch,{status:'COMMITTED',result:{...result,batchId:id,artifactId:batch.artifactId},committedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    this.state.workflowRuns.unshift({id:this.state.workflowRuns.length+1,moduleId:batch.moduleId,occurredAt:batch.committedAt,actor:context.actor,role:context.role,result:structuredClone(batch.result),...workflowAttribution(context,workflowRowScope(batch.scope))});
    this.addAudit(context,'IMPORT_REVIEW_COMMITTED',id,`${batch.moduleId}: ${result.message}`,null,batchSummary(batch));return batch.result;
  }

  async importWorkflowRows(moduleId, rows, context = {}, filename = "workbook.xlsx") {
    auditEventProvenance(context,this.auditRuntime);
    this.assertReferenceCurrent();
    context=copyAuditContext(context,{...context,sourceModule:moduleId,sourceFilename:filename});
    const receiptKey = context.sourceHash ? `${moduleId}:${context.sourceHash}:${context.userId || "preview"}` : null;
    if (receiptKey && this.importReceipts.has(receiptKey)) {
      return importReceiptResult(this.importReceipts.get(receiptKey),context.importFindings);
    }
    const history = createHistoryIndex(this.state.replacements);
    let imported = 0; let updated = 0; let skipped = 0; let ignored = 0; let obsoleteRecorded = 0; const findings = [];
    if (moduleId === "M02") {
      const lifecycleOriginals = new Map();
      for (const sourceRow of rows) {
        const row = { ...sourceRow, origMfr: canonicalManufacturer(sourceRow.origMfr), altMfr: canonicalManufacturer(sourceRow.altMfr), origPn: cleanPartNumber(sourceRow.origPn), altPn: cleanPartNumber(sourceRow.altPn), componentStatus: isObsoleteReply(sourceRow.supplierReply) ? "OBSOLETE" : sourceRow.componentStatus || "" };
        const rowContext=copyAuditContext(context,{...context,decisionSource:{...context.decisionSource,sheet:row.sourceSheet,row:row.sourceRow,...(row.round?{round:row.round}:{})}});
        // Ordinary BOM rows without a proposed alternative are ignored before
        // incomplete identity checks (Workflow830–852). Obsolete originals
        // still follow the required-identity and lifecycle-reporting path.
        if (!row.altPn && normalize(row.componentStatus)!=='OBSOLETE') { ignored++; continue; }
        const missing=[['orderNo','Order_No'],['productDecimalNo','Product_Decimal_No'],['origPn','Orig_PN'],...(normalize(row.componentStatus)!=='OBSOLETE'?[['altPn','Alt_PN']]:[])].filter(([field])=>!row[field]).map(([,label])=>label);
        if (missing.length) { skipped += 1; findings.push({ filename,sheet: row.sourceSheet, row: row.sourceRow,code:'IMPORT_REQUIRED_VALUES_MISSING',fields:missing,message:`Missing required value(s): ${missing.join(', ')}.${missing.includes('Alt_PN')?' Alt_PN may be blank only when the original component is obsolete.':''}` }); continue; }
        const matches = this.state.proposals.filter((item) => !item.archived && (!context.authenticated||canAccess(context,item)) && workflowKey(item) === workflowKey(row));
        if (matches.length > 1) { skipped += 1; findings.push({ filename,sheet:row.sourceSheet,row: row.sourceRow,code:'IMPORT_AMBIGUOUS_IDENTITY',message: `Ambiguous existing proposal identity: ${matches.map(item=>item.proposalId).join(', ')}.` }); continue; }
        if (matches[0]) {
          const item = matches[0]; const before = structuredClone(item);
          const changes = {};
          for (const field of ["productCode", "origCode", "componentStatus", "productionOrder", "supplierReply", "supplierComment"]) if (row[field]) changes[field] = row[field];
          if(Object.hasOwn(sourceRow,'round'))changes.round=cleanText(sourceRow.round);
          const changedInformation = !same(item.supplierReply, row.supplierReply) || !same(item.supplierComment, row.supplierComment);
          if (changedInformation && classifyProposal(item) === "UNKNOWN") Object.assign(changes, { clientDecision: "", clientReplyRaw: "", clientComment: "" });
          if (normalize(row.componentStatus)==='OBSOLETE'&&this.recordObsolete({...item,...changes},rowContext,history)) { obsoleteRecorded++; lifecycleOriginals.set(originalKey(item),rowContext); }
          Object.assign(item, updateProposal(item, changes, history)); updated += 1;
          this.addAudit(rowContext, "WORKFLOW_M02_ROW_UPDATED", item.proposalId, `${filename} row ${row.sourceRow}`, before, structuredClone(item));
        } else {
          const proposal = recalculateProposal({
            ...row, proposalId: this.allocateProposalId(row.orderNo),
            supplier:row.supplier||'',product:row.product||'',
            historicalStatus: "NO HISTORY", historicalReference: "",
            workflowStatus: "PRELIMINARY APPROVAL REQUIRED", canRecord: false, clientDecision: "", clientComment: "", responsible: "", decisionReference: "", decisionDate: "", archived: false, rowVersion: 1
          }, history);
          this.state.proposals.push(proposal); imported += 1;
          if (this.recordObsolete(proposal,rowContext,history)) { obsoleteRecorded++; lifecycleOriginals.set(originalKey(proposal),rowContext); Object.assign(proposal,recalculateProposal(proposal,history)); }
          this.addAudit(rowContext, "WORKFLOW_M02_ROW_IMPORTED", proposal.proposalId, `${filename} row ${row.sourceRow}`, null, structuredClone(proposal));
        }
      }
      // VBA finishes M02 with M91. Newly reported lifecycle status can affect
      // another alternative of the same original, even without its source row
      // in this import. Refresh only those active, authorized originals using
      // the operation's history index; source-row counters remain unchanged.
      if (lifecycleOriginals.size) for (const item of this.state.proposals) {
        if (item.archived || (context.authenticated&&!canAccess(context,item))) continue;
        const cause = lifecycleOriginals.get(originalKey(item));
        if (!cause) continue;
        const after = updateProposal(item,{},history);
        if (after.rowVersion===item.rowVersion) continue;
        const before = structuredClone(item);
        Object.assign(item,after);
        this.addAudit(cause,'WORKFLOW_M02_LIFECYCLE_REFRESH',item.proposalId,`${filename}: lifecycle status refreshed for a related original`,before,structuredClone(item));
      }
    } else if (["M04", "M08"].includes(moduleId)) {
      for (const sourceRow of rows) {
        const row = { ...sourceRow, origMfr: canonicalManufacturer(sourceRow.origMfr), altMfr: canonicalManufacturer(sourceRow.altMfr), origPn: cleanPartNumber(sourceRow.origPn), altPn: cleanPartNumber(sourceRow.altPn) };
        const rowContext=copyAuditContext(context,{...context,decisionSource:{...context.decisionSource,sheet:row.sourceSheet,row:row.sourceRow,...(row.round?{round:row.round}:{})}});
        const decision = moduleId === "M04" ? importedDecision(row, false) : { value: null };
        const reject = message => { skipped++; findings.push({ filename, sheet: row.sourceSheet, row: row.sourceRow, message }); };
        if (decision.error) { reject(decision.error); continue; }
        if (decision.pendingReview) findings.push({ filename, sheet: row.sourceSheet, row: row.sourceRow, code: 'TECHNICAL_REPLY_PENDING', message: 'Technical reply retained separately for review; it is not a final decision and blocks final approval.' });
        const active = this.state.proposals.filter(item => !item.archived&&(!context.authenticated||canAccess(context,item)));
        let matches;
        if (moduleId === 'M04') {
          const missing=[['orderNo','Order_No'],['productDecimalNo','Product_Decimal_No'],['origPn','Orig_PN'],['altPn','Alt_PN']].filter(([field])=>!row[field]).map(([,label])=>label);
          if (missing.length) { reject(`Missing required value(s): ${missing.join(', ')}.`); continue; }
          const byId = row.proposalId ? active.find(item => item.proposalId === row.proposalId) : null;
          if (byId && !sameOriginal(byId,row)) { reject('Proposal_ID conflicts with the supplied order, product or original component identity.'); continue; }
          // A supplied accessible ID selects its own exact alternative first.
          // A different alternative creates a fresh copy of that original,
          // even when another proposal already has that technical pair.
          matches = byId
            ? (manufacturerKey(byId.altMfr) === manufacturerKey(row.altMfr) && partNumberKey(byId.altPn) === partNumberKey(row.altPn) ? [byId] : [])
            : active.filter(item => workflowKey(item) === workflowKey(row));
          if (!matches.length) {
            const originals = byId ? [byId] : active.filter(item => sameOriginal(item,row));
            if (originals.length > 1) { reject('Ambiguous original component: select a valid Proposal_ID before proposing another alternative.'); continue; }
            const source = originals[0];
            const created = { rowVersion: 1, archived: false, responsible: '', decisionReference: '', decisionDate: '', clientComment: '', clientDecision: '', supplierComment: '' };
            for (const field of ['orderNo','supplier','product','productDecimalNo','position','origCode','origMfr','origPn']) created[field] = source ? source[field] || '' : row[field] || '';
            Object.assign(created, { proposalId: this.allocateProposalId(row.orderNo), altMfr: row.altMfr, altPn: row.altPn, supplierReply: 'CLIENT PROPOSED', sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, rawSource: row.rawSource });
            Object.assign(created, decision.value, newClientProposalMetadata(row,source,Boolean(byId)));
            const projected = recalculateProposal(created,history);
            this.state.proposals.push(projected); imported++;
            this.addAudit(rowContext,'WORKFLOW_M04_CLIENT_PROPOSAL_CREATED',projected.proposalId,`${filename} row ${row.sourceRow}`,null,structuredClone(projected));
            continue;
          }
        } else matches = findImportMatches(active,row);
        if (matches.length !== 1) { reject(matches.length ? 'Ambiguous proposal match.' : 'No compatible proposal match; check Proposal_ID and immutable component identity.'); continue; }
        const item = matches[0]; const before = structuredClone(item);
        if (moduleId === "M08") {
          const changes = {};
          for (const field of ['productCode','productionOrder','clientComment','responsible','decisionReference','decisionDate']) if (row.presentFields ? row.presentFields.includes(field) : field in row) changes[field] = row[field];
          if (changes.decisionDate && !validBusinessDate(changes.decisionDate)) { reject(`Decision_Date '${changes.decisionDate}' is not a valid calendar date.`); continue; }
          const candidate = { ...item, ...changes };
          const kind = classifyProposal(item) || (historyFor(item,history).hasApproval ? 'APPROVED' : '');
          if (!['APPROVED','REJECTED','DO NOT PURCHASE'].includes(kind)) { reject('This proposal has no final decision. Resolve the preliminary or technical reply before importing final evidence.'); continue; }
          if (['APPROVED','REJECTED'].includes(kind)) {
            const validation = validateDecision({ ...candidate, clientDecision: kind });
            if (Object.keys(validation.errors).length) { reject(Object.values(validation.errors).join(' ')); continue; }
          }
          Object.assign(item,changes);
        } else Object.assign(item, decision.value);
        if(Object.hasOwn(row,'round'))item.round=cleanText(row.round);
        const projectedChanges={...item};
        // Final evidence import never changes the existing decision wording.
        // Do not turn its full-row snapshot into a new explicit decision edit.
        if(moduleId==='M08')delete projectedChanges.clientDecision;
        Object.assign(item, updateProposal(before, projectedChanges, history)); updated += 1;
        this.addAudit(rowContext, `WORKFLOW_${moduleId}_ROW_IMPORTED`, item.proposalId, `${filename} row ${row.sourceRow}`, before, structuredClone(item));
      }
    } else throw new Error(`${moduleId} is not an import workflow.`);
    const result = withImportFindings({moduleId,filename,imported,updated,skipped,...(moduleId==='M02'?{ignored}:{}),obsoleteRecorded,findings},context.importFindings);
    if (receiptKey) this.importReceipts.set(receiptKey, structuredClone(result));
    return result;
  }

  async runWorkflow(moduleId, context = {}, options = {}) {
    auditEventProvenance(context,this.auditRuntime);
    if(moduleId==='M11')return confirmMemoryArchiveReview(this,context,options);
    if(moduleId==='M90')return MemoryStorage.prototype.recordSetupValidation.call(this,validateSetup({schema:{mode:'local'},catalog:this.state.referenceCatalog||seedReferenceCatalog(),proposals:this.state.proposals,replacements:this.state.replacements,artifacts:null,orderNo:options.orderNo}),context);
    this.assertReferenceCurrent();
    context=copyAuditContext(context,{...context,sourceModule:moduleId,...(Object.hasOwn(options,'round')?{round:options.round}:{})});
    const previousRows=new Map(this.state.proposals.map(row=>[row.proposalId,structuredClone(row)]));
    const matchesOrder=item=>['M10','M91'].includes(moduleId)?normalize(item.orderNo)===normalize(options.orderNo):item.orderNo===options.orderNo;
    const scopedProposals = options.orderNo ? this.state.proposals.filter(matchesOrder) : this.state.proposals;
    const scopedReplacements = options.orderNo ? this.state.replacements.filter(matchesOrder) : this.state.replacements;
    const preview = previewWorkflow(moduleId, scopedProposals, scopedReplacements);
    const beforeCount = this.state.replacements.length;
    const history = ['M91','M10','M11'].includes(moduleId) ? createHistoryIndex(this.state.replacements) : null;
    let result = { ...preview, moduleId, status: "COMPLETED" };

    if (moduleId === "M91") {
      this.state.proposals = this.state.proposals.map((item) => !options.orderNo || matchesOrder(item) ? updateProposal(item, {}, history) : item);
    }

    if (moduleId === "M10") {
      const plan=planDecisionRecording(scopedProposals,this.state.replacements);
      for (const {proposal,dispositionIndex} of plan.additions) {
        const record={
          recordId: `DB-${randomUUID()}`,
          proposalId: proposal.proposalId,
          orderNo: proposal.orderNo,
          supplier: proposal.supplier,
          product: proposal.product,
          productDecimalNo: proposal.productDecimalNo,
          productCode: proposal.productCode,
          position: proposal.position,
          origCode: proposal.origCode,
          origMfr: proposal.origMfr,
          origPn: proposal.origPn,
          componentStatus: proposal.componentStatus,
          altMfr: proposal.altMfr,
          altPn: proposal.altPn,
          decisionStatus: proposal.clientDecision,
          productionOrder: proposal.productionOrder,
          responsible: proposal.responsible,
          decisionReference: proposal.decisionReference,
          decisionDate: proposal.decisionDate,
          decisionComment: proposal.clientComment,
          notes: proposal.notes || "",
          sourceSheet: "Application",
          sourceRow: null,
          rowVersion: 1
        };this.state.replacements.push(record);history.add(record);this.addAudit(context,'DATABASE_RECORD_CREATED',record.recordId,'M10 recorded decision',null,structuredClone(record));
        plan.dispositions[dispositionIndex].recordId=record.recordId;
      }
      result = { ...result, ...decisionRecordingResult(plan,this.state.replacements.length) };
      this.state.proposals = this.state.proposals.map(item => !options.orderNo || matchesOrder(item) ? updateProposal(item, {}, history) : item);
    }

    for(const item of this.state.proposals){const before=previousRows.get(item.proposalId);if(before&&JSON.stringify(before)!==JSON.stringify(item))this.addAudit(context,`WORKFLOW_${moduleId}_ROW_UPDATED`,item.proposalId,'Workflow state transition',before,structuredClone(item));}
    const run = {
      id: this.state.workflowRuns.length + 1,
      moduleId,
      occurredAt: new Date().toISOString(),
      actor: context.actor || "Local user",
      role: context.role || "ADMINISTRATOR",
      ...workflowAttribution(context,workflowRowScope(scopedProposals)),
      result
    };
    this.state.workflowRuns.unshift(run);
    this.addAudit(context, `WORKFLOW_${moduleId}`, moduleId, `${result.status}: ${result.message || "workflow executed"}; database ${beforeCount}→${this.state.replacements.length}`);
    return run;
  }

  async listWorkflowRuns(options={},context={}) {
    return memoryWorkflowRuns(this.state.workflowRuns,options,context);
  }
  async prepareArchiveReview(context,body){auditEventProvenance(context,this.auditRuntime);return prepareMemoryArchiveReview(this,context,body);}
  async manageRound(context,body){auditEventProvenance(context,this.auditRuntime);return withMemoryRoundMutation(this,()=>manageMemoryRound(this,context,body));}
  async associateRoundExchanges(context,body){auditEventProvenance(context,this.auditRuntime);return withMemoryRoundMutation(this,()=>associateMemoryRoundExchanges(this,context,body));}
  async getRoundManagement(id,context){return getMemoryRoundManagement(this,id,context);}
  async getArchiveReview(id,context){return getMemoryArchiveReview(this,id,context);}

  async recordSetupValidation(report,context={}) {
    auditEventProvenance(context,this.auditRuntime);
    if(context.role!=='ADMINISTRATOR')throw Object.assign(new Error('Only an administrator can run setup validation.'),{status:403});
    const run={id:this.state.workflowRuns.length+1,moduleId:'M90',occurredAt:new Date().toISOString(),actor:context.actor||'Local administrator',role:context.role,...workflowAttribution(context,{scopeKnown:false,orderKeys:[],supplierKeys:[]}),result:structuredClone(report)};
    this.state.workflowRuns.unshift(run);
    this.addAudit(context,'WORKFLOW_M90','M90',`${report.status}: ${report.message||'Setup validation'}`,null,structuredClone(report));
    return run;
  }

  async retainedExportReceipt(exportJobId){const run=this.state.workflowRuns.find(run=>run.result?.exportJobId===exportJobId&&run.result.status==='EXPORTED');return run?structuredClone({moduleId:run.moduleId,occurredAt:run.occurredAt,result:run.result}):null;}
  async recordExport(moduleId,context,result) {
    auditEventProvenance(context,this.auditRuntime);
    if(['AUDIT','REGISTER_REPORT'].includes(moduleId)){this.state.reportReceipts||={};if(this.state.reportReceipts[result.exportJobId])return this.state.reportReceipts[result.exportJobId];const receipt={result:structuredClone(result)};this.state.reportReceipts[result.exportJobId]=receipt;this.addAudit(context,moduleId==='AUDIT'?'AUDIT_REPORT_ISSUED':'REGISTER_REPORT_ISSUED',result.exportJobId,result.filename,null,structuredClone(result));return receipt;}
    if(result.exportJobId){const prior=this.state.workflowRuns.find(run=>run.result.exportJobId===result.exportJobId);if(prior)return prior;}
    const run={id:this.state.workflowRuns.length+1,moduleId,occurredAt:new Date().toISOString(),actor:context.actor||'Local user',role:context.role||'ADMINISTRATOR',...workflowAttribution(context,workflowExportScope(result)),result:{...result,status:'EXPORTED',message:`${result.affected} row(s) exported to ${result.files.length} archived file(s).`}};
    this.state.workflowRuns.unshift(run);this.addAudit(context,`WORKFLOW_${moduleId}_EXPORTED`,moduleId,run.result.message,null,structuredClone(run.result));return run;
  }

  checkPermitMetadata(plan,context,jobId) {
    if(context.role!=='ADMINISTRATOR')throw Object.assign(new Error('Only an administrator can update product codes for deviation permits.'),{status:403,code:'M07_METADATA_FORBIDDEN'});
    const prior=this.state.permitMetadataReceipts?.[jobId];
    if(prior){if(prior.digest!==permitPlanDigest(plan))throw Object.assign(new Error('The saved product-code receipt does not match this export.'),{status:409,code:'M07_METADATA_INVALID'});return [];}
    return validatePermitMetadata(plan,this.state.proposals,context);
  }
  async applyPermitMetadata(plan,context,jobId) {
    auditEventProvenance(context,this.auditRuntime);
    const prior=this.state.permitMetadataReceipts?.[jobId];const changes=this.checkPermitMetadata(plan,context,jobId);
    if(prior)return prior.updated;
    for(const {row,update} of changes){const before=structuredClone(row);row.productCode=update.after;row.rowVersion=Number(row.rowVersion||1)+1;this.addAudit(context,'M07_PRODUCT_CODE_UPDATED',row.proposalId,`Export ${jobId}: Product_1C_Code ${update.before||'(empty)'} → ${update.after}`,before,structuredClone(row));}
    (this.state.permitMetadataReceipts||={})[jobId]={digest:permitPlanDigest(plan),updated:changes.length};
    return changes.length;
  }

  async listAudit() {
    return structuredClone(this.state.audit);
  }
  async reviewSnapshot(){return {state:structuredClone(this.state),importReceipts:structuredClone([...this.importReceipts]),sourceSha256:sourceMetadata.sourceSha256,capturedAt:new Date().toISOString()};}
}

// Durable single-process local review. Production named accounts require SQL;
// this mode preserves desktop review edits before the server is configured.
const previewFailure=(code,message,status=409)=>Object.assign(new Error(message),{status,code});
const previewBytesHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function readPreviewFile(filename){
  try{const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink())throw previewFailure('LOCAL_PREVIEW_PATH_INVALID','The preview state must be a regular file.');const bytes=await fs.readFile(filename);return {bytes,sha256:previewBytesHash(bytes)};}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function withPreviewWriteLock(filename,operation){
  const target=path.resolve(filename),directory=path.dirname(target);await fs.mkdir(directory,{recursive:true});
  if(await fs.realpath(directory)!==directory)throw previewFailure('LOCAL_PREVIEW_PATH_INVALID','The preview folder must not be redirected.');
  const lock=target+'.write-lock',token=randomUUID();let handle;
  try{handle=await fs.open(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw previewFailure('LOCAL_PREVIEW_BUSY','The preview is being saved or refreshed. Retry after that operation finishes.');throw error;}
  const owned=await handle.stat();let initialized=false;
  try{await handle.writeFile(token);await handle.sync();initialized=true;return await operation();}
  finally{await handle.close();const retained=await fs.lstat(lock);if(retained.isFile()&&!retained.isSymbolicLink()&&retained.ino===owned.ino&&retained.dev===owned.dev&&(!initialized||await fs.readFile(lock,'utf8')===token))await fs.unlink(lock);else throw previewFailure('LOCAL_PREVIEW_LOCK_CHANGED','The preview write lock changed. Reload the saved preview before continuing.');}
}
export class FilePreviewStorage extends MemoryStorage {
  constructor(filename,{auditRuntime=null}={}) { super({auditRuntime}); this.filename = path.resolve(filename); this.queue = Promise.resolve(); this.envelopeMetadata={sourceSha256:sourceMetadata.sourceSha256};this.loadedFileHash=null;this.writeUncertain=false; }
  async initialize() {
    try {
      const stored=await readPreviewFile(this.filename);if(!stored)return this;const saved = JSON.parse(stored.bytes.toString('utf8'));
      for (const key of ["proposals", "replacements", "audit", "workflowRuns"]) if (!Array.isArray(saved.state?.[key])) throw new Error(`Invalid local review state: ${key}`);
      const {state,importReceipts,...metadata}=saved;this.envelopeMetadata=metadata;this.loadedFileHash=stored.sha256;
      this.state = saved.state;
      this.proposalAllocationSnapshot=captureProposalAllocationSnapshot(this.state.proposals);
      migrateMemoryDecisionAudit(this.state);
      migrateMemoryWorkflowAudit(this.state);
      this.state.importBatches ||= [];
      this.importReceipts = new Map(saved.importReceipts || []);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return this;
  }
  previewSourceInfo(){const loaded=typeof this.envelopeMetadata.sourceSha256==='string'?this.envelopeMetadata.sourceSha256:'',{sourcePath,...publicMetadata}=sourceMetadata;return {...publicMetadata,sourceSha256:loaded,bundledSourceSha256:sourceMetadata.sourceSha256,sourceState:!loaded?'UNKNOWN':loaded===sourceMetadata.sourceSha256?'CURRENT_HASH':'PREVIOUS_HASH',provenanceKind:this.envelopeMetadata.sourceProvenance?'ADOPTION_RECEIPT_RECORDED':'LOADED_ENVELOPE_CLAIM',...(this.writeUncertain?{persistenceState:'RELOAD_REQUIRED'}:{})};}
  async sourceInfo(){await this.queue;return this.previewSourceInfo();}
  async health() { return { storage: "local-file", database: "Saved local review", source:await this.sourceInfo() }; }
  async persist() {
    if(this.writeUncertain)throw previewFailure('LOCAL_PREVIEW_WRITE_UNCERTAIN','The previous save could not be confirmed. Reload the saved preview before continuing.',503);
    const bytes=Buffer.from(JSON.stringify({...this.envelopeMetadata,state:this.state,importReceipts:[...this.importReceipts]})),nextHash=previewBytesHash(bytes);
    await withPreviewWriteLock(this.filename,async()=>{const stored=await readPreviewFile(this.filename);if((stored?.sha256??null)!==this.loadedFileHash)throw previewFailure('LOCAL_PREVIEW_STATE_CHANGED','The saved preview changed in another process. Reload it before saving again.');
      try{await replacePrivateFile(this.filename,bytes);this.loadedFileHash=nextHash;}
      catch(error){const observed=await readPreviewFile(this.filename).catch(()=>null);if((observed?.sha256??null)!==this.loadedFileHash){this.writeUncertain=true;throw previewFailure('LOCAL_PREVIEW_WRITE_UNCERTAIN','The save result could not be confirmed. Reload the saved preview before continuing.',503);}throw error;}
    });
  }
  mutate(operation) {
    const task = this.queue.then(async () => {
      const before = structuredClone(this.state); const receipts = new Map(this.importReceipts); const sequenceFloor=this.proposalSequenceFloor,allocationSnapshot=structuredClone(this.proposalAllocationSnapshot),metadata=structuredClone(this.envelopeMetadata),loadedHash=this.loadedFileHash;
      try { this.assertReferenceCurrent();const result = await operation(); await this.persist(); return result; }
      catch (error) { this.state = before; this.importReceipts = receipts; this.proposalSequenceFloor=sequenceFloor;this.proposalAllocationSnapshot=allocationSnapshot;this.envelopeMetadata=metadata;this.loadedFileHash=loadedHash; throw error; }
    });
    this.queue = task.catch(() => {}); return task;
  }
  saveDecision(...args) { return this.mutate(() => super.saveDecision(...args)); }
  updateReplacement(...args) { return this.mutate(() => super.updateReplacement(...args)); }
  deleteReplacement(...args) { return this.mutate(() => super.deleteReplacement(...args)); }
  importWorkflowRows(...args) { return this.mutate(() => super.importWorkflowRows(...args)); }
  stageImport(...args) { return this.mutate(() => super.stageImport(...args)); }
  async captureImportPreparation(...args){await this.queue;return super.captureImportPreparation(...args);}
  savePreparedImport(...args){return this.mutate(()=>super.savePreparedImport(...args));}
  commitImportBatch(...args) { return this.mutate(() => super.commitImportBatch(...args)); }
  runWorkflow(...args) { return this.mutate(() => super.runWorkflow(...args)); }
  prepareArchiveReview(...args){return this.mutate(()=>super.prepareArchiveReview(...args));}
  manageRound(...args){return this.mutate(()=>super.manageRound(...args));}
  associateRoundExchanges(...args){return this.mutate(()=>super.associateRoundExchanges(...args));}
  async getRoundManagement(...args){await this.queue;return super.getRoundManagement(...args);}
  async getArchiveReview(...args){await this.queue;return super.getArchiveReview(...args);}
  recordExport(...args) { return this.mutate(() => super.recordExport(...args)); }
  async retainedExportReceipt(...args){await this.queue;return super.retainedExportReceipt(...args);}
  recordSetupValidation(...args) { return this.mutate(() => super.recordSetupValidation(...args)); }
  applyPermitMetadata(...args) { return this.mutate(() => super.applyPermitMetadata(...args)); }
  changeReferenceEntry(...args){return this.mutate(()=>super.changeReferenceEntry(...args));}
  async getReferenceCatalog(){await this.queue;return super.getReferenceCatalog();}
  async listReferenceHistory(){await this.queue;return super.listReferenceHistory();}
  async getReferenceRevision(...args){await this.queue;return super.getReferenceRevision(...args);}
  async previewReferenceEntry(...args){await this.queue;return super.previewReferenceEntry(...args);}
  async listDecisionHistory(...args){await this.queue;return super.listDecisionHistory(...args);}
  async listAudit(){await this.queue;return super.listAudit();}
  async reviewSnapshot(){await this.queue;const result=await super.reviewSnapshot();return {...result,sourceSha256:this.previewSourceInfo().sourceSha256,sourceProvenance:structuredClone(this.envelopeMetadata.sourceProvenance||null),bundledSourceSha256:sourceMetadata.sourceSha256};}
  async listRounds(...args){await this.queue;return super.listRounds(...args);}
  async getRoundEvents(...args){await this.queue;return super.getRoundEvents(...args);}
  async getExchangeSnapshots(...args){await this.queue;return super.getExchangeSnapshots(...args);}
  async checkPermitMetadataReady(...args){await this.queue;return super.checkPermitMetadata(...args);}
  async exportState(...args){await this.queue;return super.exportState(...args);}
}

export class PostgresStorage {
  constructor(pool,{auditRuntime=null}={}) {
    // An adapter may freeze its pool/client methods. Delegate through an
    // extensible empty target so bound methods and the BEGIN hook do not
    // violate Proxy invariants for frozen own properties on those objects.
    const delegate=(source,read)=>new Proxy({}, {
      get(_target,key){const value=read?.(key);if(value!==undefined)return value;const original=Reflect.get(source,key,source);return typeof original==='function'?original.bind(source):original;},
      set(_target,key,value){return Reflect.set(source,key,value,source);},
      defineProperty(_target,key,descriptor){return Reflect.defineProperty(source,key,descriptor);},
      deleteProperty(_target,key){return Reflect.deleteProperty(source,key);},
      has(_target,key){return Reflect.has(source,key);},
      ownKeys(){return Reflect.ownKeys(source);},
      getOwnPropertyDescriptor(_target,key){const descriptor=Reflect.getOwnPropertyDescriptor(source,key);return descriptor?{...descriptor,configurable:true}:undefined;},
      getPrototypeOf(){return Reflect.getPrototypeOf(source);},
      preventExtensions(){return false;}
    });
    this.rawPool=pool;
    this.auditRuntime=auditRuntime;
    this.pool=delegate(pool,key=>{
      if(key==='connect')return async()=>{const client=await pool.connect();return delegate(client,method=>{
        if(method==='query')return async(...args)=>{const result=await client.query(...args);if(typeof args[0]==='string'&&/^begin\b/i.test(args[0])&&currentReferenceContext()?.revision){const current=(await client.query(`select revision from ${rr}.reference_catalog where singleton=true for share`)).rows[0]?.revision;if(current!==currentReferenceContext().revision)throw Object.assign(new Error('Reference data changed. Refresh the page and review before retrying.'),{status:409,code:'REFERENCE_CHANGED',current:{revision:current}});}return result;};
      });};
    });
  }
  async getReferenceCatalog(){
    let row=(await this.rawPool.query(`select catalog_json from ${rr}.reference_catalog where singleton=true`)).rows[0];
    if(!row){const catalog=seedReferenceCatalog(),client=await this.rawPool.connect();try{await client.query('begin');await client.query(`insert into ${rr}.reference_catalog(singleton,revision,catalog_hash,catalog_json) values(true,1,$1,$2) on conflict do nothing`,[catalog.hash,catalog]);await client.query(`insert into ${rr}.reference_revisions(revision,catalog_hash,catalog_json,actor,reason,change_json) values(1,$1,$2,'Authoritative workbook','Initial source snapshot',$3) on conflict do nothing`,[catalog.hash,catalog,{kind:'SOURCE_IMPORT',source:catalog.source}]);await client.query('commit');}catch(error){await client.query('rollback');throw error;}finally{client.release();}row=(await this.rawPool.query(`select catalog_json from ${rr}.reference_catalog where singleton=true`)).rows[0];}
    if(catalogHash(row.catalog_json)!==row.catalog_json.hash)throw Object.assign(new Error('Reference catalog integrity check failed. Restore a verified catalog backup before continuing.'),{status:409,code:'REFERENCE_INTEGRITY'});return row.catalog_json;
  }
  async recordSetupValidation(report,context={}, {transaction=null}={}) {
    if(context.role!=='ADMINISTRATOR')throw Object.assign(new Error('Only an administrator can run setup validation.'),{status:403});
    const client=transaction||await this.rawPool.connect();
    try{
      if(!transaction)await client.query('begin');
      if(context.authenticated){
        await client.query('select pg_advisory_xact_lock_shared(78742002)');
        const account=(await client.query(`select enabled,role,must_change_password from ${rr}.users where user_id=$1 for share`,[context.userId])).rows[0];
        if(!account?.enabled||account.role!=='ADMINISTRATOR'||account.must_change_password)throw Object.assign(new Error('Administrator access changed. Sign in again before running setup validation.'),{status:403,code:'ADMIN_ACCESS_CHANGED'});
      }
      const run=await insertSqlWorkflowRun(client,{moduleId:'M90',actor:context.actor||'Administrator',role:context.role,...workflowAttribution(context,{scopeKnown:false,orderKeys:[],supplierKeys:[]}),result:structuredClone(report)});
      await this.writeAudit(client,context,'WORKFLOW_M90','M90',`${report.status}: ${report.message||'Setup validation'}`,null,report);
      if(!transaction)await client.query('commit');return run;
    }catch(error){if(!transaction)await client.query('rollback').catch(()=>{});if(!error.status)Object.assign(error,{status:503,code:'SETUP_REPORT_NOT_SAVED',details:[`Validation result: ${report.status}. The validation report and audit could not be saved; repair the audit schema or connection and retry.`]});throw error;}finally{if(!transaction)client.release();}
  }
  async listReferenceHistory(){const rows=(await this.rawPool.query(`select revision,catalog_hash,actor,actor_user_id,reason,change_json,created_at from ${rr}.reference_revisions order by revision desc`)).rows;return rows.map(row=>({revision:row.revision,hash:row.catalog_hash,actor:row.actor,actorUserId:row.actor_user_id,reason:row.reason,change:row.change_json,createdAt:row.created_at.toISOString()}));}
  async getReferenceRevision(revision){return (await this.rawPool.query(`select catalog_json from ${rr}.reference_revisions where revision=$1`,[revision])).rows[0]?.catalog_json||null;}
  async previewReferenceEntry(body,context){
    if(context.role!=='ADMINISTRATOR')throw Object.assign(new Error('Only an administrator can moderate reference data.'),{status:403});
    await this.getReferenceCatalog();const client=await this.rawPool.connect();
    try{await client.query('begin isolation level repeatable read read only');const catalog=(await client.query(`select catalog_json from ${rr}.reference_catalog where singleton=true`)).rows[0].catalog_json;const rows=(await client.query(`select * from ${rr}.proposals order by proposal_id`)).rows.map(rowToProposal),ledger=await loadLedger(client);const result=referencePreview(referencePlan(catalog,body,context,rows,ledger),catalog);await client.query('commit');return result;}
    catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async changeReferenceEntry(body,context){
    if(context.role!=='ADMINISTRATOR')throw Object.assign(new Error('Only an administrator can moderate reference data.'),{status:403});
    await this.getReferenceCatalog();const client=await this.rawPool.connect();
    try{
      await client.query('begin');const catalog=(await client.query(`select catalog_json from ${rr}.reference_catalog where singleton=true for update`)).rows[0].catalog_json;
      const rows=(await client.query(`select * from ${rr}.proposals order by proposal_id for update`)).rows.map(rowToProposal),ledger=await loadLedger(client);let affected=0;
      const plan=referencePlan(catalog,body,context,rows,ledger);if(!plan.changed){await client.query('commit');return {catalog,changed:false,affected:0};}
      if(plan.action){
        for(const item of plan.lifecycleUpdates||[])await client.query(`update ${rr}.lifecycle_records set original_key=$2,supplier_key=$3 where record_id=$1`,[item.recordId,item.originalKey,item.supplierKey]);
      }
      await withCatalog(plan.catalog,async()=>{const history=createHistoryIndex(ledger);for(const before of rows){const item=updateProposal(before,{},history);if(item.rowVersion===before.rowVersion)continue;affected++;
        await client.query(`update ${rr}.proposals set workflow_status=$2,can_record=$3,row_version=$4,normalized_json=$5,historical_status=$6,historical_reference=$7,historical_date=$8,manufacturer_relationship=$9,component_status=$10,client_decision=$11,client_comment=$12,updated_at=now() where proposal_id=$1`,[item.proposalId,item.workflowStatus,item.canRecord,item.rowVersion,normalizedProjection(item),item.historicalStatus,item.historicalReference||'',item.historicalDate||null,item.manufacturerRelationship,item.componentStatus,item.clientDecision,item.clientComment]);
        await this.writeAudit(client,context,'REFERENCE_PROJECTION_UPDATED',item.proposalId,`Reference revision ${plan.catalog.revision}`,before,item);
      }});
      const change={kind:plan.kind,before:plan.before,after:plan.after,affected,...referenceOperation(plan)};
      await client.query(`update ${rr}.reference_catalog set revision=$1,catalog_hash=$2,catalog_json=$3,updated_at=now() where singleton=true`,[plan.catalog.revision,plan.catalog.hash,plan.catalog]);
      await client.query(`insert into ${rr}.reference_revisions(revision,catalog_hash,catalog_json,actor,actor_user_id,reason,change_json) values($1,$2,$3,$4,$5,$6,$7)`,[plan.catalog.revision,plan.catalog.hash,plan.catalog,context.actor||'Local administrator',context.userId||null,plan.reason,change]);
      await this.writeAudit(client,context,'REFERENCE_UPDATED',plan.after.id,plan.reason,{revision:catalog.revision,entry:plan.before},{revision:plan.catalog.revision,entry:plan.after,affected,...referenceOperation(plan)});
      await client.query('commit');return {catalog:plan.catalog,affected,changed:true,...referenceOperation(plan)};
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async exportState(context,options={},{workingOrder=false}={}) {
    const client=await this.pool.connect();
    try{await client.query('begin isolation level repeatable read');if(workingOrder)await assertProposalWorkingOrderSchema(client);const asOf=(await client.query('select transaction_timestamp() as time')).rows[0].time.toISOString();const memory=await this.importSnapshot(client);const result=await memory.exportState(context,options);copyProposalWorkingOrder(memory.state.proposals,result.proposals);await client.query('commit');return {...result,asOf};}
    catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }

  async applyPermitMetadata(plan,context,jobId,transaction=null) {
    const client=transaction||await this.pool.connect();
    try {
      if(!transaction)await client.query('begin');
      const rows=(await client.query(`select * from ${rr}.proposals where archived=false order by proposal_id for update`)).rows.map(rowToProposal);
      const changes=validatePermitMetadata(plan,rows,context);
      for(const {row,update} of changes) {
        const result=await client.query(`update ${rr}.proposals set product_code=$2,row_version=row_version+1,updated_at=now() where proposal_id=$1 and row_version=$3 returning row_version`,[row.proposalId,update.after,update.rowVersion]);
        if(!result.rowCount)throw Object.assign(new Error('The product-code row changed after review. Prepare a new M07 export.'),{status:409,code:'M07_METADATA_CHANGED'});
        await this.writeAudit(client,context,'M07_PRODUCT_CODE_UPDATED',row.proposalId,`Export ${jobId}: Product_1C_Code ${update.before||'(empty)'} → ${update.after}`,row,{...row,productCode:update.after,rowVersion:Number(result.rows[0].row_version)});
      }
      if(!transaction)await client.query('commit');return changes.length;
    }catch(error){if(!transaction)await client.query('rollback');throw error;}finally{if(!transaction)client.release();}
  }

  async changeLifecycle(id,changes,context) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const row = (await client.query(`select * from ${rr}.lifecycle_records where record_id=$1 for update`,[id])).rows[0];
      if (!row) { await client.query('rollback'); return null; }
      const before = rowToLifecycle(row); checkVersion(before,context);
      const after = changes ? {...before,...changes,rowVersion:before.rowVersion+1} : null;
      if (after && after.decisionStatus !== 'OBSOLETE') throw Object.assign(new Error('A lifecycle record cannot become a replacement approval.'),{status:422});
      if (after) await client.query(`update ${rr}.lifecycle_records set payload=$2,row_version=row_version+1,updated_at=now() where record_id=$1`,[id,after]);
      else await client.query(`delete from ${rr}.lifecycle_records where record_id=$1`,[id]);
      await this.writeAudit(client,context,changes?'DATABASE_RECORD_MODERATED':'DATABASE_RECORD_DELETED',id,context.reason,before,after);
      await client.query('commit'); return after || before;
    } catch(error) { await client.query('rollback'); throw error; }
    finally {client.release();}
  }

  async health() {
    const result = await this.pool.query("select current_database() as database, version() as version");
    return { storage: "postgres", database: result.rows[0].database, version: result.rows[0].version, source: sourceMetadata };
  }

  async sourceInfo() { return sourceMetadata; }

  async listProposals(filters = {}) {
    const values = [];
    const where = [];
    const add = (sql, value) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
    if (!filters.includeArchived) where.push("archived = false");
    if (filters.decision) add("client_decision = ?", filters.decision);
    if (filters.product) add("product_decimal_no = ?", filters.product);
    if (filters.orderNo) add("order_no = ?", filters.orderNo);
    if (filters.supplier) add("supplier = ?", filters.supplier);
    if (filters.search) add("search_text @@ plainto_tsquery('simple', lower(? collate replacement_register.search_unicode))", filters.search);
    const result = await this.pool.query(`select * from ${rr}.proposals ${where.length ? `where ${where.join(" and ")}` : ""} order by proposal_id`, values);
    return result.rows.map(rowToProposal);
  }

  async getProposal(id) {
    const result = await this.pool.query(`select * from ${rr}.proposals where proposal_id = $1`, [id]);
    return result.rows[0] ? rowToProposal(result.rows[0]) : null;
  }

  async writeAudit(client, context, action, subject, detail, before = null, after = null) {
    const provenance=serializeEventProvenance(context,this.auditRuntime);
    const result=await client.query(
      `insert into ${rr}.audit_events(actor, actor_role, action, subject, detail, before_json, after_json,actor_user_id,request_id,provenance_json) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) returning id,occurred_at`,
      [context.actor || "Local user", context.role || "ADMINISTRATOR", action, subject, detail, before, after, context.userId || null, context.requestId || null,provenance]
    );
    const audit={id:result.rows[0].id,occurredAt:result.rows[0].occurred_at.toISOString(),actor:context.actor||'Local user',actorUserId:context.userId||null,requestId:context.requestId||null,role:context.role||'ADMINISTRATOR',action,subject,detail,before,after,decisionSource:historySource(context,after||before)};
    await appendSqlDecisionAudit(client,audit);await appendSqlWorkflowAudit(client,{...audit,workflowExchange:context.workflowExchange});
  }
  async listDecisionHistory(filters,context){return sqlDecisionHistory(this.pool,filters,context);}
  async listRounds(filters,context){return sqlRounds(this.pool,filters,context);}
  async getRoundEvents(id,filters,context){return sqlRoundEvents(this.pool,id,filters,context);}
  async getExchangeSnapshots(id,filters,context){return sqlExchangeSnapshots(this.pool,id,filters,context);}

  async saveDecision(id, decision, context = {}) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const beforeResult = await client.query(`select * from ${rr}.proposals where proposal_id=$1 for update`, [id]);
      if (!beforeResult.rows[0]) { await client.query("rollback"); return null; }
      const before = rowToProposal(beforeResult.rows[0]);
      if (context.authenticated && !canAccess(context,before)) throw Object.assign(new Error('Proposal not found.'),{status:404});
      checkVersion(before, context);
      const replacements = await loadProposalHistory(client, {...before,...decision});
      const recalculated = updateProposal(before, decision, replacements);
      const result = await client.query(
        `update ${rr}.proposals set client_decision=$2, client_comment=$3, responsible=$4, decision_reference=$5,
          decision_date=$6, workflow_status=$7, can_record=$8, row_version=$9, normalized_json=$10,historical_status=$11,historical_reference=$12,historical_date=$13,manufacturer_relationship=$14,component_status=$15,updated_at=now()
         where proposal_id=$1 returning *`,
        [id, decision.clientDecision, decision.clientComment, decision.responsible, decision.decisionReference || null,
          decision.decisionDate || null, recalculated.workflowStatus, recalculated.canRecord,recalculated.rowVersion,normalizedProjection(recalculated),recalculated.historicalStatus,recalculated.historicalReference,recalculated.historicalDate||null,recalculated.manufacturerRelationship,recalculated.componentStatus]
      );
      await this.writeAudit(client, context, "DECISION_UPDATED", id, `${decision.clientDecision} · ${decision.decisionReference || "no reference"}`, rowToProposal(beforeResult.rows[0]), rowToProposal(result.rows[0]));
      await client.query("commit");
      return rowToProposal(result.rows[0]);
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async listReplacements(filters = {}) {
    const values = [];
    const where = [];
    const add = (sql, value) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
    if (filters.decision) add("decision_status = ?", filters.decision);
    if (filters.product) add("product_decimal_no = ?", filters.product);
    if (filters.orderNo) add("order_no = ?", filters.orderNo);
    if (filters.search) add("search_text @@ plainto_tsquery('simple', lower(? collate replacement_register.search_unicode))", filters.search);
    const result = await this.pool.query(`select * from ${rr}.replacement_records ${where.length ? `where ${where.join(" and ")}` : ""} order by ledger_position`, values);
    const lifecycle = (await this.pool.query(`select * from ${rr}.lifecycle_records order by created_at,record_id`)).rows.map(rowToLifecycle).filter(item =>
      (!filters.decision || item.decisionStatus === filters.decision) && (!filters.product || item.productDecimalNo === filters.product) && (!filters.orderNo || item.orderNo === filters.orderNo) && matchesSearch(item,filters.search,['recordId','orderNo','product','productDecimalNo','origMfr','origPn','supplier','notes']));
    return [...result.rows.map(rowToReplacement),...lifecycle];
  }

  async getReplacement(id) {
    if (id.startsWith('LC-')) { const result = await this.pool.query(`select * from ${rr}.lifecycle_records where record_id=$1`,[id]); return result.rows[0] ? rowToLifecycle(result.rows[0]) : null; }
    const result = await this.pool.query(`select * from ${rr}.replacement_records where record_id=$1`, [id]);
    return result.rows[0] ? rowToReplacement(result.rows[0]) : null;
  }

  async captureReplacementDetail(id,context) {
    return captureSqlRecordDetail({pool:this.rawPool,id,context,toReplacement:rowToReplacement,toLifecycle:rowToLifecycle});
  }

  async updateReplacement(id, changes, context = {}) {
    if (id.startsWith('LC-')) return this.changeLifecycle(id,changes,context);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const before = await client.query(`select * from ${rr}.replacement_records where record_id=$1 for update`, [id]);
      if (!before.rows[0]) { await client.query("rollback"); return null; }
      checkVersion(rowToReplacement(before.rows[0]), context);
      const result = await client.query(
        `update ${rr}.replacement_records set decision_status=$2, responsible=$3, decision_reference=$4,
          decision_date=$5, decision_comment=$6, notes=$7, row_version=row_version+1, updated_at=now()
         where record_id=$1 returning *`,
        [id, changes.decisionStatus, changes.responsible, changes.decisionReference || null,
          changes.decisionDate || null, changes.decisionComment || "", changes.notes || ""]
      );
      await this.writeAudit(client, context, "DATABASE_RECORD_MODERATED", id, context.reason, rowToReplacement(before.rows[0]), rowToReplacement(result.rows[0]));
      await client.query("commit");
      return rowToReplacement(result.rows[0]);
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async deleteReplacement(id, context = {}) {
    if (id.startsWith('LC-')) return this.changeLifecycle(id,null,context);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const before = await client.query(`select * from ${rr}.replacement_records where record_id=$1 for update`, [id]);
      if (!before.rows[0]) { await client.query("rollback"); return null; }
      checkVersion(rowToReplacement(before.rows[0]), context);
      await client.query(`delete from ${rr}.replacement_records where record_id=$1`, [id]);
      const deleted = rowToReplacement(before.rows[0]);
      await this.writeAudit(client, context, "DATABASE_RECORD_DELETED", id, context.reason, deleted, null);
      await client.query("commit");
      return deleted;
    } catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }

  async importSnapshot(client=this.pool,{lock=false,inputKey=null,moduleId=null,context={}}={}) {
    const memory=new MemoryStorage({trackDecisionEvents:false,auditRuntime:this.auditRuntime});
    const rawProposals=(await client.query(`select * from ${rr}.proposals order by proposal_id${lock?' for update':''}`)).rows;
    memory.state.proposals=bindProposalWorkingOrder(rawProposals.map(rowToProposal),rawProposals);
    memory.proposalSequenceFloor=Math.max(0,...memory.state.proposals.map(item=>Number(String(item.proposalId).match(/-(\d{1,8})$/)?.[1]||0)));
    memory.proposalAllocationSnapshot=captureProposalAllocationSnapshot(memory.state.proposals);
    memory.state.replacements=await loadLedger(client);
    if(inputKey){const row=(await client.query(`select result_json from ${rr}.import_receipts where module_id=$1 and source_hash=$2 and scope=$3`,[moduleId,inputKey,context.userId||'preview'])).rows[0];if(row)memory.importReceipts.set(`${moduleId}:${inputKey}:${context.userId||'preview'}`,row.result_json);}
    return memory;
  }
  async listImportBatches(context) {
    const rows=(await this.pool.query(`select payload from ${rr}.import_batches${context.role==='ADMINISTRATOR'?'':' where owner_user_id=$1'} order by created_at desc limit 100`,context.role==='ADMINISTRATOR'?[]:[context.userId||null])).rows;
    return rows.map(row=>row.payload).filter(batch=>batchAccess(batch,context)).map(batchSummary);
  }
  async getImportBatch(id,context) {return requireBatch((await this.pool.query(`select payload from ${rr}.import_batches where batch_id=$1`,[id])).rows[0]?.payload,context);}
  async captureImportPreparation(data,context,previousId=null,revision=null) {
    const client=await this.rawPool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      const reference=(await client.query(`select catalog_hash from ${rr}.reference_catalog where singleton=true`)).rows[0];
      if(currentReferenceContext()?.hash&&reference?.catalog_hash!==currentReferenceContext().hash)throw Object.assign(new Error('Reference data changed. Refresh the import preview before retrying.'),{status:409,code:'REFERENCE_CHANGED'});
      const previous=previousId?requireBatch((await client.query(`select payload from ${rr}.import_batches where batch_id=$1`,[previousId])).rows[0]?.payload,context):null;checkImportRefresh(previous,revision);
      const memory=await this.importSnapshot(client,{inputKey:importInputKey(data.sourceHash,data.options||{},data.error?null:data.rows||[]),moduleId:data.moduleId,context});
      const result={state:{proposals:memory.state.proposals,replacements:memory.state.replacements},proposalSequenceFloor:memory.proposalSequenceFloor,proposalAllocationSnapshot:structuredClone(memory.proposalAllocationSnapshot),receipts:[...memory.importReceipts],previous};
      await client.query('commit');return result;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async savePreparedImport(batch,context,transaction=null) {
    const client=transaction||await this.pool.connect();
    try {
      if(!transaction)await client.query('begin');
      const stored=(await client.query(`select payload from ${rr}.import_batches where batch_id=$1 for update`,[batch.batchId])).rows[0]?.payload;
      if(stored?.preparedByJobId===batch.preparedByJobId){if(!transaction)await client.query('commit');return requireBatch(stored,context);}
      const previous=batch.revision>1?requireBatch(stored,context):null;
      if(batch.revision===1&&stored)throw Object.assign(new Error('This import identity already exists.'),{status:409,code:'IMPORT_REVIEW_CHANGED'});
      checkImportRefresh(previous,batch.revision-1);
      if(previous)await client.query(`update ${rr}.import_batches set status=$2,revision=$3,payload=$4,updated_at=now() where batch_id=$1`,[batch.batchId,batch.status,batch.revision,batch]);
      else await client.query(`insert into ${rr}.import_batches(batch_id,module_id,artifact_id,owner_user_id,status,revision,payload) values($1,$2,$3,$4,$5,$6,$7)`,[batch.batchId,batch.moduleId,batch.artifactId,batch.ownerUserId,batch.status,batch.revision,batch]);
      await client.query(`insert into ${rr}.import_batch_reviews(batch_id,revision,payload) values($1,$2,$3)`,[batch.batchId,batch.revision,batch]);
      await this.writeAudit(client,context,...importReviewAudit(batch,previous));
      if(!transaction)await client.query('commit');return batch;
    }catch(error){if(!transaction)await client.query('rollback');throw error;}finally{if(!transaction)client.release();}
  }
  async stageImport(data,context,previousId=null,revision=null) {
    const client=await this.pool.connect();
    try {
      await client.query('begin isolation level repeatable read');
      const previous=previousId?requireBatch((await client.query(`select payload from ${rr}.import_batches where batch_id=$1 for update`,[previousId])).rows[0]?.payload,context):null;
      if(previous){checkBatchRevision(previous,revision);if(previous.status==='COMMITTED')throw Object.assign(new Error('A committed import cannot be changed. Upload a new file for another round.'),{status:409,code:'IMPORT_ALREADY_COMMITTED'});}
      const memory=await this.importSnapshot(client);
      const key=importInputKey(data.sourceHash,data.options||{},data.error?null:data.rows||[]);
      const receipt=(await client.query(`select result_json from ${rr}.import_receipts where module_id=$1 and source_hash=$2 and scope=$3`,[data.moduleId,key,context.userId||'preview'])).rows[0];
      if(receipt)memory.importReceipts.set(`${data.moduleId}:${key}:${context.userId||'preview'}`,receipt.result_json);
      const batch=await prepareImportBatch(memory,data,context,previous);
      await client.query(`insert into ${rr}.import_batches(batch_id,module_id,artifact_id,owner_user_id,status,revision,payload) values($1,$2,$3,$4,$5,$6,$7) on conflict(batch_id) do update set status=excluded.status,revision=excluded.revision,payload=excluded.payload,updated_at=now()`,[batch.batchId,batch.moduleId,batch.artifactId,batch.ownerUserId,batch.status,batch.revision,batch]);
      await client.query(`insert into ${rr}.import_batch_reviews(batch_id,revision,payload) values($1,$2,$3)`,[batch.batchId,batch.revision,batch]);
      await this.writeAudit(client,context,'IMPORT_REVIEW_SAVED',batch.batchId,`${batch.moduleId}: ${batch.status}; revision ${batch.revision}`,previous?batchSummary(previous):null,batchSummary(batch));
      await client.query('commit');return batch;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async commitImportBatch(id,body,context,{validateSource,transaction=null}={}) {
    const client=transaction||await this.pool.connect();
    try {
      if(!transaction)await client.query('begin isolation level serializable');await client.query('select pg_advisory_xact_lock(78742003)');
      const batch=requireBatch((await client.query(`select payload from ${rr}.import_batches where batch_id=$1 for update`,[id])).rows[0]?.payload,context);
      await validateSource?.(batch,client);
      const memory=await this.importSnapshot(client,{lock:true});validateImportCommit(batch,body,memory,context);
      if(batch.status==='COMMITTED'){if(!transaction)await client.query('commit');return {...importReceiptResult(batch.result),batchId:id};}
      const result=await this.importWorkflowRows(batch.moduleId,batch.rows,copyAuditContext(context,{...context,sourceHash:batch.inputKey,sourceSha256:batch.sourceHash,sourceArtifactId:batch.artifactId,importBatchId:batch.batchId,round:batch.options.round,importFindings:batch.parseFindings||[]}),batch.filename,client);
      Object.assign(batch,{status:'COMMITTED',result:{...result,batchId:id,artifactId:batch.artifactId},committedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      await client.query(`update ${rr}.import_batches set status=$2,payload=$3,updated_at=now() where batch_id=$1`,[id,batch.status,batch]);
      await insertSqlWorkflowRun(client,{moduleId:batch.moduleId,actor:context.actor||'Local user',role:context.role,result:batch.result,...workflowAttribution(context,workflowRowScope(batch.scope))});
      await this.writeAudit(client,context,'IMPORT_REVIEW_COMMITTED',id,`${batch.moduleId}: ${result.message}`,null,batchSummary(batch));
      if(!transaction)await client.query('commit');return batch.result;
    }catch(error){if(!transaction)await client.query('rollback');if(error.code==='40001')throw Object.assign(new Error('Another operation changed this import or register. Reopen its review before retrying.'),{status:409,code:'IMPORT_DATA_CHANGED'});throw error;}finally{if(!transaction)client.release();}
  }

  async importWorkflowRows(moduleId, rows, context = {}, filename = "workbook.xlsx", transaction=null) {
    const client = transaction||await this.pool.connect();
    try {
      if(!transaction){await client.query("begin");await client.query("select pg_advisory_xact_lock(78742003)");}
      const scope = context.userId || "preview";
      if (context.sourceHash) {
        const receipt = await client.query(`select result_json from ${rr}.import_receipts where module_id=$1 and source_hash=$2 and scope=$3`, [moduleId, context.sourceHash, scope]);
        if (receipt.rowCount) { if(!transaction)await client.query("commit");return importReceiptResult(receipt.rows[0].result_json,context.importFindings); }
      }
      if(['M02','M04'].includes(moduleId))await assertProposalWorkingOrderSchema(client);
      const memory = new MemoryStorage({trackDecisionEvents:false,auditRuntime:this.auditRuntime});
      const snapshot = (await client.query(`select * from ${rr}.proposals order by proposal_id for update`)).rows.map(rowToProposal);
      memory.proposalSequenceFloor = Math.max(0, ...snapshot.map(item => Number(String(item.proposalId).match(/-(\d{1,8})$/)?.[1] || 0)));
      memory.proposalAllocationSnapshot = captureProposalAllocationSnapshot(snapshot);
      memory.state.proposals = snapshot.filter(item => !context.authenticated || canAccess(context, item));
      memory.state.replacements = await loadLedger(client);
      const previousLifecycle = new Set(memory.state.replacements.filter(item => item.recordType === 'LIFECYCLE').map(item => item.recordId));
      memory.state.audit = [];
      const previous = new Map(memory.state.proposals.map(item => [item.proposalId, JSON.stringify(item)]));
      const result = await memory.importWorkflowRows(moduleId, rows, context, filename);
      for (const proposal of memory.state.proposals) {
        if (previous.get(proposal.proposalId) === JSON.stringify(proposal)) continue;
        await client.query(
          `insert into ${rr}.proposals(proposal_id,order_no,supplier,product,product_code,product_decimal_no,production_order,position,orig_code,orig_mfr,orig_pn,alt_mfr,alt_pn,supplier_reply,supplier_comment,component_status,manufacturer_relationship,client_decision,client_comment,responsible,decision_reference,decision_date,historical_status,workflow_status,can_record,archived,source_sheet,source_row,row_version)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
           on conflict(proposal_id) do update set supplier=excluded.supplier,product=excluded.product,product_code=excluded.product_code,product_decimal_no=excluded.product_decimal_no,production_order=excluded.production_order,position=excluded.position,orig_code=excluded.orig_code,orig_mfr=excluded.orig_mfr,orig_pn=excluded.orig_pn,alt_mfr=excluded.alt_mfr,alt_pn=excluded.alt_pn,supplier_reply=excluded.supplier_reply,supplier_comment=excluded.supplier_comment,component_status=excluded.component_status,manufacturer_relationship=excluded.manufacturer_relationship,client_decision=excluded.client_decision,client_comment=excluded.client_comment,responsible=excluded.responsible,decision_reference=excluded.decision_reference,decision_date=excluded.decision_date,historical_status=excluded.historical_status,workflow_status=excluded.workflow_status,can_record=excluded.can_record,archived=excluded.archived,source_sheet=excluded.source_sheet,source_row=excluded.source_row,row_version=excluded.row_version,updated_at=now()`,
          [proposal.proposalId,proposal.orderNo,proposal.supplier,proposal.product,proposal.productCode||"",proposal.productDecimalNo,proposal.productionOrder||"",proposal.position||"",proposal.origCode||"",proposal.origMfr||"",proposal.origPn,proposal.altMfr||"",proposal.altPn||"",proposal.supplierReply||"",proposal.supplierComment||"",proposal.componentStatus||"",proposal.manufacturerRelationship||"",proposal.clientDecision||"",proposal.clientComment||"",proposal.responsible||"",proposal.decisionReference||null,proposal.decisionDate||null,proposal.historicalStatus||"NO HISTORY",proposal.workflowStatus||"",Boolean(proposal.canRecord),Boolean(proposal.archived),proposal.sourceSheet||"Import",proposal.sourceRow||null,proposal.rowVersion||1]
        );
        await client.query(`update ${rr}.proposals set normalized_json=$2,historical_reference=$3,historical_date=$4,notes=$5,raw_source_json=coalesce(raw_source_json,$6),approval_round=$7 where proposal_id=$1`, [proposal.proposalId,normalizedProjection(proposal),proposal.historicalReference||"",proposal.historicalDate||null,proposal.notes||"",proposal.rawSource||null,cleanText(proposal.round)]);
      }
      for (const event of [...memory.state.audit].reverse()) await this.writeAudit(client, copyAuditContext(context,{...context,decisionSource:event.decisionSource}), event.action, event.subject, event.detail, event.before, event.after);
      for (const item of memory.state.replacements) if (item.recordType === 'LIFECYCLE' && !previousLifecycle.has(item.recordId)) await insertLifecycle(client,item);
      await this.writeAudit(client, context, `WORKFLOW_${moduleId}_IMPORT`, moduleId, `${filename}: ${result.message}`);
      if (context.sourceHash) await client.query(`insert into ${rr}.import_receipts(module_id,source_hash,scope,filename,result_json) values($1,$2,$3,$4,$5)`, [moduleId, context.sourceHash, scope, filename, result]);
      if(!transaction)await client.query("commit");
      return result;
    } catch (error) { if(!transaction)await client.query("rollback"); throw error; }
    finally { if(!transaction)client.release(); }
  }

  async runWorkflow(moduleId, context = {}, options = {}, {transaction=null}={}) {
    if(moduleId==='M11')return confirmSqlArchiveReview(this,rowToProposal,loadLedger,context,options);
    if(moduleId==='M90'){
      const {captureSetup}=await import('./setup-service.js');
      const captured=await captureSetup(this,null);
      return this.recordSetupValidation(validateSetup({...captured,orderNo:options.orderNo,extraChecks:[...(captured.extraChecks||[]),{id:'attachment_objects',status:'NOT_CHECKED',checked:0,message:'The physical object store is unavailable to this direct storage call. Run M90 through the application for file checks.'}]}),context);
    }
    const client = transaction||await this.pool.connect();
    try {
      if(!transaction)await client.query("begin");
      // Shared with imports. Lock before taking the snapshot, then retain row
      // locks through state changes, workflow log and audit commit.
      await client.query("select pg_advisory_xact_lock(78742003)");
      const values=[],where=[],add=value=>{values.push(value);return `$${values.length}`;};
      if(options.orderNo)where.push(['M10','M91'].includes(moduleId)?`replacement_register.scope_text(order_no)=${add(normalize(options.orderNo))}`:`order_no=${add(options.orderNo)}`);
      if(context.authenticated&&context.role!=='ADMINISTRATOR'){
        const orders=[...new Set((context.orders||[]).map(normalize))];where.push(orders.length?`replacement_register.scope_text(order_no)=any(${add(orders)}::text[])`:'false');
        if(context.role==='SUPPLIER')where.push(normalize(context.organization)?`replacement_register.scope_text(supplier)=${add(normalize(context.organization))}`:'false');
      }
      if(moduleId==='M10')await assertProposalWorkingOrderSchema(client);
      const rawProposals = (await client.query(`select * from ${rr}.proposals${where.length?' where '+where.join(' and '):''} order by proposal_id for update`,values)).rows;
      let proposals=bindProposalWorkingOrder(rawProposals.map(rowToProposal),rawProposals);
      if(moduleId==='M10'){
        const selected=copyProposalWorkingOrder(proposals,proposals.filter(item=>!item.archived));
        proposals=copyProposalWorkingOrder(proposals,[...requireKnownWorkingOrder(selected),...proposals.filter(item=>item.archived)]);
      }
      const replacements = await loadLedger(client);
      const memory = new MemoryStorage({trackDecisionEvents:false,auditRuntime:this.auditRuntime});
      memory.state.proposals = proposals;
      memory.state.replacements = replacements;
      memory.state.audit = []; memory.state.workflowRuns = [];
      const previous = new Map(proposals.map(item => [item.proposalId, JSON.stringify(item)]));
      const replacementIds = new Set(replacements.map(item => item.recordId));
      const run = await memory.runWorkflow(moduleId, context, options);
      for (const item of memory.state.proposals) {
        if (previous.get(item.proposalId) === JSON.stringify(item)) continue;
        await client.query(`update ${rr}.proposals set workflow_status=$2,can_record=$3,archived=$4,row_version=$5,normalized_json=$6,historical_status=$7,historical_reference=$8,historical_date=$9,manufacturer_relationship=$10,component_status=$11,client_decision=$12,client_comment=$13,updated_at=now() where proposal_id=$1`, [item.proposalId,item.workflowStatus,item.canRecord,Boolean(item.archived),item.rowVersion,normalizedProjection(item),item.historicalStatus,item.historicalReference||"",item.historicalDate||null,item.manufacturerRelationship,item.componentStatus,item.clientDecision,item.clientComment]);
      }
      for (const item of memory.state.replacements) {
        if (replacementIds.has(item.recordId)) continue;
        await client.query(
          `insert into ${rr}.replacement_records(record_id,proposal_id,order_no,supplier,product,product_decimal_no,product_code,position,orig_code,orig_mfr,orig_pn,component_status,alt_mfr,alt_pn,decision_status,production_order,responsible,decision_reference,decision_date,decision_comment,notes,source_sheet)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'Application')`,
          [item.recordId,item.proposalId,item.orderNo,item.supplier,item.product,item.productDecimalNo,item.productCode||"",item.position||"",item.origCode||"",item.origMfr||"",item.origPn,item.componentStatus||"",item.altMfr||"",item.altPn||"",item.decisionStatus,item.productionOrder||"",item.responsible,item.decisionReference||null,item.decisionDate||null,item.decisionComment||"",item.notes||""]
        );
      }
      const savedRun = await insertSqlWorkflowRun(client,run);
      for (const event of [...memory.state.audit].reverse()) await this.writeAudit(client, copyAuditContext(context,{...context,decisionSource:event.decisionSource}), event.action, event.subject, event.detail, event.before, event.after);
      if(!transaction)await client.query("commit");
      return savedRun;
    } catch (error) { if(!transaction)await client.query("rollback"); throw error; }
    finally { if(!transaction)client.release(); }
  }

  async listWorkflowRuns(options={},context={}) {
    return sqlWorkflowRuns(this.pool,options,context);
  }
  async prepareArchiveReview(context,body){return prepareSqlArchiveReview(this,rowToProposal,context,body);}
  async manageRound(context,body){return manageSqlRound(this,context,body);}
  async associateRoundExchanges(context,body){return associateSqlRoundExchanges(this,context,body);}
  async getRoundManagement(id,context){return getSqlRoundManagement(this,id,context);}
  async getArchiveReview(id,context){return getSqlArchiveReview(this,id,context);}

  async recordExport(moduleId,context,result,transaction=null) {
    const client=transaction||await this.pool.connect();const payload={...result,status:'EXPORTED',message:`${result.affected} row(s) exported to ${result.files.length} archived file(s).`};
    try {
      if(!transaction)await client.query('begin');
      if(['AUDIT','REGISTER_REPORT'].includes(moduleId)){await this.writeAudit(client,context,moduleId==='AUDIT'?'AUDIT_REPORT_ISSUED':'REGISTER_REPORT_ISSUED',result.exportJobId,result.filename,null,result);if(!transaction)await client.query('commit');return {result};}
      const run=await insertSqlWorkflowRun(client,{moduleId,actor:context.actor||'Local user',role:context.role||'ADMINISTRATOR',result:payload,...workflowAttribution(context,workflowExportScope(result))});
      await this.writeAudit(client,context,`WORKFLOW_${moduleId}_EXPORTED`,moduleId,payload.message,null,payload);if(!transaction)await client.query('commit');
      return run;
    }catch(error){if(!transaction)await client.query('rollback');throw error;}finally{if(!transaction)client.release();}
  }

  async listAudit() {
    const result = await this.pool.query(`select id, occurred_at as "occurredAt", actor, actor_user_id as "actorUserId", request_id as "requestId", actor_role as role, action, subject, detail, before_json as before, after_json as after, provenance_json::text as provenance from ${rr}.audit_events order by occurred_at desc limit 250`);
    return result.rows;
  }
}

export async function createStorage({applicationName,env=process.env}={}) {
  if (env.RR_STORAGE === "local-file") return new FilePreviewStorage(env.RR_PREVIEW_STATE || fileURLToPath(new URL("../.replacement-register/preview-state.json", import.meta.url))).initialize();
  if (env.RR_STORAGE !== "postgres") return new MemoryStorage();
  // Validate before constructing either pool: unsupported limits must never
  // open a database connection or bypass the SQL settlement adapter.
  const policy=sqlExecutionConfig(env),workName=applicationName??env.PGAPPNAME??`rr-exec:${randomUUID()}`;
  if(typeof workName!=='string'||!workName||workName.includes('\0')||Buffer.byteLength(workName)>55)throw TypeError('The database application name must leave room for its control suffix.');
  const { Pool } = await import("pg");
  const connection={
    host: env.PGHOST || "127.0.0.1",
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE || "replacement_register",
    user: env.PGUSER || "replacement_register_app",
    password: env.PGPASSWORD,
    connectionTimeoutMillis: 5000
  };
  let workPool,controlPool,execution,closing;
  // The adapter owns scope settlement; storage owns the actual pools. Hosts
  // drain their pinned coordinator before ending either public storage pool.
  const close=()=>closing??=(async()=>{
    const drained=execution?await Promise.allSettled([Promise.resolve().then(()=>execution.close())]):[];
    const ended=await Promise.allSettled([workPool,controlPool].filter(Boolean).map(pool=>Promise.resolve().then(()=>pool.end())));
    const failed=[...drained,...ended].find(result=>result.status==='rejected');if(failed)throw failed.reason;
  })();
  try{
    workPool=new Pool({...connection,application_name:workName,max:7,statement_timeout:policy.statementMs,lock_timeout:policy.lockMs});
    controlPool=new Pool({...connection,application_name:workName+':control',max:2,statement_timeout:Math.min(5000,policy.statementMs),lock_timeout:Math.min(1000,policy.lockMs)});
    execution=createSqlExecution({pool:workPool,controlPool,policy,applicationName:workName});
    // Do not proxy a frozen adapter property: an own facade keeps end() tied
    // to storage ownership, including for callers using its event chaining.
    const businessPool=Object.create(execution.pool,{end:{value:close,enumerable:true}});
    for(const method of ['on','once','off','removeListener'])Object.defineProperty(businessPool,method,{value:(...args)=>{execution.pool[method](...args);return businessPool;},enumerable:true});
    Object.freeze(businessPool);
    const storage=new PostgresStorage(businessPool);
    Object.defineProperties(storage,{sqlExecution:{value:execution},executionControlPool:{value:controlPool},close:{value:close}});
    await storage.health();return storage;
  }catch(error){await close().catch(()=>{});throw error;}
}
