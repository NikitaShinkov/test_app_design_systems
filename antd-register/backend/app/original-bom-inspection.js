import XLSX from 'xlsx';
import {readLegacyWorkbook,sheetRows} from './workbook-reader.js';
import {workflowError} from './workbook-file-errors.js';
import {cleanText,normalize} from './normalization.js';
import {matchSourceRow} from './bom-matching.js';
import {readImportMetadata} from './import-source.js';
import {selectedM01Product,hasM01WorkflowColumns} from './m01-metadata.js';
import {lastOccupiedHeaderColumn,importCellOccupied} from './import-row-extent.js';
import {sourceHeaderColumns,findSourceHeaderRow,sourceTableHeaders} from './source-header-plan.js';

const clean=value=>String(value??'').trim();

function inspectWorkflowSource(moduleId, buffer, filename = "workbook.xlsx", options = {}) {
  if (!["M01", "M09"].includes(moduleId)) workflowError("INSPECTION_NOT_SUPPORTED", `${moduleId} does not support source-BOM inspection.`);
  if (!buffer?.length) workflowError(`${moduleId}_FILE_REQUIRED`, `${moduleId} requires an original BOM workbook.`, ["Select a non-empty XLS, XLSX, or XLSM file."]);
  const workbook = readLegacyWorkbook(buffer,{physicalCells:true});
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) workflowError(`${moduleId}_EMPTY_WORKBOOK`, `${moduleId} cannot read '${filename}'.`, ["The workbook contains no worksheets."]);
  // Source VBA addresses worksheet cells, not a compressed used range. Keep
  // leading blank rows/columns so header limits and later physical edits agree.
  const rows = sheetRows(workbook, sheetName, true);
  const headerIndex = findSourceHeaderRow(moduleId,rows,{limit:20,allowWorkflowColumns:options.allowWorkflowColumns})-1;
  if (headerIndex < 0) {
    workflowError(`${moduleId}_HEADER_NOT_FOUND`, `${moduleId} cannot export '${filename}' because the component header row was not found.`, [
      `Worksheet checked: ${sheetName}.`,
      moduleId==='M09' ? "Within the first 20 rows, expected an Original PN / Nomenclature column." : "Within the first 20 rows, expected an Original PN / Nomenclature column and either Quantity / Qty / PCS or Designation / Orig_Mfr / Manufacturer. A position-only row is not a component header."
    ]);
  }
  // Stubs witness physical occupancy only, including uncached formulas. Never
  // use their synthesized values as metadata, business text or formula caches.
  const formulaSheet=workbook.Sheets[sheetName];
  const headerColumns=lastOccupiedHeaderColumn(formulaSheet,{row:headerIndex+1,lastColumn:formulaSheet['!ref']?XLSX.utils.decode_range(formulaSheet['!ref']).e.c+1:rows[headerIndex].length});
  const rawHeaders=Array.from({length:headerColumns},(_,index)=>rows[headerIndex][index]??'');
  const headers = sourceTableHeaders(rawHeaders);
  // Bind business fields before repairing table labels. Distinct source text
  // and punctuation cannot silently become a different source column.
  const sourceColumns=sourceHeaderColumns(moduleId,rawHeaders);
  if(moduleId==='M01' && !options.allowWorkflowColumns && hasM01WorkflowColumns(rawHeaders))workflowError('M01_WORKFLOW_COLUMNS_EXIST',`M01 cannot prepare '${filename}' again.`,[`Worksheet '${sheetName}', header row ${headerIndex+1}: alternative/workflow columns already exist. Select the original client BOM; use M02 to import a supplier reply or register the existing supplier BOM for M09.`]);
  const quantityColumn=(sourceHeaderColumns('M01',rawHeaders).quantity||0)-1;
  const pnColumn=(sourceColumns.origPn||0)-1;
  const useQuantity=moduleId==='M01' && quantityColumn>=0;
  const lastColumn=useQuantity?quantityColumn:pnColumn;
  const lastColumnFilled=index=>{
    // End(xlUp) is physical for M01 Quantity/PN and M09 PN alike. Eligibility
    // for writing final actions is a separate cleaned-PN test in createM09.
    const address=XLSX.utils.encode_cell({r:index,c:lastColumn});
    return importCellOccupied(formulaSheet[address]);
  };
  let end=rows.length-1;while(end>headerIndex && !lastColumnFilled(end))end--;
  const rowCount = end-headerIndex;
  if (!rowCount&&moduleId==='M01') workflowError(`${moduleId}_NO_COMPONENT_ROWS`, `${moduleId} cannot export '${filename}' because no component rows follow the header.`, [`Worksheet '${sheetName}', header row ${headerIndex+1}: column '${headers[lastColumn]}' has no filled cells below the header. ${useQuantity?'The macro determines the final BOM row from Quantity when this column exists.':'The macro determines the final BOM row from Original PN.'}`]);
  const findings=useQuantity?rows.slice(end+1).flatMap((row,index)=>clean(row[pnColumn])?[{code:'TRAILING_QUANTITY_MISSING',sheet:sheetName,row:end+index+2,field:headers[quantityColumn],message:`Worksheet '${sheetName}', row ${end+index+2}: '${headers[quantityColumn]}' is blank. The original component cells are retained below the supplier table, as in the macro; complete the source quantity to include this row in the table.`}]:[]):[];
  // Source metadata defaults share Core's first-label scan. Stop before the
  // component header so adjacent table labels cannot become metadata values.
  const meta = readImportMetadata(rows.slice(0,headerIndex));
  meta.productDecimalNo ||= filename.replace(/^.*[\\/]/,'').match(/[A-ZА-ЯЁ]{2,6}[.]\d{6}[.]\d{3}(-\d{1,3})?([ ]*EX)?/i)?.[0]||'';
  return {rows,inspection:{
    metadata: meta,
    sourceSheet: sheetName,
    headerRow: headerIndex + 1,
    headers,
    rawHeaders,
    sourceColumns,
    rowCount,
    lastDataRow:end+1,
    quantityColumn:quantityColumn+1,
    findings,
    missingMetadata: [["orderNo", "order number"], ["product", "product name"], ["productDecimalNo", "product decimal number"], ["supplier", "supplier name"]].filter(([key]) => !meta[key]).map(([, label]) => label)
  }};
}

