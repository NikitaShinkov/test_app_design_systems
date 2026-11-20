import { cleanText, normalize, manufacturerKey, partNumberKey, productPairKey, pairKey, originalKey, workflowKey, recordKey, currentReferenceData, currentReferenceContext, NORMALIZATION_VERSION } from './normalization.js';
import { validBusinessDate, validateDecision } from './validation.js';

export function classifyReply(value) {
  const text = normalize(value);
  if (!text) return '';
  if (['DO NOT PURCHASE', "DON'T PURCHASE", 'DONT PURCHASE', 'DO NOT BUY'].some(token => text.includes(token))) return 'DO NOT PURCHASE';
  if (['REJECT', 'NOT OK', 'NOT APPROVED', 'НЕ СОГЛАС'].some(token => text.includes(token))) return 'REJECTED';
  const tokens = text.replace(/[.,;:/\\()[\]]/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (tokens === 'OK' || tokens === 'ОК' || tokens.startsWith('OK ') || tokens.startsWith('ОК ')) return 'APPROVED';
  if (['APPROVED', 'ACCEPTED', 'СОГЛАС'].some(token => text.includes(token))) return 'APPROVED';
  return 'UNKNOWN';
}
export const classifyProposal = item => classifyReply(item.clientDecision || item.clientReplyRaw);
export function splitDecisionComment(decision, comment) {
  const text = cleanText(decision); const existing = cleanText(comment);
  if (existing) return { clientDecision: text, clientComment: existing };
  const match = text.match(/^(REJECTED|APPROVED|DO NOT PURCHASE)[:,](.*)$/i);
  return match ? { clientDecision: match[1].toUpperCase(), clientComment: cleanText(match[2]) } : { clientDecision: text, clientComment: existing };
}
// Presentation only. Classification and recording continue to use the current
// business decision. A saved witness, including an explicit blank, prevents an
// older source reply from resurfacing after a user's decision update.
export function decisionExportText(item) {
  const current=cleanText(item.clientDecision)||cleanText(item.clientReplyRaw),kind=classifyReply(current);
  const compatible=value=>classifyReply(value)===kind;
  if(Object.hasOwn(item,'clientDecisionExportText')){const saved=cleanText(item.clientDecisionExportText);return compatible(saved)?saved:current;}
  const technical=cleanText(item.clientReplyRaw);if(technical&&compatible(technical))return technical;
  const source=item.rawSource?.Client_Decision;
  if(current&&current===kind&&typeof source==='string'){
    const raw=splitDecisionComment(source,item.rawSource.Client_Comment).clientDecision;
    if(raw&&compatible(raw))return raw;
  }
  return current;
}
export function isObsoleteReply(value) { const text = normalize(value); return text === 'EOL' || text.includes('OBSOLETE') || text.includes('END OF LIFE'); }
function latestDecision(records) {
  let latest; let latestDate = '';
  for (const row of records) {
    const date = validBusinessDate(cleanText(row.decisionDate)) ? row.decisionDate : '';
    if (!latest || date >= latestDate) { latest = row; latestDate = date; }
  }
  return latest;
}
// Explicit operation-local projection. Never cache by a mutable array or reuse
// across reference revisions: alias changes must reinterpret the original rows.
class HistoryIndex {
  constructor(records) {
    this.referenceIdentity = currentReferenceContext()?.hash || currentReferenceData();
    this.pairs = new Map(); this.obsolete = new Set();
    for (const row of records) this.add(row);
  }
  assertCurrent() {
    if (this.referenceIdentity !== (currentReferenceContext()?.hash || currentReferenceData())) throw new Error('Rebuild the history index inside the current reference-data snapshot.');
  }
  add(row) {
    this.assertCurrent();
    const status = normalize(row.decisionStatus);
    if (status === 'OBSOLETE') { const key = originalKey(row); if (key) this.obsolete.add(key); return; }
    if (!['APPROVED', 'REJECTED'].includes(status)) return;
    const key = productPairKey(row); if (!key) return;
    let pair = this.pairs.get(key);
    if (!pair) { pair = { latest: undefined, latestDate: '', hasApproval: false, orders: new Map() }; this.pairs.set(key, pair); }
    const date = validBusinessDate(cleanText(row.decisionDate)) ? row.decisionDate : '';
    const consider = bucket => { if (!bucket.latest || date >= bucket.latestDate) { bucket.latest = row; bucket.latestDate = date; } };
    consider(pair); pair.hasApproval ||= status === 'APPROVED';
    const order = normalize(row.orderNo); let current = pair.orders.get(order);
    if (!current) { current = { latest: undefined, latestDate: '' }; pair.orders.set(order, current); }
    consider(current);
  }
  history(item) {
    this.assertCurrent(); const pair = this.pairs.get(productPairKey(item));
    return { latest: pair?.latest, current: pair?.orders.get(normalize(item.orderNo))?.latest, hasApproval: pair?.hasApproval || false };
  }
  hasObsolete(item) { this.assertCurrent(); return this.obsolete.has(originalKey(item)); }
}
export const createHistoryIndex = records => { if (records instanceof HistoryIndex) { records.assertCurrent(); return records; } return new HistoryIndex(records); };
export function historyFor(item, replacements) {
  if (replacements instanceof HistoryIndex) return replacements.history(item);
  const key = productPairKey(item);
  const pairs = key ? replacements.filter(record => productPairKey(record) === key && ['APPROVED', 'REJECTED'].includes(normalize(record.decisionStatus))) : [];
  const latest = latestDecision(pairs);
  const current = latestDecision(pairs.filter(record => normalize(record.orderNo) === normalize(item.orderNo)));
  return { latest, current, hasApproval: pairs.some(record => normalize(record.decisionStatus) === 'APPROVED') };
}
export function manufacturerRelation(item) {
  return currentReferenceData().relationships.find(relation => manufacturerKey(relation.original) === manufacturerKey(item.origMfr) && manufacturerKey(relation.current) === manufacturerKey(item.altMfr))?.relation || '';
}
export function recalculateProposal(input, replacements) {
  const item = { ...input, ...splitDecisionComment(input.clientDecision, input.clientComment) };
  const history = replacements ? historyFor(item, replacements) : null;
  const latestStatus = normalize(history?.latest?.decisionStatus);
  const historicalStatus = history ? latestStatus === 'APPROVED' ? 'PREVIOUSLY APPROVED' : latestStatus === 'REJECTED' ? 'PREVIOUSLY REJECTED' : 'NO HISTORY' : input.historicalStatus || 'NO HISTORY';
  const original = originalKey(item);
  const obsoleteInDatabase = replacements instanceof HistoryIndex ? replacements.hasObsolete(item) : Boolean(replacements?.some(record => original && originalKey(record) === original && normalize(record.decisionStatus) === 'OBSOLETE'));
  const componentStatus = isObsoleteReply(item.supplierReply) ? 'OBSOLETE' : cleanText(item.componentStatus) || (obsoleteInDatabase ? 'OBSOLETE' : '');
  const decisionClass = classifyProposal(item);
  const responsible = Boolean(cleanText(item.responsible));
  const date = validBusinessDate(cleanText(item.decisionDate));
  const reference = Boolean(cleanText(item.decisionReference));
  let workflowStatus; let canRecord = false; let canRecordLabel = '';
  if (item.archived) workflowStatus = 'ARCHIVED';
  else if (normalize(componentStatus) === 'OBSOLETE' && !partNumberKey(item.altPn) && !decisionClass) {
    workflowStatus = obsoleteInDatabase ? 'OBSOLETE - NO REPLACEMENT / STORED IN DATABASE' : 'OBSOLETE - DATABASE RECORD PENDING';
    canRecordLabel = obsoleteInDatabase ? 'IN DATABASE - OBSOLETE' : 'NOT IN DATABASE';
  } else if (decisionClass === 'DO NOT PURCHASE') { workflowStatus = 'DO NOT PURCHASE - INCLUDE IN FINAL / DO NOT RECORD'; canRecordLabel = 'DO NOT RECORD'; }
  else if (decisionClass === 'REJECTED') {
    const reason = Boolean(cleanText(item.clientComment));
    canRecord = responsible && date && reason;
    workflowStatus = canRecord ? 'REJECTED - READY TO RECORD' : reason ? 'REJECTED - ENTER RESPONSIBLE AND DATE' : 'REJECTED - ENTER RESPONSIBLE, DATE AND REASON';
  } else if (decisionClass === 'APPROVED') {
    canRecord = responsible && date && reference;
    workflowStatus = canRecord ? 'APPROVED WITH DOCUMENT - READY TO RECORD' : 'PRELIMINARILY APPROVED - WAITING RESPONSIBLE / DOCUMENT';
  } else if (decisionClass === 'UNKNOWN') workflowStatus = 'CLIENT REPLY NOT RECOGNIZED - CHECK VALUE';
  else if (historicalStatus === 'PREVIOUSLY APPROVED') {
    canRecord = responsible && date && reference;
    workflowStatus = canRecord ? 'PREVIOUSLY APPROVED - NEW DOCUMENT READY TO RECORD' : 'PREVIOUSLY APPROVED - INCLUDE IN FINAL FILE';
  } else if (historicalStatus === 'PREVIOUSLY REJECTED') workflowStatus = 'PREVIOUSLY REJECTED - PRELIMINARY APPROVAL REQUIRED';
  else workflowStatus = 'PRELIMINARY APPROVAL REQUIRED';
  if (canRecord) canRecordLabel = 'READY TO RECORD';
  const currentStatus = normalize(history?.current?.decisionStatus);
  if (currentStatus) { canRecord = false; canRecordLabel = `IN DATABASE - ${currentStatus}`; }
  return {
    ...item, normalizationVersion: NORMALIZATION_VERSION,
    productDecimalNorm: normalize(item.productDecimalNo), orderNorm: normalize(item.orderNo),
    origMfrNorm: manufacturerKey(item.origMfr), origPnNorm: partNumberKey(item.origPn), altMfrNorm: manufacturerKey(item.altMfr), altPnNorm: partNumberKey(item.altPn),
    pairKey: pairKey(item), productPairKey: productPairKey(item), approvedStatusKey: productPairKey(item) ? `APPROVED|${productPairKey(item)}` : '', rejectedStatusKey: productPairKey(item) ? `REJECTED|${productPairKey(item)}` : '',
    historicalStatus, hasHistoricalApproval: history ? history.hasApproval : historicalStatus === 'PREVIOUSLY APPROVED', historicalReference: history ? cleanText(history.latest?.decisionReference) : input.historicalReference || '', historicalDate: history ? cleanText(history.latest?.decisionDate) : input.historicalDate || '',
    manufacturerRelationship: manufacturerRelation(item), componentStatus, decisionClass, currentOrderDatabaseStatus: currentStatus, workflowStatus, canRecord, canRecordLabel
  };
}
export const projectionKeys = ['normalizationVersion', 'productDecimalNorm', 'orderNorm', 'origMfrNorm', 'origPnNorm', 'altMfrNorm', 'altPnNorm', 'pairKey', 'productPairKey', 'approvedStatusKey', 'rejectedStatusKey', 'decisionClass', 'clientReplyRaw', 'clientDecisionExportText', 'hasHistoricalApproval', 'currentOrderDatabaseStatus', 'canRecordLabel'];
export const normalizedProjection = item => Object.fromEntries(projectionKeys.filter(key=>key!=='clientDecisionExportText'||Object.hasOwn(item,key)).map(key => [key, item[key] ?? '']));
export function updateProposal(previous, changes, replacements) {
  const edited={...changes};
  if(Object.hasOwn(changes,'clientDecision')&&!Object.hasOwn(changes,'clientDecisionExportText'))edited.clientDecisionExportText=cleanText(changes.clientDecision)||cleanText(changes.clientReplyRaw);
  const next = recalculateProposal({ ...previous, ...edited }, replacements);
  const stable = item => JSON.stringify(Object.keys(item).sort().filter(key => key !== 'rowVersion').map(key => [key, item[key]]));
  return { ...next, rowVersion: Number(previous.rowVersion || 1) + (stable(previous) === stable(next) ? 0 : 1) };
}
export function recordingDecision(item, replacements) {
  const kind = classifyProposal(item);
  const decision = kind === '' && historyFor(item, replacements).hasApproval ? 'APPROVED' : kind;
  if (!['APPROVED', 'REJECTED'].includes(decision) || !productPairKey(item)) return null;
  const validation = validateDecision({ ...item, clientDecision: decision });
  return Object.keys(validation.errors).length ? null : { ...item, ...validation.value };
}
export function includedInFinal(item) {
  const kind = classifyProposal(item);
  return !item.archived && (['APPROVED', 'DO NOT PURCHASE'].includes(kind) || (!kind && item.historicalStatus === 'PREVIOUSLY APPROVED'));
}
export function finalPreflight(proposals) {
  const active = proposals.filter(item => !item.archived);
  const rows = active.filter(includedInFinal);
  const unresolved = active.filter(item => { const kind = classifyProposal(item); return kind === 'UNKNOWN' || (!kind && item.historicalStatus !== 'PREVIOUSLY APPROVED'); });
  const missingProductionOrder = rows.filter(item => !cleanText(item.productionOrder));
  return { rows, unresolved, missingProductionOrder, blocked: Boolean(unresolved.length || missingProductionOrder.length) };
}

export function validateRegister(proposals, replacements) {
  const findings = [];
  const history = createHistoryIndex(replacements);
  const add = (item, code, field, message) => findings.push({ recordId: item.recordId || item.proposalId, sheet: item.sourceSheet, row: item.sourceRow, code, field, message });
  const workflowIdentities = new Map(); const recordedIdentities = new Map();
  for (const item of proposals.filter(item => !item.archived)) {
    for (const field of ['orderNo', 'productDecimalNo', 'origPn']) if (!cleanText(item[field])) add(item, 'REQUIRED_FIELD', field, `${field} is required.`);
    if (!partNumberKey(item.altPn) && normalize(item.componentStatus) !== 'OBSOLETE') add(item, 'ALTERNATIVE_REQUIRED', 'altPn', 'An alternative part number or an obsolete lifecycle status is required.');
    if (classifyProposal(item) === 'UNKNOWN') add(item, 'UNKNOWN_CLIENT_REPLY', 'clientReplyRaw', 'Technical client reply is pending review; resolve it before final approval.');
    if (item.decisionDate && !validBusinessDate(item.decisionDate)) add(item, 'INVALID_DATE', 'decisionDate', 'Decision date is not a valid calendar date.');
    const identity = workflowKey(item);
    if (workflowIdentities.has(identity)) add(item, 'DUPLICATE_PROPOSAL', 'proposalId', `The same replacement identity occurs in ${workflowIdentities.get(identity)}.`);
    else workflowIdentities.set(identity, item.proposalId);
    const expected = recalculateProposal(item, history);
    for (const field of ['productPairKey', 'workflowStatus', 'canRecord', 'historicalStatus']) if (item[field] !== undefined && item[field] !== expected[field]) add(item, 'STALE_CALCULATION', field, `${field} differs from the current history and canonical calculation. Run M91.`);
  }
  for (const item of replacements) {
    if (item.recordType === 'LIFECYCLE' || item.decisionStatus === 'OBSOLETE') {
      if (!originalKey(item)) add(item,'LIFECYCLE_IDENTITY','origPn','Obsolete lifecycle record requires an original component identity.');
      if (!validBusinessDate(item.decisionDate)) add(item,'INVALID_DATE','decisionDate','Lifecycle report date is invalid.');
      continue;
    }
    const validation = validateDecision({ ...item, clientDecision: item.decisionStatus, clientComment: item.decisionComment });
    for (const [field, message] of Object.entries(validation.errors)) add(item, 'DECISION_EVIDENCE', field, message);
    for (const field of ['orderNo', 'productDecimalNo', 'origPn', 'altPn']) if (!cleanText(item[field])) add(item, 'REQUIRED_FIELD', field, `${field} is required on a recorded replacement.`);
    const identity = recordKey(item);
    if (identity && recordedIdentities.has(identity)) add(item, 'DUPLICATE_RECORDED_DECISION', 'recordId', `Recorded decision duplicates ${recordedIdentities.get(identity)}.`);
    else if (identity) recordedIdentities.set(identity, item.recordId);
  }
  return findings;
}
