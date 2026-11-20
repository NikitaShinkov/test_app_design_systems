import {copyAuditContext} from './audit-provenance.js';
import {captureQueueInitiator,queueEventContext,queueWorkerContext,queueInternalContext,inspectQueueInitiator,queueOriginRefusalError,queueRefusalStatus,queueRefusalContext} from './audit-queue-origin.js';
import {randomUUID} from 'node:crypto';
import {httpError} from './auth.js';
import {snapshotDigest} from './export-jobs.js';
import {moduleFor,canUseModule} from './workflow.js';
import {publishJobExecution,witnessedSqlRollbackFailure} from './business-command-runner.js';
import {parseBusinessCommand,commandOwner,commandOwnerKey,commandScopeHash,commandRequestHash,commandAllowed,commandSummary} from './business-command-policy.js';

const rr='replacement_register',table=rr+'.business_command_jobs',receiptTable=rr+'.business_command_receipts';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const clone=value=>structuredClone(value),object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const missing=()=>httpError(404,'Business command not found.',{code:'COMMAND_NOT_FOUND'});
const leaseLost=()=>httpError(409,'The confirmed operation was cancelled or its worker lease expired.',{code:'COMMAND_LEASE_LOST'});
const receiptInvalid=()=>httpError(409,'The retained business command receipt failed its integrity check. Ask an administrator to verify the saved history.',{code:'COMMAND_RECEIPT_INVALID'});
const iso=value=>value instanceof Date?value.toISOString():value;
const fromRow=row=>row?{commandId:row.command_id,ordinal:String(row.ordinal),ownerKey:row.owner_key,initiatorProvenance:row.audit_initiator_provenance_text??null,owner:row.owner_json,idempotencyKey:row.idempotency_key,requestHash:row.request_hash,descriptor:row.descriptor,moduleId:row.module_id,status:row.status,attempts:row.attempts,leaseToken:row.lease_token,leaseUntil:iso(row.lease_until),...(typeof row.lease_active==='boolean'?{leaseActive:row.lease_active}:{}),progress:row.progress,result:row.result_json,error:row.error_json,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)}:null;
const receiptFromRow=row=>row?{commandId:row.command_id,ownerKey:row.owner_key,requestHash:row.request_hash,requestJson:row.request_json,resultHash:row.result_hash,resultJson:row.result_json,occurredAt:iso(row.occurred_at)}:null;
const noResultColumns='initiator_provenance_json::text as audit_initiator_provenance_text,command_id,ordinal,owner_key,owner_json,idempotency_key,request_hash,descriptor,module_id,status,attempts,lease_token,lease_until,progress,error_json,created_at,updated_at';

