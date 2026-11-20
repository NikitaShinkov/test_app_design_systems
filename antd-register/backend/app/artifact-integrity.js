import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value??null);
const sameAttachmentMetadata=(left,right)=>canonical(left??null)===canonical(right??null);

export async function verifyAttachmentSchema(client){
  const column=(await client.query("select udt_name from information_schema.columns where table_schema='replacement_register' and table_name='artifacts' and column_name='attachment_json'")).rows[0];
  const constraint=(await client.query("select 1 from pg_constraint where conrelid='replacement_register.artifacts'::regclass and conname='artifact_attachment_metadata' and contype='c' and convalidated")).rowCount>0;
  const trigger=(await client.query("select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid='replacement_register.artifacts'::regclass and t.tgname='attachment_metadata_immutable' and not t.tgisinternal and t.tgenabled in ('O','A') and (t.tgtype & 19)=19 and n.nspname='replacement_register' and p.proname='protect_attachment_metadata'")).rowCount>0;
  const missing=[];if(column?.udt_name!=='jsonb')missing.push('artifacts.attachment_json jsonb');if(!constraint)missing.push('validated artifact_attachment_metadata CHECK');if(!trigger)missing.push('enabled attachment_metadata_immutable trigger');return {ok:missing.length===0,missing};
}

export function verifyAttachmentReferences(artifacts){
  const errors=[],records=new Map(),children=new Map(),versions=new Map(),minimumVersions=new Map();
  const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value),uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const scope=value=>object(value)&&['orderNos','suppliers','productDecimalNos','proposalIds'].every(key=>Array.isArray(value[key])&&value[key].every(item=>typeof item==='string'));
  const required=['attachmentRole','source','description','confidentiality','supersedesArtifactId'];
  const add=(item,code,error)=>errors.push({artifactId:item.artifactId,code,error});
  for(const item of artifacts){if(records.has(item.artifactId))add(item,'ATTACHMENT_DUPLICATE_ID','Retained artifact IDs are ambiguous.');records.set(item.artifactId,item);if(item.kind==='ATTACHMENT'&&typeof item.logicalKey==='string'&&Number.isSafeInteger(item.version))minimumVersions.set(item.logicalKey,Math.min(minimumVersions.get(item.logicalKey)??Infinity,item.version));}
  for(const item of artifacts){
    const metadata=item.attachmentMetadata;
    if(item.kind==='ATTACHMENT'&&typeof item.logicalKey==='string'&&Number.isSafeInteger(item.version)){
      const identity=JSON.stringify([item.logicalKey,item.version]);if(versions.has(identity))add(item,'ATTACHMENT_DUPLICATE_VERSION','Attachment logical key/version is duplicated.');else versions.set(identity,item.artifactId);
    }
    if(metadata===null||metadata===undefined)continue;
    if(item.kind!=='ATTACHMENT'||item.moduleId!==null){add(item,'ATTACHMENT_METADATA_KIND','Attachment metadata must belong to a module-free ordinary attachment.');continue;}
    if(!object(metadata)||Object.keys(metadata).length!==required.length||!required.every(key=>Object.hasOwn(metadata,key))||!['Supplier_Datasheet','Client_Datasheet','Supporting_Document'].includes(metadata.attachmentRole)||!['ADMINISTRATOR','SUPPLIER','CLIENT'].includes(metadata.source)||typeof metadata.description!=='string'||metadata.description.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(metadata.description)||!['ORDER_PARTICIPANTS','ADMINISTRATORS'].includes(metadata.confidentiality)||!(metadata.supersedesArtifactId===null||uuid(metadata.supersedesArtifactId))){add(item,'ATTACHMENT_METADATA_INVALID','Attachment metadata has an invalid shape, role, source, description, confidentiality or parent ID.');continue;}
    if((metadata.source==='SUPPLIER'&&metadata.attachmentRole!=='Supplier_Datasheet')||(metadata.source==='CLIENT'&&metadata.attachmentRole!=='Client_Datasheet')||(metadata.confidentiality==='ADMINISTRATORS'&&metadata.source!=='ADMINISTRATOR'))add(item,'ATTACHMENT_SOURCE_POLICY','Attachment role or confidentiality conflicts with its recorded source actor role.');
    if(!uuid(item.artifactId)||!Number.isSafeInteger(item.version)||item.version<1||typeof item.logicalKey!=='string'||!item.logicalKey||!scope(item.scope))add(item,'ATTACHMENT_VERSION_INVALID','Typed attachment requires an exact artifact ID, positive version, logical key and complete scope.');
    const parentId=metadata.supersedesArtifactId;if(parentId===null){if(minimumVersions.get(item.logicalKey)<item.version)add(item,'ATTACHMENT_PARENT_MISSING','A typed attachment version must identify the preceding retained version in its logical chain.');continue;}
    const siblings=children.get(parentId)||[];siblings.push(item);children.set(parentId,siblings);
    const parent=records.get(parentId);
    if(!parent||parentId===item.artifactId||parent.kind!=='ATTACHMENT'||parent.moduleId!==null){add(item,'ATTACHMENT_PARENT_INVALID','Superseded attachment is missing, self-referential or not an ordinary attachment.');continue;}
    if(parent.logicalKey!==item.logicalKey||!scope(parent.scope)||canonical(parent.scope)!==canonical(item.scope)||!Number.isSafeInteger(parent.version)||item.version!==parent.version+1)add(item,'ATTACHMENT_PARENT_SCOPE','Supersession must retain the logical key and proposal/order scope and advance the immediately preceding integer version.');
    if(parent.attachmentMetadata&&(parent.attachmentMetadata.attachmentRole!==metadata.attachmentRole||parent.attachmentMetadata.confidentiality!==metadata.confidentiality))add(item,'ATTACHMENT_PARENT_POLICY','Supersession must retain its recorded attachment role and confidentiality.');
  }
  for(const siblings of children.values())if(siblings.length>1)for(const item of siblings)add(item,'ATTACHMENT_BRANCH','One retained attachment has multiple superseding versions; the linear chain is ambiguous.');
  // Iterative walks keep a long legitimate chain from exhausting the JS stack.
  const done=new Set();for(const item of artifacts){const seen=new Set();let current=item;while(current&&!done.has(current.artifactId)){
    if(seen.has(current.artifactId)){add(item,'ATTACHMENT_CYCLE','Attachment supersession contains a cycle.');break;}seen.add(current.artifactId);const parent=current.attachmentMetadata?.supersedesArtifactId;current=typeof parent==='string'?records.get(parent):null;
  }for(const id of seen)done.add(id);}
  return errors;
}

