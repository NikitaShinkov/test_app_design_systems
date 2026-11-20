import {httpError,canAccess} from './auth.js';
import {normalize} from './normalization.js';
import {withCatalog} from './reference-catalog.js';
import {rowToProposal} from './storage.js';
import {filePreparationKinds,filePreparationResultMatches,verifyFilePreparation} from './file-preparations.js';
import {snapshotDigest} from './export-jobs.js';
import {digest,safeFilename} from './artifacts.js';
import {validateAttachment} from './attachment-policy.js';
import {queueWorkerContext} from './audit-queue-origin.js';

const scopeFor=rows=>Object.fromEntries(['orderNo','supplier','productDecimalNo','proposalId'].map((field,index)=>[['orderNos','suppliers','productDecimalNos','proposalIds'][index],[...new Set(rows.map(row=>row[field]).filter(Boolean))]]));
const inputIdentity=item=>({artifactId:item.artifactId,sha256:item.sha256,bytes:item.bytes});
const artifactResult=(job,artifact)=>({kind:job.descriptor.kind,preparationId:job.jobId,artifactId:artifact.artifactId,artifact});

export class FilePreparationService {
  constructor(storage,artifacts,jobs,{generator,currentContext,checkInputs}){Object.assign(this,{storage,artifacts,jobs,generator,currentContext,checkInputs});}
  async context(job,client=null){
    const context=await this.currentContext(job,client);
    if(job.descriptor.kind==='ATTACHMENT'){
      if(!client&&this.storage.queue)await this.storage.queue;
      const proposal=client?(await client.query('select * from replacement_register.proposals where proposal_id=$1 for share',[job.descriptor.proposalId])).rows.map(rowToProposal)[0]:await this.storage.getProposal(job.descriptor.proposalId);
      if(!proposal||(context.authenticated&&!canAccess(context,proposal)))throw httpError(404,'Attachment proposal is unavailable.',{code:'ATTACHMENT_TARGET_UNAVAILABLE'});
      const item=await this.artifacts.get(job.descriptor.input.artifactId,context);
      for(const [key,value] of [['orderNos',proposal.orderNo],['suppliers',proposal.supplier],['productDecimalNos',proposal.productDecimalNo]])if(value&&!item.scope[key].some(entry=>normalize(entry)===normalize(value)))throw httpError(409,'The proposal scope changed while this attachment was being verified. Upload it against the current proposal.',{code:'ATTACHMENT_SCOPE_CHANGED'});
    }
    return queueWorkerContext(context,job,'PREPARATION',this.jobs.auditRuntime||this.storage.auditRuntime);
  }
  async enqueue(kind,context,{bytes=null,filename='',contentType,attachmentMetadata,options={},proposal=null,artifact=null,idempotencyKey}={}){
    if(!filePreparationKinds.has(kind))throw httpError(422,'Unknown file preparation.');
    if(kind!=='ATTACHMENT'&&context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can run this file operation.');
    if(kind==='ATTACHMENT'&&(!proposal||(context.authenticated&&!canAccess(context,proposal))))throw httpError(404,'Proposal not found.');
    if(kind==='ATTACHMENT'){
      const supplied=attachmentMetadata||{},validated=await validateAttachment(bytes,{filename:safeFilename(filename),contentType,role:supplied.role||supplied.attachmentRole,description:supplied.description,confidentiality:supplied.confidentiality,supersedesArtifactId:supplied.supersedesArtifactId},context),{filename:checkedName,contentType:checkedType,...metadata}=validated;
      const descriptor={kind,moduleId:null,input:{sha256:digest(bytes),bytes:bytes.length},filename:checkedName,options:{...options,attachmentMetadata:metadata,contentType:checkedType},proposalId:proposal.proposalId};
      return this.jobs.enqueue(descriptor,context,idempotencyKey,{retainInput:client=>this.artifacts.put(bytes,{kind:'ATTACHMENT',moduleId:null,filename:checkedName,contentType:checkedType,attachmentMetadata:metadata,scope:scopeFor([proposal]),ownerOnly:false},context,{transaction:client,scan:{status:'PENDING',detail:'Queued for background file verification.'},reusePendingInput:true})});
    }
    if(kind!=='RESCAN'){
      const scope=kind==='ATTACHMENT'?scopeFor([proposal]):scopeFor([{orderNo:options.orderNo||'Unassigned',supplier:options.supplier||'',productDecimalNo:options.productDecimalNo||''}]);
      artifact=await this.artifacts.put(bytes,{kind:kind==='ATTACHMENT'?'ATTACHMENT':'WORKFLOW_INPUT',moduleId:kind==='ATTACHMENT'?null:'M01',filename,contentType:kind==='ATTACHMENT'?contentType:'application/octet-stream',...(attachmentMetadata?{attachmentMetadata}:{}),scope,ownerOnly:kind!=='ATTACHMENT'},context,{scan:{status:'PENDING',detail:'Queued for background file verification.'},reusePendingInput:true});
    }
    if(!artifact)throw httpError(404,'File not found.');
    return this.jobs.enqueue({kind,moduleId:['INSPECT','REGISTER_BOM'].includes(kind)?'M01':null,input:inputIdentity(artifact),filename:artifact.filename,options,...(proposal?{proposalId:proposal.proposalId}:{})},context,idempotencyKey);
  }
  async resolve(job,context,client=null){
    const receipt=await this.jobs.readFileResult(job,context);if(receipt)return receipt;
    let artifact;
    if(job.descriptor.kind==='REGISTER_BOM'){
      artifact=await this.artifacts.findPublishedFile(job,context,client);
      if(artifact)return {...artifactResult(job,artifact),sourceArtifactId:job.descriptor.input.artifactId};
    }
    if(['ATTACHMENT','RESCAN'].includes(job.descriptor.kind)){
      artifact=await this.artifacts.publishedFileScan(job.jobId,context,{transaction:client});
      if(job.descriptor.kind==='ATTACHMENT'){
        if(!artifact||!(artifact.scanStatus==='CLEAN'||this.artifacts.preview&&artifact.scanStatus==='ERROR'))return null;
        try{await this.checkInputs({snapshot:{inputs:[job.descriptor.input]}},context,client);}catch(error){if(error.status===423)return null;throw error;}
      }
      const result=artifact&&artifactResult(job,artifact);if(result&&filePreparationResultMatches(job,result))return result;
    }
    return null;
  }
  async execute(job,control,catalog){
    const context=await this.context(job),existing=await this.resolve(job,context);
    let verified=null,inspection=null,metadata=null,bomProjection=null;
    if(!existing){
      verified=await verifyFilePreparation(job,{artifacts:this.artifacts,preparations:this.jobs,context,control,currentContext:(...args)=>this.context(...args)});
      if(['INSPECT','REGISTER_BOM'].includes(job.descriptor.kind)){
        await control.progress('Inspecting the original workbook');
        if(job.descriptor.kind==='INSPECT'){
          const state=await withCatalog(catalog,()=>this.storage.exportState(context));
          const result=await this.generator.run({operation:'INSPECT_ORIGINAL',input:verified.input,replacements:state.replacements,filename:verified.archived.filename,options:job.descriptor.options},catalog,{signal:control.signal});
          inspection={...result,historyHash:snapshotDigest({history:state.replacements,referenceHash:catalog.hash}),referenceRevision:catalog.revision,referenceHash:catalog.hash,sourceHash:verified.archived.sha256};
        }else{
          bomProjection=await this.generator.run({operation:'BOM_PROJECTION',input:verified.input,filename:verified.archived.filename},catalog,{signal:control.signal});
          const fields=['orderNo','product','productCode','productDecimalNo','supplier','productionOrder'];
          metadata=Object.fromEntries(fields.map(key=>[key,Object.hasOwn(job.descriptor.options,key)?job.descriptor.options[key]:bomProjection.metadata[key]||'']));
          bomProjection={...bomProjection,metadata};
          const missing=['orderNo','supplier','productDecimalNo'].filter(key=>!String(metadata[key]||'').trim());
          if(missing.length)throw httpError(422,'The original BOM must identify its order, product decimal number and supplier.',{code:'ORIGINAL_BOM_METADATA_REQUIRED',details:[`Missing fields: ${missing.join(', ')}. Exact source retained as ${verified.archived.artifactId}.`]});
        }
      }
    }
    await control.progress('Saving the file operation result');
    return this.jobs.complete(job,context,async client=>{
      const current=await this.context(job,client);
      const recovered=existing||await this.resolve(job,current,client);
      if(recovered){if(job.descriptor.kind==='ATTACHMENT')await this.checkInputs({snapshot:{inputs:[job.descriptor.input]}},current,client);return recovered;}
      if(job.descriptor.kind==='RESCAN')return artifactResult(job,verified.archived);
      if(client)await client.query('select pg_advisory_xact_lock(78742004)');
      await this.checkInputs({snapshot:{inputs:[job.descriptor.input]}},current,client);
      if(job.descriptor.kind==='ATTACHMENT')return artifactResult(job,verified.archived);
      if(client){const reference=(await client.query('select catalog_hash from replacement_register.reference_catalog where singleton=true for share')).rows[0];if(reference?.catalog_hash!==catalog.hash)throw httpError(409,'Reference data changed during workbook inspection. Retry the saved file operation.',{code:'REFERENCE_CHANGED'});}
      if(job.descriptor.kind==='INSPECT')return {kind:'INSPECT',preparationId:job.jobId,...inputIdentity(verified.archived),sourceArtifactId:verified.archived.artifactId,filename:verified.archived.filename,contentType:verified.archived.contentType,inspection};
      const artifact=await this.artifacts.put(verified.input,{kind:'ORIGINAL_BOM',moduleId:'M01',filename:verified.archived.filename,scope:scopeFor([metadata]),bomProjection},current,{scan:{status:verified.archived.scanStatus,detail:verified.archived.scanDetail},transaction:client,preparationId:job.jobId});
      return {...artifactResult(job,artifact),sourceArtifactId:verified.archived.artifactId};
    });
  }
}
