import {cleanText,normalize} from './normalization.js';

export const IMPORT_SOURCE_VERSION='IMPORT-SOURCE-CELLS-v6';
export const importHeaderFields={M02:['origPn','altPn'],M04:['origPn','altPn','clientDecision'],M08:['origPn','altPn','decisionDate']};
export const importHeaderLabels={origPn:'Orig_PN',altPn:'Alt_PN',clientDecision:'Client_Decision',decisionDate:'Decision_Date'};

function metadataName(value) {
  const name=normalize(value).replace(/[_-]/g,' ').replace(/ {2,}/g,' ').replace(/^ +| +$/g,'');
  if(['ORDER NO','ORDER NUMBER','ORDER'].includes(name))return 'ORDER NO';
  if(['PRODUCT DECIMAL NO','PRODUCT DECIMAL NUMBER','DECIMAL NO','DECIMAL NUMBER'].includes(name))return 'PRODUCT DECIMAL NO';
  if(['PRODUCT 1C CODE','PRODUCT CODE 1C'].includes(name))return 'PRODUCT 1C CODE';
  if(['PRODUCTION ORDER','PRODUCTION ORDER NO','PRODUCTION ORDER NUMBER'].includes(name))return 'PRODUCTION ORDER';
  if(['SUPPLIER','SUPPLIER NAME'].includes(name))return 'SUPPLIER';
  if(['PRODUCT','PRODUCT NAME','BOARD'].includes(name))return 'PRODUCT';
  return name;
}

// Core.bas AC8_GetMetadataValue: first matching label, rows 1–15, columns A–H;
// the value is the adjacent cell (including column I for a label in H).
export function readImportMetadata(rows) {
  const labels={orderNo:'ORDER NO',product:'PRODUCT',productCode:'PRODUCT 1C CODE',productDecimalNo:'PRODUCT DECIMAL NO',supplier:'SUPPLIER',productionOrder:'PRODUCTION ORDER',round:'ROUND'};
  const found=new Map();
  for(const row of rows.slice(0,15))for(let column=0;column<8;column++){
    const name=metadataName(row[column]);if(!found.has(name))found.set(name,cleanText(row[column+1]));
  }
  return Object.fromEntries(Object.entries(labels).map(([field,label])=>[field,found.get(label)??(field==='round'?found.get('APPROVAL ROUND')||'':'')]));
}

// Workflow.bas WF_ExtractProductDecimalFromFileName uses this unanchored,
// case-insensitive first match. Preserve its returned case and spaces.
export function supplierDecimalFilenameDefault(filename='') {
  const basename=String(filename).split(/[\\/]/).at(-1);
  return basename.match(/[A-ZА-ЯЁ]{2,6}[.]\d{6}[.]\d{3}(-\d{1,3})?([ ]*EX)?/i)?.[0]||'';
}

export function resolveImportMetadata(moduleId,row,meta,options,sheetName,filename='') {
  const result={...row};
  for(const field of ['orderNo','supplier','product','productCode','productDecimalNo','productionOrder']){
    if(row.presentFields.includes(field)){
      // Final.bas explicitly falls back to the selected order for a blank row
      // order. M02/M04 preserve that blank so it is reported, not inferred.
      if(moduleId==='M08'&&field==='orderNo'&&!row.orderNo)result.orderNo=cleanText(options.orderNo);
      continue;
    }
    if(moduleId==='M08'&&field==='productDecimalNo')result[field]=row.proposalId?'':cleanText(options[field])||sheetName;
    else if(moduleId==='M02'&&field==='productDecimalNo')result[field]=meta[field]||cleanText(options[field])||supplierDecimalFilenameDefault(filename);
    else result[field]=(moduleId==='M02'||field==='orderNo'?meta[field]:'')||cleanText(options[field]);
  }
  result.round=meta.round||cleanText(options.round);
  return result;
}
