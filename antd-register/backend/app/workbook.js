import {translateM01Sheet} from './bom-english.js';
import {applyExcelDecisionFormatting} from './decision-formatting.js';
import {workflowError} from './workbook-file-errors.js';
export {WorkflowFileError} from './workbook-file-errors.js';
import {readLegacyWorkbook,sheetRows} from './workbook-reader.js';
export {readLegacyWorkbook} from './workbook-reader.js';
import {inspectWorkflowWorkbook,analyzeOriginalBOM} from './original-bom-inspection.js';
export {inspectWorkflowWorkbook,analyzeOriginalBOM} from './original-bom-inspection.js';
import ExcelJS from "exceljs";
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {loadBundledProfiles} from './font-metrics.js';
import {applyExcelJsSheetGrowth} from './selective-row-growth.js';
import {normalFontFromStyles} from './preserved-row-growth.js';
import XLSX from "xlsx";
import JSZip from "jszip";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {createHash} from 'node:crypto';
import { finalPreflight, recalculateProposal, classifyProposal, includedInFinal, createHistoryIndex,decisionExportText } from "./domain.js";
import { cleanText, canonicalManufacturer, cleanPartNumber, normalize, originalKey } from "./normalization.js";
import { validBusinessDate } from "./validation.js";
import {shiftFormulaReferences,shiftWorkbookReferences} from './workbook-structure.js';
import {exchangeScope,preliminaryEligible,feedbackEligible,roundValue,selectionValues} from './exchange-scope.js';
import {preparePermitMetadata,permitCatalog,permitProductKey} from './permit-metadata.js';
import {importProposalWorkingOrder,copyProposalWorkingOrder,requireKnownWorkingOrder,proposalWorkingOrderProof} from './working-order-operations.js';
import {PreservedWorkbook} from './xlsx-preservation.js';
import {readImportMetadata,resolveImportMetadata,importHeaderFields,importHeaderLabels} from './import-source.js';
import {selectedM01Product} from './m01-metadata.js';
import {lastImportDataRow} from './import-row-extent.js';
import {planM09Headers,m09TableHeaders,m09CellOccupied} from './m09-header-plan.js';
import {sourceHeaderColumns,findSourceHeaderRow,sourceImportFields,sourceTableHeaders} from './source-header-plan.js';
import {canonicalWorksheetProperties} from './worksheet-xml-order.js';

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ZIP_TYPE = "application/zip";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const deviationTemplatePath = path.join(moduleRoot, "assets", "Card_of_Deviation_Template_v6.docx");
let layoutProfiles;
const measuredLayoutProfiles=()=>layoutProfiles??=loadBundledProfiles(moduleRoot);
async function sourceLayoutInformation(buffer){
  const zip=await JSZip.loadAsync(buffer),part=zip.file('xl/styles.xml');
  const parse=text=>new DOMParser().parseFromString(text.replace(/^\uFEFF/,''),'application/xml');
  const read=async entry=>{const bytes=await entry.async('nodebuffer'),encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';return parse(new TextDecoder(encoding,{fatal:true}).decode(bytes));};
  const normalFont=part?normalFontFromStyles(await read(part)):{name:'Calibri',size:11};
  const workbook=await read(zip.file('xl/workbook.xml')),relationships=await read(zip.file('xl/_rels/workbook.xml.rels'));
  const firstSheet=workbook.getElementsByTagNameNS('*','sheet')[0],relationshipId=firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id')||firstSheet?.getAttribute('r:id'),relationship=Array.from(relationships.getElementsByTagNameNS('*','Relationship')).find(node=>node.getAttribute('Id')===relationshipId),target=relationship?.getAttribute('Target');
  const sheetPart=target&&(target.startsWith('/')?target.slice(1):path.posix.normalize(path.posix.join('xl',target))),zeroHeightRows=new Set();
  if(sheetPart&&zip.file(sheetPart))for(const row of Array.from((await read(zip.file(sheetPart))).getElementsByTagNameNS('*','row')))if(row.hasAttribute('ht')&&Number(row.getAttribute('ht'))===0)zeroHeightRows.add(Number(row.getAttribute('r')));
  return {normalFont,zeroHeightRows};
}
async function growDataRows(worksheet,headerRow,headers,lastRow=worksheet.rowCount,{normalFont={name:'Calibri',size:11},date1904=false}={}){
  const profiles=await measuredLayoutProfiles();
  return applyExcelJsSheetGrowth(worksheet,headerRow,lastRow,headers,{profiles,normalFont,formatDisplay:cell=>{
    const value=typeof cell.value==='number'?cell.value:typeof cell.value?.result==='number'?cell.value.result:undefined;
    return value!==undefined&&cell.numFmt?XLSX.SSF.format(cell.numFmt,value,{date1904}):undefined;
  }});
}

const preliminaryHeaders = ["Supplier", "Product", "Product_1C_Code", "Product_Decimal_No", "Position", "Orig_Code", "Orig_Mfr", "Orig_PN", "Alt_Mfr", "Alt_PN", "Supplier_Reply", "Supplier_Comment", "Component_Status", "Manufacturer_Relationship", "Historical_Status", "Client_Decision", "Client_Comment", "Responsible", "Proposal_ID"];
const finalHeaders = ["Supplier", "Product", "Product_1C_Code", "Product_Decimal_No", "Production_Order", "Position", "Orig_Code", "Orig_Mfr", "Orig_PN", "Alt_Mfr", "Alt_PN", "Manufacturer_Relationship", "Component_Status", "Historical_Status", "Historical_Reference", "Client_Decision", "Client_Comment", "Responsible", "Decision_Reference", "Decision_Date", "Proposal_ID"];
const feedbackHeaders = ["Position", "Orig_Code", "Orig_Mfr", "Orig_PN", "Alt_Mfr", "Alt_PN", "Supplier_Reply", "Supplier_Comment", "Component_Status", "Client_Decision", "Client_Comment", "Historical_Status", "Historical_Reference", "Proposal_ID"];
const supplierHeaders = ["Position", "Orig_Code", "Orig_Mfr", "Orig_PN", "Quantity", "Alt_Mfr", "Alt_PN", "Supplier_Reply", "Supplier_Comment", "Component_Status", "Client_Decision", "Client_Comment"];
const completeHeaders = ["Position", "Orig_Code", "Orig_Mfr", "Orig_PN", "Quantity", "Procurement_Action", "Final_Mfr", "Final_PN", "Client_Comment"];

const clean = (value) => String(value ?? "").trim();
const sameText = (left, right) => clean(left).toUpperCase() === clean(right).toUpperCase();
const normalizeHeader = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
const safeName = (value) => clean(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, " ").slice(0, 120) || "Replacement Register";
const safeSheetName = (value) => safeName(value).replace(/[\[\]]/g, "_").slice(0, 31).replace(/^'+|'+$/g, "") || "Sheet";

function productSheetNames(groups) {
  const bases = new Map(groups.map(([key, rows]) => [key, safeSheetName(rows[0].productDecimalNo || "Unspecified")]));
  const counts = new Map();
  for (const name of bases.values()) counts.set(name.toUpperCase(), (counts.get(name.toUpperCase()) || 0) + 1);
  const names = new Map(), used = new Set();
  for (const [key, base] of bases) {
    let name = base;
    if (counts.get(base.toUpperCase()) > 1 || base.toUpperCase() === 'HISTORY') name = `${base.slice(0, 24)}_${createHash('sha256').update(key).digest('hex').slice(0, 6)}`;
    let suffix = 1;
    while (used.has(name.toUpperCase())) name = `${base.slice(0, 22)}_${String(suffix++).padStart(8, '0')}`;
    used.add(name.toUpperCase()); names.set(key, name);
  }
  return names;
}

function selectedValues(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(clean).filter(Boolean);
  } catch {}
  return text.split("\u001f").map(clean).filter(Boolean);
}