export function verifyExportReferences(artifacts,exports){
  const records=new Map(artifacts.map(item=>[item.artifactId,item])),errors=[];
  const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value),metadataHash=value=>createHash('sha256').update(canonical(value??null)).digest('hex');
  for(const job of exports){
    const add=(code,error)=>errors.push({artifactId:`export:${job.job_id}`,code,error}),inputs=job.inputs??[],indexed=new Map();
    if(!Array.isArray(inputs)){add('EXPORT_INPUT_INVALID','Saved export inputs are not an array.');continue;}
    for(const input of inputs){
      if(!object(input)){add('EXPORT_INPUT_INVALID','A saved export input is malformed.');continue;}indexed.set(input.artifactId,input);const actual=records.get(input.artifactId);
      if(!actual||actual.sha256!==input.sha256||(Object.hasOwn(input,'bytes')&&actual.bytes!==input.bytes))add('EXPORT_INPUT_MISSING','Saved export input bytes or identity are missing or inconsistent.');
      if(Object.hasOwn(input,'attachmentMetadataHash')&&(!/^[a-f0-9]{64}$/.test(input.attachmentMetadataHash||'')||actual?.kind!=='ATTACHMENT'||metadataHash(actual.attachmentMetadata)!==input.attachmentMetadataHash))add('EXPORT_ATTACHMENT_METADATA','Packaged attachment metadata differs from its frozen input hash.');
    }
    const manifest=job.attachmentManifest;if(manifest===null||manifest===undefined)continue;
    if(!object(manifest)||manifest.formatVersion!==1||!['M03','M06'].includes(manifest.moduleId)||(job.moduleId&&manifest.moduleId!==job.moduleId)||!Array.isArray(manifest.attachments)){add('EXPORT_ATTACHMENT_MANIFEST','The approval attachment manifest is malformed.');continue;}
    const listed=new Map();
    for(const entry of manifest.attachments){
      if(!object(entry)){add('EXPORT_ATTACHMENT_MANIFEST','An approval manifest attachment is malformed.');continue;}
      const actual=records.get(entry.artifactId),input=indexed.get(entry.artifactId);if(listed.has(entry.artifactId))add('EXPORT_ATTACHMENT_MANIFEST','An approval manifest lists one attachment more than once.');listed.set(entry.artifactId,entry);
      if(!actual||actual.kind!=='ATTACHMENT'||!input?.attachmentMetadataHash||entry.sha256!==actual.sha256||entry.bytes!==actual.bytes||entry.version!==actual.version||!sameAttachmentMetadata(entry.attachmentMetadata,actual.attachmentMetadata)||entry.attachmentMetadataSha256!==metadataHash(actual.attachmentMetadata)||entry.attachmentMetadataSha256!==input.attachmentMetadataHash||canonical(entry.scope)!==canonical(actual.scope)||actual.attachmentMetadata?.confidentiality!=='ORDER_PARTICIPANTS'||!['Supplier_Datasheet','Client_Datasheet'].includes(actual.attachmentMetadata?.attachmentRole))add('EXPORT_ATTACHMENT_MANIFEST','A packaged datasheet does not match its retained version, scope, immutable metadata or public datasheet policy.');
    }
    for(const input of indexed.values())if(Object.hasOwn(input,'attachmentMetadataHash')&&!listed.has(input.artifactId))add('EXPORT_ATTACHMENT_MANIFEST','A frozen datasheet input is absent from the approval manifest.');
    if(manifest.perProposal!==undefined){
      if(!Array.isArray(manifest.perProposal))add('EXPORT_ATTACHMENT_MANIFEST','Per-proposal approval associations are malformed.');
      else for(const proposal of manifest.perProposal){if(!object(proposal)||!Array.isArray(proposal.attachments)){add('EXPORT_ATTACHMENT_MANIFEST','A proposal attachment association is malformed.');continue;}for(const entry of proposal.attachments){const captured=object(entry)?listed.get(entry.artifactId):null;if(!captured||captured.version!==entry.version||captured.sha256!==entry.sha256||captured.attachmentMetadataSha256!==entry.attachmentMetadataSha256||!captured.scope?.proposalIds?.includes(proposal.proposalId))add('EXPORT_ATTACHMENT_MANIFEST','A proposal references an attachment outside its captured scope or version.');}}
    }
  }
  return errors;
}

