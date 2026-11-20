import { randomUUID, createHash } from 'node:crypto';
import { normalize } from './normalization.js';
import {appendSqlDecisionAudit} from './decision-history.js';
import {appendSqlWorkflowAudit} from './workflow-rounds.js';
import {canonicalSourceJson,sourceJsonHash,planSourceCapture} from './source-refresh.js';
import {maintenanceIdentity} from './audit-provenance.js';
import {serializeEventProvenance} from './audit-writer.js';
import {assertProposalWorkingOrderSchema} from './working-order-operations.js';
async function retainAuditEvidence(client,audit){await appendSqlDecisionAudit(client,audit);await appendSqlWorkflowAudit(client,{...audit,occurredAt:new Date(audit.occurredAt).toISOString()});}
function maintenanceProvenance(actor,auditRuntime){
  if(auditRuntime==null)return null;
  let context={};
  // Keep the historical actor column verbatim; an unavailable or invalid label
  // is unknown metadata, never an inferred authenticated identity.
  try{maintenanceIdentity(actor);context={actor,role:'SYSTEM'};}catch{}
  return serializeEventProvenance(context,auditRuntime);
}

const rr = 'replacement_register';
const common = {
  orderNo: 'order_no', supplier: 'supplier', product: 'product', productCode: 'product_code', productDecimalNo: 'product_decimal_no',
  productionOrder: 'production_order', position: 'position', origCode: 'orig_code', origMfr: 'orig_mfr', origPn: 'orig_pn',
  altMfr: 'alt_mfr', altPn: 'alt_pn', componentStatus: 'component_status', responsible: 'responsible',
  decisionReference: 'decision_reference', decisionDate: 'decision_date', notes: 'notes'
};
export const proposalFields = { ...common, supplierReply: 'supplier_reply', supplierComment: 'supplier_comment', manufacturerRelationship: 'manufacturer_relationship', clientDecision: 'client_decision', clientComment: 'client_comment', historicalStatus: 'historical_status', historicalReference: 'historical_reference', historicalDate: 'historical_date', workflowStatus: 'workflow_status', canRecord: 'can_record' };
export const replacementFields = { ...common, proposalId: 'proposal_id', decisionStatus: 'decision_status', decisionComment: 'decision_comment' };
const value = (item, key) => key === 'canRecord' ? Boolean(item[key]) : String(item[key] ?? '');
const databaseValue = (key, item) => (['decisionDate', 'historicalDate', 'proposalId'].includes(key) ? value(item, key) || null : key === 'decisionReference' ? value(item, key) || null : value(item, key));
function dateText(value) {
  if (!value) return '';
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return String(value).slice(0, 10);
}
export function sourceIdentity(kind, item) {
  if (kind === 'proposal') return String(item.proposalId || '');
  // Spreadsheet row numbers and manufacturer names can change. Bind historical
  // records by stable source evidence, then three-way merge manufacturer edits.
  const fields = ['orderNo', 'productDecimalNo', 'origPn', 'altPn', 'decisionStatus', 'decisionDate'];
  const identity = fields.map(key => normalize(item[key]));
  identity.push(normalize(item.decisionReference) || normalize(item.responsible));
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}
export function mergeSourceRecord(current, incoming, baseline, fields) {
  const merged = { ...current }; const conflicts = []; const changed = []; const preserved = [];
  for (const key of Object.keys(fields)) {
    const local = value(current, key); const source = value(incoming, key);
    if (local === source) continue;
    if (!baseline || !(key in baseline)) { conflicts.push({ field: key, current: local, incoming: source, baseline: null, reason: 'NO_TRUSTED_BASELINE' }); continue; }
    const previous = value(baseline, key);
    if (local === previous) { merged[key] = source; changed.push(key); }
    else if (source === previous) preserved.push(key);
    else conflicts.push({ field: key, current: local, incoming: source, baseline: previous, reason: 'CONCURRENT_SOURCE_AND_APPLICATION_EDIT' });
  }
  return { merged, conflicts, changed, preserved };
}
function fromDatabase(row, fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, ['decisionDate', 'historicalDate'].includes(key) ? dateText(row[column]) : key === 'canRecord' ? Boolean(row[column]) : String(row[column] ?? '')]));
}

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const captureOf=row=>({sourceHash:row?.source_workbook_hash??null,sourceSheet:row?.source_sheet??null,sourceRow:row?.source_row??null});
const scopeOf=row=>Object.fromEntries(['orderNo','supplier','productDecimalNo'].map(key=>[key,row[key]??'']));
function captureError(code,message,kind,identity){return Object.assign(new Error(message),{status:422,code,sourceTable:kind==='proposal'?'Check':'Database',sourceKey:identity,details:[`${kind==='proposal'?'Check':'Database'}; source key ${identity}: ${message}`]});}
function sourceCapture(item,sourceHash,kind,identity){
  if(!Object.hasOwn(item,'rawSource')||!plain(item.rawSource))throw captureError('SOURCE_REFRESH_RAW_REQUIRED','The source row requires its captured rawSource object; typed business values cannot substitute for original cells.',kind,identity);
  const capture={sourceHash,sourceSheet:item.sourceSheet,sourceRow:item.sourceRow??null};
  try{planSourceCapture({currentRaw:undefined,incomingRaw:item.rawSource,currentCapture:null,incomingCapture:capture});}catch(error){throw captureError(error.code||'SOURCE_REFRESH_INPUT_INVALID',error.message,kind,identity);}
  return {capture,raw:item.rawSource};
}
function rawFieldsChanged(before,after){
  const original=plain(before)?before:{};return [...new Set([...Object.keys(original),...Object.keys(after)])].sort().filter(key=>!Object.hasOwn(original,key)||!Object.hasOwn(after,key)||sourceJsonHash(original[key])!==sourceJsonHash(after[key]));
}
async function verifyCapture(client,kind,identity,source,incoming){
  const args=[kind,identity,source.capture.sourceHash,source.capture.sourceSheet,source.capture.sourceRow,canonicalSourceJson(incoming),canonicalSourceJson(source.raw)];
  const inserted=await client.query(`insert into ${rr}.source_versions(entity_kind,source_identity,source_hash,source_sheet,source_row,source_json,raw_json) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) on conflict do nothing returning source_hash`,args);
  if(inserted.rowCount)return true;
  const existing=(await client.query(`select source_sheet,source_row,source_json,raw_json from ${rr}.source_versions where entity_kind=$1 and source_identity=$2 and source_hash=$3 for share`,args.slice(0,3))).rows[0];
  return Boolean(existing)&&existing.source_sheet===source.capture.sourceSheet&&existing.source_row===source.capture.sourceRow&&sourceJsonHash(existing.source_json)===sourceJsonHash(incoming)&&sourceJsonHash(existing.raw_json)===sourceJsonHash(source.raw);
}
async function auditCapture(client,{actor,kind,identity,targetId,current,merged,beforeCapture,source,plan,versionBefore,versionAfter,typedFields,preservedFields,beforeRaw,auditRuntime}){
  const captureId=capture=>capture.sourceHash?sourceJsonHash({kind,identity,...capture}):null;
  const before={...scopeOf(current),entityKind:kind,sourceIdentity:identity,targetId,captureId:captureId(beforeCapture),captureStatus:beforeCapture.sourceHash?'RECORDED_POINTER':'UNRECORDED',capture:beforeCapture,rawHash:plan.rawBeforeHash,rowVersion:versionBefore};
  const after={...scopeOf(merged),entityKind:kind,sourceIdentity:identity,targetId,captureId:captureId(source.capture),captureStatus:'MATCHED_STORED_CAPTURE',capture:source.capture,rawHash:plan.rawAfterHash,rowVersion:versionAfter,rawChanged:plan.rawChanged,rawFieldsChanged:rawFieldsChanged(beforeRaw,source.raw),typedFieldsChanged:typedFields,typedFieldsPreserved:preservedFields};
  // Evidence adoption is an actual maintenance event, not a new decision or
  // workflow round. Full source cells remain in the immutable capture table.
  await client.query(`insert into ${rr}.audit_events(actor,actor_role,action,subject,detail,before_json,after_json,provenance_json) values($1,'SYSTEM','SOURCE_EVIDENCE_REFRESHED',$2,$3,$4,$5,$6::jsonb)`,[actor,targetId,`Adopted ${kind} source capture ${source.capture.sourceHash}; raw changed: ${plan.rawChanged}; typed fields changed: ${typedFields.length}`,before,after,maintenanceProvenance(actor,auditRuntime)]);
}