function positiveNumber(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function filenameToken(value, fallback = "Unknown", maximum = 28) {
  return clean(value).replace(/\b(?:limited|ltd|incorporated|inc|company|co)\.?\b/gi, "").replace(/[^\p{L}\p{N}.-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, maximum) || fallback;
}

function productToken(value, decimal = "") {
  const source = clean(value) || clean(decimal);
  const number = source.match(/\b\d{3,}(?:[.-]\d+)*\b/);
  return filenameToken(number?.[0] || source.replace(/\b(?:board|module|assembly|pcba|product)\b/gi, ""), "", 24)||filenameToken(decimal,"",24);
}

const filenameStem=(...tokens)=>tokens.filter(Boolean).join('_');

function proposedFilename(moduleId, items = [], options = {}, extension = "xlsx") {
  const first = items[0] || options;
  const selectedOrders = selectedValues(options.orderNos);
  const order = selectedOrders.length > 1 ? "Multiple" : filenameToken(options.orderNo || selectedOrders[0] || first.orderNo, "", 18);
  const version = positiveNumber(options.version);
  const round = roundValue(options);const roundTag=round?`_R${filenameToken(round,'Round',16)}`:'';
  const product = productToken(options.product || first.product, options.productDecimalNo || first.productDecimalNo);
  const supplier = filenameToken(options.supplier || first.supplier, "", 24);
  const orderTag=order?`O${order}`:'';
  const identity=['M03','M05'].includes(moduleId)&&items.length&&new Set(items.map(item=>normalize(item.productDecimalNo))).size===1&&new Set(items.map(item=>normalize(item.supplier))).size===1?[product,supplier]:[];
  const named=(stage,tokens=[],ext='xlsx')=>`${filenameStem(moduleId,stage,...tokens,orderTag,roundTag.replace(/^_/,''),`v${version}`)}.${ext}`;
  const names = {
    M01: `${filenameStem('M01','Supplier-BOM',product,supplier,orderTag,version===1?'':`v${version}`)}.xlsx`,
    M03: named('Prelim-Approval',identity),
    M05: named('Feedback',identity,'zip'),
    M06: named('Final-Approval'),
    M07: `${filenameStem('M07','Permits',orderTag,`v${version}`)}.zip`,
    M09: `${filenameStem('M09','Final-BOM',orderTag,`v${version}`)}.zip`
  };
  return names[moduleId] || `${filenameStem(moduleId,orderTag,`v${version}`)}.${extension}`;
}

function selectedFilename(defaultName, requestedName, extension) {
  if (!clean(requestedName)) return defaultName;
  const withoutExtension = clean(requestedName).replace(/\.(?:xlsx|zip|docx)$/i, "");
  return `${safeName(withoutExtension)}.${extension}`;
}

function uniqueHeaders(headers) {
  const used = new Map();
  return headers.map((value, index) => {
    const base = clean(value) || `Column_${index + 1}`;
    const key = base.toUpperCase();
    const count = (used.get(key) || 0) + 1;
    used.set(key, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function findHeader(rows, required = ["origpn"]) {
  for (let index = 0; index < Math.min(rows.length, 40); index += 1) {
    const normalized = rows[index].map(normalizeHeader);
    if (required.every((key) => normalized.includes(key))) return { index, headers: normalized };
  }
  return null;
}

function valueFor(row, headers, aliases) {
  // Core.FindHeaderAtRow scans columns before aliases; aliases express
  // accepted labels rather than a preference between multiple source columns.
  const index = headers.findIndex(header => aliases.includes(header));
  return index < 0 ? "" : cleanText(row[index]);
}

const importAliases = {
  proposalId: ['proposalid'], orderNo: ['orderno', 'order'], supplier: ['supplier', 'suppliername'], product: ['product', 'productname', 'board'],
  productCode: ['product1ccode', 'productcode1c', 'productcode'], productDecimalNo: ['productdecimalno', 'decimalno', 'decimalnumber'], productionOrder: ['productionorder'],
  position: ['position', 'pos', 'positionaldesignation', 'positional', 'designator'], origCode: ['origcode', 'originalcode', 'code', '1ccode', 'code1c'],
  origMfr: ['origmfr', 'originalmanufacturer', 'manufacturer', 'mfr', 'brand', 'designation', 'designationorigmf'],
  origPn: ['origpn', 'originalpn', 'nomenclature', 'partnumber', 'partno', 'pn', 'origpnparameters', 'nomenclatureorigpn', 'mpn'],
  quantity: ['quantity', 'quantitypcs', 'qty'], altMfr: ['altmfr', 'alternativemanufacturer', 'alternativemfr', 'altmanufacturer', 'replacementmanufacturer', 'finalmfr'],
  altPn: ['altpn', 'alternativepn', 'replacementpn', 'suggestedpn', 'finalpn'], supplierReply: ['supplierreply', 'supplierdecision'], supplierComment: ['suppliercomment', 'comment', 'remarks'],
  componentStatus: ['componentstatus', 'lifecyclestatus'], manufacturerRelationship: ['manufacturerrelationship'], historicalStatus: ['historicalstatus'], historicalReference: ['historicalreference'],
  clientDecision: ['clientdecision', 'preliminaryreply', 'customerreply'], clientComment: ['clientcomment', 'customercomment', 'decisioncomment'],
  responsible: ['responsible', 'owner'], decisionReference: ['decisionreference'], decisionDate: ['decisiondate']
};
function importDate(value,date1904=false) {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value,{date1904});
    return date ? `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}` : String(value);
  }
  const text = cleanText(value);
  if (validBusinessDate(text)) return text;
  const dotted = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`;
  return text;
}
function parseCanonicalRows(rows, sheetName, mapping, moduleId, date1904, worksheet) {
  let header,columns;
  const required=importHeaderFields[moduleId],limit=moduleId==='M08'?10:20;
  if(mapping) {
    // Numbered mapping is an explicit user choice. Do not turn its columns
    // into synthetic aliases and accidentally run automatic matching again.
    header={index:mapping.headerRow-1};columns={...mapping.columns};
  }
  if(!header){
    const row=findSourceHeaderRow(moduleId,rows,{limit});
    if(row){header={index:row-1};columns=sourceHeaderColumns(moduleId,rows[row-1]);}
  }
  if (!header) return {rows:[],message:`No compatible header within the first ${limit} rows. Expected ${required.map(field=>importHeaderLabels[field]).join(', ')}. Select an explicit worksheet/header mapping if the header is later.`};
  const presentFields = sourceImportFields.filter(field=>Number.isSafeInteger(columns[field])&&columns[field]>0);
  const missing=required.filter(field=>!(mapping&&presentFields.includes('proposalId')&&['origPn','altPn'].includes(field))&&!presentFields.includes(field));
  if(missing.length)return {rows:[],headerRow:header.index+1,fields:missing.map(field=>importHeaderLabels[field]),message:`Header row ${header.index+1}: missing required column(s): ${missing.map(field=>importHeaderLabels[field]).join(', ')}.`};
  const columnFor=field=>(columns[field]||0)-1;
  const lastColumn=columnFor('origPn')>=0?columnFor('origPn'):columnFor('proposalId');
  const end=lastImportDataRow(worksheet,{column:lastColumn+1,headerRow:header.index+1,lastRow:rows.length});
  const parsed=rows.slice(header.index + 1,end).map((row, offset) => {
    const item = Object.fromEntries(sourceImportFields.map(key => [key, cleanText(row[columnFor(key)])]));
    item.origMfr = canonicalManufacturer(item.origMfr); item.altMfr = canonicalManufacturer(item.altMfr);
    item.origPn = cleanPartNumber(item.origPn); item.altPn = cleanPartNumber(item.altPn);
    const dateIndex = columnFor('decisionDate');
    if (dateIndex >= 0) item.decisionDate = importDate(row[dateIndex],date1904);
    return { ...item, sourceSheet: sheetName, sourceRow: header.index + offset + 2, presentFields,
      rawSource: Object.fromEntries(rows[header.index].map((name, index) => [String(name), row[index] ?? '']).filter(([name]) => name)) };
  });
  return {rows:parsed,headerRow:header.index+1,message:parsed.length?'':`Header row ${header.index+1}: no component rows at or before the last occupied ${lastColumn===columnFor('origPn')?'Orig_PN':'Proposal_ID'} cell.`};
}

function importMapping(value,workbook) {
  if(value===undefined)return null;
  let mappings=value;try{if(typeof value==='string')mappings=JSON.parse(value);}catch{workflowError('IMPORT_MAPPING_INVALID','Column mapping must be valid JSON.');}
  if(!Array.isArray(mappings)||!mappings.length)workflowError('IMPORT_MAPPING_INVALID','Select at least one worksheet to import.');
  const selected=new Set();
  return mappings.map(mapping=>{
    if(!mapping||!workbook.SheetNames.includes(mapping.sheet)||selected.has(mapping.sheet))workflowError('IMPORT_MAPPING_INVALID','Select each existing worksheet only once.');
    selected.add(mapping.sheet);
    if(!Number.isSafeInteger(mapping.headerRow)||mapping.headerRow<1||mapping.headerRow>1048576)workflowError('IMPORT_MAPPING_INVALID',`Worksheet '${mapping.sheet}': enter a valid header row.`);
    const columns=mapping.columns;
    if(!columns||typeof columns!=='object'||Array.isArray(columns)||!Object.keys(columns).length)workflowError('IMPORT_MAPPING_INVALID',`Worksheet '${mapping.sheet}': map the component columns.`);
    const used=new Set();
    for(const [field,column] of Object.entries(columns)) {
      if(!sourceImportFields.includes(field)||!Number.isSafeInteger(column)||column<1||column>16384||used.has(column))workflowError('IMPORT_MAPPING_INVALID',`Worksheet '${mapping.sheet}': '${field}' must use a unique, valid column number.`);
      used.add(column);
    }
    if(!columns.proposalId&&(!columns.origPn||!columns.altPn))workflowError('IMPORT_MAPPING_INVALID',`Worksheet '${mapping.sheet}': map Orig_PN and Alt_PN, or Proposal_ID.`);
    return {sheet:mapping.sheet,headerRow:mapping.headerRow,columns:{...columns}};
  });
}

export function inspectImportWorkbook(buffer,moduleId='M02') {
  const workbook=readLegacyWorkbook(buffer,{exactImportStrings:true});
  return {fields:[...sourceImportFields],sheets:workbook.SheetNames.map(sheet=>{
    const rows=sheetRows(workbook,sheet,true);
    // Forty rows are a reviewed mapping suggestion, not automatic permission
    // to import a later or nonstandard header.
    const candidate=findSourceHeaderRow(moduleId,rows,{limit:40});
    const headerRow=candidate||1,headers=rows[headerRow-1]||[];
    const columns=sourceHeaderColumns(moduleId,headers);
    return {sheet,rowCount:rows.length,headerRow,detected:Boolean(candidate),headers:headers.map(cleanText),columns,sample:rows.slice(0,Math.min(rows.length,12)).map(row=>row.slice(0,80).map(cleanText))};
  })};
}

export function parseWorkflowWorkbook(moduleId, buffer, filename = "workbook.xlsx", options = {}) {
  if(!importHeaderFields[moduleId])workflowError('IMPORT_MODULE_INVALID',`${moduleId} is not a workbook import workflow.`);
  const workbook = readLegacyWorkbook(buffer,{exactImportStrings:true});
  const all = [],findings=[];
  const mappings=importMapping(options.mapping,workbook);
  const sheets = mappings?mappings.map(item=>item.sheet):moduleId === "M02" ? workbook.SheetNames.slice(0, 1) : workbook.SheetNames;
  for (const sheetName of sheets) {
    const rows = sheetRows(workbook, sheetName, true);
    const meta = readImportMetadata(rows),parsed=parseCanonicalRows(rows,sheetName,mappings?.find(item=>item.sheet===sheetName),moduleId,Boolean(workbook.Workbook?.WBProps?.date1904),workbook.Sheets[sheetName]);
    if(!parsed.rows.length)findings.push({code:'IMPORT_SHEET_SKIPPED',filename,sheet:sheetName,...(parsed.headerRow?{row:parsed.headerRow}:{}),...(parsed.fields?{fields:parsed.fields}:{}),message:`Worksheet '${sheetName}': ${parsed.message}`});
    for (const row of parsed.rows) all.push(resolveImportMetadata(moduleId,row,meta,options,sheetName,filename));
  }
  if (!all.length) {
    workflowError(`${moduleId}_NO_COMPATIBLE_ROWS`, `${moduleId} cannot import '${filename}': no compatible component rows were found.`, [
      `Required columns: ${importHeaderFields[moduleId].map(field=>importHeaderLabels[field]).join(', ')}.`,
      ...findings.map(finding=>finding.message)
    ]);
  }
  return { rows: all, sheets, findings };
}

function setMetadata(worksheet, values, includeRound = false) {
  const pairs = [
    ["Order No", values.orderNo], ["Product", values.product], ["Product 1C Code", values.productCode],
    ["Product Decimal No", values.productDecimalNo], ["Supplier", values.supplier], ["Production Order", values.productionOrder]
  ];
  if (includeRound) pairs.push(["Round", values.round || 1]);
  for (const pair of pairs) worksheet.addRow(pair);
  worksheet.addRow([]);
}

function writeMacroMetadata(worksheet,values) {
  [['Order_No',values.orderNo],['Supplier',values.supplier],['Product',values.product],['Product_1C_Code',values.productCode],['Product_Decimal_No',values.productDecimalNo],['Production_Order',values.productionOrder]].forEach((row,index)=>{
    for(let column=1;column<=2;column++){const cell=worksheet.getCell(index+1,column);cell.value=row[column-1]||'';cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF2F2F2'}};cell.border=Object.fromEntries(['top','left','bottom','right'].map(edge=>[edge,{style:'thin',color:{argb:'FFBFBFBF'}}]));cell.alignment={vertical:'middle',horizontal:'left',wrapText:false};if(column===1)cell.font={...cell.font,bold:true};}
  });
  worksheet.getColumn(1).width=22;worksheet.getColumn(2).width=32;
}

function styleSheet(worksheet, headerRow, headers, options = {}) {
  const { decisionColumnName = "Client_Decision", original = [], alternative = [], input = [] } = options;
  const tableRows = [];
  const lastRow=options.lastRow??worksheet.rowCount;
  for (let rowIndex = headerRow + 1; rowIndex <= lastRow; rowIndex += 1) {
    tableRows.push(headers.map((_, columnIndex) => worksheet.getCell(rowIndex, columnIndex + 1).value ?? ""));
  }
  const tableName = options.tableName||`RR_${worksheet.name}_${headerRow}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 240);
  worksheet.autoFilter=undefined;
  worksheet.addTable({
    name: tableName,
    ref: worksheet.getCell(headerRow, 1).address,
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleMedium1", showRowStripes: false, showColumnStripes: false },
    columns: headers.map((name) => ({ name, filterButton:true })),
    rows: tableRows
  });
  worksheet.views = [{ state: "frozen", ySplit: headerRow }];
  const row = worksheet.getRow(headerRow);
  row.height = 32;
  row.eachCell((cell) => {
    cell.style = { ...cell.style };
    cell.font = { ...cell.font, bold: true, color: { argb: "FF000000" }, size: cell.font?.size || 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = Object.fromEntries(["top","left","bottom","right"].map(edge=>[edge,{style:"thin",color:{argb:"FFB7C4CE"}}]));
  });
  if (!options.preserveWidths) headers.forEach((header, index) => {
    const width = /Comment/.test(header) ? 34 : /Mfr|PN|Reference|Status/.test(header) ? 23 : /Product/.test(header) ? 22 : 15;
    worksheet.getColumn(index + 1).width = width;
  });
  for (let index = headerRow + 1; index <= lastRow; index += 1) {
    const dataRow = worksheet.getRow(index);
    if (!dataRow.hidden && !Number.isFinite(dataRow.height)) dataRow.height = worksheet.properties.defaultRowHeight || 15;
    dataRow.alignment = { vertical: "top", wrapText: false };
    for (let column = 1; column <= headers.length; column += 1) {
      const header = clean(headers[column - 1]);
      const allowWrap = ["Designation", "Nomenclature", "Alt_Mfr", "Alt_PN"].includes(header);
      let color = "FFFFFFFF";
      if (original.includes(column)) color = "FFE2EFDA";
      if (alternative.includes(column)) color = "FFDDEBF7";
      if (input.includes(column)) color = "FFFFF2CC";
      const cell = worksheet.getCell(index, column);
      // Loaded XLSX cells can share a style object. Detach before changing
      // stage fill/wrapping so a permitted field cannot wrap Position too.
      cell.style = { ...cell.style };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      cell.alignment = { vertical: "top", wrapText: allowWrap };
      cell.border = Object.fromEntries(["top","left","bottom","right"].map(edge=>[edge,{style:"thin",color:{argb:"FFB7C4CE"}}]));
    }
  }
  applyExcelDecisionFormatting(worksheet,headerRow,lastRow,headers);
  const decisionColumn = headers.indexOf(decisionColumnName) + 1;
  if (decisionColumn > 0) {
    const validationEndRow = lastRow;
    for (let index = headerRow + 1; index <= validationEndRow; index += 1) {
      worksheet.getCell(index, decisionColumn).dataValidation = { type: "list", allowBlank: true, formulae: ['"APPROVED,REJECTED,DO NOT PURCHASE"'] };
    }
  }
  worksheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function preliminaryRow(item) {
  return [item.supplier, item.product, item.productCode, item.productDecimalNo, item.position, item.origCode, item.origMfr, item.origPn, item.altMfr, item.altPn, item.supplierReply, item.supplierComment, item.componentStatus, item.manufacturerRelationship, item.historicalStatus, item.clientDecision, item.clientComment, item.responsible, item.proposalId];
}

function finalRow(item) {
  const newApproval = !item.historicalStatus || item.historicalStatus === 'NO HISTORY';
  const sourceProduct = item.rawSource?.Product;
  const scalarProduct = typeof sourceProduct === 'string' || typeof sourceProduct === 'number' && Number.isFinite(sourceProduct) || typeof sourceProduct === 'boolean';
  // Copy the source cell only while it still represents the current Product.
  // Reconciliation can retain or replace raw evidence beside a local edit.
  const product = scalarProduct && item.product === cleanText(sourceProduct) ? sourceProduct : item.product;
  return [item.supplier, product, item.productCode, item.productDecimalNo, item.productionOrder, item.position, item.origCode, item.origMfr, item.origPn, item.altMfr, item.altPn, item.manufacturerRelationship, item.componentStatus, newApproval ? 'NEW APPROVAL' : item.historicalStatus, newApproval ? '' : item.historicalReference || "", decisionExportText(item), item.clientComment, item.responsible, item.decisionReference, item.decisionDate ? new Date(`${item.decisionDate}T00:00:00Z`) : "", item.proposalId];
}

async function workbookBuffer(workbook) {
  // ExcelJS can load a valid worksheet without sheetFormatPr and replace its
  // defaults with undefined. Writing that model emits an invalid customHeight
  // without the required defaultRowHeight, which desktop Excel rejects.
  for(const sheet of workbook.worksheets) if(!Number.isFinite(sheet.properties.defaultRowHeight) || sheet.properties.defaultRowHeight<=0) sheet.properties.defaultRowHeight=15;
  const zeroRows=[];
  for(const sheet of workbook.worksheets)sheet.eachRow({includeEmpty:true},row=>{if(row.height===0)zeroRows.push({sheetId:sheet.id,row:row.number});});
  const bytes=Buffer.from(await workbook.xlsx.writeBuffer());
  // ExcelJS omits zero heights when serializing. Keep explicit source zero
  // geometry, including a row whose hidden flag was not separately supplied.
  const zip=await JSZip.loadAsync(bytes);
  let changed=false;
  for(const part of Object.keys(zip.files).filter(name=>/^xl\/worksheets\/sheet[0-9]+\.xml$/.test(name))){
    const original=await zip.file(part).async('string');let xml=canonicalWorksheetProperties(original);
    const sheetId=Number(part.match(/sheet([0-9]+)\.xml$/)[1]);
    for(const item of zeroRows.filter(item=>item.sheetId===sheetId))xml=xml.replace(new RegExp(`<row\\b(?=[^>]*\\br="${item.row}")([^>]*)>`),(_,attributes)=>`<row${attributes.replace(/ ht="[^"]*"| customHeight="[^"]*"/g,'')} ht="0" customHeight="1">`);
    if(xml!==original){zip.file(part,xml);changed=true;}
  }
  return changed?zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}):bytes;
}

async function makeSupplierWorkbook(meta, rows, includeRound = false) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Replacement Register";
  const worksheet = workbook.addWorksheet("BOM");
  setMetadata(worksheet, meta, includeRound);
  worksheet.addRow(supplierHeaders);
  for (const item of rows) worksheet.addRow([item.position, item.origCode, item.origMfr, item.origPn, item.quantity || 1, item.altMfr, item.altPn, item.supplierReply, item.supplierComment, item.componentStatus, item.clientDecision, item.clientComment]);
  styleSheet(worksheet, includeRound ? 9 : 8, supplierHeaders, { original: [3, 4], alternative: [6, 7], input: [8, 9] });
  await growDataRows(worksheet,includeRound?9:8,supplierHeaders);
  return workbookBuffer(workbook);
}

async function addToZip(zip, filename, buffer) {
  zip.file(filename, buffer);
}

function grouped(items, keyFor) {
  return items.reduce((groups, item) => {
    const key = keyFor(item);
    (groups[key] ||= []).push(item);
    return groups;
  }, {});
}

async function createM01(buffer, replacements, options) {
  const inspected=analyzeOriginalBOM(buffer,replacements,options);const meta=inspected.metadata;
  const include=options.includeApproved===true || options.includeApproved==='true';
  if(inspected.approvedMatchCount && ![true,false,'true','false'].includes(options.includeApproved))workflowError('M01_PREFILL_CHOICE_REQUIRED','Choose whether to include previously approved replacements.',[`${inspected.approvedMatchCount} source row(s) have an unambiguous approved replacement. Review the matches, then choose Include or Leave blank.`]);
  const workbook=new ExcelJS.Workbook();
  let layoutSource=buffer;
  try{await workbook.xlsx.load(buffer);}catch{
    // A legacy conversion cannot retain an XLSX table that ExcelJS failed to
    // load. Report that source instead of silently converting its tables away.
    let hasSourceTables=false;try{hasSourceTables=Object.keys((await JSZip.loadAsync(buffer)).files).some(name=>/^xl\/tables\/[^/]+\.xml$/.test(name));}catch{}
    if(hasSourceTables)workflowError('M01_SOURCE_TABLE_LOAD_UNSUPPORTED','M01 cannot safely load the original Excel tables.',[`Source '${options.sourceFilename||'workbook.xlsx'}': the workbook contains table XML that could not be loaded. No converted supplier file was created.`]);
    layoutSource=XLSX.write(readLegacyWorkbook(buffer),{type:'buffer',bookType:'xlsx'});await workbook.xlsx.load(layoutSource);
  }
  const worksheet=workbook.worksheets[0];
  const layoutInformation=await sourceLayoutInformation(layoutSource);
  // ExcelJS spliceRows moves cell values/heights but drops row visibility and
  // outline metadata. Capture the source rows before inserting macro metadata.
  const sourceRowLayouts=[];
  worksheet.eachRow({includeEmpty:true},row=>sourceRowLayouts.push({number:row.number,height:layoutInformation.zeroHeightRows.has(row.number)?0:row.height,hidden:row.hidden,outlineLevel:row.outlineLevel}));
  const originalTables=worksheet.getTables(),originalTable=originalTables[0],originalTableName=originalTable?.name;
  const headerRow=inspected.headerRow+7,lastDataRow=inspected.lastDataRow+7;
  const insertColumn=inspected.quantityColumn?inspected.quantityColumn+1:inspected.headers.length+1;
  const sourceArchive=await JSZip.loadAsync(layoutSource);
  const sourceXml=async part=>{const bytes=await sourceArchive.file(part).async('nodebuffer'),encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';return new DOMParser().parseFromString(new TextDecoder(encoding,{fatal:true}).decode(bytes).replace(/^\uFEFF/,''),'application/xml');};
  const declaredTableStyles=new Set();
  if(sourceArchive.file('xl/styles.xml'))for(const container of Array.from((await sourceXml('xl/styles.xml')).getElementsByTagNameNS('*','tableStyles')))for(const style of Array.from(container.childNodes).filter(node=>node.nodeType===1&&node.localName==='tableStyle'))if(style.hasAttribute('name'))declaredTableStyles.add(style.getAttribute('name').toUpperCase());
  const tableIssue=(code,owner,model,message)=>workflowError(code,'M01 cannot safely preserve an original Excel table.',[`Worksheet '${owner.name}', table '${model.name||'(unnamed)'}', source range '${model.tableRef||'(missing)'}': ${message}`]);
  const range=(owner,model,ref)=>{
    if(typeof ref!=='string'||!/^\$?[A-Z]{1,3}\$?[1-9][0-9]*(?::\$?[A-Z]{1,3}\$?[1-9][0-9]*)?$/i.test(ref))tableIssue('M01_TABLE_RANGE_INVALID',owner,model,`Invalid table range '${ref}'.`);
    const value=XLSX.utils.decode_range(ref);if(value.s.r>value.e.r||value.s.c>value.e.c||value.e.r>=1048576||value.e.c>=16384)tableIssue('M01_TABLE_RANGE_INVALID',owner,model,`Table range '${ref}' is outside the worksheet.`);return value;
  };
  const overlaps=(left,right)=>left.s.r<=right.e.r&&right.s.r<=left.e.r&&left.s.c<=right.e.c&&right.s.c<=left.e.c;
  const moved=ref=>shiftFormulaReferences(shiftFormulaReferences(ref,worksheet.name,worksheet.name,{rows:7}),worksheet.name,worksheet.name,{column:insertColumn,columns:7});
  const allTables=[],names=new Set();
  for(const owner of workbook.worksheets)for(const table of owner.getTables()){
    const model=table.model,name=model.name;
    if(typeof name!=='string'||!name.trim()||/\s|[\[\]:*?/]/.test(name)||names.has(name.toUpperCase()))tableIssue('M01_TABLE_NAME_INVALID',owner,model,'The table name is empty, malformed or duplicated across the workbook.');names.add(name.toUpperCase());
    const sourceRange=range(owner,model,model.tableRef);
    if(!Array.isArray(model.columns)||model.columns.length!==sourceRange.e.c-sourceRange.s.c+1||model.columns.some(column=>typeof column.name!=='string'||!column.name)||new Set(model.columns.map(column=>column.name.toUpperCase())).size!==model.columns.length)tableIssue('M01_TABLE_COLUMNS_INVALID',owner,model,'The table range and named column definitions do not agree.');
    if(!model.autoFilterRef)tableIssue('M01_TABLE_METADATA_UNSUPPORTED',owner,model,'A table without an explicit filter range cannot be safely reserialized by the current M01 workbook writer.');
    const filter=range(owner,model,model.autoFilterRef);if(filter.s.r!==sourceRange.s.r||filter.s.c!==sourceRange.s.c||filter.e.c!==sourceRange.e.c||filter.e.r!==sourceRange.e.r-(model.totalsRow?1:0))tableIssue('M01_TABLE_RANGE_INVALID',owner,model,'The table filter range does not agree with its header, data and totals rows.');
    if(sourceRange.e.r-sourceRange.s.r+1<Number(Boolean(model.headerRow))+Number(Boolean(model.totalsRow)))tableIssue('M01_TABLE_RANGE_INVALID',owner,model,'The table has no room for its declared header and totals rows.');
    if(owner===worksheet&&table!==originalTable&&sourceRange.s.c<insertColumn-1&&sourceRange.e.c>=insertColumn-1)tableIssue('M01_TABLE_INSERTION_UNSUPPORTED',owner,model,`Insertion of seven workflow columns before source column ${XLSX.utils.encode_col(insertColumn-1)} crosses this additional table; its generated header names cannot be safely reproduced. Move that additional table outside the insertion columns in the original BOM.`);
    if(owner===worksheet&&(sourceRange.e.r+7>=1048576||sourceRange.e.c+(sourceRange.e.c>=insertColumn-1?7:0)>=16384))tableIssue('M01_TABLE_RANGE_INVALID',owner,model,'The required row or column insertion would move the table outside the worksheet.');
    allTables.push({owner,table,model,sourceRange,targetRange:owner===worksheet?range(owner,model,moved(model.tableRef)):sourceRange});
  }
  // ExcelJS does not retain calculated-column/custom-total XML, filter criteria
  // or table extensions. Refuse those sources rather than returning a repairable
  // or silently simplified workbook, including tables on untouched worksheets.
  const parts=Object.keys(sourceArchive.files).filter(name=>/^xl\/tables\/[^/]+\.xml$/.test(name));
  if(parts.length!==allTables.length)workflowError('M01_TABLE_METADATA_UNSUPPORTED','M01 cannot safely resolve the original table definitions.',[`Source '${options.sourceFilename||'workbook.xlsx'}': table XML parts and loaded table definitions do not agree.`]);
  const tableMetadata=[];
  for(const part of parts){const document=await sourceXml(part),node=document.documentElement,entry=allTables.find(item=>item.model.name===node.getAttribute('name'));if(!entry)workflowError('M01_TABLE_METADATA_UNSUPPORTED','M01 cannot safely resolve an original table.',[`Table part '${part}' is not linked to a loaded worksheet table.`]);
    const checkAttributes=(element,allowed)=>{for(const attribute of Array.from(element.attributes||[])){if(attribute.namespaceURI==='http://www.w3.org/2000/xmlns/'||attribute.namespaceURI==='http://schemas.openxmlformats.org/markup-compatibility/2006'&&attribute.localName==='Ignorable')continue;if(!allowed.includes(attribute.name))tableIssue('M01_TABLE_METADATA_UNSUPPORTED',entry.owner,entry.model,`Unsupported table attribute '${element.localName}@${attribute.name}' cannot be retained safely; style identifiers and external bindings are not copied into rewritten workbook styles.`);}};
    const boolean=(element,name,fallback)=>{if(!element.hasAttribute(name))return fallback;const value=element.getAttribute(name);if(!['0','1','false','true'].includes(value))tableIssue('M01_TABLE_METADATA_UNSUPPORTED',entry.owner,entry.model,`Invalid table boolean '${element.localName}@${name}=${value}'.`);return value==='1'||value==='true';};
    checkAttributes(node,['id','name','displayName','ref','headerRowCount','totalsRowCount','totalsRowShown','comment']);
    const header=node.hasAttribute('headerRowCount')?node.getAttribute('headerRowCount'):'1';if(!['0','1'].includes(header))tableIssue('M01_TABLE_METADATA_UNSUPPORTED',entry.owner,entry.model,`Unsupported headerRowCount '${header}'.`);entry.model.headerRow=header==='1';
    const totals=node.hasAttribute('totalsRowCount')?node.getAttribute('totalsRowCount'):'0';if(!['0','1'].includes(totals))tableIssue('M01_TABLE_METADATA_UNSUPPORTED',entry.owner,entry.model,`Unsupported totalsRowCount '${totals}'.`);entry.model.totalsRow=totals==='1';
    if(entry.table===originalTable&&!entry.model.headerRow)tableIssue('M01_TABLE_METADATA_UNSUPPORTED',entry.owner,entry.model,'The first source table has no header row for the macro header styling operation.');
    if(entry.sourceRange.e.r-entry.sourceRange.s.r+1<Number(entry.model.headerRow)+Number(Boolean(entry.model.totalsRow)))tableIssue('M01_TABLE_RANGE_INVALID',entry.owner,entry.model,'The table has no room for its header and totals rows.');
    const columns=Array.from(node.getElementsByTagNameNS('*','tableColumn'));if(columns.length!==entry.model.columns.length)tableIssue('M01_TABLE_COLUMNS_INVALID',entry.owner,entry.model,'The XML column count does not agree with the loaded table.');
    const uniqueNames=[];columns.forEach((column,index)=>{checkAttributes(column,['id','name','totalsRowLabel','totalsRowFunction','uniqueName']);if(column.hasAttribute('uniqueName'))uniqueNames.push({index,value:column.getAttribute('uniqueName')});entry.model.columns[index].filterButton=true;});
    const filter=node.getElementsByTagNameNS('*','autoFilter')[0];if(filter){checkAttributes(filter,['ref']);const seenColumns=new Set();for(const column of Array.from(filter.getElementsByTagNameNS('*','filterColumn'))){checkAttributes(column,['colId','hiddenButton']);const id=column.getAttribute('colId');if(!/^(0|[1-9][0-9]*)$/.test(id)||Number(id)>=columns.length||seenColumns.has(Number(id)))tableIssue('M01_TABLE_COLUMNS_INVALID',entry.owner,entry.model,`Invalid or repeated filter column index '${id}'.`);seenColumns.add(Number(id));entry.model.columns[Number(id)].filterButton=!boolean(column,'hiddenButton',false);}}
    const style=node.getElementsByTagNameNS('*','tableStyleInfo')[0];if(style){checkAttributes(style,['name','showFirstColumn','showLastColumn','showRowStripes','showColumnStripes']);entry.model.style||={};for(const flag of ['showFirstColumn','showLastColumn','showRowStripes','showColumnStripes'])entry.model.style[flag]=boolean(style,flag,false);if(entry.table!==originalTable&&style.hasAttribute('name')&&(declaredTableStyles.has(style.getAttribute('name').toUpperCase())||!/^TableStyle(?:Light|Medium|Dark)[0-9]+$/.test(style.getAttribute('name'))))tableIssue('M01_TABLE_METADATA_UNSUPPORTED',entry.owner,entry.model,`An additional table uses custom style '${style.getAttribute('name')}' whose source definition cannot be safely remapped.`);}
    else entry.model.style={theme:null,showFirstColumn:false,showLastColumn:false,showRowStripes:false,showColumnStripes:false};
    const attributes={};if(node.hasAttribute('comment'))attributes.comment=node.getAttribute('comment');if(node.hasAttribute('totalsRowShown')){boolean(node,'totalsRowShown',false);attributes.totalsRowShown=node.getAttribute('totalsRowShown');}
    tableMetadata.push({entry,attributes,uniqueNames});
    const unsupported=Array.from(node.childNodes).filter(child=>child.nodeType===1).find(child=>!['autoFilter','tableColumns','tableStyleInfo'].includes(child.localName))||Array.from(node.getElementsByTagName('*')).find(child=>['calculatedColumnFormula','totalsRowFormula','xmlColumnPr','extLst','sortState','filters','customFilters','dynamicFilter','colorFilter','iconFilter','top10'].includes(child.localName));
    if(unsupported||entry.model.columns.some(column=>column.totalsRowFunction==='custom'))tableIssue('M01_TABLE_METADATA_UNSUPPORTED',entry.owner,entry.model,`Unsupported table feature '${unsupported?.localName||'custom totals formula'}' must be retained in the original; no supplier file was created.`);
  }
  const targetFirst={s:{r:headerRow-1,c:0},e:{r:lastDataRow-1,c:inspected.headers.length+6}};
  for(let left=0;left<allTables.length;left++)for(let right=left+1;right<allTables.length;right++)if(allTables[left].owner===allTables[right].owner&&overlaps(allTables[left].sourceRange,allTables[right].sourceRange))tableIssue('M01_TABLE_OVERLAP',allTables[right].owner,allTables[right].model,`Its source range overlaps table '${allTables[left].model.name}'.`);
  const remaining=allTables.filter(entry=>entry.owner===worksheet&&entry.table!==originalTable);
  for(const entry of remaining)if(overlaps(targetFirst,entry.targetRange))tableIssue('M01_TABLE_OVERLAP',entry.owner,entry.model,`After insertion, range '${moved(entry.model.tableRef)}' would overlap the resized first table '${XLSX.utils.encode_range(targetFirst)}'.`);
  if(originalTable?.model.totalsRow&&XLSX.utils.decode_range(originalTable.model.tableRef).e.r!==inspected.lastDataRow-1)tableIssue('M01_TABLE_TOTALS_RESIZE_UNSUPPORTED',worksheet,originalTable.model,'The original totals row differs from the final BOM row. Moving that totals row during resize is not supported; no supplier file was created.');
  let outputTableName=originalTableName;
  if(!originalTable){const document=await sourceXml('xl/workbook.xml'),sourceSheetIndex=Array.from(document.getElementsByTagNameNS('*','sheet')).findIndex(node=>node.getAttribute('name')===worksheet.name)+1;if(!sourceSheetIndex)workflowError('M01_SHEET_INDEX_INVALID','M01 cannot determine the original worksheet index.',[`Worksheet '${worksheet.name}' is not present in the source workbook sheet order.`]);outputTableName=`tblOriginalBOMForSupplier_${sourceSheetIndex}`;if(names.has(outputTableName.toUpperCase()))workflowError('M01_TABLE_NAME_COLLISION','M01 cannot name the new supplier table.',[`Worksheet '${worksheet.name}', source header row ${inspected.headerRow}: generated name '${outputTableName}' already belongs to another original table.`]);}
  if(originalTable)worksheet.removeTable(originalTableName);
  const splice=(shift,operation)=>{
    const merges=[...worksheet.model.merges];for(const range of merges)worksheet.unMergeCells(range);
    shiftWorkbookReferences(workbook,worksheet.name,shift);operation();
    for(const range of merges)worksheet.mergeCells(shiftFormulaReferences(range,worksheet.name,worksheet.name,shift));
  };
  splice({rows:7},()=>worksheet.spliceRows(1,0,...Array.from({length:7},()=>[])));
  splice({column:insertColumn,columns:7},()=>worksheet.spliceColumns(insertColumn,0,...Array.from({length:7},()=>[])));
  for(const entry of remaining){entry.model.tableRef=moved(entry.model.tableRef);if(entry.model.autoFilterRef)entry.model.autoFilterRef=moved(entry.model.autoFilterRef);}
  for(const layout of sourceRowLayouts){const row=worksheet.getRow(layout.number+7);row.height=layout.height;row.hidden=layout.hidden;row.outlineLevel=layout.outlineLevel;}
  writeMacroMetadata(worksheet,meta);
  const supplierInput=worksheet.getCell(2,2);supplierInput.style={...supplierInput.style};supplierInput.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFFFF2CC"}};supplierInput.protection={...supplierInput.protection,locked:false};
  const selectedProduct=selectedM01Product(options);if(selectedProduct!==undefined)worksheet.getCell(3,2).value=selectedProduct;
  const appended = ["Alt_Mfr", "Alt_PN", "Supplier_Reply", "Supplier_Comment", "Component_Status", "Client_Decision", "Client_Comment"];
  let outputHeaders=sourceTableHeaders([...inspected.headers.slice(0,insertColumn-1),...appended,...inspected.headers.slice(insertColumn-1)]);
  outputHeaders.forEach((header,index)=>{worksheet.getCell(headerRow,index+1).value=header;});
  for(const match of inspected.matches) {
    const values=[include?match.record?.altMfr||'':'',include?match.record?.altPn||'':'','','',match.obsolete?'OBSOLETE':'','',''];
    values.forEach((value,index)=>{worksheet.getCell(match.sourceRow+7,insertColumn+index).value=value;});
  }
  const column=key=>{const sourceColumn=inspected.sourceColumns[key]||0;return sourceColumn&&(sourceColumn>=insertColumn?sourceColumn+7:sourceColumn);};
  const protectedColumns=['origPn','origCode','position'].map(column).concat(insertColumn+1);
  for(const [index,header]of outputHeaders.entries())if(/^(?:ref\.?\s*designators?|refdes|position|orig_code|1c code|code1c|alt_pn|orig_pn)$/i.test(String(header).trim()))protectedColumns.push(index+1);
  const english=await translateM01Sheet(worksheet,{headerRow,lastRow:worksheet.rowCount,protectedColumns});
  outputHeaders=sourceTableHeaders(outputHeaders.map((_,index)=>worksheet.getCell(headerRow,index+1).text));
  outputHeaders.forEach((header,index)=>{worksheet.getCell(headerRow,index+1).value=header;});
  styleSheet(worksheet,headerRow,outputHeaders,{original:[column('origMfr'),column('origPn')],alternative:[insertColumn,insertColumn+1],input:[insertColumn+2,insertColumn+3],preserveWidths:true,lastRow:lastDataRow,decisionColumnName:'',tableName:outputTableName});
  if(originalTable)worksheet.tables=Object.fromEntries([[outputTableName,worksheet.getTable(outputTableName)],...remaining.map(entry=>[entry.model.name,entry.table])]);
  if(originalTable){const target=worksheet.getTable(outputTableName).model;target.displayName=originalTable.model.displayName||originalTableName;if(originalTable.model.totalsRow){target.totalsRow=true;target.autoFilterRef=XLSX.utils.encode_range({s:targetFirst.s,e:{r:targetFirst.e.r-1,c:targetFirst.e.c}});}const sourceRange=XLSX.utils.decode_range(originalTable.model.tableRef);originalTable.model.columns.forEach((source,index)=>{const sourceColumn=sourceRange.s.c+index,targetColumn=sourceColumn+(sourceColumn>=insertColumn-1?7:0);if(!target.columns[targetColumn])tableIssue('M01_TABLE_COLUMNS_INVALID',worksheet,originalTable.model,'An original table column lies outside the resized supplier table.');for(const key of ['filterButton','totalsRowLabel','totalsRowFunction'])if(Object.hasOwn(source,key))target.columns[targetColumn][key]=source[key];});}
  for(const key of ['position','origCode'])if(column(key))worksheet.getColumn(column(key)).width=key==='origCode'?14:10;
  for(const [key,width] of [['origMfr',24],['origPn',32]])if(column(key))worksheet.getColumn(column(key)).width=Math.max(worksheet.getColumn(column(key)).width||0,width);
  [24,32,18,38,18,18,42].forEach((width,index)=>{worksheet.getColumn(insertColumn+index).width=width;});
  await growDataRows(worksheet,headerRow,outputHeaders,lastDataRow,{normalFont:layoutInformation.normalFont,date1904:Boolean(workbook.properties.date1904)});
  const defaultName = proposedFilename("M01", [], { ...options, ...meta });
  let outputBuffer=await workbookBuffer(workbook);
  // Restore only safe source metadata that ExcelJS's table model omits. This
  // wrapper is M01-local; functional attributes/style IDs were rejected above.
  if(tableMetadata.some(item=>Object.keys(item.attributes).length||item.uniqueNames.length)){
    const outputArchive=await JSZip.loadAsync(outputBuffer),found=new Set();
    for(const part of Object.keys(outputArchive.files).filter(name=>/^xl\/tables\/[^/]+\.xml$/.test(name))){const document=new DOMParser().parseFromString(await outputArchive.file(part).async('string'),'application/xml'),node=document.documentElement,item=tableMetadata.find(item=>item.entry.model.name===node.getAttribute('name'));if(!item)continue;found.add(item.entry.model.name);for(const [name,value]of Object.entries(item.attributes))node.setAttribute(name,value);const columns=Array.from(node.getElementsByTagNameNS('*','tableColumn'));for(const unique of item.uniqueNames){const originalColumn=item.entry.sourceRange.s.c+unique.index,index=item.entry.table===originalTable?originalColumn+(originalColumn>=insertColumn-1?7:0):unique.index;if(!columns[index])tableIssue('M01_TABLE_COLUMNS_INVALID',item.entry.owner,item.entry.model,'A unique column identity lies outside the serialized table.');columns[index].setAttribute('uniqueName',unique.value);}outputArchive.file(part,new XMLSerializer().serializeToString(document));}
    if(found.size!==tableMetadata.length)workflowError('M01_TABLE_METADATA_UNSUPPORTED','M01 could not retain every original table.', ['A source table is missing from the serialized supplier workbook. No supplier file was created.']);
    outputBuffer=await outputArchive.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  }
  return { filename: selectedFilename(defaultName, options.fileName, "xlsx"), contentType: XLSX_TYPE, buffer: outputBuffer, affected: inspected.rowCount,translation:english,approvedPrefilled:include?inspected.approvedMatchCount:0,ambiguous:inspected.ambiguousCount,obsolete:inspected.obsoleteCount };
}

// Shared metadata plan. Input rows already have their captured history applied;
// this function performs no workbook/ZIP construction or ledger I/O.
function gateWorkingOrderLabel(proposals,orderNo,gate){
  if(!gate)return;const rows=proposals.filter(row=>!row.archived&&normalize(row.orderNo)===normalize(orderNo));
  if(new Set(rows.map(row=>row.orderNo)).size>1)gate(rows);
}
export function planWorkflowExchange(moduleId,proposals,options={},workingOrderGate=null) {
  if(!['M03','M05'].includes(moduleId))workflowError('FILE_SUGGESTION_NOT_SUPPORTED','This exchange does not use the preliminary/feedback filename plan.');
  const scoped=exchangeScope(moduleId,proposals,options);options={...options,orderNo:scoped.orderNo};
  const rows=scoped.rows.filter(moduleId==='M03'?preliminaryEligible:feedbackEligible);
  if(moduleId==='M03'){
    if(!rows.length)workflowError('M03_NO_ELIGIBLE_ROWS','M03 cannot export a preliminary approval file.',['No active proposals with an alternative part number and an unresolved client decision were found for the selected order.']);
    workingOrderGate?.(rows);gateWorkingOrderLabel(proposals,scoped.orderNo,workingOrderGate);
    const date=options.exportDate||new Intl.DateTimeFormat('en-CA',{timeZone:process.env.RR_BUSINESS_TIMEZONE||'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(!validBusinessDate(date))workflowError('M03_EXPORT_DATE_INVALID','Export date is invalid.');
    return {moduleId,options,rows,date,filename:selectedFilename(proposedFilename('M03',rows,options),options.fileName,'xlsx'),descriptors:[]};
  }
  if(!rows.length)workflowError('M05_NO_ROWS','M05 cannot export supplier feedback files.',['No active proposals were found for the selected order.']);
  gateWorkingOrderLabel(proposals,scoped.orderNo,workingOrderGate);
  // Source metadata is discovered before body eligibility filtering. A row
  // absent from the table may hold its group's only code or production order.
  const groups=grouped(scoped.rows,item=>`${normalize(item.productDecimalNo)}\u001f${normalize(item.supplier)}`);
  const descriptors=Object.entries(groups).flatMap(([groupKey,sourceRows])=>{
    const groupRows=sourceRows.filter(feedbackEligible);if(!groupRows.length)return [];
    workingOrderGate?.(sourceRows);
    const first=Object.fromEntries(['orderNo','product','productCode','productDecimalNo','supplier','productionOrder'].map(key=>[key,sourceRows.map(item=>cleanText(item[key])).find(Boolean)||'']));
    const round=roundValue(options),order=filenameToken(first.orderNo,'',18),base=filenameStem('M05','Feedback',productToken(first.product,first.productDecimalNo),filenameToken(first.supplier,'',24),order?`O${order}`:'',round?`R${filenameToken(round,'Round',16)}`:'');
    return [{groupKey,groupRows,first,base}];
  });
  const names=new Map();for(const descriptor of descriptors)names.set(descriptor.base,(names.get(descriptor.base)||0)+1);
  for(const descriptor of descriptors)descriptor.filename=`${descriptor.base}${names.get(descriptor.base)>1?'_'+createHash('sha256').update(descriptor.groupKey).digest('hex').slice(0,8):''}_v${positiveNumber(options.version)}.xlsx`;
  return {moduleId,options,rows,filename:selectedFilename(proposedFilename('M05',rows,options,'zip'),options.fileName,'zip'),descriptors};
}

export function workflowExchangeSuggestion(moduleId,proposals,replacements,options={},workingOrderGate=null) {
  const history=createHistoryIndex(replacements),plan=planWorkflowExchange(moduleId,proposals.map(item=>recalculateProposal(item,history)),options,workingOrderGate);
  return {filename:plan.filename,version:positiveNumber(options.version),files:plan.descriptors.map(({filename,groupRows})=>({filename,product:groupRows[0].product,productDecimalNo:groupRows[0].productDecimalNo,supplier:groupRows[0].supplier,rows:groupRows.length})),rows:plan.rows.length};
}

async function createM03(proposals, options,workingOrderGate=null) {
  const plan=planWorkflowExchange('M03',proposals,options,workingOrderGate),{rows,date,filename}=plan;options=plan.options;
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Preliminary_Approval");
  worksheet.addRow(['Order_No',options.orderNo]);worksheet.addRow(['Approval_Round',roundValue(options)]);worksheet.addRow(['Export_Date',new Date(`${date}T00:00:00Z`)]);worksheet.getCell('B3').numFmt='dd.mm.yyyy';
  for(let number=1;number<=3;number++)worksheet.getCell(number,1).font={bold:true};
  worksheet.addRow([]);worksheet.addRow(preliminaryHeaders);
  rows.forEach(item=>{const row=preliminaryRow(item);row[15]='';row[16]='';worksheet.addRow(row);});
  styleSheet(worksheet, 5, preliminaryHeaders, { original: [7, 8], alternative: [9, 10], input: [16, 17],tableName:'tblPreliminaryApproval' });
  [16,24,18,24,10,10,24,32,24,32,18,38,18,24,24,18,42,24,18].forEach((width,index)=>{worksheet.getColumn(index+1).width=width;});worksheet.getColumn(19).hidden=true;
  await growDataRows(worksheet,5,preliminaryHeaders);
  return { filename, contentType: XLSX_TYPE, buffer: await workbookBuffer(workbook), affected: rows.length,scopeRows:rows };
}

async function createM05(proposals, options,workingOrderGate=null) {
  const plan=planWorkflowExchange('M05',proposals,options,workingOrderGate),{rows,filename,descriptors}=plan;options=plan.options;
  const zip = new JSZip();const members=[];
  for (const {groupKey,groupRows,first,filename:innerName} of descriptors) {
    const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet("Client_Feedback");
    writeMacroMetadata(worksheet,first);worksheet.addRow([]);worksheet.addRow(feedbackHeaders);
    groupRows.forEach((item) => worksheet.addRow([item.position, item.origCode, item.origMfr, item.origPn, item.altMfr, item.altPn, item.supplierReply, item.supplierComment, item.componentStatus, decisionExportText(item), item.clientComment, item.historicalStatus, item.historicalReference || "", item.proposalId]));
    styleSheet(worksheet,8,feedbackHeaders,{original:[3,4],alternative:[5,6],input:[7,8],decisionColumnName:'',tableName:'tblClientFeedback'});
    [10,10,24,32,24,32,18,38,18,18,42,24,38,18].forEach((width,index)=>{worksheet.getColumn(index+1).width=width;});worksheet.getColumn(14).hidden=true;
    await growDataRows(worksheet,8,feedbackHeaders);
    const buffer=await workbookBuffer(workbook);await addToZip(zip,innerName,buffer);members.push({filename:innerName,contentType:XLSX_TYPE,buffer,scopeRows:groupRows,groupKey});
  }
  return { filename, contentType: ZIP_TYPE, buffer: await zip.generateAsync({ type: "nodebuffer" }), affected: rows.length,scopeRows:rows,members };
}

async function createM06(proposals, options,workingOrderGate=null) {
  const scoped = exchangeScope('M06', proposals, options);
  options = {...options, orderNo: scoped.orderNo};
  const active = scoped.rows;
  const { unresolved, missingProductionOrder, rows } = finalPreflight(active);
  if (unresolved.length || missingProductionOrder.length) workflowError("M06_PREFLIGHT_FAILED", "M06 cannot export the final approval workbook.", [
    ...unresolved.map(item => `${item.proposalId}; ${item.sourceSheet || 'Check'}${item.sourceRow ? ` row ${item.sourceRow}` : ''}; Client_Decision: ${classifyProposal(item) === 'UNKNOWN' ? `unresolved reply '${item.clientReplyRaw || item.clientDecision}'` : 'missing decision and no previous approval'}.`),
    ...missingProductionOrder.map(item => `${item.proposalId}; ${item.sourceSheet || 'Check'}${item.sourceRow ? ` row ${item.sourceRow}` : ''}; Production_Order is required.`)
  ]);
  if (!rows.length) workflowError("M06_NO_ELIGIBLE_ROWS", "M06 cannot export the final approval workbook.", ["No approved, do-not-purchase, or previously approved rows were found for the selected order."]);
  workingOrderGate?.(rows);gateWorkingOrderLabel(proposals,scoped.orderNo,workingOrderGate);
  const groups = Object.entries(grouped(rows, (item) => normalize(item.productDecimalNo)));
  const sheetNames = productSheetNames(groups);
  const workbook = new ExcelJS.Workbook();
  for (const [decimal, groupRows] of groups) {
    const worksheet = workbook.addWorksheet(sheetNames.get(decimal));
    worksheet.addRow(["Order_No", options.orderNo]); worksheet.getCell('A1').font = {bold: true}; worksheet.addRow([]); worksheet.addRow(finalHeaders);
    groupRows.forEach((item) => worksheet.addRow(finalRow(item)));
    const tableIndex = workbook.worksheets.length;
    styleSheet(worksheet, 3, finalHeaders, { original: [8, 9], alternative: [10, 11], input: [18, 19, 20], decisionColumnName: '', tableName: `tblFinalBOMForApproval${tableIndex === 1 ? '' : `_${tableIndex}`}` });
    [16,24,18,24,22,10,10,24,32,24,32,24,18,24,40,18,42,24,38,14,18].forEach((width,index) => {worksheet.getColumn(index+1).width = width;});
    worksheet.getColumn(21).hidden = true;
    worksheet.getColumn(20).numFmt = "dd.mm.yyyy";
    await growDataRows(worksheet,3,finalHeaders);
  }
  const defaultName = proposedFilename("M06", rows, options);
  return { filename: selectedFilename(defaultName, options.fileName, "xlsx"), contentType: XLSX_TYPE, buffer: await workbookBuffer(workbook), affected: rows.length, worksheets: groups.length,scopeRows:rows };
}

function xmlEscape(value) {
  return cleanText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function fillContentControl(documentXml, tag, value) {
  const marker = `<w:tag w:val="${tag}"/>`;
  let offset=0,count=0;
  for(;;){
    const markerIndex=documentXml.indexOf(marker,offset);if(markerIndex<0)break;
    const start=documentXml.lastIndexOf('<w:sdt>',markerIndex),end=documentXml.indexOf('</w:sdt>',markerIndex);
    if(start<offset||end<0)workflowError('M07_TEMPLATE_CONTROL_INVALID',`M07 found an invalid '${tag}' content control in the deviation permit template.`);
    const block=documentXml.slice(start,end+8);let found=false;
    // Word's Range.Text replaces the entire control, including split runs.
    // Callback replacement keeps dollar syntax in component data literal.
    const replaced=block.replace(/(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)/g,(_match,open,close)=>{const text=found?'':xmlEscape(value);found=true;return open+text+close;});
    if(!found)workflowError('M07_TEMPLATE_CONTROL_INVALID',`M07 cannot write the '${tag}' content control because it contains no text run.`);
    documentXml=documentXml.slice(0,start)+replaced+documentXml.slice(end+8);offset=start+replaced.length;count++;
  }
  if(!count)workflowError('M07_TEMPLATE_CONTROL_MISSING',`M07 cannot use the deviation permit template because content control '${tag}' is missing.`);
  return documentXml;
}

function validatePermitCharacters(rows){
  const fields={product:'Product',productDecimalNo:'Product_Decimal_No',productCode:'Product_1C_Code',productionOrder:'Production_Order',origCode:'Orig_Code',origMfr:'Orig_Mfr',origPn:'Orig_PN',altMfr:'Alt_Mfr',altPn:'Alt_PN',responsible:'Responsible'},findings=[];
  for(const row of rows)for(const [field,label] of Object.entries(fields)){let offset=0;for(const character of String(row[field]??'')){const code=character.codePointAt(0);if((code<32&&![9,10,13].includes(code))||(code>=0xd800&&code<=0xdfff)||code===0xfffe||code===0xffff){findings.push(`${row.proposalId}; ${row.sourceSheet||'Check'}${row.sourceRow?` row ${row.sourceRow}`:''}; ${label}: U+${code.toString(16).toUpperCase().padStart(4,'0')} at character ${offset+1} cannot be stored in a DOCX XML text field.`);break;}offset+=character.length;}}
  if(findings.length)workflowError('M07_INVALID_XML_CHARACTER','M07 cannot generate deviation permits because source values contain invalid XML characters.',findings);
}

function clearStandaloneParagraph(documentXml, targetText) {
  let removed = false;
  return documentXml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (removed) return paragraph;
    const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join("").trim();
    if (text !== targetText) return paragraph;
    removed = true;
    // Word Range.Delete leaves this empty paragraph before the rebuilt table.
    // Preserve its template spacing so Appendix pagination matches the macro.
    const open=paragraph.match(/^<w:p(?:\s[^>]*)?>/)[0],properties=paragraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0]||'';
    return `${open}${properties}</w:p>`;
  });
}

function permitCellXml(text, width, bold = false) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="auto"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/><w:ind w:left="0" w:firstLine="0"/><w:jc w:val="center"/><w:rPr>${bold ? "<w:b/>" : ""}<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="2"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>${bold ? "<w:b/>" : ""}<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`;
}

function templateTableGeometry(documentXml) {
  const tableMatch = documentXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/);
  if (!tableMatch) workflowError("M07_TEMPLATE_TABLE_MISSING", "M07 cannot use the deviation permit template because its replacement table is missing.");
  const widths = [...tableMatch[0].matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  const tableProperties = tableMatch[0].match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/)?.[0];
  if (widths.length !== 9 || widths.some((width) => !Number.isFinite(width) || width <= 0) || !tableProperties) {
    workflowError("M07_TEMPLATE_TABLE_INVALID", "M07 cannot use the deviation permit template because its nine-column table geometry is invalid.");
  }
  const adjustedWidths = [...widths];
  const minimumWidths = new Map([[1, 1400], [8, 2055]]);
  const donorIndexes = [2, 3, 5, 6];
  const donorMinimum = 1500;
  const required = [...minimumWidths].reduce((total, [index, minimum]) => total + Math.max(0, minimum - adjustedWidths[index]), 0);
  const available = donorIndexes.map((index) => Math.max(0, adjustedWidths[index] - donorMinimum));
  const availableTotal = available.reduce((total, value) => total + value, 0);
  if (availableTotal < required) workflowError("M07_TEMPLATE_TABLE_INVALID", "M07 cannot widen the source-code and responsible columns without exceeding the template table width.");
  minimumWidths.forEach((minimum, index) => { adjustedWidths[index] = Math.max(adjustedWidths[index], minimum); });
  let remaining = required;
  donorIndexes.forEach((index, donorIndex) => {
    const reduction = donorIndex === donorIndexes.length - 1 ? remaining : Math.min(remaining, Math.round(required * available[donorIndex] / availableTotal));
    adjustedWidths[index] -= reduction;
    remaining -= reduction;
  });
  return { widths: adjustedWidths, tableProperties };
}

function permitTableXml(rows, geometry) {
  const { widths, tableProperties } = geometry;
  const headers = ["№", "Исходный код 1С", "Исходный производитель", "Исходный Артикул", "Код 1С замены", "Производитель замены", "Артикул замены", "Заказ на производство", "Ответственный"];
  const rowXml = (values, header = false) => `<w:tr><w:tblPrEx><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx><w:trPr>${header ? "<w:cantSplit/><w:tblHeader/>" : ""}</w:trPr>${values.map((value, index) => permitCellXml(value, widths[index], header)).join("")}</w:tr>`;
  return `<w:tbl>${tableProperties}<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rowXml(headers, true)}${rows.map((row) => rowXml(row)).join("")}</w:tbl>`;
}

async function appendAppendixHeader(documentXml, relationshipsXml, contentTypesXml, zip) {
  const stylesXml=await zip.file('word/styles.xml').async('string');
  const headerStyle=(stylesXml.match(/<w:style\b[\s\S]*?<\/w:style>/g)||[]).find(style=>/<w:name\b[^>]*\bw:val="header"/i.test(style))?.match(/\bw:styleId="([^"]+)"/)?.[1];
  if(!headerStyle)workflowError('M07_TEMPLATE_HEADER_STYLE_MISSING','M07 cannot use the deviation template because its built-in Header paragraph style is missing.');
  const existingIds = [...relationshipsXml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
  const relationshipId = `rId${Math.max(0, ...existingIds) + 1}`;
  let headerNumber = 1;
  while (zip.file(`word/header${headerNumber}.xml`)) headerNumber += 1;
  const headerName = `header${headerNumber}.xml`;
  const sectionStart = documentXml.lastIndexOf("<w:sectPr");
  const sectionOpenEnd = documentXml.indexOf(">", sectionStart);
  if (sectionStart < 0 || sectionOpenEnd < 0) workflowError("M07_TEMPLATE_SECTION_MISSING", "M07 requires a separate landscape Appendix section in the deviation permit template.");
  documentXml = `${documentXml.slice(0, sectionOpenEnd + 1)}<w:headerReference w:type="default" r:id="${relationshipId}"/>${documentXml.slice(sectionOpenEnd + 1)}`;
  relationshipsXml = relationshipsXml.replace("</Relationships>", `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="${headerName}"/></Relationships>`);
  contentTypesXml = contentTypesXml.replace("</Types>", `<Override PartName="/word/${headerName}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`);
  const headerFont='<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/>';
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pStyle w:val="${xmlEscape(headerStyle)}"/><w:spacing w:after="120"/><w:jc w:val="right"/><w:rPr>${headerFont}</w:rPr></w:pPr><w:r><w:rPr>${headerFont}</w:rPr><w:t>Приложение А</w:t></w:r></w:p></w:hdr>`;
  zip.file(`word/${headerName}`, headerXml);
  return { documentXml, relationshipsXml, contentTypesXml };
}

async function createPermitFromTemplate(groupRows,template) {
  const first = groupRows[0];
  const productCode = groupRows.map((item) => cleanText(item.productCode)).find(Boolean) || "";
  let cardData = `${cleanText(first.product)}, ${cleanText(first.productDecimalNo)}`;
  if (productCode) cardData += `, код 1С изделия ${productCode}`;
  cardData += `, номер заказа ${cleanText(first.productionOrder)}`;
  const zip = await JSZip.loadAsync(template);
  let documentXml = await zip.file("word/document.xml").async("string");
  let relationshipsXml = await zip.file("word/_rels/document.xml.rels").async("string");
  let contentTypesXml = await zip.file("[Content_Types].xml").async("string");
  documentXml = fillContentControl(documentXml, "NAME_1C", cardData);
  documentXml = fillContentControl(documentXml, "APPLIES_TO", `${cleanText(first.product)}, ${cleanText(first.productDecimalNo)}`);
  documentXml = fillContentControl(documentXml, "EX_PRODUCT", cleanText(first.productDecimalNo).toUpperCase().endsWith("EX") ? "ДА" : "НЕТ");
  documentXml = fillContentControl(documentXml, "DEVIATION_SCOPE", cardData);
  documentXml = fillContentControl(documentXml, "DATE", "");
  documentXml = clearStandaloneParagraph(documentXml, "Приложение А");
  const tableGeometry = templateTableGeometry(documentXml);
  const tableRows = groupRows.map((item, index) => [String(index + 1), item.origCode, item.origMfr, item.origPn, "—", item.altMfr, item.altPn, first.productionOrder, item.responsible]);
  documentXml = documentXml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/, () => permitTableXml(tableRows, tableGeometry));
  ({ documentXml, relationshipsXml, contentTypesXml } = await appendAppendixHeader(documentXml, relationshipsXml, contentTypesXml, zip));
  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", relationshipsXml);
  zip.file("[Content_Types].xml", contentTypesXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

async function createM07(proposals, options,workingOrderGate=null) {
  if(workingOrderGate){
    const catalog=permitCatalog(proposals),requested=selectionValues(options.orderNos)??(cleanText(options.orderNo)?[options.orderNo]:null),availableOrders=[...new Set(catalog.map(row=>normalize(row.orderNo)))];
    const orders=requested??(availableOrders.length===1?availableOrders:[]),products=selectionValues(options.productDecimalNos),chosenOrders=new Set(orders.map(normalize)),chosenProducts=products===null?null:new Set(products.map(normalize));
    const selected=catalog.filter(row=>chosenOrders.has(normalize(row.orderNo))&&(!chosenProducts||chosenProducts.has(normalize(row.productDecimalNo))));
    if(selected.length){
      // Stored-code selection reads every active row of each selected group.
      const keys=new Set(selected.map(row=>row.key));
      workingOrderGate(proposals.filter(row=>!row.archived&&keys.has(permitProductKey(row))));
      for(const orderNo of new Set(selected.map(row=>row.orderNo)))gateWorkingOrderLabel(proposals,orderNo,workingOrderGate);
    }
  }
  const {rows,plan:metadataPlan}=preparePermitMetadata(proposals,options);
  const missingProductionOrder = rows.filter((item) => !clean(item.productionOrder));
  if (missingProductionOrder.length) workflowError("M07_PRODUCTION_ORDER_MISSING", "M07 cannot generate deviation permits.", missingProductionOrder.map(item=>`${item.proposalId}; ${item.sourceSheet||'Check'}${item.sourceRow?` row ${item.sourceRow}`:''}; Production_Order is required.`));
  if (!rows.length) workflowError("M07_NO_ELIGIBLE_ROWS", "M07 cannot generate deviation permits.", ["No approved or previously approved substitutions were found for the selected order."]);
  validatePermitCharacters(rows);
  const template=await fs.readFile(deviationTemplatePath);const templateSha256=createHash('sha256').update(template).digest('hex');
  const groups = grouped(rows, (item) => JSON.stringify([normalize(item.orderNo),normalize(item.productDecimalNo),normalize(item.productionOrder)]));
  const zip = new JSZip();const members=[];
  const baseName=first=>{const order=filenameToken(first.orderNo,'',18);return `${filenameStem('M07','Permit',productToken(first.product,first.productDecimalNo),filenameToken(first.supplier,'',24),order?`O${order}`:'',`v${positiveNumber(options.version)}`)}.docx`;};
  const counts=new Map();for(const groupRows of Object.values(groups)){const name=baseName(groupRows[0]).toLowerCase();counts.set(name,(counts.get(name)||0)+1);}
  for (const [groupKey,groupRows] of Object.entries(groups)) {
    const first = groupRows[0];
    let name=baseName(first);if(counts.get(name.toLowerCase())>1)name=name.replace(/_v\d+\.docx$/,`_PO${filenameToken(first.productionOrder,'PO',14)}_${createHash('sha256').update(groupKey).digest('hex').slice(0,6)}_v${positiveNumber(options.version)}.docx`);
    const buffer=await createPermitFromTemplate(groupRows,template);await addToZip(zip,name,buffer);members.push({filename:name,buffer,contentType:DOCX_TYPE,scopeRows:groupRows,affected:groupRows.length});
  }
  const defaultName = proposedFilename("M07", rows, options, "zip");
  return { filename: selectedFilename(defaultName, options.fileName, "zip"), contentType: ZIP_TYPE, buffer: await zip.generateAsync({ type: "nodebuffer" }), affected: rows.length, documentType: DOCX_TYPE,scopeRows:rows,members,templateSha256,metadataPlan };
}

async function createM09(proposals, replacements, options,workingOrderGate=null) {
  if (!options.originalBoms?.length) workflowError('M09_SOURCE_REQUIRED','M09 requires the original supplier BOM.', ['Select a saved original BOM or upload the original supplier-cycle workbook. Proposal rows cannot reconstruct quantities or unchanged components.']);
  const rows=proposals.filter(item=>!item.archived);
  const zip=new JSZip();let affected=0;const actions={};const members=[];const scopeRows=[];
  for(const source of options.originalBoms) {
    const previousAffected=affected;
    const inspected=inspectWorkflowWorkbook('M09',source.buffer,source.filename);
    const meta={...inspected.metadata};
    meta.orderNo ||= source.scope?.orderNos?.[0];meta.productDecimalNo ||= source.scope?.productDecimalNos?.[0];meta.supplier ||= source.scope?.suppliers?.[0];
    if(!meta.orderNo || !meta.productDecimalNo) workflowError('M09_METADATA_MISSING',`M09 cannot complete '${source.filename}'.`,['Order_No and Product_Decimal_No are required in the source BOM metadata.']);
    if(options.orderNo && normalize(options.orderNo)!==normalize(meta.orderNo)) workflowError('M09_ORDER_MISMATCH','The selected original BOM belongs to a different order.');
    // Edit the original OOXML package. Rebuilding the entire workbook drops
    // unsupported drawings/parts and breaks references outside the BOM sheet.
    const sourceBytes=source.buffer[0]===0x50&&source.buffer[1]===0x4b?source.buffer:XLSX.write(readLegacyWorkbook(source.buffer),{type:'buffer',bookType:'xlsx'});
    const workbook=await PreservedWorkbook.open(sourceBytes);const headerRow=inspected.headerRow;
    // Match the preserved source labels with Core.AC8_Normalize, before any
    // table-label repair. Punctuation and tabs are meaningful in the macro.
    const headerPlan=planM09Headers(Array.from({length:inspected.headers.length},(_,index)=>workbook.value(headerRow,index+1)));
    for(const {column} of headerPlan.deletions)await workbook.removeColumn(column);
    const headers=m09TableHeaders(headerPlan.headers);
    const sourceColumns=sourceHeaderColumns('M09',headerPlan.headers);
    const col=key=>sourceColumns[key]||0;
    const pnColumn=col('origPn'),mfrColumn=col('origMfr'),positionColumn=col('position');
    if(!pnColumn) workflowError('M09_PN_COLUMN_MISSING',`M09 cannot complete '${source.filename}'.`,[`Worksheet ${workbook.sheet.name}; header row ${headerRow}: Original PN / Nomenclature column is missing.`]);
    const finalColumns=headerPlan.finalColumns;
    headers.forEach((name,index)=>{workbook.set(headerRow,index+1,name);});
    let lastRow=headerRow;
    for(const row of workbook.sheet.rows.keys())if(row>lastRow){
      const cell=workbook.cell(row,pnColumn);if(!cell)continue;
      const parts=Array.from(cell.childNodes).filter(node=>node.nodeType===1);
      if(m09CellOccupied({formula:parts.some(node=>node.localName==='f'),type:cell.getAttribute('t'),value:parts.find(node=>node.localName==='v')?.textContent||'',text:workbook.value(row,pnColumn)}))lastRow=row;
    }
    // Final.bas FOB_AppendUnique searches the delimiter-wrapped accumulated
    // text literally. Preserve its spacing behavior (A, B, A => A | B | A)
    // for exported text only; this is not record/identity deduplication.
    const join=values=>values.map(cleanText).reduce((existing,value)=>!value?existing:!existing?value:(`|${normalize(existing)}|`.includes(`|${normalize(value)}|`)?existing:`${existing} | ${value}`),'');
    for(let number=headerRow+1;number<=lastRow;number++) {
      const origPn=cleanPartNumber(workbook.value(number,pnColumn));
      if(!origPn)continue;
      const origMfr=mfrColumn?canonicalManufacturer(workbook.value(number,mfrColumn)):'';
      const position=positionColumn?cleanText(workbook.value(number,positionColumn)):'';
      const matching=rows.filter(item=>normalize(item.orderNo)===normalize(meta.orderNo) && normalize(item.productDecimalNo)===normalize(meta.productDecimalNo) && normalize(cleanPartNumber(item.origPn))===normalize(origPn) && (!origMfr || !item.origMfr || normalize(canonicalManufacturer(item.origMfr))===normalize(origMfr)) && (!position || !item.position || normalize(position)===normalize(item.position)));
      const approved=matching.filter(item=>classifyProposal(item)==='APPROVED' || (!classifyProposal(item) && !item.clientReplyRaw && item.historicalStatus==='PREVIOUSLY APPROVED'));
      const doNotPurchase=matching.filter(item=>classifyProposal(item)==='DO NOT PURCHASE');
      workingOrderGate?.(matching.filter(item=>approved.includes(item)||doNotPurchase.includes(item)));
      const obsolete=replacements.some(item=>item.decisionStatus==='OBSOLETE' && originalKey(item)===originalKey({...meta,origMfr,origPn}));
      const action=approved.length && doNotPurchase.length?'CHECK - CONFLICT':doNotPurchase.length?'DO NOT PURCHASE':approved.length?'REPLACEMENT':obsolete?'CHECK - OBSOLETE':'ORIGINAL';
      const values=[action,join(approved.map(item=>item.altMfr)),join(approved.map(item=>item.altPn)),join(matching.filter(item=>approved.includes(item)||doNotPurchase.includes(item)).map(item=>item.clientComment))];
      finalColumns.forEach((column,index)=>{workbook.set(number,column,values[index]);});
      actions[action]=(actions[action]||0)+1;affected++;
    }
    await workbook.formatTable(headerRow,lastRow,headers,{original:[mfrColumn,pnColumn],alternative:[finalColumns[1],finalColumns[2]],widths:finalColumns.map((column,index)=>[column,[22,24,32,42][index]])});
    // Existing source widths and quantities are retained. Only the four user-
    // approved headers wrap; positional designation never changes row height.
    const order=filenameToken(meta.orderNo,'',18),name=`${filenameStem('M09','Final-BOM',productToken(meta.product,meta.productDecimalNo),filenameToken(meta.supplier,'',24),order?`O${order}`:'',`v${positiveNumber(options.version)}`)}.xlsx`;
    if(zip.file(name)) workflowError('M09_DUPLICATE_SOURCE','Two selected BOMs would create the same output name. Select one source version per product and supplier.');
    const buffer=await workbook.buffer();await addToZip(zip,name,buffer);members.push({filename:name,buffer,contentType:XLSX_TYPE,scopeRows:[meta],affected:affected-previousAffected});scopeRows.push(meta);
  }
  const defaultName=proposedFilename('M09',scopeRows,options,'zip');
  return {filename:selectedFilename(defaultName,options.fileName,'zip'),contentType:ZIP_TYPE,buffer:await zip.generateAsync({type:'nodebuffer'}),affected,actions,scopeRows,members};
}

export function workflowFilenameSuggestion(moduleId, proposals = [], options = {}) {
  const extension = ["M05", "M07", "M09"].includes(moduleId) ? "zip" : "xlsx";
  return proposedFilename(moduleId, proposals, options, extension);
}

export async function createWorkflowFile(moduleId, proposals, replacements, options = {}, inputBuffer = null,workingOrder=null) {
  if(workingOrder)proposals=importProposalWorkingOrder(proposals,workingOrder);
  if (moduleId !== 'M01') { const history=createHistoryIndex(replacements),source=proposals; proposals = proposals.map(item => recalculateProposal(item,history));if(workingOrder)copyProposalWorkingOrder(source,proposals); }
  const contributorIds=new Set(),gate=workingOrder?rows=>{for(const row of requireKnownWorkingOrder(copyProposalWorkingOrder(proposals,rows)))contributorIds.add(row.proposalId);}:null;
  const finish=async promise=>{const file=await promise;if(!workingOrder)return file;const selected=copyProposalWorkingOrder(proposals,proposals.filter(row=>contributorIds.has(row.proposalId))),ordered=requireKnownWorkingOrder(selected);return {...file,workingOrder:{...proposalWorkingOrderProof(ordered),contributorIds:ordered.map(row=>row.proposalId)}};};
  if (moduleId === "M01") return createM01(inputBuffer, replacements, options);
  if (moduleId === "M03") return finish(createM03(proposals, options,gate));
  if (moduleId === "M05") return finish(createM05(proposals, options,gate));
  if (moduleId === "M06") return finish(createM06(proposals, options,gate));
  if (moduleId === "M07") return finish(createM07(proposals, options,gate));
  if (moduleId === "M09") return finish(createM09(proposals, replacements, options,gate));
  workflowError("FILE_EXPORT_NOT_SUPPORTED", `${moduleId} does not generate a downloadable file.`);
}

