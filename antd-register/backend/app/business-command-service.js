import {MemoryStorage} from './storage.js';
import {parseBusinessCommand,commandAllowed,commandOwnerKey,commandScopeHash} from './business-command-policy.js';
import {prepareSetupValidation} from './setup-service.js';
import {withCatalog,catalogHash} from './reference-catalog.js';
import {canUseModule,moduleFor} from './workflow.js';
import {httpError,lockNamedReleaseAccount,currentNamedReleaseContext} from './auth.js';
import {queueWorkerContext} from './audit-queue-origin.js';
import {copyAuditContext} from './audit-provenance.js';

const denied=()=>httpError(403,'The initiating account role or assigned scope changed. Review the operation under the current account.',{code:'COMMAND_ACCOUNT_CHANGED'});
const stopped=()=>httpError(409,'The command worker stopped or lost its current execution lease.',{code:'COMMAND_LEASE_LOST'});
function queueFailure(error){
  if(error.status)throw error;
  const schema=['42P01','42703','42883'].includes(error.code),local=['EACCES','EIO','ENOSPC','EROFS'].includes(error.code);
  throw httpError(503,'The service could not confirm that the operation was queued. Retry with the same idempotency key to check its saved status.',{code:'COMMAND_QUEUE_UNAVAILABLE',details:[schema?'Required command or audit schema is unavailable. Apply ordered migrations and run preflight.':local?'Local queue/state storage could not be written. Check folder permissions and free space.':'Command or audit storage is unavailable. Check the service and database connection.']});
}

