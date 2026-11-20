import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
import {readLegacyWorkbook,inspectWorkflowWorkbook} from './workbook.js';
import {readImportMetadata} from './import-source.js';
import {cleanText,normalize} from './normalization.js';
import {sourceHeaderColumns} from './source-header-plan.js';

const metadataFields=['orderNo','product','productCode','productDecimalNo','supplier','productionOrder'];
const metadataValues=value=>Object.fromEntries(metadataFields.map(key=>[key,String(value[key]??'')]));

function sourceCell(sheet,column,row){
  const address=XLSX.utils.encode_cell({c:column-1,r:row-1}),cell=sheet[address];
  return {column,address,type:cell?.t||'z',value:cell?.v??null,
    ...(typeof cell?.f==='string'?{formula:cell.f}:{}),
    ...(typeof cell?.w==='string'?{formatted:cell.w}:{})};
}

/** Immutable read projection of the original workbook. Coordinates and raw
 * cells remain authoritative; this projection never regenerates an M09 file.
 * Call inside ExportGenerator so parsing keeps its existing memory/deadline
 * isolation. The bounded reader also validates archive and physical ranges. */
export function extractSourceBom(buffer,filename='workbook.xlsx'){
  const inspection=inspectWorkflowWorkbook('M09',buffer,filename);
  const workbook=readLegacyWorkbook(buffer),sheet=workbook.Sheets[inspection.sourceSheet];
  const end=XLSX.utils.decode_range(sheet['!ref']).e;
  const headers=Array.from({length:end.c+1},(_,index)=>({column:index+1,label:String(sheet[XLSX.utils.encode_cell({c:index,r:inspection.headerRow-1})]?.v??'')}));
  // M09 identity is the exact source-selected physical column, before table
  // label repair. These context fields are projection data, not M09 decisions.
  const labels=headers.map(header=>header.label),columns={...inspection.sourceColumns,
    quantity:sourceHeaderColumns('M01',labels).quantity||0,
    componentStatus:labels.findIndex(label=>['COMPONENT_STATUS','LIFECYCLE_STATUS'].includes(normalize(label)))+1};
  const sourceRows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:'',range:`A1:${XLSX.utils.encode_cell(end)}`});
  const sourceMetadata=metadataValues(readImportMetadata(sourceRows.slice(0,inspection.headerRow-1)));
  const rows=[];
  for(let sourceRow=inspection.headerRow+1;sourceRow<=inspection.lastDataRow;sourceRow++){
    const cells=headers.map(header=>sourceCell(sheet,header.column,sourceRow));
    const value=field=>columns[field]>0?cells[columns[field]-1].value:null;
    rows.push({sourceRow,position:cleanText(value('position')),origCode:cleanText(value('origCode')),
      origMfr:cleanText(value('origMfr')),origPn:cleanText(value('origPn')),
      quantity:value('quantity'),componentStatus:cleanText(value('componentStatus')),cells});
  }
  return {formatVersion:1,sourceSha256:createHash('sha256').update(buffer).digest('hex'),sourceBytes:buffer.length,
    sourceFilename:String(filename),sourceSheet:inspection.sourceSheet,headerRow:inspection.headerRow,lastDataRow:inspection.lastDataRow,
    headers,sourceMetadata,metadata:metadataValues(inspection.metadata),rows,findings:inspection.findings};
}
