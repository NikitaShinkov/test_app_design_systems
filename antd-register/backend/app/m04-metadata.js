import {cleanText} from './normalization.js';

export const M04_METADATA_VERSION='M04-METADATA-2026-11-06';

// Workflow.bas WF_UpdateClientDecision receives no Production_Order from M04.
// Blank optional cells preserve an existing pair, including technical replies.
export function preliminaryClientMetadata(row) {
  const productCode=cleanText(row.productCode),responsible=cleanText(row.responsible);
  return {...(productCode?{productCode}:{}),...(responsible?{responsible}:{})};
}

// M04's three creation branches deliberately assign different metadata. Apply
// these after the decision fields so unsupported incoming cells cannot leak in.
export function newClientProposalMetadata(row,source,matchedById) {
  if(!source)return {productCode:cleanText(row.productCode),productionOrder:'',componentStatus:'',responsible:''};
  if(matchedById)return {productCode:source.productCode||'',productionOrder:source.productionOrder||'',componentStatus:source.componentStatus||'',responsible:cleanText(row.responsible)};
  return {productCode:cleanText(row.productCode)||source.productCode||'',productionOrder:source.productionOrder||'',componentStatus:cleanText(row.componentStatus),responsible:''};
}
