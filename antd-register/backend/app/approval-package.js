import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import {roundValue} from './exchange-scope.js';

const MiB=1024*1024;
export const approvalPackageLimits=Object.freeze({maxOutputBytes:30*MiB,maxSourceBytes:64*MiB,maxAttachments:100,maxNativeFiles:100,maxEntries:201,maxManifestBytes:MiB});
const hardLimits=Object.freeze({maxOutputBytes:128*MiB,maxSourceBytes:128*MiB,maxAttachments:999,maxNativeFiles:999,maxEntries:1000,maxManifestBytes:4*MiB});
const XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const scopeFields=['orderNos','suppliers','productDecimalNos','proposalIds'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
export const approvalPackageMetadataDigest=metadata=>hash(JSON.stringify(stable(metadata)));
export class ApprovalPackageError extends Error {
  constructor(code,message,details=[]){super(message);this.name='ApprovalPackageError';this.status=422;this.code=code;this.details=details;}
}
const fail=(code,message,details=[])=>{throw new ApprovalPackageError(code,message,details);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function text(value,label,{optional=false,max=512}={}) {
  if(optional&&(value===undefined||value===null||value===''))return null;
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail('APPROVAL_PACKAGE_METADATA_INVALID',`${label} must be nonempty text of at most ${max} characters without control characters.`);
  return value;
}
function positive(value,label,{optional=false}={}) {
  if(optional&&(value===undefined||value===null||value===''))return null;
  if(typeof value==='string'&&/^\d+$/.test(value))value=Number(value);
  if(!Number.isSafeInteger(value)||value<1)fail('APPROVAL_PACKAGE_METADATA_INVALID',`${label} must be a positive integer.`);
  return value;
}
function timestamp(value,label) {
  const result=text(value,label,{max:64});
  if(!/^\d{4}-\d\d-\d\dT/.test(result)||!Number.isFinite(Date.parse(result)))fail('APPROVAL_PACKAGE_METADATA_INVALID',`${label} must be an ISO date and time.`);
  return result;
}
function limitsFor(input={}) {
  if(!object(input))fail('APPROVAL_PACKAGE_LIMIT_INVALID','Package limits must be an object.');
  for(const key of Object.keys(input))if(!Object.hasOwn(hardLimits,key))fail('APPROVAL_PACKAGE_LIMIT_INVALID',`Unknown package limit: ${key}.`);
  const result={...approvalPackageLimits,...input};
  for(const [key,value] of Object.entries(result))if(!Number.isSafeInteger(value)||value<1||value>hardLimits[key])fail('APPROVAL_PACKAGE_LIMIT_INVALID',`${key} must be a positive integer no greater than ${hardLimits[key]}.`);
  return result;
}
const compare=(left,right)=>left<right?-1:left>right?1:0;
const unique=values=>[...new Set(values)].sort(compare);
const scopeFor=rows=>({orderNos:unique(rows.map(row=>row.orderNo)),suppliers:unique(rows.map(row=>row.supplier)),productDecimalNos:unique(rows.map(row=>row.productDecimalNo)),proposalIds:unique(rows.map(row=>row.proposalId))});
function rowsFor(input) {
  if(!Array.isArray(input)||!input.length||input.length>10000)fail('APPROVAL_PACKAGE_SCOPE_INVALID','Provide between 1 and 10,000 explicitly exported proposal rows.');
  const seen=new Set();
  return input.map(row=>{
    if(!object(row))fail('APPROVAL_PACKAGE_SCOPE_INVALID','Every exported row must be an object.');
    const result=Object.fromEntries(['proposalId','orderNo','supplier','productDecimalNo'].map(key=>[key,text(row[key],`Exported row ${key}`)]));
    if(seen.has(result.proposalId))fail('APPROVAL_PACKAGE_SCOPE_INVALID','Exported proposal IDs must be unique.',[result.proposalId]);seen.add(result.proposalId);
    if(row.rowVersion!==undefined)result.rowVersion=positive(row.rowVersion,'Exported row version');
    return result;
  }).sort((a,b)=>compare(a.proposalId,b.proposalId));
}
function selectedScope(value,allRows,label) {
  if(!object(value)||Object.keys(value).some(key=>!scopeFields.includes(key)))fail('APPROVAL_PACKAGE_SCOPE_INVALID',`${label} must contain only orderNos, suppliers, productDecimalNos and proposalIds.`);
  const normalized={};
  for(const key of scopeFields){
    if(!Array.isArray(value[key])||!value[key].length||value[key].length>10000)fail('APPROVAL_PACKAGE_SCOPE_INVALID',`${label}.${key} must be a nonempty bounded array.`);
    normalized[key]=unique(value[key].map(item=>text(item,`${label}.${key}`)));
  }
  const selected=normalized.proposalIds.map(id=>allRows.get(id));
  if(selected.some(row=>!row))fail('APPROVAL_PACKAGE_SCOPE_INVALID',`${label} contains a proposal outside the exported rows.`);
  const expected=scopeFor(selected);
  for(const key of scopeFields)if(JSON.stringify(normalized[key])!==JSON.stringify(expected[key]))fail('APPROVAL_PACKAGE_SCOPE_INVALID',`${label}.${key} does not match its explicitly linked exported proposals.`);
  return normalized;
}
/** A single relative filename segment; Cyrillic and other Unicode letters survive. */
export function approvalPackageFilename(value,fallback='file') {
  const raw=text(value,'File name',{max:512});
  let name=raw.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/\s+/g,' ').trim().replace(/^[. ]+|[. ]+$/g,'');
  if(!name)name=fallback;
  if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
  if([...name].length>160){const extension=name.match(/\.[^.]{1,12}$/)?.[0]||'';name=[...name.slice(0,name.length-extension.length)].slice(0,160-[...extension].length).join('')+extension;}
  return name;
}
function view(value,label) {
  if(Buffer.isBuffer(value))return value;
  if(value instanceof Uint8Array)return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(value instanceof ArrayBuffer)return Buffer.from(value);
  fail('APPROVAL_PACKAGE_BYTES_INVALID',`${label} must contain a Buffer, Uint8Array or ArrayBuffer.`);
}
function digestFor(value,label) {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))fail('APPROVAL_PACKAGE_DIGEST_INVALID',`${label} must contain a SHA-256 digest.`);
  return value.toLowerCase();
}
function provenanceFor(value,rows) {
  if(!object(value))fail('APPROVAL_PACKAGE_METADATA_INVALID','Export provenance must be an object.');
  const result={asOf:timestamp(value.asOf,'Export asOf')};
  for(const key of ['applicationHash','sourceSha256','referenceHash','historyHash','snapshotHash'])if(value[key]!==undefined&&value[key]!==null)result[key]=digestFor(value[key],`Provenance ${key}`);
  if(value.referenceRevision!==undefined&&value.referenceRevision!==null)result.referenceRevision=positive(value.referenceRevision,'Reference revision');
  if(value.snapshotRef!==undefined&&value.snapshotRef!==null)result.snapshotRef=text(value.snapshotRef,'Snapshot reference');
  if(value.proposalVersions!==undefined){
    if(!Array.isArray(value.proposalVersions)||value.proposalVersions.length>10000)fail('APPROVAL_PACKAGE_METADATA_INVALID','Provenance proposalVersions must be a bounded array.');
    const byId=new Map(rows.map(row=>[row.proposalId,row])),seen=new Set();
    result.proposalVersions=value.proposalVersions.filter(item=>object(item)&&byId.has(item.proposalId)).map(item=>{
      if(seen.has(item.proposalId))fail('APPROVAL_PACKAGE_METADATA_INVALID','Provenance proposal versions must be unique.');seen.add(item.proposalId);
      const row=byId.get(item.proposalId),version=positive(item.rowVersion,'Provenance proposal version');
      if(row.rowVersion!==undefined&&row.rowVersion!==version)fail('APPROVAL_PACKAGE_METADATA_INVALID','Provenance proposal version differs from the exported row.',[row.proposalId]);
      return {proposalId:row.proposalId,rowVersion:version};
    }).sort((a,b)=>compare(a.proposalId,b.proposalId));
  }
  return result;
}
function metadataFor(item) {
  const value=item.attachmentMetadata;
  if(!object(value)||!['Supplier_Datasheet','Client_Datasheet'].includes(value.attachmentRole)||value.confidentiality!=='ORDER_PARTICIPANTS'||!['ADMINISTRATOR','SUPPLIER','CLIENT'].includes(value.source)||item.ownerOnly===true||(item.kind!==undefined&&item.kind!=='ATTACHMENT'))fail('APPROVAL_PACKAGE_ATTACHMENT_POLICY','Only classified supplier/client datasheets shared with order participants may be selected.',[String(item.artifactId||'Unknown attachment')]);
  if(value.source!=='ADMINISTRATOR'&&value.attachmentRole!==(value.source==='SUPPLIER'?'Supplier_Datasheet':'Client_Datasheet'))fail('APPROVAL_PACKAGE_ATTACHMENT_POLICY','Attachment source and datasheet role do not match.');
  if(typeof value.description!=='string'||value.description.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.description))fail('APPROVAL_PACKAGE_METADATA_INVALID','Attachment description is invalid.');
  const allowed=['attachmentRole','source','description','confidentiality','supersedesArtifactId'];
  if(Object.keys(value).some(key=>!allowed.includes(key)))fail('APPROVAL_PACKAGE_ATTACHMENT_POLICY','Attachment classification contains unsupported policy fields.');
  const metadata={attachmentRole:value.attachmentRole,source:value.source,description:value.description,confidentiality:value.confidentiality,supersedesArtifactId:text(value.supersedesArtifactId,'Superseded attachment ID',{optional:true,max:128})};
  // A missing supersedes field is legacy/unknown metadata, not a current typed record.
  if(!Object.hasOwn(value,'supersedesArtifactId'))fail('APPROVAL_PACKAGE_ATTACHMENT_POLICY','Attachment version metadata is incomplete.');
  const sha256=approvalPackageMetadataDigest(metadata);
  if(item.attachmentMetadataSha256!==undefined&&digestFor(item.attachmentMetadataSha256,'Attachment metadata hash')!==sha256)fail('APPROVAL_PACKAGE_METADATA_CHANGED','The attachment classification changed after capture.',[String(item.artifactId)]);
  return {metadata,sha256};
}
// Count the bounded metadata tree before creating its serialized string. Strings
// are individually bounded and repeated scope references count on each occurrence.
function jsonSize(value,limit) {
  let size=0;
  const add=bytes=>{size+=bytes;if(size>limit)fail('APPROVAL_PACKAGE_MANIFEST_LIMIT','The approval package manifest exceeds its byte limit.');};
  const visit=item=>{
    if(Array.isArray(item)){add(2);item.forEach((child,index)=>{if(index)add(1);visit(child);});}
    else if(object(item)){add(2);Object.entries(item).forEach(([key,child],index)=>{if(index)add(1);add(Buffer.byteLength(JSON.stringify(key))+1);visit(child);});}
    else add(Buffer.byteLength(JSON.stringify(item)));
  };
  visit(value);return size;
}