export async function verifyFilePreparationConstraints(client){
  const required=['preparation_kind_module','preparation_file_input','preparation_result_identity'];
  const rows=(await client.query("select conname from pg_constraint where conrelid='replacement_register.preparation_jobs'::regclass and conname=any($1::text[]) and contype='c' and convalidated",[required])).rows;
  const found=new Set(rows.map(row=>row.conname)),missing=required.filter(name=>!found.has(name));return {ok:missing.length===0,required,missing};
}

export async function verifyArtifactStore(root,artifacts) {
  const errors=[];const objects=new Map();let checkedBytes=0;
  for(const item of artifacts) {
    if(!/^[a-f0-9]{64}$/.test(item.sha256)||!Number.isSafeInteger(item.bytes)||item.bytes<1){errors.push({artifactId:item.artifactId,error:'Invalid stored hash or byte count.'});continue;}
    if(objects.has(item.sha256)&&objects.get(item.sha256)!==item.bytes)errors.push({artifactId:item.artifactId,error:'Same content hash has inconsistent byte counts.'});
    objects.set(item.sha256,item.bytes);
  }
  for(const [sha256,bytes] of objects) {
    try {
      const filename=path.join(root,'objects',sha256.slice(0,2),sha256);const stat=await fs.lstat(filename);
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Object must be an ordinary file.');
      if(stat.size!==bytes)throw new Error('Object byte count differs from database metadata.');
      const hash=createHash('sha256');let actual=0;for await(const chunk of createReadStream(filename)){hash.update(chunk);actual+=chunk.length;}
      if(actual!==bytes||hash.digest('hex')!==sha256)throw new Error('Object SHA-256 integrity check failed.');
      checkedBytes+=bytes;
    }catch(error){errors.push({sha256,error:error.code==='ENOENT'?'Object is missing.':error.message});}
  }
  return {ok:errors.length===0,artifacts:artifacts.length,uniqueObjects:objects.size,checkedBytes,errors};
}

