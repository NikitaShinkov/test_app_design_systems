import {cleanText,normalize} from './normalization.js';
import {classifyProposal} from './domain.js';
import {selectionValues} from './exchange-scope.js';
import {createHash} from 'node:crypto';

const fail=(status,code,message,details=[])=>{throw Object.assign(new Error(message),{status,code,details});};
export const permitEligible=row=>!row.archived&&(classifyProposal(row)==='APPROVED'||(!classifyProposal(row)&&row.hasHistoricalApproval));
export const permitProductKey=row=>JSON.stringify([normalize(row.orderNo),normalize(row.productDecimalNo)]);
const text=value=>String(value??'');
const checks=rows=>rows.map(row=>({proposalId:row.proposalId,rowVersion:Number(row.rowVersion||1),productCode:text(row.productCode)})).sort((a,b)=>a.proposalId<b.proposalId?-1:a.proposalId>b.proposalId?1:0);

export function permitCatalog(proposals) {
  const active=proposals.filter(row=>!row.archived),products=new Map(),orderNames=new Map();
  for(const row of active)if(!orderNames.has(normalize(row.orderNo)))orderNames.set(normalize(row.orderNo),row.orderNo);
  for(const row of active.filter(permitEligible)) {
    const key=permitProductKey(row);
    if(!products.has(key))products.set(key,{key,orderKey:normalize(row.orderNo),productKey:normalize(row.productDecimalNo),orderNo:orderNames.get(normalize(row.orderNo)),productDecimalNo:row.productDecimalNo,product:row.product||'',eligible:0});
    products.get(key).eligible++;
  }
  return [...products.values()].map(product=>{
    const rows=active.filter(row=>permitProductKey(row)===product.key);
    const storedCode=rows.map(row=>cleanText(row.productCode)).find(Boolean)||'';
    return {...product,storedCode,currentCodes:[...new Set(rows.map(row=>cleanText(row.productCode)).filter(Boolean))],updatesIfStored:storedCode?rows.filter(row=>text(row.productCode)!==storedCode).length:0};
  });
}