/**
 * Pure optional outer package for native M03/M06 workbooks. No repository reads,
 * access checks, antivirus scans, persistence, workbook parsing or byte rewriting.
 * Caller selects authorized current chain heads at preparation, then rechecks the
 * frozen artifact identity, access, metadata and CLEAN status at issue/download.
 * A later replacement does not invalidate access to the exact reviewed version.
 */
export async function buildApprovalPackage(input,configuredLimits={}) {
  const limits=limitsFor(configuredLimits);
  if(!object(input)||!['M03','M06'].includes(input.moduleId))fail('APPROVAL_PACKAGE_MODULE_INVALID','Approval packages are supported only for M03 and M06.');
  const {moduleId}=input,version=positive(input.version,'Export version'),round=moduleId==='M06'&&(input.round===undefined||input.round===null)?null:roundValue(input),rows=rowsFor(input.exportedRows),rowMap=new Map(rows.map(row=>[row.proposalId,row])),scope=scopeFor(rows);
  if(round!==null&&round.length>1000)fail('APPROVAL_PACKAGE_METADATA_INVALID','Approval round must contain at most 1,000 characters.');
  const provenance=provenanceFor(input.provenance,rows);
  const defaultName=`${moduleId}_Approval${round===null?'':`_R${round}`}_Docs`;
  const filename=(input.filename===undefined?defaultName:approvalPackageFilename(input.filename).replace(/\.zip$/i,'')).replace(/(?:_v\d+)+$/i,'')+`_v${version}.zip`;
  if(!Array.isArray(input.nativeFiles)||!input.nativeFiles.length||input.nativeFiles.length>limits.maxNativeFiles)fail('APPROVAL_PACKAGE_COUNT_LIMIT',`Provide 1 to ${limits.maxNativeFiles} native workbooks.`);
  if(!Array.isArray(input.attachments)||input.attachments.length>limits.maxAttachments)fail('APPROVAL_PACKAGE_COUNT_LIMIT',`Select no more than ${limits.maxAttachments} attachments.`);
  if(input.nativeFiles.length+input.attachments.length+1>limits.maxEntries)fail('APPROVAL_PACKAGE_COUNT_LIMIT','The package exceeds the archive entry limit.');
  // Check aggregate source size before any byte copies, hashing or ZIP allocation.
  let sourceBytes=0;
  const originals=[...input.nativeFiles,...input.attachments].map((item,index)=>{
    if(!object(item))fail('APPROVAL_PACKAGE_METADATA_INVALID','Every selected file must be an object.');
    const buffer=view(item.buffer,`Selected file ${index+1}`);sourceBytes+=buffer.length;
    if(!buffer.length)fail('APPROVAL_PACKAGE_BYTES_INVALID','Selected files cannot be empty.');
    if(sourceBytes>limits.maxSourceBytes)fail('APPROVAL_PACKAGE_SOURCE_LIMIT','Selected files exceed the aggregate source byte limit.');
    return buffer;
  });
  if(sourceBytes>limits.maxOutputBytes)fail('APPROVAL_PACKAGE_OUTPUT_LIMIT','The approval package exceeds the output byte limit.');
  const nativeFiles=input.nativeFiles.map((item,index)=>{
    const filename=approvalPackageFilename(item.filename),contentType=item.contentType||XLSX;
    if(!/\.xlsx$/i.test(filename)||contentType!==XLSX)fail('APPROVAL_PACKAGE_NATIVE_INVALID','Pass native XLSX leaf workbooks, rather than an existing outer ZIP.');
    let fileScope=scope;
    if(item.scopeRows!==undefined){const nativeRows=rowsFor(item.scopeRows);for(const row of nativeRows){const original=rowMap.get(row.proposalId);if(!original||['orderNo','supplier','productDecimalNo'].some(key=>original[key]!==row[key]))fail('APPROVAL_PACKAGE_SCOPE_INVALID','A native workbook contains rows outside the exported scope.');}fileScope=scopeFor(nativeRows);}
    if(item.scope!==undefined){const explicit=selectedScope(item.scope,rowMap,'Native workbook scope');if(item.scopeRows!==undefined&&JSON.stringify(explicit)!==JSON.stringify(fileScope))fail('APPROVAL_PACKAGE_SCOPE_INVALID','Native workbook scope and scopeRows differ.');fileScope=explicit;}
    const buffer=Buffer.from(originals[index]),sha256=hash(buffer);
    if((item.sha256!==undefined&&digestFor(item.sha256,'Native workbook hash')!==sha256)||(item.bytes!==undefined&&item.bytes!==buffer.length))fail('APPROVAL_PACKAGE_BYTES_CHANGED','Native workbook bytes differ from the captured identity.');
    return {filename,originalFilename:item.filename,contentType,scope:fileScope,buffer,sha256,bytes:buffer.length};
  }).sort((a,b)=>compare(a.filename,b.filename)||compare(a.sha256,b.sha256)||compare(JSON.stringify(a.scope),JSON.stringify(b.scope)));
  const artifactIds=new Set(),logicalKeys=new Set();
  const attachments=input.attachments.map((item,index)=>{
    const artifactId=text(item.artifactId,'Attachment artifact ID',{max:128});
    if(artifactIds.has(artifactId))fail('APPROVAL_PACKAGE_DUPLICATE_ATTACHMENT','Select each attachment artifact only once.',[artifactId]);artifactIds.add(artifactId);
    if(item.logicalKey!==undefined){const logicalKey=text(item.logicalKey,'Attachment logical key',{max:2048});if(logicalKeys.has(logicalKey))fail('APPROVAL_PACKAGE_DUPLICATE_ATTACHMENT','Only one current version of each attachment may be selected.');logicalKeys.add(logicalKey);}
    if(item.scanStatus!=='CLEAN')fail('APPROVAL_PACKAGE_ATTACHMENT_NOT_CLEAN','Every selected attachment must have a captured CLEAN scan status.',[artifactId]);
    const classification=metadataFor(item),attachmentScope=selectedScope(item.scope,rowMap,'Attachment scope'),buffer=Buffer.from(originals[input.nativeFiles.length+index]),sha256=hash(buffer);
    if(!Number.isSafeInteger(item.bytes)||item.bytes!==buffer.length||digestFor(item.sha256,'Attachment hash')!==sha256)fail('APPROVAL_PACKAGE_BYTES_CHANGED','Attachment bytes differ from the captured artifact identity.',[artifactId]);
    return {artifactId,version:positive(item.version,'Attachment version'),filename:approvalPackageFilename(item.filename),originalFilename:item.filename,contentType:text(item.contentType,'Attachment content type',{max:250}),scope:attachmentScope,buffer,sha256,bytes:buffer.length,attachmentMetadata:classification.metadata,attachmentMetadataSha256:classification.sha256,ownerActor:text(item.ownerActor,'Attachment owner actor',{max:240}),createdAt:timestamp(item.createdAt,'Attachment createdAt')};
  }).sort((a,b)=>compare(a.filename,b.filename)||compare(a.artifactId,b.artifactId));
  // Detect a selected ancestor even when a caller omits logicalKey.
  for(const item of attachments)if(artifactIds.has(item.attachmentMetadata.supersedesArtifactId))fail('APPROVAL_PACKAGE_DUPLICATE_ATTACHMENT','The package cannot include an attachment and its superseded ancestor.');
  nativeFiles.forEach((item,index)=>{item.path=`native/${String(index+1).padStart(3,'0')}_${item.filename}`;});
  attachments.forEach((item,index)=>{item.path=`attachments/${String(index+1).padStart(3,'0')}_v${item.version}_${item.filename}`;});
  const publicFile=({buffer,...item})=>item;
  const manifest={formatVersion:1,moduleId,version,round,asOf:provenance.asOf,provenance,scope,exportedRows:rows,nativeFiles:nativeFiles.map(publicFile),attachments:attachments.map(publicFile),perProposal:[]};
  let manifestSize=jsonSize(manifest,limits.maxManifestBytes);
  for(const row of rows){
    const entry={proposalId:row.proposalId,nativeFiles:nativeFiles.filter(item=>item.scope.proposalIds.includes(row.proposalId)).map(item=>({path:item.path,sha256:item.sha256})),attachments:attachments.filter(item=>item.scope.proposalIds.includes(row.proposalId)).map(item=>({artifactId:item.artifactId,version:item.version,path:item.path,sha256:item.sha256,attachmentMetadataSha256:item.attachmentMetadataSha256}))};
    if(!entry.nativeFiles.length)fail('APPROVAL_PACKAGE_SCOPE_INVALID','Every exported proposal must occur in at least one selected native workbook.');
    manifestSize+=jsonSize(entry,limits.maxManifestBytes)+(manifest.perProposal.length?1:0);
    if(manifestSize>limits.maxManifestBytes)fail('APPROVAL_PACKAGE_MANIFEST_LIMIT','The approval package manifest exceeds its byte limit.');
    manifest.perProposal.push(entry);
  }
  const manifestBuffer=Buffer.from(JSON.stringify(manifest));
  // STORE preserves bytes without attempting to recompress already compressed Office files.
  // Fail before constructing JSZip if even the uncompressed payload cannot fit.
  if(sourceBytes+manifestBuffer.length>limits.maxOutputBytes)fail('APPROVAL_PACKAGE_OUTPUT_LIMIT','The approval package exceeds the output byte limit.');
  const zip=new JSZip(),options={date:new Date('1980-01-01T00:00:00Z'),createFolders:false,binary:true,compression:'STORE'};
  zip.file('manifest.json',manifestBuffer,options);
  for(const item of [...nativeFiles,...attachments])zip.file(item.path,item.buffer,options);
  const chunks=[];let outputBytes=0;
  const stream=zip.generateNodeStream({type:'nodebuffer',streamFiles:true,compression:'STORE',platform:'DOS'});
  // JSZip uses readable-stream v2, which has no Symbol.asyncIterator.
  await new Promise((resolve,reject)=>{
    let settled=false;
    stream.on('error',()=>{if(!settled){settled=true;reject(new ApprovalPackageError('APPROVAL_PACKAGE_GENERATION_FAILED','The approval archive could not be generated.'));}});
    stream.on('data',chunk=>{
      if(settled)return;
      outputBytes+=chunk.length;
      if(outputBytes>limits.maxOutputBytes){settled=true;stream.pause();stream.destroy();reject(new ApprovalPackageError('APPROVAL_PACKAGE_OUTPUT_LIMIT','The approval package exceeds the output byte limit.'));return;}
      chunks.push(chunk);
    });
    stream.on('end',()=>{if(!settled){settled=true;resolve();}});
  });
  return {filename,contentType:'application/zip',buffer:Buffer.concat(chunks,outputBytes),manifest};
}