export async function reconcileAuthoritative(pool, proposalsSeed, replacementsSeed, { dryRun = false, actor = 'Authoritative migration', auditRuntime = null } = {}) {
  const sourceHash = proposalsSeed.metadata?.sourceSha256;
  if (!sourceHash || sourceHash !== replacementsSeed.metadata?.sourceSha256) throw new Error('Check and Database snapshots must come from the same verified workbook');
  const report = { sourceSha256: sourceHash, dryRun, inserted: 0, updated: 0, rawRefreshed:0,captureRefreshed:0,provenanceOnly:0,unchanged: 0, preserved: 0, conflicts: [], rows: [] };
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(78742003)');
    let workingOrderVerified=false;
    for (const [kind, seed, fields, table, idColumn] of [
      ['proposal', proposalsSeed, proposalFields, 'proposals', 'proposal_id'],
      ['replacement', replacementsSeed, replacementFields, 'replacement_records', 'record_id']
    ]) {
      const identities = new Map();
      for (const item of seed.items) { const identity = sourceIdentity(kind, item); identities.set(identity, (identities.get(identity) || 0) + 1); }
      const existing = (await client.query(`select *,raw_source_json is not null as source_raw_present from ${rr}.${table} order by ${idColumn} for update`)).rows;
      for (const item of seed.items) {
        const identity = sourceIdentity(kind, item);
        const incoming = Object.fromEntries(Object.keys(fields).map(key => [key, value(item, key)]));
        const binding = (await client.query(`select * from ${rr}.source_bindings where entity_kind=$1 and source_identity=$2`, [kind, identity])).rows[0];
        const record = { kind, sourceIdentity: identity, sourceSheet: item.sourceSheet, sourceRow: item.sourceRow, fieldsChanged: [], fieldsPreserved: [], conflicts: [] };
        let row;
        if (!identity || identities.get(identity) !== 1) record.conflicts.push({ reason: 'AMBIGUOUS_SOURCE_IDENTITY' });
        else if (binding) {
          row = existing.find(row => row[idColumn] === binding.target_id);
          if (!row) record.conflicts.push({ reason: 'TARGET_DELETED', targetId: binding.target_id });
        } else if (kind === 'proposal') row = existing.find(row => row.proposal_id === item.proposalId);
        else {
          const candidates = existing.filter(row => sourceIdentity(kind, fromDatabase(row, fields)) === identity);
          if (candidates.length > 1) record.conflicts.push({ reason: 'AMBIGUOUS_TARGET_IDENTITY', targets: candidates.map(row => row.record_id) });
          else row = candidates[0] || existing.find(row => row.record_id === item.recordId);
        }
        const targetId = row?.[idColumn] || binding?.target_id || (kind === 'proposal' ? item.proposalId : `DB-${randomUUID()}`);
        record.targetId = targetId;
        let source;
        if (!record.conflicts.length) {
          source=sourceCapture(item,sourceHash,kind,identity);
          if(!await verifyCapture(client,kind,identity,source,incoming))record.conflicts.push({reason:'IMMUTABLE_SOURCE_CAPTURE_MISMATCH',sourceHash});
        }
        if (!record.conflicts.length) {
          if (!row) {
            if(kind==='proposal'&&!workingOrderVerified){await assertProposalWorkingOrderSchema(client);workingOrderVerified=true;}
            const keys = Object.keys(fields);
            const columns = [idColumn, ...Object.values(fields), 'source_workbook_hash', 'source_sheet', 'source_row', 'raw_source_json'];
            const values = [targetId, ...keys.map(key => databaseValue(key, incoming)), sourceHash, item.sourceSheet, item.sourceRow??null, canonicalSourceJson(source.raw)];
            const inserted = await client.query(`insert into ${rr}.${table}(${columns.join(',')}) values(${values.map((_, index) => `$${index + 1}`).join(',')}) returning *`, values);
            row = inserted.rows[0]; existing.push(row); record.status = 'INSERTED'; report.inserted++;
            const audit=(await client.query(`insert into ${rr}.audit_events(actor,actor_role,action,subject,detail,after_json,provenance_json) values($1,'SYSTEM','SOURCE_RECORD_IMPORTED',$2,$3,$4,$5::jsonb) returning id,occurred_at`, [actor, targetId, `Workbook ${sourceHash}; ${item.sourceSheet} row ${item.sourceRow}`, incoming,maintenanceProvenance(actor,auditRuntime)])).rows[0];
            await retainAuditEvidence(client,{id:audit.id,occurredAt:audit.occurred_at,actor,role:'SYSTEM',action:'SOURCE_RECORD_IMPORTED',subject:targetId,detail:`Workbook ${sourceHash}; ${item.sourceSheet} row ${item.sourceRow}`,before:null,after:{...incoming,[kind==='proposal'?'proposalId':'recordId']:targetId},decisionSource:{sha256:sourceHash,sheet:item.sourceSheet,row:item.sourceRow,description:'Authoritative workbook reconciliation'}});
          } else {
            const current = fromDatabase(row, fields);
            const merge = mergeSourceRecord(current, incoming, binding?.baseline_json, fields);
            record.fieldsChanged = merge.changed; record.fieldsPreserved = merge.preserved; record.conflicts = merge.conflicts;
            if (merge.conflicts.length) record.status = 'CONFLICT';
            else {
              const beforeRaw=row.source_raw_present?row.raw_source_json:undefined,beforeCapture=captureOf(row),plan=planSourceCapture({currentRaw:beforeRaw,incomingRaw:source.raw,currentCapture:beforeCapture,incomingCapture:source.capture,typedChangedFields:merge.changed}),versionBefore=String(row.row_version);
              record.rawChanged=plan.rawChanged;record.captureChanged=plan.captureChanged;record.rowVersionIncrement=plan.rowVersionIncrement;record.rawBeforeHash=plan.rawBeforeHash;record.rawAfterHash=plan.rawAfterHash;record.captureBeforeHash=plan.captureBeforeHash;record.captureAfterHash=plan.captureAfterHash;
              let versionAfter=versionBefore;
              if(plan.businessChanged||plan.rawChanged||plan.captureChanged){
                const values=[targetId,...merge.changed.map(key=>databaseValue(key,merge.merged))],assignments=merge.changed.map((key,index)=>`${fields[key]}=$${index+2}`),add=value=>{values.push(value);return '$'+values.length;};
                if(plan.rawChanged)assignments.push(`raw_source_json=${add(canonicalSourceJson(source.raw))}::jsonb`);
                if(plan.captureChanged)assignments.push(`source_workbook_hash=${add(sourceHash)}`,`source_sheet=${add(source.capture.sourceSheet)}`,`source_row=${add(source.capture.sourceRow)}`);
                if(plan.rowVersionIncrement)assignments.push('row_version=row_version+1');assignments.push('updated_at=now()');
                versionAfter=String((await client.query(`update ${rr}.${table} set ${assignments.join(',')} where ${idColumn}=$1 returning row_version`,values)).rows[0].row_version);
              }
              if (merge.changed.length) {
              const audit=(await client.query(`insert into ${rr}.audit_events(actor,actor_role,action,subject,detail,before_json,after_json,provenance_json) values($1,'SYSTEM','SOURCE_RECORD_UPDATED',$2,$3,$4,$5,$6::jsonb) returning id,occurred_at`, [actor, targetId, `Workbook ${sourceHash}; changed ${merge.changed.join(', ')}`, current, merge.merged,maintenanceProvenance(actor,auditRuntime)])).rows[0];
              await retainAuditEvidence(client,{id:audit.id,occurredAt:audit.occurred_at,actor,role:'SYSTEM',action:'SOURCE_RECORD_UPDATED',subject:targetId,detail:`Workbook ${sourceHash}; changed ${merge.changed.join(', ')}`,before:{...current,[kind==='proposal'?'proposalId':'recordId']:targetId},after:{...merge.merged,[kind==='proposal'?'proposalId':'recordId']:targetId},decisionSource:{sha256:sourceHash,sheet:item.sourceSheet,row:item.sourceRow,description:'Authoritative workbook reconciliation'}});
              record.status = 'UPDATED'; report.updated++;
              }else if(plan.rawChanged)record.status='RAW_REFRESHED';else if(plan.captureChanged)record.status='CAPTURE_REFRESHED';else{record.status=merge.preserved.length?'LOCAL_CHANGES_PRESERVED':'UNCHANGED';report.unchanged++;}
              if(plan.rawChanged)report.rawRefreshed++;if(plan.captureChanged)report.captureRefreshed++;if(!plan.businessChanged&&!plan.rawChanged&&plan.captureChanged)report.provenanceOnly++;
              if(plan.action==='SOURCE_EVIDENCE_REFRESHED')await auditCapture(client,{actor,kind,identity,targetId,current,merged:merge.merged,beforeCapture,source,plan,versionBefore,versionAfter,typedFields:merge.changed,preservedFields:merge.preserved,beforeRaw,auditRuntime});
            }
            if (merge.preserved.length) report.preserved++;
          }
        }
        if (record.conflicts.length) {
          record.status = 'CONFLICT'; report.conflicts.push(record);
        } else {
          await client.query(`insert into ${rr}.source_bindings(entity_kind,source_identity,target_id,baseline_json,source_hash) values($1,$2,$3,$4,$5) on conflict(entity_kind,source_identity) do update set baseline_json=excluded.baseline_json,source_hash=excluded.source_hash where ${rr}.source_bindings.baseline_json is distinct from excluded.baseline_json or ${rr}.source_bindings.source_hash is distinct from excluded.source_hash or ${rr}.source_bindings.target_id is distinct from excluded.target_id`, [kind, identity, targetId, incoming, sourceHash]);
        }
        report.rows.push(record);
      }
    }
    // Whole-run atomicity: findings never leave half a migration applied.
    report.committed = !dryRun && report.conflicts.length === 0;
    if (report.committed) await client.query('commit'); else await client.query('rollback');
    if (!dryRun && report.conflicts.length) {
      await client.query('begin');
      for (const record of report.conflicts) await client.query(`insert into ${rr}.migration_conflicts(conflict_id,source_hash,entity_kind,source_identity,target_id,findings_json) values($1,$2,$3,$4,$5,$6)`, [randomUUID(), sourceHash, record.kind, record.sourceIdentity, record.targetId, JSON.stringify(record.conflicts)]);
      await client.query(`insert into ${rr}.audit_events(actor,actor_role,action,subject,detail,provenance_json) values($1,'SYSTEM','SOURCE_MIGRATION_QUARANTINED',$2,$3,$4::jsonb)`, [actor, sourceHash, `${report.conflicts.length} conflicting records; no domain changes committed`,maintenanceProvenance(actor,auditRuntime)]);
      await client.query('commit');
    }
    return report;
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

