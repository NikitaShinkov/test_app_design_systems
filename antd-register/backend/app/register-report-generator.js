import fs from 'node:fs/promises';
import {isDecisionHeader,colorDecisionCell,colorDecisionHeader,applyExcelDecisionFormatting} from './decision-formatting.js';
import {loadBundledProfiles} from './font-metrics.js';
import {applyExcelJsRowGrowth} from './selective-row-growth.js';
let layoutProfiles;
const measuredLayoutProfiles=()=>layoutProfiles??=loadBundledProfiles(new URL('.',import.meta.url));
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import ExcelJS from 'exceljs';
import {auditCSVCell} from './audit-feed.js';
import {readRegisterReportCapture,canonicalRegisterReportJson} from './register-report-spool.js';
import {parseRegisterReport} from './register-report.js';
import {registerReportFields,registerReportProjection,registerRowSelection} from './register-column-filters.js';
import {httpError} from './auth.js';

const wrapHeaders=new Set(['Designation','Nomenclature','Alt_Mfr','Alt_PN']);
const stopped=()=>httpError(409,'Register report generation stopped or lost its execution lease.',{code:'PREPARATION_LEASE_LOST'});
const badSource=()=>httpError(409,'The retained register report source no longer matches its capture.',{code:'REGISTER_REPORT_SOURCE_INVALID'});
const tooLarge=()=>httpError(422,'The complete register report exceeds the configured file size limit. Narrow its filters or selection; no partial report was created.',{code:'REGISTER_REPORT_TOO_LARGE'});
function cellValue(value,field,rowId){
  if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value!=='string')throw badSource();
  if(value.length>32767)throw httpError(422,'One value exceeds the XLSX cell text limit. Choose CSV or narrow the report after reviewing the source value.',{code:'REGISTER_REPORT_CELL_LIMIT',details:[`Row ${rowId}; field ${field}; length ${value.length}; Excel maximum32767 characters. No value was shortened and no report was issued.`]});
  return value;
}
function writeTarget(filename,maxBytes){
  let bytes=0,failure=null;
  const input=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>maxBytes)callback(tooLarge());else callback(null,chunk);}}),target=createWriteStream(filename,{flags:'wx',mode:0o600});
  const done=pipeline(input,target);done.catch(error=>{failure=error;});
  return {input,done,check(){if(failure)throw failure;},async write(text){this.check();if(!input.write(text))await Promise.race([once(input,'drain'),done]);this.check();},bytes:()=>bytes};
}
const width=field=>['origPn','altPn'].includes(field)?38:['origMfr','altMfr'].includes(field)?26:field.toLowerCase().includes('comment')||field==='notes'?44:field==='position'?16:field.toLowerCase().includes('code')?18:field.toLowerCase().includes('date')?18:field.toLowerCase().includes('id')?27:24;
/** A fresh worker streams the frozen source into a bounded output file. */
export async function generateRegisterReport(task){
  const request=parseRegisterReport(task.request),directory=path.resolve(task.directory),filename=path.join(directory,'report.'+request.format);
  if(!directory.includes(path.sep+'.register-report-preparations'+path.sep)||!Number.isSafeInteger(task.maxBytes)||task.maxBytes<1)throw badSource();
  const fields=registerReportFields(request.registerKind),headers=fields.map(item=>item.header);
  if(new Set(headers).size!==headers.length||headers.some(value=>!value))throw badSource();
  const rowLayoutProfiles=request.format==='xlsx'?await measuredLayoutProfiles():null;
  const output=writeTarget(filename,task.maxBytes);let workbook,data,meta,header=null,footer=null,rowNumber=0;
  const check=()=>{if(task.signal?.aborted)throw stopped();output.check();};
  try{
    if(request.format==='xlsx'){
      workbook=new ExcelJS.stream.xlsx.WorkbookWriter({stream:output.input,useStyles:true,useSharedStrings:false});workbook.creator='Replacement Register';
      meta=workbook.addWorksheet('Meta');meta.columns=[{width:38},{width:84},{width:18}];
      const add=(key,value,third='')=>{const row=meta.addRow([key,value,third]);row.height=20;row.eachCell(cell=>{cell.alignment={vertical:'middle',wrapText:false};});row.commit();};
      add('Document_Type','Replacement Register report');add('Register',request.registerKind);add('Format','XLSX');add('Data_As_Of_UTC',task.capture.asOf);add('Rows',task.capture.rowCount);add('Selection_Mode',request.selection.mode);add('Selection_Count',request.selection.mode==='SELECTED'?request.selection.items.length:'All filtered rows');add('Excluded_Count',request.selection.mode==='FILTERED'?request.selection.excluded.length:0);add('Source_SHA256',task.source.sha256);add('Rows_SHA256',task.capture.rowHash);
      for(const [key,value]of Object.entries(request.filters)){if(key==='columnFilters'){for(const filter of value||[])add('Column_Filter '+filter.field,filter.op,typeof filter.value==='object'?JSON.stringify(filter.value):filter.value??'');}else add('Filter '+key,value);}
      add('','');add('Export_Header','Register_Field','Type');for(const field of fields)add(field.header,field.field,field.type);meta.commit();
      data=workbook.addWorksheet('Data',{views:[{state:'frozen',ySplit:1}]});data.columns=fields.map(field=>({key:field.field,width:width(field.field),style:{alignment:{vertical:'middle',wrapText:wrapHeaders.has(field.header)},...(field.type==='text'||field.type==='date'?{numFmt:'@'}:{})}}));
      const titles=data.addRow(headers);titles.height=30;titles.eachCell((cell,index)=>{cell.font={bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF163B4D'}};cell.alignment={vertical:'middle',wrapText:false};if(isDecisionHeader(headers[index-1]))colorDecisionHeader(cell);});titles.commit();
    }else await output.write('\uFEFF'+headers.map(auditCSVCell).join(',')+'\r\n');
    for await(const entry of readRegisterReportCapture(task.source,{directory})){
      check();
      if(entry.type==='header'){header=entry.header;if(canonicalRegisterReportJson(header.request)!==canonicalRegisterReportJson(request))throw badSource();continue;}
      if(entry.type==='footer'){footer=entry.capture;continue;}
      if(!header||entry.type!=='row')throw badSource();
      const values=registerReportProjection(request.registerKind,entry.values),key=registerRowSelection(request.registerKind,entry.values);
      if(canonicalRegisterReportJson(key)!==canonicalRegisterReportJson(entry.key)||canonicalRegisterReportJson(values)!==canonicalRegisterReportJson(entry.values))throw badSource();
      rowNumber++;
      if(request.format==='xlsx'){
        if(rowNumber+1>1048576)throw httpError(422,'The complete report exceeds the XLSX worksheet row limit. Choose CSV or narrower filters; no rows were omitted.',{code:'REGISTER_REPORT_XLSX_ROWS'});
        const row=data.addRow(fields.map(field=>cellValue(values[field.field],field.field,key.id)));row.height=30;
        row.eachCell({includeEmpty:true},(cell,index)=>{if(isDecisionHeader(headers[index-1]))colorDecisionCell(cell);});
        applyExcelJsRowGrowth(row,headers,{profiles:rowLayoutProfiles});row.commit();
      }else await output.write(fields.map(field=>auditCSVCell(values[field.field])).join(',')+'\r\n');
    }
    check();if(!header||!footer||canonicalRegisterReportJson(footer)!==canonicalRegisterReportJson(task.capture)||footer.rowCount!==rowNumber)throw badSource();
    if(workbook){applyExcelDecisionFormatting(data,1,rowNumber+1,headers,{colorCells:false});data.autoFilter={from:{row:1,column:1},to:{row:rowNumber+1,column:fields.length}};data.commit();await Promise.race([workbook.commit(),output.done]);}
    else output.input.end();
    await output.done;check();
    const buffer=await fs.readFile(filename);if(buffer.length>task.maxBytes)throw tooLarge();
    return {filename:task.filename,contentType:request.format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv; charset=utf-8',buffer,affected:rowNumber};
  }catch(error){output.input.destroy(error);await output.done.catch(()=>{});if(['ENOSPC','EDQUOT'].includes(error.code))throw Object.assign(new Error('Controlled file storage is full.'),{status:507,code:'FILE_STORAGE_RESERVE'});throw error;}
}
