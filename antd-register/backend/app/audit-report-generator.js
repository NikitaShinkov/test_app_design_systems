import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import ExcelJS from 'exceljs';
import {auditReportColumns,auditReportTextPartColumns,auditReportError,auditReportTextFitsCell,auditReportTextParts,assertAuditReportTextPartCapacity,escapeAuditReportJSON,validateAuditReportText} from './audit-report-fields.js';
import {assertAuditReportDirectory,readAuditReportCapture} from './audit-report-spool.js';
import {WORKBOOK_LIMITS} from './workbook-limits.js';
import {checkObjectStorageSpace,storageAdmissionLimits} from './storage-admission.js';

const invalid=()=>auditReportError('AUDIT_REPORT_SOURCE_INVALID','The audit generator received an invalid capture or output identity.',[],409);
const stopped=()=>auditReportError('PREPARATION_LEASE_LOST','Audit workbook generation was cancelled or lost its execution lease.',[],409);
const widths=Object.freeze([28,30,28,38,22,32,36,70,38,80,80,22,80]);
function captureJSON(value){
 try{const text=JSON.stringify(value,(key,item)=>{if(item===undefined||typeof item==='bigint'||typeof item==='function'||typeof item==='symbol'||typeof item==='number'&&!Number.isFinite(item))throw invalid();return item;});if(typeof text!=='string')throw invalid();return validateAuditReportText(escapeAuditReportJSON(text),{header:'Capture_JSON'});}
 catch(error){if(error.code?.startsWith('AUDIT_REPORT_'))throw error;throw auditReportError('AUDIT_REPORT_METADATA_INVALID','The complete audit capture metadata cannot be represented without loss.',['Column Capture_JSON; no metadata was omitted.']);}
}
/** Genuine streaming XLSX. This runs inside the existing isolated generator. */
export async function generateAuditReport(task){
 if(task?.signal?.aborted)throw stopped();
 if(!task||typeof task!=='object'||!task.capture||typeof task.capture!=='object'||Array.isArray(task.capture)||!task.source||typeof task.filename!=='string'||!/\.xlsx$/i.test(task.filename)||/[/\\\x00-\x1f<>:"|?*]/.test(task.filename)||/[. ]$/.test(task.filename)||!Number.isSafeInteger(task.maxBytes)||task.maxBytes<1||task.maxBytes>WORKBOOK_LIMITS.maxInputBytes)throw invalid();
 const directory=task.directory;await assertAuditReportDirectory(directory);if(task.source.path!==path.join(directory,'source.ndjson.gz')||task.capture.rows!==undefined&&task.capture.rows!==task.source.rows)throw invalid();
 const metadata=captureJSON(task.capture);if(typeof task.capture.asOf!=='string'||!Number.isFinite(Date.parse(task.capture.asOf)))throw invalid();
 const filename=path.join(directory,'report.xlsx');
 await checkObjectStorageSpace(directory,task.maxBytes,{limits:task.storageLimits??storageAdmissionLimits()});if(task.signal?.aborted)throw stopped();
 let bytes=0,failure=null,currentEvent='(none)',workbook;
 const limit=()=>auditReportError('AUDIT_REPORT_TOO_LARGE','The complete audit workbook exceeds the configured file byte limit.',[`Event ${JSON.stringify(currentEvent).slice(0,180)}; workbook maximum ${task.maxBytes} bytes. Narrow the audit filters; no partial report was issued.`]);
 const input=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>task.maxBytes)return done(limit());done(null,chunk);}}),target=createWriteStream(filename,{flags:'wx',mode:0o600});
 const output=pipeline(input,target,...(task.signal?[{signal:task.signal}]:[]));output.catch(error=>{failure=error;});
 const check=()=>{if(task.signal?.aborted)throw stopped();if(failure)throw failure;};
 let count=0,partsRows=0,partsSheet=null;
 try{
  check();workbook=new ExcelJS.stream.xlsx.WorkbookWriter({stream:input,useStyles:true,useSharedStrings:false});workbook.creator='Replacement Register';
  const audit=workbook.addWorksheet('Audit',{views:[{state:'frozen',ySplit:1}]});audit.columns=auditReportColumns.map((header,index)=>({key:header,width:widths[index],style:{numFmt:'@',font:{name:'Calibri',size:11},alignment:{vertical:'middle',wrapText:false}}}));
  const meta=workbook.addWorksheet('Meta');meta.columns=[{width:38,style:{numFmt:'@'}},{width:100,style:{numFmt:'@'}}];
  const textRow=(sheet,values,height=30)=>{const row=sheet.addRow(values);row.height=height;row.eachCell({includeEmpty:true},cell=>{cell.numFmt='@';cell.font={name:'Calibri',size:11};cell.alignment={vertical:'middle',wrapText:false};});row.commit();};
  const displayValue=(value,auditRow,index,eventId)=>{
   if(auditReportTextFitsCell(value))return value;
   const header=auditReportColumns[index],continuation=auditReportTextParts(value);
   assertAuditReportTextPartCapacity(partsRows,continuation.parts.length,{auditRow,eventId,header});
   if(!partsSheet){partsSheet=workbook.addWorksheet('TextParts',{views:[{state:'frozen',ySplit:1}]});partsSheet.columns=[12,38,28,10,10,22,70,100].map(width=>({width,style:{numFmt:'@',alignment:{vertical:'middle',wrapText:false}}}));textRow(partsSheet,[...auditReportTextPartColumns]);}
   const identity=auditReportTextFitsCell(eventId)?eventId:`Audit!A${auditRow}`;
   for(const [part,text]of continuation.parts.entries()){check();textRow(partsSheet,[String(auditRow),identity,header,String(part+1),String(continuation.parts.length),String(continuation.utf16Units),continuation.sha256,text]);partsRows++;}
   return `See TextParts: Audit!${String.fromCharCode(65+index)}${auditRow}; SHA256 ${continuation.sha256}`;
  };
  const titles=audit.addRow([...auditReportColumns]);titles.height=30;titles.eachCell(cell=>{cell.font={name:'Calibri',size:11,bold:true,color:{argb:'FFFFFFFF'}};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF163B4D'}};cell.alignment={vertical:'middle',wrapText:false};});titles.commit();
  for await(const values of readAuditReportCapture(task.source,{signal:task.signal})){check();currentEvent=values[0];const displayed=values.map((value,index)=>displayValue(value,count+2,index,values[0]));textRow(audit,displayed);count++;}
  check();if(count!==task.source.rows)throw invalid();audit.autoFilter={from:{row:1,column:1},to:{row:count+1,column:auditReportColumns.length}};audit.commit();
  if(partsSheet)partsSheet.commit();
  const add=(key,value)=>{const text=validateAuditReportText(String(value??''),{header:key});textRow(meta,[key,text],20);};
  add('Document_Type','Replacement Register audit report');add('Format','XLSX');add('Data_As_Of_UTC',task.capture.asOf);add('Rows',count);add('Source_SHA256',task.source.sha256);add('Source_Bytes',task.source.bytes);add('Capture_JSON',metadata);
  if(task.capture.filters&&typeof task.capture.filters==='object')for(const [key,value]of Object.entries(task.capture.filters))add('Filter '+key+'_JSON',escapeAuditReportJSON(JSON.stringify(value)));
  add('TextParts_Format','JSON_STRING_V1');add('TextParts_Rows',partsRows);
  add('TextParts_Binding','Find continuation groups by Audit_Row and exact Header, verified against the full SHA256 in the Audit cell. Never infer a continuation from reference-looking text alone. Event_ID is literal when safe, otherwise it references Audit!A<row>.');
  add('TextParts_Reconstruction','Sort each group by Part, require exactly Parts entries, JSON.parse every Text_JSON and join with no separator. Verify JavaScript UTF-16 length against Original_UTF16_Units and SHA-256 of UTF-8 JSON.stringify(the joined original string) against Value_SHA256.');
  add('TextParts_Reason','Values exceeding32767 UTF-16 units or253 linefeeds, XML-unrepresentable characters, DEL, CR/CRLF and OpenXML escape-looking literals use lossless JSON continuations. JSON chunks escape every underscore, DEL and XML-invalid character. Source_SHA256 witnesses the complete frozen capture; no field was shortened.');
  add('Meta_Text_Encoding','Filter *_JSON values are JSON-encoded values; JSON.parse reconstructs each original filter, including whitespace and control characters. Capture_JSON is complete JSON with reversible underscore and XML-safe escapes. Other trusted metadata values remain plain text.');
  for(const [index,header]of auditReportColumns.entries())add('Column '+(index+1),header);meta.commit();check();
  const writing=workbook.commit();writing.catch(()=>{});await Promise.race([writing,output]);await output;check();
  const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==bytes||bytes>task.maxBytes)throw invalid();
  const buffer=await fs.readFile(filename);if(buffer.length!==bytes)throw invalid();
  return {buffer,filename:task.filename,contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',affected:count};
 }catch(error){input.destroy(error);await output.catch(()=>{});if(task.signal?.aborted)throw stopped();if(['ENOSPC','EDQUOT'].includes(error.code))throw auditReportError('FILE_STORAGE_RESERVE','Controlled file storage is full.',[],507);throw error;}
}
