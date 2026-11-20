import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {isUtf8} from 'node:buffer';
import {WORKBOOK_LIMITS} from './workbook-limits.js';
import {checkObjectStorageSpace,storageAdmissionLimits} from './storage-admission.js';
import {auditReportColumns,auditReportLimits,auditReportError,auditReportSourceSummary,validateAuditReportRow} from './audit-report-fields.js';

const hash=()=>createHash('sha256'),uuid=/^capture-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const invalid=()=>auditReportError('AUDIT_REPORT_SOURCE_INVALID','The retained audit report source failed its integrity, shape or count check.',[],409);
const stopped=()=>auditReportError('PREPARATION_LEASE_LOST','Audit report preparation was cancelled or lost its execution lease.',[],409);
const checkSignal=signal=>{if(signal?.aborted)throw stopped();};
const tooLarge=(code,message,details=[])=>auditReportError(code,message,[...details,'No partial report was issued and no rows were omitted.']);
const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
const contained=(parent,child)=>path.dirname(child)===parent&&path.basename(child)!=='.'&&path.basename(child)!=='..';
async function realDirectory(directory){
 const stat=await fs.lstat(directory,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await fs.realpath(directory))!==directory)throw invalid();
 return stat;
}
/** Revalidate the regular owned path before a read, output write or cleanup. */
export async function assertAuditReportDirectory(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory||!uuid.test(path.basename(directory))||path.basename(path.dirname(directory))!=='.audit-report-preparations')throw invalid();
 await realDirectory(path.dirname(directory));return realDirectory(directory);
}
const identity=stat=>({dev:stat.dev,ino:stat.ino});
const sameIdentity=(first,second)=>first.dev===second.dev&&first.ino===second.ino;
function checkedLine(value){const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>WORKBOOK_LIMITS.maxPartBytes)throw tooLarge('AUDIT_REPORT_ROW_LIMIT','One audit source row exceeds the existing workbook part limit.');return bytes;}
async function *lines(stream,signal){
 let pieces=[],length=0;
 for await(const chunk of stream){checkSignal(signal);let start=0,end;
  while((end=chunk.indexOf(10,start))!==-1){const piece=chunk.subarray(start,end);pieces.push(piece);length+=piece.length;if(length>WORKBOOK_LIMITS.maxPartBytes)throw tooLarge('AUDIT_REPORT_ROW_LIMIT','One audit source row exceeds the existing workbook part limit.');const bytes=Buffer.concat(pieces,length);if(!bytes.length||!isUtf8(bytes))throw invalid();yield bytes.toString('utf8');pieces=[];length=0;start=end+1;}
  if(start<chunk.length){pieces.push(chunk.subarray(start));length+=chunk.length-start;if(length>WORKBOOK_LIMITS.maxPartBytes)throw tooLarge('AUDIT_REPORT_ROW_LIMIT','One audit source row exceeds the existing workbook part limit.');}
 }
 if(length)throw invalid();
}
async function verifyCompressed(source,signal){
 const digest=hash();let bytes=0;
 for await(const chunk of createReadStream(source.path)){checkSignal(signal);bytes+=chunk.length;if(bytes>source.bytes)throw invalid();digest.update(chunk);}
 if(bytes!==source.bytes||digest.digest('hex')!==source.sha256)throw invalid();
}
/** One bounded private GZIPNDJSON capture; no collection of all event rows. */
export async function createAuditReportCapture({root,rows,maxBytes,signal,storageLimits=storageAdmissionLimits(),checkSpace=checkObjectStorageSpace}={}){
 if(typeof root!=='string'||!path.isAbsolute(root)||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>WORKBOOK_LIMITS.maxInputBytes||!rows||typeof rows[Symbol.asyncIterator]!=='function'&&typeof rows[Symbol.iterator]!=='function'||typeof checkSpace!=='function')throw invalid();
 checkSignal(signal);await fs.mkdir(root,{recursive:true,mode:0o700});const realRoot=await fs.realpath(root),base=path.join(realRoot,'.audit-report-preparations');await fs.mkdir(base,{recursive:true,mode:0o700});const baseIdentity=identity(await realDirectory(base));
 const directory=path.join(base,'capture-'+randomUUID());await fs.mkdir(directory,{mode:0o700});const ownedIdentity=identity(await assertAuditReportDirectory(directory)),sourcePath=path.join(directory,'source.ndjson.gz');let cleaned=false;
 const cleanup=async()=>{if(cleaned)return;let exists;try{exists=await fs.lstat(directory,{bigint:true});}catch(error){if(error.code==='ENOENT'){cleaned=true;return;}throw error;}
  if(!sameIdentity(baseIdentity,await realDirectory(base))||!sameIdentity(ownedIdentity,exists)||!sameIdentity(ownedIdentity,await assertAuditReportDirectory(directory))||!contained(base,directory))throw invalid();
  await fs.rm(directory,{recursive:true});cleaned=true;
 };
 try{
  await checkSpace(directory,maxBytes,{limits:storageLimits});checkSignal(signal);let rowCount=0,expandedBytes=0,rowDigest=hash();
  async function *records(){
   yield checkedLine({type:'header',formatVersion:1,columns:auditReportColumns});
   for await(const input of rows){checkSignal(signal);const values=[...validateAuditReportRow(input,{rowNumber:rowCount+2})];if(rowCount>=auditReportLimits.dataRows)throw tooLarge('AUDIT_REPORT_XLSX_ROWS','The audit report exceeds the XLSX worksheet row limit.',[`Worksheet Audit; row ${rowCount+2}; event ${JSON.stringify(values[0]).slice(0,180)}; column Event_ID; maximum ${auditReportLimits.dataRows} data rows plus the header.`]);rowCount++;rowDigest.update(JSON.stringify(values)+'\n');yield checkedLine({type:'row',values});}
   checkSignal(signal);yield checkedLine({type:'footer',rows:rowCount,rowHash:rowDigest.digest('hex')});
  }
  const expanded=new Transform({transform(chunk,encoding,done){expandedBytes+=chunk.length;if(expandedBytes>WORKBOOK_LIMITS.maxExpandedBytes)return done(tooLarge('AUDIT_REPORT_EXPANDED_LIMIT','The complete audit capture exceeds the existing expanded workbook byte limit.',[`Maximum ${WORKBOOK_LIMITS.maxExpandedBytes} bytes.`]));done(null,chunk);}});
  const digest=hash();let bytes=0;const compressed=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>maxBytes)return done(tooLarge('AUDIT_REPORT_TOO_LARGE','The complete audit source exceeds the configured file byte limit.',[`Maximum ${maxBytes} compressed bytes.`]));digest.update(chunk);done(null,chunk);}});
  await pipeline(Readable.from(records()),expanded,createGzip(),compressed,createWriteStream(sourcePath,{flags:'wx',mode:0o600}),...(signal?[{signal}]:[]));checkSignal(signal);
  const file=await fs.open(sourcePath,'r+');try{await file.sync();}finally{await file.close();}
  return {source:{path:sourcePath,bytes,expandedBytes,sha256:digest.digest('hex'),rows:rowCount,formatVersion:1},directory,rows:rowCount,cleanup};
 }catch(error){try{await cleanup();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Audit capture failed and owned cleanup requires review.');}if(signal?.aborted)throw stopped();if(['ENOSPC','EDQUOT'].includes(error.code))throw auditReportError('FILE_STORAGE_RESERVE','Controlled file storage is full.',[],507);throw error;}
}
/** Consume to completion before publishing. A bad compressed hash yields no rows. */
export async function *readAuditReportCapture(source,{signal}={}){
 checkSignal(signal);auditReportSourceSummary(source);if(typeof source.path!=='string')throw invalid();
 const directory=path.dirname(source.path);await assertAuditReportDirectory(directory);if(source.path!==path.join(directory,'source.ndjson.gz'))throw invalid();
 const stat=await fs.lstat(source.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==source.bytes||path.resolve(await fs.realpath(source.path))!==source.path)throw invalid();
 await verifyCompressed(source,signal);checkSignal(signal);
 const raw=createReadStream(source.path),gunzip=createGunzip(),digest=hash();let bytes=0,expandedBytes=0,rows=0,header=false,footer=null;const rowDigest=hash();
 const compressed=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>source.bytes)return done(invalid());digest.update(chunk);done(null,chunk);},flush(done){done(bytes===source.bytes&&digest.digest('hex')===source.sha256?null:invalid());}});
 const expanded=new Transform({transform(chunk,encoding,done){expandedBytes+=chunk.length;if(expandedBytes>WORKBOOK_LIMITS.maxExpandedBytes)return done(tooLarge('AUDIT_REPORT_EXPANDED_LIMIT','The audit capture exceeds the existing expanded workbook byte limit.'));done(null,chunk);}});
 const pending=pipeline(raw,compressed,gunzip,expanded,...(signal?[{signal}]:[]));pending.catch(()=>{});
 try{
  for await(const text of lines(expanded,signal)){let value;try{value=JSON.parse(text);}catch{throw invalid();}if(footer)throw invalid();
   if(!header){if(keys(value)!=='columns,formatVersion,type'||value.type!=='header'||value.formatVersion!==1||JSON.stringify(value.columns)!==JSON.stringify(auditReportColumns))throw invalid();header=true;continue;}
   if(value.type==='row'&&keys(value)==='type,values'){const row=validateAuditReportRow(value.values,{rowNumber:rows+2});rows++;if(rows>source.rows||rows>auditReportLimits.dataRows)throw invalid();rowDigest.update(JSON.stringify(row)+'\n');yield row;}
   else if(value.type==='footer'&&keys(value)==='rowHash,rows,type')footer=value;
   else throw invalid();
  }
  await pending;checkSignal(signal);if(!header||!footer||footer.rows!==rows||source.rows!==rows||source.expandedBytes!==expandedBytes||footer.rowHash!==rowDigest.digest('hex'))throw invalid();
 }catch(error){if(signal?.aborted)throw stopped();if(error.code?.startsWith('AUDIT_REPORT_'))throw error;throw invalid();}
 finally{raw.destroy();compressed.destroy();gunzip.destroy();expanded.destroy();await pending.catch(()=>{});}
}