export function inspectWorkflowWorkbook(moduleId,buffer,filename='workbook.xlsx',options={}){
  return inspectWorkflowSource(moduleId,buffer,filename,options).inspection;
}

export function analyzeOriginalBOM(buffer,replacements,options={}) {
  selectedM01Product(options);
  const {inspection:inspected,rows}=inspectWorkflowSource('M01',buffer,options.sourceFilename||'workbook.xlsx');
  const meta={...inspected.metadata,...Object.fromEntries(['orderNo','product','productCode','productDecimalNo','supplier','productionOrder'].filter(key=>Object.hasOwn(options,key)).map(key=>[key,cleanText(options[key])]))};
  const productKey=normalize(meta.productDecimalNo),relatedRecords=replacements.filter(record=>normalize(record.productDecimalNo)===productKey);
  const sourceValue=(row,key)=>cleanText(row[(inspected.sourceColumns[key]||0)-1]);
  const matches=rows.slice(inspected.headerRow,inspected.lastDataRow).map((row,offset)=>{
    const match=matchSourceRow({productDecimalNo:meta.productDecimalNo,position:sourceValue(row,'position'),code:sourceValue(row,'origCode'),rowText:row.map(cleanText).filter(Boolean).join(' | ')},relatedRecords);
    return {sourceRow:inspected.headerRow+offset+1,position:sourceValue(row,'position'),origCode:sourceValue(row,'origCode'),sourcePn:sourceValue(row,'origPn'),...match};
  });
  return {...inspected,metadata:meta,missingMetadata:[['orderNo','order number'],['product','product name'],['productDecimalNo','product decimal number'],['supplier','supplier name']].filter(([key])=>!meta[key]).map(([,label])=>label),approvedDatabaseCount:relatedRecords.filter(record=>normalize(record.decisionStatus)==='APPROVED'&&cleanText(record.altPn)).length,approvedMatchCount:matches.filter(item=>item.record).length,ambiguousCount:matches.filter(item=>item.ambiguous).length,obsoleteCount:matches.filter(item=>item.obsolete).length,matches};
}