function validateStored(job){
  try{
    const intent=parseBusinessCommand(job.descriptor,job.idempotencyKey);
    if(!uuid(job.commandId)||snapshotDigest(intent)!==snapshotDigest(job.descriptor)||commandRequestHash(intent)!==job.requestHash||commandOwnerKey(job.owner)!==job.ownerKey||!canUseModule(moduleFor(job.moduleId),job.owner.role))throw receiptInvalid();
    if(intent.kind==='WORKFLOW'?intent.moduleId!==job.moduleId:!['M02','M04','M08'].includes(job.moduleId))throw receiptInvalid();
    return intent;
  }catch{throw receiptInvalid();}
}
function validateResult(job,result){
  if(!object(result)||(job.descriptor.kind==='IMPORT_COMMIT'?result.batchId!==job.descriptor.batchId:result.moduleId!==job.moduleId||!object(result.result)))throw receiptInvalid();
  // Only durable JSON values enter hashes, state and PostgreSQL alike.
  try{const saved=JSON.parse(JSON.stringify(result));if(!object(saved))throw receiptInvalid();return saved;}catch{throw receiptInvalid();}
}
export function verifyBusinessCommandReceipt(job,receipt){
  validateStored(job);
  if(!receipt||receipt.commandId!==job.commandId||receipt.ownerKey!==job.ownerKey||receipt.requestHash!==job.requestHash||snapshotDigest(receipt.requestJson)!==snapshotDigest(job.descriptor)||commandRequestHash(receipt.requestJson)!==receipt.requestHash||snapshotDigest(receipt.resultJson)!==receipt.resultHash||snapshotDigest(receipt.resultJson)!==snapshotDigest(job.result))throw receiptInvalid();
  validateResult(job,receipt.resultJson);return clone(receipt.resultJson);
}
function pageOptions(input,context){
  const limit=input.limit===undefined?30:Number(input.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw httpError(422,'Command page size must be 1–100.',{code:'COMMAND_PAGE_INVALID'});
  const binding=snapshotDigest([commandOwnerKey(context),commandScopeHash(context)]);let after=null;
  if(input.cursor!==undefined&&input.cursor!==null&&input.cursor!==''){try{if(typeof input.cursor!=='string'||input.cursor.length>2048)throw Error();const decoded=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));if(decoded.v!==1||decoded.binding!==binding||typeof decoded.after!=='string'||!/^[1-9][0-9]{0,18}$/.test(decoded.after)||BigInt(decoded.after)>9223372036854775807n)throw Error();after=decoded.after;}catch{throw httpError(422,'This command cursor belongs to another account or page.',{code:'COMMAND_PAGE_INVALID'});}}
  return {limit,binding,after};
}
const nextCursor=(binding,after)=>Buffer.from(JSON.stringify({v:1,binding,after})).toString('base64url');

