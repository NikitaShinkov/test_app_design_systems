import {classifyProposal} from './domain.js';
import {normalize} from './normalization.js';
import {validateDecision} from './validation.js';
export function summarize(proposals){
  const count=predicate=>proposals.filter(predicate).length,kind=row=>classifyProposal(row),unique=field=>new Set(proposals.map(row=>normalize(row[field])).filter(Boolean)).size;
  const approved=count(row=>kind(row)==='APPROVED'),rejected=count(row=>kind(row)==='REJECTED'),doNotPurchase=count(row=>kind(row)==='DO NOT PURCHASE');
  return {total:proposals.length,approved,rejected,doNotPurchase,pending:proposals.length-approved-rejected-doNotPurchase,
    awaitingDocuments:count(row=>['APPROVED','REJECTED'].includes(kind(row))&&Object.keys(validateDecision({...row,clientDecision:kind(row)}).errors).length>0),
    readyToRecord:count(row=>row.canRecord),products:unique('productDecimalNo'),orders:unique('orderNo'),suppliers:unique('supplier')};
}

// Only active, already-authorized rows enter this aggregation.
export function summarizeOrders(proposals){
  const groups=new Map();
  for(const row of proposals){if(row.archived)continue;const key=normalize(row.orderNo);const group=groups.get(key)||[];group.push(row);groups.set(key,group);}
  return [...groups.values()].map(rows=>({orderNo:String(rows[0].orderNo||''),summary:summarize(rows),products:[...new Set(rows.map(r=>r.product||r.productDecimalNo).filter(Boolean))],suppliers:[...new Set(rows.map(r=>r.supplier).filter(Boolean))]})).sort((a,b)=>a.orderNo.localeCompare(b.orderNo,undefined,{numeric:true}));
}