export function verifyPreparationReferences(artifacts,exportJobs,preparations,importReviews=[]){
  const errors=[],inputs=new Map(artifacts.map(row=>[row.artifactId,row])),reviews=new Set(exportJobs.map(row=>row.job_id));
  const imports=new Set(importReviews.map(row=>`${row.batch_id}:${row.revision}:${row.payload?.preparedByJobId}`));
  const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
  const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const fileKinds=new Set(['INSPECT','REGISTER_BOM','ATTACHMENT','RESCAN']);
  const sameContent=(item,input)=>Boolean(item)&&item.sha256===input?.sha256&&item.bytes===input?.bytes;
  const attachment=(item,descriptor)=>item?.kind==='ATTACHMENT'&&item.moduleId===null&&Array.isArray(item.scope?.proposalIds)&&item.scope.proposalIds.includes(descriptor.proposalId);
  const fileInput=(descriptor,item)=>object(descriptor.input)&&uuid(descriptor.input.artifactId)&&/^[a-f0-9]{64}$/.test(descriptor.input.sha256||'')&&Number.isSafeInteger(descriptor.input.bytes)&&descriptor.input.bytes>0&&sameContent(item,descriptor.input)&&(
    ['INSPECT','REGISTER_BOM'].includes(descriptor.kind)?descriptor.moduleId==='M01'&&item.kind==='WORKFLOW_INPUT'&&item.moduleId==='M01':
    descriptor.kind==='ATTACHMENT'?descriptor.moduleId===null&&typeof descriptor.proposalId==='string'&&Boolean(descriptor.proposalId)&&attachment(item,descriptor):descriptor.moduleId===null
  );
  const fileResult=job=>{
    const descriptor=job.descriptor,result=job.result;
    if(!object(result)||result.kind!==descriptor.kind||result.preparationId!==job.job_id)return false;
    if(descriptor.kind==='INSPECT')return result.artifactId===descriptor.input.artifactId&&result.sourceArtifactId===descriptor.input.artifactId&&result.sha256===descriptor.input.sha256&&(!Object.hasOwn(result,'bytes')||result.bytes===descriptor.input.bytes)&&typeof result.filename==='string'&&result.filename.length>0&&typeof result.contentType==='string'&&object(result.inspection)&&sameContent(inputs.get(result.artifactId),descriptor.input);
    const snapshot=result.artifact,actual=inputs.get(result.artifactId);
    if(!object(snapshot)||!uuid(result.artifactId)||snapshot.artifactId!==result.artifactId||!sameContent(snapshot,descriptor.input)||!sameContent(actual,descriptor.input)||snapshot.kind!==actual.kind||snapshot.moduleId!==actual.moduleId||!sameAttachmentMetadata(snapshot.attachmentMetadata,actual.attachmentMetadata))return false;
    // Scan verdicts and mutable scope may legitimately change after a frozen
    // completion. Verify retained identity/content, not a stale current verdict.
    if(descriptor.kind==='REGISTER_BOM')return result.sourceArtifactId===descriptor.input.artifactId&&result.artifactId!==descriptor.input.artifactId&&snapshot.kind==='ORIGINAL_BOM'&&snapshot.moduleId==='M01'&&actual.kind==='ORIGINAL_BOM'&&actual.moduleId==='M01';
    if(result.artifactId!==descriptor.input.artifactId)return false;
    return descriptor.kind==='RESCAN'||attachment(snapshot,descriptor)&&attachment(actual,descriptor)&&['CLEAN','ERROR'].includes(snapshot.scanStatus);
  };
  for(const job of preparations){
    if(!job.descriptor||typeof job.descriptor!=='object'||Array.isArray(job.descriptor)){errors.push({artifactId:`preparation:${job.job_id}`,error:'Preparation descriptor is invalid.'});continue;}
    const input=job.descriptor.input;
    if(input){const item=inputs.get(input.artifactId);if(!item||item.sha256!==input.sha256||item.bytes!==input.bytes)errors.push({artifactId:`preparation:${job.job_id}`,error:'Retained preparation input metadata is missing or inconsistent.'});}
    if(fileKinds.has(job.descriptor.kind)&&!fileInput(job.descriptor,inputs.get(input?.artifactId))){errors.push({artifactId:`preparation:${job.job_id}`,error:'Retained file-operation input kind, module, scope or identity is missing or inconsistent.'});continue;}
    if(job.status==='SUCCEEDED'){
      const kind=job.descriptor.kind??'EXPORT';
      const valid=kind==='IMPORT'?job.result?.kind==='IMPORT'&&job.result.preparationId===job.job_id&&job.result.batchId===(job.descriptor.batchId||job.job_id)&&imports.has(`${job.result.batchId}:${job.result.revision}:${job.job_id}`):fileKinds.has(kind)?fileResult(job):kind==='EXPORT'&&job.result?.jobId===job.job_id&&reviews.has(job.result.jobId);
      if(!valid)errors.push({artifactId:`preparation:${job.job_id}`,error:'Completed preparation review metadata is missing or inconsistent.'});
    }
  }
  return errors;
}
