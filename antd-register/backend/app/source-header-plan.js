import {normalize} from './normalization.js';

// Exact labels from the current source VBA. Detector aliases deliberately
// differ from extraction aliases; explicit user mapping is handled separately.
const aliases = {
  "M01": {
    "quantity": [
      "Quantity",
      "Qty",
      "PCS",
      "Quantity (PCS)",
      "Qty (PCS)"
    ],
    "origPn": [
      "Orig_PN",
      "Nomenclature",
      "Part Number",
      "Part No",
      "PN",
      "Orig PN"
    ],
    "position": [
      "Position",
      "Pos",
      "Positional designation",
      "Positional"
    ],
    "origCode": [
      "Orig_Code",
      "Code",
      "1C Code",
      "Code 1C",
      "Code1C"
    ],
    "origMfr": [
      "Orig_Mfr",
      "Manufacturer",
      "Mfr",
      "Brand",
      "Designation",
      "Designation (Orig_Mf)"
    ]
  },
  "M02": {
    "proposalId": [
      "Proposal_ID"
    ],
    "orderNo": [
      "Order_No",
      "Order No",
      "Order"
    ],
    "supplier": [
      "Supplier",
      "Supplier Name"
    ],
    "product": [
      "Product",
      "Product Name",
      "Board"
    ],
    "productCode": [
      "Product_1C_Code",
      "Product 1C Code",
      "Product Code 1C"
    ],
    "productDecimalNo": [
      "Product_Decimal_No",
      "Product Decimal No",
      "Decimal No",
      "Decimal Number"
    ],
    "productionOrder": [
      "Production_Order",
      "Production Order"
    ],
    "position": [
      "Position",
      "Pos",
      "Positional designation",
      "Positional"
    ],
    "origCode": [
      "Orig_Code",
      "Code",
      "1C Code",
      "Code 1C",
      "Code1C"
    ],
    "origMfr": [
      "Orig_Mfr",
      "Manufacturer",
      "Mfr",
      "Brand",
      "Designation",
      "Designation (Orig_Mf)"
    ],
    "origPn": [
      "Orig_PN",
      "Nomenclature",
      "Part Number",
      "Part No",
      "PN",
      "Orig PN",
      "Orig_PN/Parameters",
      "Nomenclature (Orig_PN)"
    ],
    "altMfr": [
      "Alt_Mfr",
      "Alternative Manufacturer",
      "Alternative Mfr",
      "Alt Manufacturer"
    ],
    "altPn": [
      "Alt_PN",
      "Alternative PN",
      "Replacement PN",
      "Suggested PN",
      "Alt PN"
    ],
    "supplierReply": [
      "Supplier_Reply",
      "Supplier Reply",
      "Supplier_Decision"
    ],
    "supplierComment": [
      "Supplier_Comment",
      "Supplier Comment",
      "Comment",
      "Remarks"
    ],
    "componentStatus": [
      "Component_Status",
      "Component Status",
      "Lifecycle Status"
    ]
  },
  "M04": {
    "proposalId": [
      "Proposal_ID"
    ],
    "orderNo": [
      "Order_No",
      "Order No",
      "Order"
    ],
    "supplier": [
      "Supplier",
      "Supplier Name"
    ],
    "product": [
      "Product",
      "Product Name",
      "Board"
    ],
    "productCode": [
      "Product_1C_Code",
      "Product 1C Code"
    ],
    "productDecimalNo": [
      "Product_Decimal_No",
      "Product Decimal No",
      "Decimal No"
    ],
    "position": [
      "Position",
      "Pos",
      "Positional designation"
    ],
    "origCode": [
      "Orig_Code",
      "Code",
      "1C Code",
      "Code 1C",
      "Code1C"
    ],
    "origMfr": [
      "Orig_Mfr",
      "Manufacturer",
      "Mfr",
      "Designation"
    ],
    "origPn": [
      "Orig_PN",
      "Nomenclature",
      "Part Number",
      "PN"
    ],
    "altMfr": [
      "Alt_Mfr",
      "Alternative Manufacturer",
      "Alternative Mfr"
    ],
    "altPn": [
      "Alt_PN",
      "Alternative PN",
      "Replacement PN",
      "Suggested PN"
    ],
    "clientDecision": [
      "Client_Decision",
      "Preliminary_Reply",
      "Customer_Reply",
      "Customer Reply"
    ],
    "clientComment": [
      "Client_Comment",
      "Customer_Comment",
      "Customer Comment"
    ],
    "componentStatus": [
      "Component_Status",
      "Component Status",
      "Lifecycle Status"
    ],
    "responsible": [
      "Responsible",
      "Owner"
    ]
  },
  "M08": {
    "proposalId": [
      "Proposal_ID"
    ],
    "orderNo": [
      "Order_No",
      "Order No",
      "Order"
    ],
    "productDecimalNo": [
      "Product_Decimal_No",
      "Product Decimal No",
      "Decimal No",
      "Decimal Number"
    ],
    "position": [
      "Position",
      "Pos",
      "Positional designation"
    ],
    "origMfr": [
      "Orig_Mfr",
      "Manufacturer",
      "Mfr",
      "Designation"
    ],
    "origPn": [
      "Orig_PN",
      "Original PN",
      "Nomenclature",
      "Part Number",
      "Part No",
      "PN"
    ],
    "altMfr": [
      "Alt_Mfr",
      "Alternative Manufacturer",
      "Alternative Mfr",
      "Final_Mfr"
    ],
    "altPn": [
      "Alt_PN",
      "Alternative PN",
      "Replacement PN",
      "Final_PN"
    ],
    "productCode": [
      "Product_1C_Code"
    ],
    "productionOrder": [
      "Production_Order"
    ],
    "clientComment": [
      "Client_Comment",
      "Decision_Comment"
    ],
    "responsible": [
      "Responsible"
    ],
    "decisionReference": [
      "Decision_Reference"
    ],
    "decisionDate": [
      "Decision_Date"
    ]
  },
  "M09": {
    "position": [
      "Position",
      "Pos",
      "Positional designation"
    ],
    "origCode": [
      "Orig_Code",
      "Code",
      "1C Code",
      "Code 1C",
      "Code1C"
    ],
    "origMfr": [
      "Orig_Mfr",
      "Manufacturer",
      "Mfr",
      "Brand",
      "Designation"
    ],
    "origPn": [
      "Orig_PN",
      "Nomenclature",
      "Part Number",
      "Part No",
      "PN",
      "Orig PN"
    ]
  }
};
export const sourceHeaderAliases=Object.freeze(Object.fromEntries(Object.entries(aliases).map(([id,fields])=>[id,Object.freeze(Object.fromEntries(Object.entries(fields).map(([field,names])=>[field,Object.freeze(names)])))])));
export const sourceImportFields=Object.freeze(['proposalId','orderNo','supplier','product','productCode','productDecimalNo','productionOrder','position','origCode','origMfr','origPn','quantity','altMfr','altPn','supplierReply','supplierComment','componentStatus','manufacturerRelationship','historicalStatus','historicalReference','clientDecision','clientComment','responsible','decisionReference','decisionDate']);
const pn=['Orig_PN','Nomenclature','Part Number','Part No','PN','Orig PN'];
const quantity=['Quantity','Qty','PCS','Quantity (PCS)','Qty (PCS)'];
const alternative=['Alt_PN','Alternative PN','Replacement PN','Suggested PN','Alt PN'];
const preliminaryAlternative=['Alt_PN','Alternative PN','Replacement PN'];
const preliminaryDecision=['Client_Decision','Preliminary_Reply','Customer_Reply'];
const invalid=()=>Object.assign(new Error('The source header model or module is invalid.'),{status:422,code:'SOURCE_HEADER_MODEL_INVALID'});
const moduleFields=id=>{const fields=sourceHeaderAliases[id];if(!fields)throw invalid();return fields;};
const headerMatch=(headers,names)=>{const accepted=new Set(names.map(normalize));return headers.findIndex(value=>accepted.has(normalize(value)));};