export function preparePermitMetadata(proposals,options={}) {
  const catalog=permitCatalog(proposals);
  if(!catalog.length)fail(422,'M07_NO_ELIGIBLE_ROWS','M07 cannot generate deviation permits.',['No approved or previously approved substitutions were found.']);
  let orders=selectionValues(options.orderNos)??(cleanText(options.orderNo)?[options.orderNo]:null);
  if(orders===null) {
    orders=[...new Set(catalog.map(row=>row.orderNo))];
    if(new Set(orders.map(normalize)).size>1)fail(422,'M07_ORDER_SELECTION_REQUIRED','Choose the orders for the deviation permits.');
  }
  if(!orders.length)fail(422,'M07_ORDER_SELECTION_EMPTY','Select at least one order for deviation permits.');
  const selectedOrders=new Set(orders.map(normalize));
  const availableOrders=new Set(catalog.map(row=>normalize(row.orderNo)));
  if(orders.some(order=>!availableOrders.has(normalize(order))))fail(422,'M07_ORDER_NOT_AVAILABLE','A selected order has no eligible deviation-permit rows.');
  const available=catalog.filter(row=>selectedOrders.has(normalize(row.orderNo)));
  const products=selectionValues(options.productDecimalNos);
  if(products!==null&&!products.length)fail(422,'M07_PRODUCT_SELECTION_EMPTY','Select at least one product for deviation permits.');
  const selectedProducts=products===null?null:new Set(products.map(normalize));
  if(products?.some(product=>!available.some(row=>normalize(row.productDecimalNo)===normalize(product))))fail(422,'M07_PRODUCT_NOT_AVAILABLE','A selected product has no eligible rows in the selected orders.');
  const selected=available.filter(row=>!selectedProducts||selectedProducts.has(normalize(row.productDecimalNo)));
  if(!selected.length)fail(422,'M07_NO_ELIGIBLE_ROWS','M07 cannot generate deviation permits.',['No approved or previously approved substitutions were found for the selected orders and products.']);
  let inputs=options.productCodes??[];
  if(typeof inputs==='string'){try{inputs=JSON.parse(inputs);}catch{fail(422,'M07_PRODUCT_CODES_INVALID','Product codes must be supplied as a JSON array.');}}
  if(!Array.isArray(inputs)||inputs.length>1000)fail(422,'M07_PRODUCT_CODES_INVALID','Supply one optional product code for each selected order and product.');
  const entered=new Map();
  for(const input of inputs) {
    if(!input||typeof input!=='object'||typeof input.orderNo!=='string'||typeof input.productDecimalNo!=='string'||typeof input.productCode!=='string')fail(422,'M07_PRODUCT_CODES_INVALID','Each product-code entry must contain an order, product decimal number and text code.');
    const key=permitProductKey(input),product=selected.find(row=>row.key===key),code=cleanText(input.productCode);
    if(!product)fail(422,'M07_PRODUCT_CODE_SCOPE','A product-code entry is outside the selected order/product scope.');
    // The read-only UI echoes the stored code. Reusing it must follow the
    // same path as omitting this input; this is not a new product-code entry.
    const storedEcho=Boolean(product.storedCode)&&input.productCode===product.storedCode;
    if(!storedEcho&&(input.productCode.length>120||/[\x00-\x1f\x7f]/.test(input.productCode)))fail(422,'M07_PRODUCT_CODES_INVALID','New product codes must be text of at most 120 characters without control characters.');
    if(entered.has(key)&&entered.get(key)!==code)fail(422,'M07_PRODUCT_CODE_CONFLICT','Conflicting product codes were entered for the same order and product.');
    if(product.storedCode&&code&&product.storedCode!==code)fail(409,'M07_STORED_PRODUCT_CODE_CHANGED','A product code is already stored. Review the current stored code before preparing this export.');
    entered.set(key,code);
  }
  const groups=selected.map(product=>{
    const allRows=proposals.filter(row=>!row.archived&&permitProductKey(row)===product.key);
    const productCode=product.storedCode||entered.get(product.key)||'';
    const updates=productCode?allRows.filter(row=>text(row.productCode)!==productCode).map(row=>({proposalId:row.proposalId,rowVersion:Number(row.rowVersion||1),before:text(row.productCode),after:productCode})):[];
    return {...product,productCode,source:product.storedCode?'STORED':productCode?'ENTERED':'OMITTED',checks:checks(allRows),updates};
  });
  const byKey=new Map(groups.map(group=>[group.key,group]));
  const rows=proposals.filter(permitEligible).filter(row=>byKey.has(permitProductKey(row))).map(row=>({...row,productCode:byKey.get(permitProductKey(row)).productCode}));
  return {rows,plan:{format:1,groups}};
}

export function permitMetadataSummary(plan) {
  return (plan?.groups||[]).map(({orderNo,productDecimalNo,product,productCode,source,updates})=>({orderNo,productDecimalNo,product,productCode,source,updatedRows:updates.length}));
}
export const permitPlanDigest=plan=>createHash('sha256').update(JSON.stringify(plan)).digest('hex');

export function validatePermitMetadata(plan,proposals,context) {
  if(context.role!=='ADMINISTRATOR')fail(403,'M07_METADATA_FORBIDDEN','Only an administrator can update product codes for deviation permits.');
  if(plan?.format!==1||!Array.isArray(plan.groups))fail(409,'M07_METADATA_INVALID','The saved product-code review is invalid. Prepare a new export.');
  const changes=[];
  for(const group of plan.groups.filter(group=>group.updates.length)) {
    const current=proposals.filter(row=>!row.archived&&permitProductKey(row)===group.key);
    if(JSON.stringify(checks(current))!==JSON.stringify(group.checks))fail(409,'M07_METADATA_CHANGED','Product metadata or its proposal rows changed after review. Prepare a new M07 export.',[`Order ${group.orderNo}; product ${group.productDecimalNo}. No product-code updates were applied.`]);
    for(const update of group.updates) {
      const row=current.find(row=>row.proposalId===update.proposalId);
      if(!row||text(row.productCode)!==update.before||update.after!==group.productCode)fail(409,'M07_METADATA_INVALID','The saved product-code updates are inconsistent. Prepare a new export.');
      changes.push({row,update});
    }
  }
  return changes;
}
