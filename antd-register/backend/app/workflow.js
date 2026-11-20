import { classifyProposal, finalPreflight, validateRegister, recalculateProposal, createHistoryIndex } from './domain.js';
import {preliminaryEligible,feedbackEligible} from './exchange-scope.js';
import {normalize} from './normalization.js';
import {permitEligible} from './permit-metadata.js';
export { recalculateProposal } from './domain.js';
export const roles = ["ADMINISTRATOR", "SUPPLIER", "CLIENT"];

export const workflowModules = [
  { id: "M01", title: "Prepare original BOM for supplier", stage: "Original BOM", roles: ["ADMINISTRATOR"], kind: "EXPORT", description: "Validate an original BOM, apply historical decisions and create a versioned supplier request." },
  { id: "M02", title: "Import supplier proposals", stage: "Supplier round", roles: ["ADMINISTRATOR", "SUPPLIER"], kind: "IMPORT", description: "Validate supplier alternatives, preserve prior rounds and reconcile duplicate proposal identities." },
  { id: "M03", title: "Prepare preliminary approval", stage: "Client review", roles: ["ADMINISTRATOR", "CLIENT"], kind: "EXPORT", description: "Create the preliminary approval queue for unresolved proposals that are not previously approved." },
  { id: "M04", title: "Import preliminary client reply", stage: "Client reply", roles: ["ADMINISTRATOR", "CLIENT"], kind: "IMPORT", description: "Match replies deterministically, record decisions and quarantine ambiguous rows." },
  { id: "M05", title: "Prepare supplier feedback", stage: "Supplier feedback", roles: ["ADMINISTRATOR", "SUPPLIER"], kind: "EXPORT", description: "Group client feedback by product and supplier without losing proposal identity." },
  { id: "M06", title: "Prepare final approval workbook", stage: "Final approval", roles: ["ADMINISTRATOR", "CLIENT"], kind: "EXPORT", description: "Block unresolved rows and create one worksheet for each Product_Decimal_No." },
  { id: "M07", title: "Create deviation permits", stage: "Documents", roles: ["ADMINISTRATOR"], kind: "DOCUMENT", description: "Group eligible replacements by product and production order and prepare deviation permits." },
  { id: "M08", title: "Import approved final workbook", stage: "Final reply", roles: ["ADMINISTRATOR", "CLIENT"], kind: "IMPORT", description: "Import responsible person, Decision Reference, date and comment using deterministic matching." },
  { id: "M09", title: "Prepare complete supplier BOM", stage: "Procurement", roles: ["ADMINISTRATOR", "SUPPLIER"], kind: "EXPORT", description: "Create the supplier BOM with original, replacement, do-not-purchase, obsolete and conflict actions." },
  { id: "M10", title: "Record decisions in the database", stage: "Recording", roles: ["ADMINISTRATOR"], kind: "COMMIT", description: "Append approved decisions with full evidence and rejected decisions with responsible person, date, and rejection reason." },
  { id: "M11", title: "Archive current workspace", stage: "Close order", roles: ["ADMINISTRATOR"], kind: "ARCHIVE", description: "Archive the working set with recovery and audit instead of permanently deleting it." },
  { id: "M90", title: "Validate configuration and data", stage: "Administration", roles: ["ADMINISTRATOR"], kind: "VALIDATE", description: "Check schema, references, keys, dates, decisions, duplicates and workflow prerequisites." },
  { id: "M91", title: "Recalculate workflow state", stage: "Administration", roles: ["ADMINISTRATOR"], kind: "RECALCULATE", description: "Recompute canonical keys, historical state, workflow status and recordability deterministically." }
];

export function moduleFor(id) {
  if(id==='REGISTER_REPORT')return {id,title:'Register report',stage:'Reports',roles:[...roles],kind:'EXPORT',description:'Export selected or all filtered register rows.'};
  return workflowModules.find((module) => module.id === id) || null;
}

export function canUseModule(module, role) {
  return Boolean(module?.roles.includes(role));
}

export function previewWorkflow(moduleId, proposals, replacements) {
  const active = proposals.filter((item) => !item.archived);
  const preflight = finalPreflight(active);
  const unresolved = preflight.unresolved;
  const missingProductionOrder = preflight.missingProductionOrder;
  const documented = active.filter((item) => item.canRecord);
  const finalRows = preflight.rows;
  const worksheets = new Set(finalRows.map((item) => normalize(item.productDecimalNo)));
  const bySupplierProduct = new Set(active.filter(feedbackEligible).map((item) => `${item.supplier}|${item.productDecimalNo}`));
  const diagnostics = moduleId === 'M90' ? validateRegister(active, replacements) : [];
  const permitHistory=moduleId==='M07'?createHistoryIndex(replacements):null;
  const permitRows=moduleId==='M07'?active.map(row=>recalculateProposal(row,permitHistory)).filter(permitEligible):[];
  const permitGroups=new Set(permitRows.map(row=>JSON.stringify([normalize(row.orderNo),normalize(row.productDecimalNo),normalize(row.productionOrder)])));

  const results = {
    M01: { affected: active.length, message: `${new Set(active.map((item) => item.productDecimalNo)).size} product BOMs are available for supplier preparation.` },
    M02: { affected: active.length, message: `${active.length} supplier proposals across ${new Set(active.map((item) => item.supplier)).size} suppliers are loaded.` },
    M03: { affected: active.filter(preliminaryEligible).length, message: "Eligible unresolved proposals require preliminary client review." },
    M04: { affected: active.filter((item) => item.clientDecision).length, message: `${active.filter((item) => item.clientDecision).length} client replies are currently matched.` },
    M05: { affected: bySupplierProduct.size, message: `${bySupplierProduct.size} supplier/product feedback groups will be produced.` },
    M06: { affected: finalRows.length, blocked: unresolved.length + missingProductionOrder.length, worksheets: worksheets.size, message: `${finalRows.length} rows form ${worksheets.size} product worksheets; ${unresolved.length + missingProductionOrder.length} blocking findings remain.` },
    M07: { affected: permitRows.length,documents:permitGroups.size,blocked:permitRows.filter(row=>!String(row.productionOrder||'').trim()).length,message: `${permitRows.length} eligible replacement rows form ${permitGroups.size} order/product/production-order permit groups.` },
    M08: { affected: documented.length, message: `${documented.length} proposals currently have complete final decision evidence.` },
    M09: { affected: active.length, message: `${active.length} rows are available for complete supplier BOM actions.` },
    M10: { affected: documented.length, blocked: active.filter((item) => ["APPROVED", "REJECTED"].includes(item.clientDecision) && !item.canRecord).length, message: `${documented.length} decisions can be recorded; incomplete approved/rejected decisions remain blocked.` },
    M11: { affected: active.length, message: `${active.length} working proposals would be archived with recovery and audit.` },
    M90: { affected: active.length + replacements.length, findings: diagnostics.length, details: diagnostics, message: `${diagnostics.length} row-level findings: required fields, decisions, dates, duplicate identities and stale calculations checked.` },
    M91: { affected: active.length, message: `${active.length} proposal states will be recalculated using the canonical rules.` }
  };
  return results[moduleId] || null;
}