/** A confirmed command and domain publication share one transaction/state file. */
export class BusinessCommandJobs {
  constructor(storage,{now=()=>Date.now(),leaseMs=30000,maxGlobal=20,maxPerOwner=3,auditRuntime=storage.auditRuntime||null}={}){
    if(!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>3600000||!Number.isSafeInteger(maxGlobal)||maxGlobal<1||maxGlobal>1000||!Number.isSafeInteger(maxPerOwner)||maxPerOwner<1||maxPerOwner>maxGlobal)throw Error('Invalid business-command queue configuration.');
    this.storage=storage;this.auditRuntime=auditRuntime;this.pool=storage.rawPool||storage.pool||null;this.now=now;this.leaseMs=leaseMs;this.maxGlobal=maxGlobal;this.maxPerOwner=maxPerOwner;
  }
  async transaction(action,{serializable=false}={}){
    const client=await this.pool.connect();
    try{await client.query(serializable?'begin isolation level serializable':'begin');const result=await action(client);await client.query('commit');return result;}
    catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
  }
  local(action,{canMutate}={}){
    const storage=this.storage;storage.queue||=Promise.resolve();
    const pending=storage.queue.then(async()=>{
      if(canMutate&&!canMutate())return null;
      const before=clone(storage.state),receipts=storage.importReceipts?new Map(storage.importReceipts):null,sequenceFloor=storage.proposalSequenceFloor,allocation=clone(storage.proposalAllocationSnapshot);
      try{this.localDirty=false;const result=await action();if(this.localDirty&&storage.persist)await storage.persist();return result;}
      catch(error){storage.state=before;if(receipts)storage.importReceipts=receipts;storage.proposalSequenceFloor=sequenceFloor;storage.proposalAllocationSnapshot=allocation;throw error;}
    });
    storage.queue=pending.catch(()=>{});return pending;
  }
  async read(id,client=this.pool,lock=false){
    if(!uuid(id))throw missing();
    return client?fromRow((await client.query(`select *,initiator_provenance_json::text as audit_initiator_provenance_text,lease_until>clock_timestamp() as lease_active from ${table} where command_id=$1${lock?' for update':''}`,[id])).rows[0]):clone((this.storage.state.commandJobs||[]).find(row=>row.commandId===id)||null);
  }
  async receipt(id,client=this.pool){return client?receiptFromRow((await client.query(`select * from ${receiptTable} where command_id=$1`,[id])).rows[0]):clone((this.storage.state.commandReceipts||[]).find(row=>row.commandId===id)||null);}
  require(job,context,{execute=false}={}){if(!commandAllowed(job,context,{execute}))throw missing();return job;}
  async get(id,context){
    const job=this.require(await this.read(id),context);validateStored(job);if(job.status==='SUCCEEDED')verifyBusinessCommandReceipt(job,await this.receipt(id));return commandSummary(job,context);
  }
  async list(context,input={}){
    const owner=commandOwner(context),{limit,binding,after}=pageOptions(input,context);let rows;
    if(this.pool){
      const values=[],where=[],add=value=>{values.push(value);return '$'+values.length;};
      if(owner.role!=='ADMINISTRATOR'){
        where.push(`owner_key=${add(commandOwnerKey(owner))}`,`owner_json->>'role'=${add(owner.role)}`,`owner_json->>'organization'=${add(owner.organization)}`,`owner_json->'orders'=${add(JSON.stringify(owner.orders))}::jsonb`);
        const modules=['M02','M04','M08'].filter(id=>canUseModule(moduleFor(id),owner.role));where.push(`module_id=any(${add(modules)}::text[])`);
      }
      if(after)where.push(`ordinal<${add(after)}::bigint`);
      rows=(await this.pool.query(`select ${noResultColumns} from ${table}${where.length?' where '+where.join(' and '):''} order by ordinal desc limit ${add(limit+1)}`,values)).rows.map(fromRow);
    }else{
      await this.storage.queue;
      rows=(this.storage.state.commandJobs||[]).filter(job=>commandAllowed(job,context)&&(!after||BigInt(job.ordinal)<BigInt(after))).sort((a,b)=>BigInt(a.ordinal)>BigInt(b.ordinal)?-1:1).slice(0,limit+1);
    }
    const visible=rows.slice(0,limit),items=visible.filter(job=>commandAllowed(job,context)).map(job=>commandSummary(job,context,{includeResult:false}));
    return {items,nextCursor:rows.length>limit?nextCursor(binding,visible.at(-1).ordinal):null};
  }
  async audit(job,context,action,client=null){
    const after={commandId:job.commandId,kind:job.descriptor.kind,moduleId:job.moduleId,status:job.status,attempts:job.attempts,progress:clone(job.progress),...(job.error?{errorCode:job.error.code}:{}),createdAt:job.createdAt,updatedAt:job.updatedAt};
    const actor=queueEventContext(context,job,'BUSINESS_COMMAND',action==='COMMAND_QUEUED'?'QUEUE':action==='COMMAND_CANCELLED'||action==='COMMAND_RETRIED'?'CONTROL':'WORKER',this.auditRuntime),detail=`${job.moduleId}: ${job.status}`;
    if(client)await this.storage.writeAudit(client,actor,action,job.commandId,detail,null,after);
    else{this.localDirty=true;this.storage.addAudit(actor,action,job.commandId,detail,null,after);}
  }
  async refuseOrigin(job,client){
    this.originRefusalStatus=queueRefusalStatus(job,'BUSINESS_COMMAND');const context=queueRefusalContext(job,'BUSINESS_COMMAND',this.auditRuntime),after={commandId:job.commandId,status:job.status,attempts:job.attempts,code:'AUDIT_PROVENANCE_INVALID'},detail='Stored queue audit provenance refused execution.';
    if(client)return this.storage.writeAudit(client,context,'COMMAND_AUDIT_REFUSED',job.commandId,detail,null,after);
    this.localDirty=true;this.storage.addAudit(context,'COMMAND_AUDIT_REFUSED',job.commandId,detail,null,after);
  }
  async save(job,client=null){
    if(client)await client.query(`update ${table} set status=$2,attempts=$3,lease_token=$4,lease_until=$5,progress=$6,result_json=$7,error_json=$8,updated_at=$9 where command_id=$1`,[job.commandId,job.status,job.attempts,job.leaseToken||null,job.leaseUntil||null,job.progress,job.result??null,job.error??null,job.updatedAt]);
    else{this.localDirty=true;const index=this.storage.state.commandJobs.findIndex(row=>row.commandId===job.commandId);this.storage.state.commandJobs[index]=clone({...job,initiatorProvenance:this.storage.state.commandJobs[index]?.initiatorProvenance??null});}
  }
  async assertCapacity(ownerKey,client=null){
    const counts=client?(await client.query(`select count(*)::integer as global,count(*) filter(where owner_key=$1)::integer as owner from ${table} where status in ('QUEUED','RUNNING')`,[ownerKey])).rows[0]:(this.storage.state.commandJobs||[]).reduce((value,job)=>{if(['QUEUED','RUNNING'].includes(job.status)){value.global++;if(job.ownerKey===ownerKey)value.owner++;}return value;},{global:0,owner:0});
    if(counts.global>=this.maxGlobal||counts.owner>=this.maxPerOwner)throw httpError(429,'The confirmed-operation queue is busy. Wait for an operation to finish and try again.',{code:'COMMAND_LIMIT',retryAfter:3,headers:{'Retry-After':'3'}});
  }
  async enqueue(input,context,idempotencyKey,{moduleId,currentContext}={}){
    const descriptor=parseBusinessCommand(input,idempotencyKey),owner=commandOwner(context),resolved=descriptor.kind==='WORKFLOW'?descriptor.moduleId:moduleId;
    if(!resolved||!canUseModule(moduleFor(resolved),owner.role)||(descriptor.kind==='IMPORT_COMMIT'&&!['M02','M04','M08'].includes(resolved)))throw httpError(403,'This confirmed operation is unavailable for your role.',{code:'COMMAND_ACCOUNT_CHANGED'});
    const stamp=new Date(this.now()).toISOString(),job={commandId:randomUUID(),ownerKey:commandOwnerKey(owner),owner,descriptor,requestHash:commandRequestHash(descriptor),idempotencyKey,moduleId:resolved,status:'QUEUED',attempts:0,leaseToken:null,leaseUntil:null,progress:{phase:'Queued'},result:null,error:null,createdAt:stamp,updatedAt:stamp};
    const authorize=async client=>{if(currentContext)context=copyAuditContext(context,await currentContext(client,job));this.require(job,context,{execute:true});};
    const existing=async(previous,client)=>{this.require(previous,context,{execute:true});validateStored(previous);if(previous.requestHash!==job.requestHash||previous.moduleId!==resolved)throw httpError(409,'This idempotency key belongs to a different confirmed operation.',{code:'COMMAND_KEY_CONFLICT'});if(previous.status==='SUCCEEDED')verifyBusinessCommandReceipt(previous,await this.receipt(previous.commandId,client));return commandSummary(previous,context);};
    if(this.pool)return this.transaction(async client=>{
      await client.query('select pg_advisory_xact_lock(78742022)');
      await authorize(client);
      const previous=fromRow((await client.query(`select *,initiator_provenance_json::text as audit_initiator_provenance_text from ${table} where owner_key=$1 and idempotency_key=$2`,[job.ownerKey,idempotencyKey])).rows[0]);if(previous)return existing(previous,client);
      job.initiatorProvenance=captureQueueInitiator(context,job,'BUSINESS_COMMAND',this.auditRuntime);await this.assertCapacity(job.ownerKey,client);
      const inserted=await client.query(`insert into ${table}(command_id,owner_key,owner_json,idempotency_key,request_hash,descriptor,module_id,status,progress,created_at,updated_at,initiator_provenance_json) values($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$9,$9,$10::jsonb) returning ordinal`,[job.commandId,job.ownerKey,owner,idempotencyKey,job.requestHash,descriptor,resolved,job.progress,stamp,job.initiatorProvenance]);job.ordinal=String(inserted.rows[0].ordinal);
      await this.audit(job,context,'COMMAND_QUEUED',client);return commandSummary(job,context);
    });
    return this.local(async()=>{
      await authorize(null);
      const jobs=this.storage.state.commandJobs||=[],previous=jobs.find(row=>row.ownerKey===job.ownerKey&&row.idempotencyKey===idempotencyKey);if(previous)return existing(previous,null);
      job.initiatorProvenance=captureQueueInitiator(context,job,'BUSINESS_COMMAND',this.auditRuntime);await this.assertCapacity(job.ownerKey);job.ordinal=(jobs.reduce((max,row)=>BigInt(row.ordinal)>max?BigInt(row.ordinal):max,0n)+1n).toString();jobs.push(job);this.storage.state.commandJobs=jobs;await this.audit(job,context,'COMMAND_QUEUED');return commandSummary(job,context);
    });
  }
  owns(current,claimed){return current?.status==='RUNNING'&&current.leaseToken===claimed.leaseToken&&(typeof current.leaseActive==='boolean'?current.leaseActive:Date.parse(current.leaseUntil)>this.now());}
  async claim(){
    if(this.originRefusalStatus)throw queueOriginRefusalError();
    const take=async(job,client)=>{
      if(!job)return null;if(inspectQueueInitiator(job,'BUSINESS_COMMAND').status==='INVALID'){await this.refuseOrigin(job,client);return null;}validateStored(job);job.updatedAt=new Date(this.now()).toISOString();
      if(job.attempts>=3){Object.assign(job,{status:'FAILED',leaseToken:null,leaseUntil:null,error:{status:409,code:'COMMAND_INTERRUPTED',message:'The operation was interrupted three times. Verify its review before starting a new operation.',details:[],retryable:false},progress:{phase:'Failed'}});await this.audit(job,queueInternalContext(job,'BUSINESS_COMMAND',this.auditRuntime),'COMMAND_FAILED',client);await this.save(job,client);return null;}
      Object.assign(job,{status:'RUNNING',attempts:job.attempts+1,leaseToken:randomUUID(),leaseUntil:new Date(this.now()+this.leaseMs).toISOString(),progress:{phase:job.attempts?'Resuming interrupted command':'Starting command'},error:null});delete job.leaseActive;
      await this.audit(job,queueInternalContext(job,'BUSINESS_COMMAND',this.auditRuntime),'COMMAND_STARTED',client);await this.save(job,client);return clone(job);
    };
    try{const result=this.pool?await this.transaction(async client=>take(fromRow((await client.query(`select *,initiator_provenance_json::text as audit_initiator_provenance_text from ${table} where status='QUEUED' or (status='RUNNING' and lease_until<=clock_timestamp()) order by created_at,command_id for update skip locked limit 1`)).rows[0]),client)):await this.local(()=>take(clone((this.storage.state.commandJobs||[]).filter(job=>job.status==='QUEUED'||job.status==='RUNNING'&&Date.parse(job.leaseUntil)<=this.now()).sort((a,b)=>BigInt(a.ordinal)<BigInt(b.ordinal)?-1:1)[0]||null),null),{canMutate:()=>(this.storage.state.commandJobs||[]).some(job=>job.status==='QUEUED'||job.status==='RUNNING'&&Date.parse(job.leaseUntil)<=this.now())});if(this.originRefusalStatus)throw queueOriginRefusalError();return result;}catch(error){if(this.originRefusalStatus)throw queueOriginRefusalError();throw error;}
  }
  async heartbeat(claimed,progress=null){
    const stamp=new Date(this.now()).toISOString(),until=new Date(this.now()+this.leaseMs).toISOString();
    if(this.pool)return (await this.pool.query(`update ${table} set lease_until=$3,updated_at=$4,progress=coalesce($5,progress) where command_id=$1 and lease_token=$2 and status='RUNNING' and lease_until>clock_timestamp()`,[claimed.commandId,claimed.leaseToken,until,stamp,progress])).rowCount===1;
    return this.local(async()=>{const job=await this.read(claimed.commandId,null);if(!this.owns(job,claimed))return false;Object.assign(job,{leaseUntil:until,updatedAt:stamp,...(progress?{progress:clone(progress)}:{})});await this.save(job);return true;});
  }
  async complete(claimed,context,publish,{currentContext}={}){
    validateStored(claimed);
    const finish=async(job,client)=>{
      if(!job)throw missing();validateStored(job);
      let current=currentContext?await currentContext(client,job):context;
      this.require(job,current,{execute:true});
      if(job.status==='SUCCEEDED'){verifyBusinessCommandReceipt(job,await this.receipt(job.commandId,client));return commandSummary(job,current);}
      // Authorization may have waited on an account lock. Validate the lease
      // against a fresh clock after that wait, while retaining the job row lock.
      if(client)job.leaseActive=(await client.query('select $1::timestamptz>clock_timestamp() as active',[job.leaseUntil])).rows[0].active;
      if(!this.owns(job,claimed)||claimed.requestHash!==job.requestHash)throw leaseLost();
      current=queueWorkerContext(current,job,'BUSINESS_COMMAND',this.auditRuntime);
      const result=validateResult(job,await publish(client,current));
      const stamp=new Date(this.now()).toISOString(),receipt={commandId:job.commandId,ownerKey:job.ownerKey,requestHash:job.requestHash,requestJson:clone(job.descriptor),resultHash:snapshotDigest(result),resultJson:clone(result),occurredAt:stamp};
      if(client)await client.query(`insert into ${receiptTable}(command_id,owner_key,request_hash,request_json,result_hash,result_json,occurred_at) values($1,$2,$3,$4,$5,$6,$7)`,[receipt.commandId,receipt.ownerKey,receipt.requestHash,receipt.requestJson,receipt.resultHash,receipt.resultJson,stamp]);
      else(this.storage.state.commandReceipts||=[]).push(receipt);
      Object.assign(job,{status:'SUCCEEDED',result,error:null,progress:{phase:'Completed'},leaseToken:null,leaseUntil:null,updatedAt:stamp});delete job.leaseActive;
      await this.audit(job,current,'COMMAND_SUCCEEDED',client);await this.save(job,client);return commandSummary(job,current);
    };
    return publishJobExecution(this,claimed,{terminal:true},()=>this.pool?this.transaction(async client=>finish(await this.read(claimed.commandId,client,true),client),{serializable:claimed.descriptor?.kind==='IMPORT_COMMIT'}):this.local(async()=>finish(await this.read(claimed.commandId,null),null)));
  }
  async resolveExecution(claimed,{error,allowFailure=false}={}){
    const rollbackFailure=allowFailure?witnessedSqlRollbackFailure(this.storage.sqlExecution,error):null;
    const resolve=async client=>{
      const current=await this.read(claimed.commandId,client,true);
      if(!current||current.requestHash!==claimed.requestHash||current.ownerKey!==claimed.ownerKey||snapshotDigest(current.owner)!==snapshotDigest(claimed.owner))throw receiptInvalid();
      validateStored(current);
      const receipt=await this.receipt(current.commandId,client);
      if(current.status==='SUCCEEDED')verifyBusinessCommandReceipt(current,receipt);
      else if(receipt)throw receiptInvalid();
      else if(rollbackFailure&&current.status==='RUNNING'){
        // The original domain effects, success state, receipt and audit are one
        // transaction. After proven cleanup, this fresh locked no-receipt row
        // proves that command did not commit; earlier auxiliary commits may
        // still exist and are not represented as rolled back globally.
        if(client)current.leaseActive=(await client.query('select $1::timestamptz>clock_timestamp() as active',[current.leaseUntil])).rows[0].active;
        if(this.owns(current,claimed)){
          Object.assign(current,{status:'FAILED',error:{...rollbackFailure,correlationId:current.commandId},progress:{phase:'Failed'},leaseToken:null,leaseUntil:null,updatedAt:new Date(this.now()).toISOString()});delete current.leaseActive;
          await this.audit(current,queueInternalContext(current,'BUSINESS_COMMAND',this.auditRuntime),'COMMAND_FAILED',client);await this.save(current,client);
        }
      }
      // This is an internal execution outcome, not a request publication. The
      // durable owner intentionally has no enabled/session authority fields;
      // passing it to public commandSummary would reject a named owner and
      // roll back this otherwise verified failure transaction. Public reads
      // still require their original freshly authorized request context.
      return ['SUCCEEDED','FAILED','CANCELLED'].includes(current.status)?{
        commandId:current.commandId,status:current.status,
        result:current.status==='SUCCEEDED'?clone(current.result):null,
        error:current.status==='FAILED'?clone(current.error):null
      }:null;
    };
    return this.pool?this.transaction(resolve):this.local(()=>resolve(null));
  }
  async fail(claimed,error){
    const apply=async(job,client)=>{if(!this.owns(job,claimed))return null;Object.assign(job,{status:'FAILED',error:clone(error),progress:{phase:'Failed'},leaseToken:null,leaseUntil:null,updatedAt:new Date(this.now()).toISOString()});delete job.leaseActive;await this.audit(job,queueInternalContext(job,'BUSINESS_COMMAND',this.auditRuntime),'COMMAND_FAILED',client);await this.save(job,client);return true;};
    return this.pool?this.transaction(async client=>apply(await this.read(claimed.commandId,client,true),client)):this.local(async()=>apply(await this.read(claimed.commandId,null),null));
  }
  async change(id,action,context,{currentContext}={}){
    if(!['cancel','retry'].includes(action))throw httpError(422,'Choose cancel or retry.',{code:'COMMAND_ACTION_INVALID'});
    const apply=async(job,client)=>{
      if(currentContext)context=copyAuditContext(context,await currentContext(client,job));
      this.require(job,context,{execute:true});validateStored(job);if(inspectQueueInitiator(job,'BUSINESS_COMMAND').status==='INVALID')throw queueOriginRefusalError();
      if(action==='cancel'){
        if(job.status==='CANCELLED')return commandSummary(job,context);
        if(!['QUEUED','RUNNING'].includes(job.status))throw httpError(409,job.status==='SUCCEEDED'?'The operation has already committed. Cancellation cannot undo its changes.':'Only a queued or running operation can be cancelled.',{code:'COMMAND_ALREADY_TERMINAL'});
        Object.assign(job,{status:'CANCELLED',progress:{phase:'Cancelled'},error:null});
      }else{
        if(job.status!=='FAILED'||job.error?.retryable!==true||job.attempts>=3)throw httpError(409,'This operation cannot be retried. Reopen and verify its current review before starting a new operation.',{code:'COMMAND_RETRY_NOT_ALLOWED'});
        await this.assertCapacity(job.ownerKey,client);Object.assign(job,{status:'QUEUED',progress:{phase:'Queued for retry'},error:null});
      }
      Object.assign(job,{leaseToken:null,leaseUntil:null,updatedAt:new Date(this.now()).toISOString()});delete job.leaseActive;
      await this.audit(job,context,action==='cancel'?'COMMAND_CANCELLED':'COMMAND_RETRIED',client);await this.save(job,client);return commandSummary(job,context);
    };
    return this.pool?this.transaction(async client=>{if(action==='retry')await client.query('select pg_advisory_xact_lock(78742022)');return apply(await this.read(id,client,true),client);}):this.local(async()=>apply(await this.read(id,null),null));
  }
}
