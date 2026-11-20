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

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const scalar=value=>value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value);
const failure=(code,message,status=409)=>Object.assign(new Error(message),{status,code});
const invalid=()=>failure('REGISTER_REPORT_SOURCE_INVALID','The retained register report source failed its integrity or format check.');
const abort=()=>failure('PREPARATION_LEASE_LOST','Register report preparation was cancelled or lost its execution lease.');
function checkSignal(signal){if(signal?.aborted)throw abort();}
function safeJson(value,depth=0){if(depth>64)throw invalid();if(scalar(value))return value;if(Array.isArray(value))return value.map(item=>safeJson(item,depth+1));if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,safeJson(value[key],depth+1)]));throw invalid();}
export const canonicalRegisterReportJson=value=>JSON.stringify(safeJson(value));
const hash=()=>createHash('sha256');
const scopeFields={orderNos:'orderNo',suppliers:'supplier',productDecimalNos:'productDecimalNo',proposalIds:'proposalId'};
const scopes=()=>Object.fromEntries(Object.keys(scopeFields).map(key=>[key,new Set()]));
function addScope(scope,values){for(const [key,field]of Object.entries(scopeFields))if(values[field]!==null&&values[field]!==undefined&&String(values[field])!=='')scope[key].add(String(values[field]));}
const finishScope=scope=>Object.fromEntries(Object.entries(scope).map(([key,values])=>[key,[...values].sort()]));
function validateRow(entry){
  if(!object(entry)||Object.keys(entry).some(key=>!['key','values'].includes(key))||!object(entry.key)||!object(entry.values))throw invalid();
  const {key,values}=entry;
  if(Object.keys(key).length!==4||!['p','r','l'].includes(key.kind)||typeof key.id!=='string'||!key.id||key.id.length>1000||/[\x00-\x1f\x7f]/.test(key.id)||!Number.isSafeInteger(key.version)||key.version<0||!/^[a-f0-9]{64}$/.test(key.fingerprint))throw invalid();
  if(Object.values(values).some(value=>!scalar(value)))throw invalid();
  return {key:safeJson(key),values:safeJson(values)};
}
function line(value){const bytes=Buffer.from(canonicalRegisterReportJson(value)+'\n');if(bytes.length>WORKBOOK_LIMITS.maxPartBytes)throw failure('REGISTER_REPORT_ROW_TOO_LARGE','One report source row exceeds the supported processing size. No report was issued or rows omitted.',413);return bytes;}
function contained(directory,filename){const relative=path.relative(directory,filename);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
async function guardedDirectory(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||!/^capture-[a-f0-9-]{36}-[a-f0-9-]{36}$/i.test(path.basename(directory)))throw invalid();
  const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw invalid();
  if(path.resolve(await fs.realpath(directory))!==path.resolve(directory))throw invalid();
  return directory;
}
function sourceCounter(expected){const digest=hash();let bytes=0;return new Transform({transform(chunk,encoding,done){bytes+=chunk.length;digest.update(chunk);if(bytes>expected.bytes)return done(invalid());done(null,chunk);},flush(done){if(bytes!==expected.bytes||digest.digest('hex')!==expected.sha256)return done(invalid());done();}});}
async function verifyCompressedStream(stream,source,signal){
  if(!stream||typeof stream[Symbol.asyncIterator]!=='function'||typeof stream.destroy!=='function')throw invalid();
  const digest=hash();let count=0;
  for await(const bytes of stream){checkSignal(signal);count+=bytes.length;if(count>source.bytes)throw invalid();digest.update(bytes);}
  if(count!==source.bytes||digest.digest('hex')!==source.sha256)throw invalid();
}
async function *lines(stream,signal){
  let pieces=[],length=0;
  for await(const raw of stream){checkSignal(signal);const chunk=Buffer.isBuffer(raw)?raw:Buffer.from(raw);let start=0,index;
    while((index=chunk.indexOf(10,start))>=0){const piece=chunk.subarray(start,index);pieces.push(piece);length+=piece.length;if(length>WORKBOOK_LIMITS.maxPartBytes)throw invalid();const bytes=Buffer.concat(pieces,length);if(!bytes.length||!isUtf8(bytes))throw invalid();yield bytes.toString('utf8');pieces=[];length=0;start=index+1;}
    if(start<chunk.length){pieces.push(chunk.subarray(start));length+=chunk.length-start;if(length>WORKBOOK_LIMITS.maxPartBytes)throw invalid();}
  }
  if(length)throw invalid();
}