/** One-based indexes; only fields actually read by this module are inferred.
 * Core.FindHeaderAtRow scans columns before aliases, so no alias is preferred. */
export function sourceHeaderColumns(moduleId,headers){
 if(!Array.isArray(headers)||headers.length>16384)throw invalid();
 const fields=moduleFields(moduleId),result={};
 for(const [field,names]of Object.entries(fields)){const index=headerMatch(headers,names);if(index>=0)result[field]=index+1;}
 return result;
}

/** One-based row or0. The optional40-row limit is mapping-preview discovery,
 * never an extension of the automatic import limits chosen by the caller. */
export function findSourceHeaderRow(moduleId,rows,{limit=moduleId==='M08'?10:20,allowWorkflowColumns=false}={}){
 moduleFields(moduleId);if(!Array.isArray(rows)||!Number.isSafeInteger(limit)||limit<1||limit>40)throw invalid();
 const count=Math.min(rows.length,limit),has=(row,names)=>headerMatch(Array.isArray(row)?row:[],names)>=0;
 if(moduleId==='M08'){
  for(const name of ['Orig_PN','Nomenclature'])for(let index=0;index<count;index++)if(has(rows[index],[name]))return index+1;
  return 0;
 }
 for(let index=0;index<count;index++){
  const row=rows[index];let found=false;
  if(moduleId==='M01')found=has(row,pn)&&(allowWorkflowColumns||has(row,quantity)||has(row,['Designation','Orig_Mfr','Manufacturer']));
  else if(moduleId==='M02')found=has(row,pn)&&has(row,alternative);
  else if(moduleId==='M04')found=has(row,preliminaryDecision)&&has(row,preliminaryAlternative);
  else if(moduleId==='M09')found=has(row,pn);
  if(found)return index+1;
 }
 return 0;
}

// Table-label safety is separate from identity. Keep distinct nonempty labels
// verbatim, including edge tabs/spaces; repair blanks/case collisions only.
export function sourceTableHeaders(headers){
 const labels=headers.map(header=>String(header??''));
 const reserved=new Set(labels.filter(label=>label.trim()).map(label=>label.toUpperCase())),used=new Set();
 return labels.map((label,index)=>{
  const base=label.trim()?label:'Column_'+(index+1);let name=base,suffix=2;
  if(!label.trim()||used.has(name.toUpperCase()))while(used.has(name.toUpperCase())||reserved.has(name.toUpperCase()))name=base+'_'+suffix++;
  used.add(name.toUpperCase());return name;
 });
}