/** Domain methods receive the queue's transaction; no second business commit exists. */
export class BusinessCommandService {
  constructor(storage,artifacts,jobs,{auth=null}={}){this.storage=storage;this.artifacts=artifacts;this.jobs=jobs;this.auth=auth;}
  async currentContext(job,client=null){
    let context;
    try{context=job.owner.authenticated
      ?await this.auth.preparationContext(job.owner.userId,client||this.storage.rawPool||this.storage.pool,{lock:Boolean(client)})
      :{...structuredClone(job.owner)};
    }catch(error){if(error.code==='PREPARATION_ACCOUNT_CHANGED'||error.code==='PASSWORD_CHANGE_REQUIRED')throw denied();throw error;}
    if(!commandAllowed(job,context,{execute:true}))throw denied();
    // Queue audit links the HTTP enqueue trace to this stable execution trace.
    return queueWorkerContext({...context,requestId:job.commandId},job,'BUSINESS_COMMAND',this.jobs.auditRuntime||this.storage.auditRuntime);
  }
  async enqueue(body,context,key){
    const descriptor=parseBusinessCommand(body,key);
    let moduleId=descriptor.moduleId;
    if(descriptor.kind==='IMPORT_COMMIT'){
      const batch=await this.storage.getImportBatch(descriptor.batchId,context);
      moduleId=batch.moduleId;
    }
    if(!canUseModule(moduleFor(moduleId),context.role))throw httpError(403,'This confirmed operation is unavailable for your role.',{code:'COMMAND_ROLE_DENIED'});
    try{return await this.jobs.enqueue(descriptor,context,key,{moduleId,currentContext:client=>this.requestContext(context,client)});}catch(error){return queueFailure(error);}
  }
  async requestContext(context,client){
    if(!client||!context.authenticated)return context;
    await lockNamedReleaseAccount(client,context);
    return copyAuditContext(context,await currentNamedReleaseContext(client,context));
  }
  async change(id,action,context){
    try{return await this.jobs.change(id,action,context,{currentContext:client=>this.requestContext(context,client)});}catch(error){return queueFailure(error);}
  }
  async get(id,context){return this.publishRead(context,()=>this.jobs.get(id,context));}
  async list(context,options){return this.publishRead(context,()=>this.jobs.list(context,options));}
  async publishRead(context,read){
    // Let logout/moderation finish while a payload query waits. Only the final
    // publication fence locks the original session and checks current scope.
    const payload=await read();
    if(!context.authenticated)return payload;
    const client=await this.storage.rawPool.connect();
    try{
      await client.query('begin');
      const current=await this.requestContext(context,client);
      if(commandOwnerKey(current)!==commandOwnerKey(context)||commandScopeHash(current)!==commandScopeHash(context))throw denied();
      await client.query('commit');return payload;
    }catch(error){await client.query('rollback').catch(()=>{});throw error;}
    finally{client.release();}
  }
  async execute(claimed,control){
    const check=()=>{if(control.signal.aborted)throw stopped();};
    check();let context=await this.currentContext(claimed),report=null;
    if(claimed.descriptor.kind==='WORKFLOW'&&claimed.moduleId==='M90'){
      await control.progress('Validating configuration and data');
      report=await prepareSetupValidation(this.storage,this.artifacts,claimed.descriptor.options);
      check();
    }
    await control.progress(claimed.descriptor.kind==='IMPORT_COMMIT'?'Committing reviewed import':claimed.moduleId==='M10'?'Recording decisions':claimed.moduleId==='M91'?'Recalculating workflow state':'Running workflow');
    const finish=()=>this.jobs.complete(claimed,context,async(client,current)=>{
      check();const descriptor=claimed.descriptor;
      let result;
      if(descriptor.kind==='IMPORT_COMMIT'){
        const body={revision:descriptor.revision,acceptFindings:descriptor.acceptFindings};
        if(client){
          const catalog=await this.transactionCatalog(client);
          result=await withCatalog(catalog,()=>this.storage.commitImportBatch(descriptor.batchId,body,current,{
            transaction:client,
            validateSource:(batch,transaction)=>this.artifacts.withImportSource(batch,current,async()=>{},transaction)
          }));
        }else result=await this.memoryDomain(async memory=>withCatalog(await memory.getReferenceCatalog(),()=>memory.commitImportBatch(descriptor.batchId,body,current)));
      }else if(descriptor.moduleId==='M90'){
        result=client
          ?await this.storage.recordSetupValidation(report,current,{transaction:client})
          :await this.memoryDomain(memory=>memory.recordSetupValidation(report,current));
      }else if(client){
        const catalog=await this.transactionCatalog(client);
        result=await withCatalog(catalog,()=>this.storage.runWorkflow(descriptor.moduleId,current,descriptor.options,{transaction:client}));
      }else result=await this.memoryDomain(async memory=>withCatalog(await memory.getReferenceCatalog(),()=>memory.runWorkflow(descriptor.moduleId,current,descriptor.options)));
      check();return result;
    },{currentContext:(client,job)=>this.currentContext(job,client)});
    if(!this.storage.rawPool&&claimed.descriptor.kind==='IMPORT_COMMIT'){
      // The local lock order is artifact catalogue, then one atomic state write.
      const batch=await this.storage.getImportBatch(claimed.descriptor.batchId,context);
      return this.artifacts.withImportSource(batch,context,finish);
    }
    return finish();
  }
  async memoryDomain(publish){
    // FilePreviewStorage readers/mutators wait on its queue. Within the queue's
    // existing atomic write, use the memory implementation rather than nest it.
    const memory=new MemoryStorage({auditRuntime:this.storage.auditRuntime});
    Object.assign(memory,{state:this.storage.state,importReceipts:this.storage.importReceipts,proposalSequenceFloor:this.storage.proposalSequenceFloor,proposalAllocationSnapshot:structuredClone(this.storage.proposalAllocationSnapshot??null)});
    const result=await publish(memory);
    Object.assign(this.storage,{state:memory.state,importReceipts:memory.importReceipts,proposalSequenceFloor:memory.proposalSequenceFloor,proposalAllocationSnapshot:structuredClone(memory.proposalAllocationSnapshot??null)});
    return result;
  }
  async transactionCatalog(client){
    // Match existing domain lock order: catalog shared before workflow/row locks.
    const catalog=(await client.query('select catalog_json from replacement_register.reference_catalog where singleton=true for share')).rows[0]?.catalog_json;
    if(!catalog||catalogHash(catalog)!==catalog.hash)throw httpError(409,'Reference catalog integrity check failed. Restore a verified catalog before continuing.',{code:'REFERENCE_INTEGRITY'});
    return catalog;
  }
}