/** Bounded row streaming; only identity/scope sets and the current row are retained. */
export async function createRegisterReportCapture({root,jobId,header,rows,maxBytes,signal,storageLimits=storageAdmissionLimits(),checkSpace=checkObjectStorageSpace}={}){
  if(typeof root!=='string'||!uuid.test(jobId||'')||!object(header)||!Number.isSafeInteger(maxBytes)||maxBytes<1||!rows||typeof rows[Symbol.asyncIterator]!=='function'&&typeof rows[Symbol.iterator]!=='function')throw invalid();
  checkSignal(signal);const safeHeader=safeJson(header),asOf=safeHeader.dataAsOf||safeHeader.asOf||new Date().toISOString();if(typeof asOf!=='string'||Number.isNaN(Date.parse(asOf)))throw invalid();safeHeader.dataAsOf=asOf;
  await fs.mkdir(root,{recursive:true,mode:0o700});const realRoot=await fs.realpath(root),base=path.join(realRoot,'.register-report-preparations');await fs.mkdir(base,{recursive:true,mode:0o700});if(path.resolve(await fs.realpath(base))!==path.resolve(base))throw invalid();
  const directory=path.join(base,`capture-${jobId}-${randomUUID()}`);await fs.mkdir(directory,{mode:0o700});const sourcePath=path.join(directory,'source.ndjson.gz');let cleaned=false;
  const cleanup=async()=>{if(cleaned)return;try{await guardedDirectory(directory);if(!contained(base,directory))throw invalid();await fs.rm(directory,{recursive:true,force:true});cleaned=true;}catch(error){if(error.code==='ENOENT'){cleaned=true;return;}throw error;}};
  try{
    // Spooling has the same free-space reserve as publishing stored objects.
    // Admit the configured compressed bound before creating a partial file.
    await checkSpace(directory,maxBytes,{limits:storageLimits});checkSignal(signal);
    const digest=hash(),scope=scopes(),ids=new Set();let rowCount=0,capture;
    async function *records(){
      yield line({type:'header',formatVersion:1,header:safeHeader});
      for await(const input of rows){checkSignal(signal);const row=validateRow(input),id=row.key.kind+':'+row.key.id;if(ids.has(id))throw invalid();ids.add(id);const serialized=canonicalRegisterReportJson(row)+'\n';digest.update(serialized);addScope(scope,row.values);rowCount++;yield line({type:'row',...row});}
      checkSignal(signal);capture={asOf,rowCount,rowHash:digest.digest('hex'),scope:finishScope(scope)};yield line({type:'footer',capture});
    }
    const compressedHash=hash();let bytes=0;
    const bound=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;if(bytes>maxBytes)return done(failure('REGISTER_REPORT_SOURCE_TOO_LARGE',`Compressed report source exceeds the configured ${maxBytes}-byte object limit. No report was issued or rows omitted.`,413));compressedHash.update(chunk);done(null,chunk);}});
    await pipeline(Readable.from(records()),createGzip(),bound,createWriteStream(sourcePath,{flags:'wx',mode:0o600}),...(signal?[{signal}]:[]));
    checkSignal(signal);const file=await fs.open(sourcePath,'r+');try{await file.sync();}finally{await file.close();}
    return {directory,source:{path:sourcePath,sha256:compressedHash.digest('hex'),bytes},capture,cleanup};
  }catch(error){await cleanup();if(signal?.aborted)throw abort();throw error;}
}

