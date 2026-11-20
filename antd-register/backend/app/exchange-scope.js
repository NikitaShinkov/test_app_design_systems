import {cleanText,normalize} from './normalization.js';

export const preliminaryEligible=item=>!item.archived&&!cleanText(item.clientDecision)&&!cleanText(item.clientReplyRaw)&&item.historicalStatus!=='PREVIOUSLY APPROVED'&&Boolean(cleanText(item.altPn));
export const feedbackEligible=item=>!item.archived&&Boolean(cleanText(item.origPn))&&(Boolean(cleanText(item.altPn))||normalize(item.componentStatus)==='OBSOLETE');
export const exchangeCatalogItem=item=>({...item,orderKey:normalize(item.orderNo),productKey:normalize(item.productDecimalNo),supplierKey:normalize(item.supplier)});
const fail=(code,message,details=[])=>{throw Object.assign(new Error(message),{status:422,code,details});};
export function selectionValues(value) {
  if(Array.isArray(value))return value.map(cleanText).filter(Boolean);
  if(value===undefined)return null;
  const text=cleanText(value);if(!text)return [];
  if(text.startsWith('[')){let values;try{values=JSON.parse(text);}catch{fail('INVALID_PRODUCT_SELECTION','Product selection must be a valid JSON array.');}if(!Array.isArray(values)||values.some(value=>typeof value!=='string'))fail('INVALID_PRODUCT_SELECTION','Select products by their decimal numbers.');return values.map(cleanText).filter(Boolean);}
  return text.split('\u001f').map(cleanText).filter(Boolean);
}
export function exchangeScope(moduleId,proposals,options={}) {
  const active=proposals.filter(item=>!item.archived),orders=new Map();
  for(const item of active){const key=normalize(item.orderNo);if(key&&!orders.has(key))orders.set(key,item.orderNo);}
  let orderNo=cleanText(options.orderNo);
  if(!orderNo && orders.size===1)orderNo=orders.values().next().value;
  if(!orderNo)fail(`${moduleId}_ORDER_REQUIRED`,`${moduleId} requires one order.`,['Choose an order before preparing this exchange.']);
  let rows=active.filter(item=>normalize(item.orderNo)===normalize(orderNo));
  if(!rows.length)fail(`${moduleId}_NO_ORDER_ROWS`,`${moduleId} has no active proposals for the selected order.`,[`Order: ${orderNo}.`]);
  orderNo=rows[0].orderNo;
  if(moduleId==='M05') {
    const available=new Map(rows.filter(item=>cleanText(item.productDecimalNo)).map(item=>[normalize(item.productDecimalNo),item.productDecimalNo]));
    const selected=selectionValues(options.productDecimalNos)??[...available.values()];
    if(!selected.length)fail('M05_PRODUCT_SELECTION_EMPTY','Select at least one product for supplier feedback.');
    const unknown=selected.filter(value=>!available.has(normalize(value)));
    if(unknown.length)fail('M05_PRODUCT_NOT_AVAILABLE','A selected product is unavailable in this order.',unknown.map(value=>`Order ${orderNo}; product ${value}.`));
    const chosen=new Set(selected.map(normalize));rows=rows.filter(item=>chosen.has(normalize(item.productDecimalNo)));
  }
  return {orderNo,rows};
}
export function roundValue(options={}) {return Object.hasOwn(options,'round')?cleanText(options.round):'1';}
export function roundSequenceValue(options={}) {const value=roundValue(options);return value===''?0:/^[1-9][0-9]*$/.test(value)?Number(value):normalize(value);}
