import {createHash} from 'node:crypto';
import {WORKBOOK_LIMITS} from './workbook-limits.js';

export const auditReportColumns=Object.freeze(['Event_ID','Occurred_At_UTC','Actor','Actor_User_ID','Role','Action','Subject','Detail','Request_ID','Before_JSON','After_JSON','Provenance_State','Provenance_JSON']);
export const auditReportTextPartColumns=Object.freeze(['Audit_Row','Event_ID','Header','Part','Parts','Original_UTF16_Units','Value_SHA256','Text_JSON']);
export const auditReportLimits=Object.freeze({cellCharacters:32767,cellLineFeeds:253,dataRows:1048575});
export const auditReportError=(code,message,details=[],status=422)=>Object.assign(new Error(message),{status,code,details});
const identity=value=>typeof value==='string'?JSON.stringify(value).slice(0,180):'(unknown)';
const detail=(id,header,rowNumber=null,worksheet='Audit')=>`Worksheet ${worksheet}; row ${rowNumber??'(identified by event)'}; event ${identity(id)}; column ${header}.`;
export function auditReportSourceSummary(source){
 if(!source||source.formatVersion!==1||!/^[a-f0-9]{64}$/.test(source.sha256)||!Number.isSafeInteger(source.bytes)||source.bytes<1||source.bytes>WORKBOOK_LIMITS.maxInputBytes||!Number.isSafeInteger(source.expandedBytes)||source.expandedBytes<1||source.expandedBytes>WORKBOOK_LIMITS.maxExpandedBytes||!Number.isSafeInteger(source.rows)||source.rows<0||source.rows>auditReportLimits.dataRows)throw auditReportError('AUDIT_REPORT_SOURCE_INVALID','The audit source summary is invalid.',[],409);
 return Object.freeze({formatVersion:1,sha256:source.sha256,bytes:source.bytes,expandedBytes:source.expandedBytes,rows:source.rows});
}
export function parseAuditReportFormat(value,{defaultFormat='xlsx'}={}){
 if(!['xlsx','csv'].includes(defaultFormat))throw new TypeError('Invalid default audit report format.');
 const format=value===undefined?defaultFormat:value;
 if(!['xlsx','csv'].includes(format))throw auditReportError('AUDIT_REPORT_FORMAT','Choose XLSX or CSV for the audit report.',['Allowed format values: xlsx, csv.']);
 return format;
}
function json(value,id,header){
 try{const result=JSON.stringify(value,(key,item)=>{if(item===undefined||typeof item==='function'||typeof item==='symbol'||typeof item==='bigint'||typeof item==='number'&&!Number.isFinite(item))throw new Error();return item;});if(typeof result!=='string')throw new Error();return result;}
 catch{throw auditReportError('AUDIT_REPORT_VALUE_INVALID','An audit value cannot be represented without loss.',[detail(id,header),'The entire report was refused; no value was omitted or shortened.']);}
}
export function auditReportValues(event){
 if(!event||typeof event!=='object'||Array.isArray(event))throw auditReportError('AUDIT_REPORT_ROW_INVALID','An audit event must be an object.');
 const text=value=>String(value??'');
 return [event.id,event.occurredAt,event.actor,event.actorUserId,event.role,event.action,event.subject,event.detail,event.requestId].map(text).concat([
  event.before==null?'':json(event.before,event.id,'Before_JSON'),event.after==null?'':json(event.after,event.id,'After_JSON'),text(event.provenanceState),json(event.provenance??null,event.id,'Provenance_JSON')
 ]);
}
const xmlPoint=point=>point===9||point===10||point===13||point>=32&&point<=0xd7ff||point>=0xe000&&point<=0xfffd||point>=0x10000&&point<=0x10ffff;
/** OpenXML escape-looking literals also need an unambiguous JSON continuation. */
export function auditReportTextFitsCell(value){
 if(typeof value!=='string'||value.length>auditReportLimits.cellCharacters||value.includes('\r')||value.includes('\u007f')||/_x[0-9a-f]{4}_/i.test(value))return false;
 let lineFeeds=0;for(const character of value){const point=character.codePointAt(0);if(!xmlPoint(point)||point===10&&++lineFeeds>auditReportLimits.cellLineFeeds)return false;}
 return true;
}
/** Safe JSON string content: no raw XML-invalid or OpenXML escape characters. */
export const escapeAuditReportJSON=text=>text.replace(/[_\u007f\ufffe\uffff]/g,character=>character==='_'?'\\u005f':character==='\u007f'?'\\u007f':character==='\ufffe'?'\\ufffe':'\\uffff');
/** Only one field is materialized; each fragment is appended/joined once. */
export function auditReportTextParts(value){
 if(typeof value!=='string')throw auditReportError('AUDIT_REPORT_VALUE_INVALID','A text continuation must contain a full string.');
 const parts=[];let fragments=[],length=2;
 const flush=()=>{parts.push('"'+fragments.join('')+'"');fragments=[];length=2;};
 for(const character of value){const encoded=escapeAuditReportJSON(JSON.stringify(character).slice(1,-1));if(length+encoded.length>auditReportLimits.cellCharacters)flush();fragments.push(encoded);length+=encoded.length;}
 if(fragments.length||!parts.length)flush();
 return {sha256:createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex'),utf16Units:value.length,parts};
}
export function assertAuditReportTextPartCapacity(used,additional,{auditRow,eventId,header}={}){
 if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(additional)||additional<1)throw auditReportError('AUDIT_REPORT_SOURCE_INVALID','The continuation row accounting is invalid.',[],409);
 if(used+additional>auditReportLimits.dataRows)throw auditReportError('AUDIT_REPORT_TEXT_PARTS_ROWS','The lossless audit continuation exceeds the XLSX worksheet row limit.',[`Worksheet TextParts; Audit row ${auditRow}; event ${identity(eventId)}; column ${header}; maximum ${auditReportLimits.dataRows} data rows. No partial report was issued.`]);
}
function jsonCharacterBytes(character){
 const point=character.codePointAt(0);if(character==='"'||character==='\\'||[8,9,10,12,13].includes(point))return 2;
 if(point<32||point>=0xd800&&point<=0xdfff)return 6;
 return point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;
}
/** Keep complete strings in the source; cell representation is the writer's job. */
export function validateAuditReportRow(row,{rowNumber=null}={}){
 const id=Array.isArray(row)?row[0]:null;
 if(!Array.isArray(row)||row.length!==auditReportColumns.length)throw auditReportError('AUDIT_REPORT_ROW_INVALID','An audit report row must contain all13 fields.',[detail(id,'*',rowNumber)]);
 let bytes=Buffer.byteLength('{"type":"row","values":[]}\n');
 for(let index=0;index<row.length;index++){
  const value=row[index],header=auditReportColumns[index];
  if(typeof value!=='string')throw auditReportError('AUDIT_REPORT_VALUE_INVALID','Audit report cells must be complete strings.',[detail(id,header,rowNumber)]);
  const tooLarge=()=>auditReportError('AUDIT_REPORT_ROW_LIMIT','One complete audit row exceeds the existing workbook part limit.',[detail(id,header,rowNumber),`Maximum ${WORKBOOK_LIMITS.maxPartBytes} serialized UTF-8 bytes; no value was shortened or omitted.`]);
  bytes+=2+(index?1:0);if(value.length>WORKBOOK_LIMITS.maxPartBytes-bytes)throw tooLarge();
  for(const character of value){bytes+=jsonCharacterBytes(character);if(bytes>WORKBOOK_LIMITS.maxPartBytes)throw tooLarge();}
 }
 return row;
}
export function validateAuditReportText(value,{id='Meta',header='Capture_JSON',rowNumber=null,worksheet='Meta'}={}){
  if(typeof value!=='string')throw auditReportError('AUDIT_REPORT_VALUE_INVALID','Audit report cells must be complete strings.',[detail(id,header,rowNumber,worksheet)]);
  if(value.length>auditReportLimits.cellCharacters)throw auditReportError('AUDIT_REPORT_CELL_LIMIT','An audit value exceeds the XLSX cell text limit.',[detail(id,header,rowNumber,worksheet),`Length ${value.length}; maximum ${auditReportLimits.cellCharacters} UTF-16 units. No value was shortened and no report was issued.`]);
  for(const character of value){const point=character.codePointAt(0);if(!xmlPoint(point))throw auditReportError('AUDIT_REPORT_CHARACTER_INVALID','An audit value contains a character that XLSX XML cannot preserve.',[detail(id,header,rowNumber,worksheet),`Character U+${point.toString(16).toUpperCase()}. The entire report was refused; no value was omitted.`]);}
 return value;
}