/** All entries must be consumed: the footer is yielded only after full verification. */
export async function *readRegisterReportCapture(source,{directory,signal}={}){
  checkSignal(signal);if(!object(source)||!Number.isSafeInteger(source.bytes)||source.bytes<1||!/^[a-f0-9]{64}$/.test(source.sha256))throw invalid();
  let raw;
  if(Buffer.isBuffer(source.buffer)||source.buffer instanceof Uint8Array){const bytes=Buffer.from(source.buffer.buffer,source.buffer.byteOffset,source.buffer.byteLength);if(bytes.length!==source.bytes||hash().update(bytes).digest('hex')!==source.sha256)throw invalid();raw=Readable.from([bytes]);}
  else if(typeof source.open==='function'){
    // A trusted internal stream factory permits integrity/backup checks against
    // immutable object storage without materializing a complete source Buffer.
    // HTTP/worker JSON cannot supply a function. Each pass is hash-checked.
    await verifyCompressedStream(await source.open(),source,signal);checkSignal(signal);raw=await source.open();
  }
  else{
    await guardedDirectory(directory);if(typeof source.path!=='string'||path.resolve(source.path)!==path.join(directory,'source.ndjson.gz')||!contained(directory,path.resolve(source.path)))throw invalid();
    let stat;try{stat=await fs.lstat(source.path);}catch{throw invalid();}if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==source.bytes)throw invalid();
    await verifyCompressedStream(createReadStream(source.path),source,signal);raw=createReadStream(source.path);
  }
  const checked=sourceCounter(source),expanded=createGunzip(),pending=pipeline(raw,checked,expanded,...(signal?[{signal}]:[]));pending.catch(()=>{});
  const digest=hash(),scope=scopes(),ids=new Set();let header=null,footer=null,rowCount=0,complete=false;
  try{
    for await(const text of lines(expanded,signal)){
      let entry;try{entry=JSON.parse(text);}catch{throw invalid();}if(!object(entry)||footer)throw invalid();
      if(!header){if(entry.type!=='header'||entry.formatVersion!==1||!object(entry.header)||Object.keys(entry).sort().join(',')!=='formatVersion,header,type')throw invalid();safeJson(entry.header);header=entry;yield entry;continue;}
      if(entry.type==='row'){
        if(Object.keys(entry).sort().join(',')!=='key,type,values')throw invalid();const row=validateRow({key:entry.key,values:entry.values}),id=row.key.kind+':'+row.key.id;if(ids.has(id))throw invalid();ids.add(id);rowCount++;digest.update(canonicalRegisterReportJson(row)+'\n');addScope(scope,row.values);yield {type:'row',...row};
      }else if(entry.type==='footer'&&Object.keys(entry).sort().join(',')==='capture,type')footer=entry;
      else throw invalid();
    }
    await pending;checkSignal(signal);
    if(!header||!footer||!object(footer.capture)||Object.keys(footer.capture).sort().join(',')!=='asOf,rowCount,rowHash,scope')throw invalid();
    const expected={asOf:header.header.dataAsOf||header.header.asOf||footer.capture.asOf,rowCount,rowHash:digest.digest('hex'),scope:finishScope(scope)};
    if(typeof expected.asOf!=='string'||Number.isNaN(Date.parse(expected.asOf))||canonicalRegisterReportJson(footer.capture)!==canonicalRegisterReportJson(expected))throw invalid();
    complete=true;yield footer;
  }catch(error){if(signal?.aborted)throw abort();if(error.code?.startsWith('REGISTER_REPORT_'))throw error;throw invalid();}
  finally{raw.destroy();checked.destroy();expanded.destroy();await pending.catch(()=>{});if(!complete&&signal?.aborted)checkSignal(signal);}
}
