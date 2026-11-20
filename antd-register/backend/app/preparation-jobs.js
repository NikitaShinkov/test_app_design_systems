import {copyAuditContext} from './audit-provenance.js';
import {auditEventProvenance} from './audit-writer.js';
import {captureQueueInitiator,queueEventContext,queueWorkerContext,queueInternalContext,inspectQueueInitiator,queueOriginRefusalError,queueRefusalStatus,queueRefusalContext} from './audit-queue-origin.js';
import {replacePrivateFile} from './atomic-file.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {httpError,lockNamedReleaseAccount,currentNamedReleaseContext} from './auth.js';
import {publishNamedRead} from './named-read.js';
import {workloadOwnerKey} from './workload-admission.js';
import {createJobExecutionControl,withJobExecutionControl,publishJobExecution,resolveRunnerSqlOutcome,settledSqlFailure} from './business-command-runner.js';
import {safeFileOperationFailure} from './file-operation-errors.js';
import {moduleFor,canUseModule} from './workflow.js';
import {normalize} from './normalization.js';
import {snapshotDigest} from './export-jobs.js';
import {filePreparationKinds,filePreparationAllowed,validateFilePreparationDescriptor,filePreparationResultMatches,filePreparationProgress} from './file-preparations.js';
import {safeBackgroundErrorRecord} from './request-errors.js';
import {admissionDefaults,requestAdmissionConfig,assertPreparationAdmission} from './request-admission.js';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const preparationOwner=context=>({authenticated:Boolean(context.authenticated),userId:context.userId||null,role:context.role,actor:context.actor,organization:context.organization||'',orders:[...new Set((context.orders||[]).map(normalize))].sort()});
const ownerKey=context=>context.authenticated?context.userId:snapshotDigest(preparationOwner(context));
const scopeKey=context=>snapshotDigest({...preparationOwner(context),actor:null});
function allowed(job,context){return Boolean(job)&&(filePreparationKinds.has(job.descriptor.kind)?filePreparationAllowed(job.descriptor,context):canUseModule(moduleFor(job.descriptor.moduleId),context.role))&&(context.role==='ADMINISTRATOR'||(job.ownerKey===ownerKey(context)&&scopeKey(context)===scopeKey(job.descriptor.owner)));}
function requireJob(job,context){if(!allowed(job,context))throw httpError(404,'Preparation job not found.');return job;}
const fromRow=row=>row?{jobId:row.job_id,ownerKey:row.owner_key,initiatorProvenance:row.audit_initiator_provenance_text??null,idempotencyKey:row.idempotency_key,requestHash:row.request_hash,descriptor:row.descriptor,status:row.status,attempts:row.attempts,leaseToken:row.lease_token,leaseUntil:row.lease_until?.toISOString(),progress:row.progress,result:row.result,error:row.error,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()}:null;
export function preparationSummary(job){return {preparationId:job.jobId,moduleId:job.descriptor.moduleId,kind:job.descriptor.kind||'EXPORT',...(filePreparationKinds.has(job.descriptor.kind)&&job.descriptor.filename?{filename:job.descriptor.filename}:{}),status:job.status,attempts:job.attempts,progress:job.progress,createdAt:job.createdAt,updatedAt:job.updatedAt,result:job.result,error:job.error};}
export class PreparationJobs {
  constructor(artifacts,storage,{now=()=>Date.now(),leaseMs=30000,admission=requestAdmissionConfig(process.env),auditRuntime=storage.auditRuntime||null}={}){assertPreparationAdmission({global:0,owner:0},admission);this.admission=Object.freeze({...admissionDefaults,...admission});this.artifacts=artifacts;this.storage=storage;this.auditRuntime=auditRuntime;this.pool=storage.rawPool||storage.pool||null;this.directory=path.join(artifacts.root,'preparations');this.now=now;this.leaseMs=leaseMs;this.queue=Promise.resolve();this.resolveExisting=null;}
  async local(task){const pending=this.queue.then(task);this.queue=pending.catch(()=>{});return pending;}
  file(id){if(!uuid(id))throw httpError(404,'Preparation job not found.');return path.join(this.directory,id+'.json');}
  async read(id,client=this.pool,lock=false){if(!uuid(id))throw httpError(404,'Preparation job not found.');if(this.pool)return fromRow((await client.query(`select *,initiator_provenance_json::text as audit_initiator_provenance_text from replacement_register.preparation_jobs where job_id=$1${lock?' for update':''}`,[id])).rows[0]);try{return JSON.parse(await fs.readFile(this.file(id),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return null;}}
  async write(job){await fs.mkdir(this.directory,{recursive:true,mode:0o700});let retained;try{retained=JSON.parse(await fs.readFile(this.file(job.jobId),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}if(retained)job.initiatorProvenance=retained.initiatorProvenance??null;await replacePrivateFile(this.file(job.jobId),JSON.stringify(job));}
  async all(){let names=[];try{names=await fs.readdir(this.directory);}catch(error){if(error.code!=='ENOENT')throw error;}return Promise.all(names.filter(name=>uuid(name.slice(0,-5))&&name.endsWith('.json')).map(name=>this.read(name.slice(0,-5))));}
  async get(id,context){return publishNamedRead(this.pool,context,async()=>preparationSummary(requireJob(await this.read(id),context)),{code:'PREPARATION_ACCOUNT_CHANGED'});}
  async list(context){return publishNamedRead(this.pool,context,async()=>{const jobs=this.pool?(await this.pool.query(`select *,initiator_provenance_json::text as audit_initiator_provenance_text from replacement_register.preparation_jobs${context.role==='ADMINISTRATOR'?'':' where owner_key=$1'} order by created_at desc,job_id desc limit 100`,context.role==='ADMINISTRATOR'?[]:[ownerKey(context)])).rows.map(fromRow):(await this.all()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return jobs.filter(job=>allowed(job,context)).slice(0,100).map(preparationSummary);},{code:'PREPARATION_ACCOUNT_CHANGED'});}
  async requestContext(client,context){await lockNamedReleaseAccount(client,context);const current=copyAuditContext(context,await currentNamedReleaseContext(client,context));if(scopeKey(current)!==scopeKey(context))throw httpError(403,'Your account or assigned scope changed. Refresh the file operation before continuing.',{code:'PREPARATION_ACCOUNT_CHANGED'});return current;}
  async audit(job,context,action,client=null,phase=null){context=queueEventContext(context,job,'PREPARATION',phase||(action==='PREPARATION_QUEUED'?'QUEUE':action==='PREPARATION_CANCELLED'||action==='PREPARATION_RETRIED'?'CONTROL':'WORKER'),this.auditRuntime);const after=preparationSummary(job),label=job.descriptor.moduleId||job.descriptor.kind||'EXPORT';if(client)await this.storage.writeAudit(client,context,action,job.jobId,`${label}: ${job.status}`,null,after);else{job.events||=[];job.events.push({id:randomUUID(),jobId:job.jobId,sequence:job.events.length+1,occurredAt:new Date(this.now()).toISOString(),actor:context.actor,actorUserId:context.userId||null,role:context.role,action,subject:job.jobId,detail:`${label}: ${job.status}`,before:null,after,provenance:auditEventProvenance(context,this.auditRuntime)});}}
  async listAuditEvents(){if(this.pool)return [];let refusals=[];try{refusals=JSON.parse(await fs.readFile(path.join(this.directory,'audit-refusals.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}return [...(await this.all()).flatMap(job=>job.events||[]),...refusals];}
  async refuseOrigin(job,client){
    this.originRefusalStatus=queueRefusalStatus(job,'PREPARATION');const context=queueRefusalContext(job,'PREPARATION',this.auditRuntime),after={preparationId:job.jobId,status:job.status,attempts:job.attempts,code:'AUDIT_PROVENANCE_INVALID'},detail='Stored queue audit provenance refused execution.';
    if(client)return this.storage.writeAudit(client,context,'PREPARATION_AUDIT_REFUSED',job.jobId,detail,null,after);
    const filename=path.join(this.directory,'audit-refusals.json');let events=[];try{events=JSON.parse(await fs.readFile(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}events.push({id:randomUUID(),jobId:job.jobId,sequence:events.length+1,occurredAt:new Date(this.now()).toISOString(),actor:context.actor,actorUserId:null,role:context.role,action:'PREPARATION_AUDIT_REFUSED',subject:job.jobId,detail,before:null,after,provenance:auditEventProvenance(context,this.auditRuntime)});await replacePrivateFile(filename,JSON.stringify(events));
  }
  async transaction(action){const client=await this.pool.connect();try{await client.query('begin');const result=await action(client);await client.query('commit');return result;}catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}}
  async saveSql(job,client){await client.query('update replacement_register.preparation_jobs set status=$2,attempts=$3,lease_token=$4,lease_until=$5,progress=$6,result=$7,error=$8,updated_at=$9 where job_id=$1',[job.jobId,job.status,job.attempts,job.leaseToken||null,job.leaseUntil||null,job.progress,job.result||null,job.error||null,job.updatedAt]);}
  async assertCapacity(owner,client=null,jobs=null){
    const active=jobs||(!client?await this.all():null),counts=client?(await client.query("select count(*)::text as global,count(*) filter(where owner_key=$1)::text as owner from replacement_register.preparation_jobs where status in ('QUEUED','RUNNING')",[owner])).rows[0]:{global:active.filter(job=>['QUEUED','RUNNING'].includes(job.status)).length,owner:active.filter(job=>['QUEUED','RUNNING'].includes(job.status)&&job.ownerKey===owner).length};
    assertPreparationAdmission({global:Number(counts.global),owner:Number(counts.owner)},this.admission);
  }
  async enqueue(descriptor,context,idempotencyKey=randomUUID(),{retainInput=null}={}){
    const kind=descriptor.kind||'EXPORT';
    if(retainInput&&(kind!=='ATTACHMENT'||typeof retainInput!=='function'))throw new Error('Deferred input retention belongs to attachment uploads only.');
    if(filePreparationKinds.has(kind)){if(!retainInput)validateFilePreparationDescriptor(descriptor,context,await this.artifacts.get(descriptor.input?.artifactId,context));}else if(!canUseModule(moduleFor(descriptor.moduleId),context.role)||!(kind==='IMPORT'?['M02','M04','M08']:kind==='EXPORT'?['M01','M03','M05','M06','M07','M09','REGISTER_REPORT']:[]).includes(descriptor.moduleId))throw httpError(403,'This preparation is unavailable for your role.');
    if(kind==='IMPORT'&&(!descriptor.input||!uuid(descriptor.input.artifactId)||(descriptor.batchId&&(!uuid(descriptor.batchId)||!Number.isSafeInteger(descriptor.revision)||descriptor.revision<1))))throw httpError(422,'An import preparation requires its retained input and a valid refresh revision.');
    if(typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9._:-]{1,120}$/.test(idempotencyKey))throw httpError(422,'Use an idempotency key of 1–120 letters, numbers, dots, colons, dashes or underscores.');
    const owner=preparationOwner(context),requestHash=snapshotDigest({...descriptor,...(descriptor.input?{input:{sha256:descriptor.input.sha256,bytes:descriptor.input.bytes}}:{})}),createdAt=new Date(this.now()).toISOString(),job={jobId:randomUUID(),ownerKey:ownerKey(context),idempotencyKey,requestHash,descriptor:{...descriptor,owner},status:'QUEUED',attempts:0,progress:{phase:'Queued'},createdAt,updatedAt:createdAt};
    const existing=previous=>{requireJob(previous,context);if(previous.requestHash!==requestHash)throw httpError(409,'This idempotency key belongs to another preparation request.',{code:'PREPARATION_KEY_CONFLICT'});return preparationSummary(previous);};
    const retain=async client=>{if(!retainInput)return;const item=await retainInput(client);if(item.sha256!==descriptor.input?.sha256||item.bytes!==descriptor.input?.bytes)throw httpError(409,'The retained attachment differs from the upload request.',{code:'ATTACHMENT_INPUT_CHANGED'});job.descriptor={...job.descriptor,input:{artifactId:item.artifactId,sha256:item.sha256,bytes:item.bytes}};validateFilePreparationDescriptor(job.descriptor,context,item);};
    if(this.pool)return this.transaction(async client=>{await client.query('select pg_advisory_xact_lock(78742008)');context=await this.requestContext(client,context);const previous=fromRow((await client.query('select *,initiator_provenance_json::text as audit_initiator_provenance_text from replacement_register.preparation_jobs where owner_key=$1 and idempotency_key=$2',[job.ownerKey,idempotencyKey])).rows[0]);if(previous)return existing(previous);job.initiatorProvenance=captureQueueInitiator(context,job,'PREPARATION',this.auditRuntime);await this.assertCapacity(job.ownerKey,client);await retain(client);const inserted=await client.query("insert into replacement_register.preparation_jobs(job_id,owner_key,idempotency_key,request_hash,descriptor,status,initiator_provenance_json) values($1,$2,$3,$4,$5,'QUEUED',$6::jsonb) on conflict(owner_key,idempotency_key) do nothing returning job_id",[job.jobId,job.ownerKey,idempotencyKey,requestHash,job.descriptor,job.initiatorProvenance]);if(!inserted.rowCount)return existing(fromRow((await client.query('select *,initiator_provenance_json::text as audit_initiator_provenance_text from replacement_register.preparation_jobs where owner_key=$1 and idempotency_key=$2',[job.ownerKey,idempotencyKey])).rows[0]));await this.audit(job,context,'PREPARATION_QUEUED',client);return preparationSummary(job);});
    return this.local(async()=>{const jobs=await this.all(),previous=jobs.find(row=>row.ownerKey===job.ownerKey&&row.idempotencyKey===idempotencyKey);if(previous)return existing(previous);job.initiatorProvenance=captureQueueInitiator(context,job,'PREPARATION',this.auditRuntime);await this.assertCapacity(job.ownerKey,null,jobs);await retain(null);await this.audit(job,context,'PREPARATION_QUEUED');await this.write(job);return preparationSummary(job);});
  }
  async claim(){
    if(this.originRefusalStatus)throw queueOriginRefusalError();
    const take=async(job,client)=>{if(!job)return null;if(inspectQueueInitiator(job,'PREPARATION').status==='INVALID'){await this.refuseOrigin(job,client);return null;}job.updatedAt=new Date(this.now()).toISOString();if(job.attempts>=3){job.status='FAILED';job.error={code:'PREPARATION_INTERRUPTED',message:'Preparation was interrupted three times. Start a new preparation after checking the service.'};job.leaseToken=null;job.leaseUntil=null;await this.audit(job,queueInternalContext(job,'PREPARATION',this.auditRuntime),'PREPARATION_FAILED',client);}else{job.status='RUNNING';job.attempts++;job.leaseToken=randomUUID();job.leaseUntil=new Date(this.now()+this.leaseMs).toISOString();job.progress={phase:job.attempts>1?'Resuming interrupted preparation':'Starting preparation'};await this.audit(job,queueInternalContext(job,'PREPARATION',this.auditRuntime),'PREPARATION_STARTED',client);}if(client)await this.saveSql(job,client);else await this.write(job);return job.status==='RUNNING'?job:null;};
    try{const result=this.pool?await this.transaction(async client=>take(fromRow((await client.query("select *,initiator_provenance_json::text as audit_initiator_provenance_text from replacement_register.preparation_jobs where status='QUEUED' or (status='RUNNING' and lease_until<now()) order by created_at,job_id for update skip locked limit 1")).rows[0]),client)):await this.local(async()=>take((await this.all()).filter(row=>row.status==='QUEUED'||(row.status==='RUNNING'&&Date.parse(row.leaseUntil)<this.now())).sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]));if(this.originRefusalStatus)throw queueOriginRefusalError();return result;}catch(error){if(this.originRefusalStatus)throw queueOriginRefusalError();throw error;}
  }
  async heartbeat(job,progress=null){
    const until=new Date(this.now()+this.leaseMs).toISOString(),at=new Date(this.now()).toISOString();
    if(this.pool){const result=await this.pool.query("update replacement_register.preparation_jobs set lease_until=$3,updated_at=$4,progress=coalesce($5,progress) where job_id=$1 and lease_token=$2 and status='RUNNING' and lease_until>now()",[job.jobId,job.leaseToken,until,at,progress]);return result.rowCount===1;}
    return this.local(async()=>{const current=await this.read(job.jobId);if(!this.owns(current,job))return false;Object.assign(current,{leaseUntil:until,updatedAt:at,...(progress?{progress}:{})});await this.write(current);return true;});
  }
  owns(current,claimed){return current?.status==='RUNNING'&&current.leaseToken===claimed.leaseToken&&Date.parse(current.leaseUntil)>this.now();}
  async checkpoint(claimed,publish){
    const apply=async(current,client)=>{
      if(!this.owns(current,claimed))throw httpError(409,'This preparation was cancelled or its worker lease expired.',{code:'PREPARATION_LEASE_LOST'});
      if(inspectQueueInitiator(current,'PREPARATION').status==='INVALID')throw queueOriginRefusalError();
      const result=await publish(client);
      // This transaction/local queue still owns the same locked job row. Give
      // the resumed nonterminal phase a fresh lease even after a long publish.
      Object.assign(current,{leaseUntil:new Date(this.now()+this.leaseMs).toISOString(),updatedAt:new Date(this.now()).toISOString()});
      if(client)await this.saveSql(current,client);else await this.write(current);return result;
    };
    return publishJobExecution(this,claimed,{},()=>this.pool?this.transaction(async client=>apply(await this.read(claimed.jobId,client,true),client)):this.local(async()=>apply(await this.read(claimed.jobId))));
  }
  async complete(claimed,context,publish){
    const finish=async(current,client)=>{if(!this.owns(current,claimed))throw httpError(409,'This preparation was cancelled or its worker lease expired.',{code:'PREPARATION_LEASE_LOST'});const file=filePreparationKinds.has(current.descriptor.kind);if(file)requireJob(current,context);context=queueWorkerContext(context,current,'PREPARATION',this.auditRuntime);const result=(!client&&file?await this.readFileResult(current,context):null)||await publish(client);if(file?!filePreparationResultMatches(current,result):(current.descriptor.kind==='IMPORT'?result?.kind!=='IMPORT'||result?.preparationId!==current.jobId||result?.batchId!==(current.descriptor.batchId||current.jobId)||!Number.isSafeInteger(result?.revision)||result.revision<1:result?.jobId!==current.jobId))throw new Error('Preparation returned an unrelated review.');if(!client&&file)await this.writeFileResult(current,result);Object.assign(current,{status:'SUCCEEDED',result,error:null,progress:{phase:file?filePreparationProgress(current.descriptor.kind):current.descriptor.kind==='IMPORT'?'Ready for import review':'Ready for filename review'},leaseToken:null,leaseUntil:null,updatedAt:new Date(this.now()).toISOString()});await this.audit(current,context,'PREPARATION_SUCCEEDED',client);if(client)await this.saveSql(current,client);else await this.write(current);return preparationSummary(current);};
    return publishJobExecution(this,claimed,{terminal:true},()=>this.pool?this.transaction(async client=>finish(await this.read(claimed.jobId,client,true),client)):this.local(async()=>finish(await this.read(claimed.jobId))));
  }
  async resolveExecution(claimed){
    // Inputs and scan checkpoints can survive independently of the final job
    // publication. A command's no-receipt rollback proof cannot classify this
    // whole preparation as failed. Validate a terminal typed result here;
    // unresolved publication stays on its existing typed recovery path.
    const resolve=async client=>{
      const current=await this.read(claimed.jobId,client,true);
      if(!current||current.requestHash!==claimed.requestHash||current.ownerKey!==claimed.ownerKey)throw httpError(409,'The retained preparation identity failed verification.',{code:'PREPARATION_RESULT_INVALID'});
      if(current.status==='SUCCEEDED'){
        const file=filePreparationKinds.has(current.descriptor.kind),result=current.result;
        const valid=file?filePreparationResultMatches(current,result):current.descriptor.kind==='IMPORT'?result?.kind==='IMPORT'&&result?.preparationId===current.jobId&&result?.batchId===(current.descriptor.batchId||current.jobId)&&Number.isSafeInteger(result?.revision)&&result.revision>=1:result?.jobId===current.jobId;
        if(!valid)throw httpError(409,'The retained preparation result failed verification.',{code:'PREPARATION_RESULT_INVALID'});
      }
      return ['SUCCEEDED','FAILED','CANCELLED'].includes(current.status)?preparationSummary(current):null;
    };
    return this.pool?this.transaction(resolve):this.local(()=>resolve(null));
  }
  async readFileResult(job,context){
    if(!filePreparationKinds.has(job.descriptor.kind))return null;requireJob(job,context);
    if(this.pool)return job.status==='SUCCEEDED'&&filePreparationResultMatches(job,job.result)?job.result:null;
    try{const receipt=JSON.parse(await fs.readFile(this.file(job.jobId).replace(/\.json$/,'.result.json'),'utf8'));if(receipt.requestHash!==job.requestHash||!filePreparationResultMatches(job,receipt.result))throw httpError(409,'The saved file preparation receipt does not match its request.',{code:'FILE_PREPARATION_RECEIPT_INVALID'});return receipt.result;}catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async writeFileResult(job,result){await fs.mkdir(this.directory,{recursive:true,mode:0o700});await replacePrivateFile(this.file(job.jobId).replace(/\.json$/,'.result.json'),JSON.stringify({requestHash:job.requestHash,result}));}
  async fail(claimed,error){const finish=async(current,client)=>{if(!this.owns(current,claimed))return;Object.assign(current,{status:'FAILED',error,leaseToken:null,leaseUntil:null,updatedAt:new Date(this.now()).toISOString()});await this.audit(current,queueInternalContext(current,'PREPARATION',this.auditRuntime),'PREPARATION_FAILED',client);if(client)await this.saveSql(current,client);else await this.write(current);};return this.pool?this.transaction(async client=>finish(await this.read(claimed.jobId,client,true),client)):this.local(async()=>finish(await this.read(claimed.jobId)));}
  async change(id,action,context){
    const change=async(job,client)=>{requireJob(job,context);if(inspectQueueInitiator(job,'PREPARATION').status==='INVALID')throw queueOriginRefusalError();if(action==='cancel'){if(job.status==='CANCELLED')return preparationSummary(job);if(job.status==='SUCCEEDED')throw httpError(409,'The preparation is already ready for review. Close its review to leave it unconfirmed.',{code:'PREPARATION_ALREADY_READY'});if(!client&&this.resolveExisting){const result=await this.resolveExisting(job,context);if(result){Object.assign(job,{status:'SUCCEEDED',result,error:null,leaseToken:null,leaseUntil:null,updatedAt:new Date(this.now()).toISOString()});await this.audit(job,context,'PREPARATION_SUCCEEDED',null,'CONTROL');await this.write(job);throw httpError(409,'The file was prepared before interruption and is already ready for review.',{code:'PREPARATION_ALREADY_READY'});}}job.status='CANCELLED';job.progress={phase:'Cancelled'};}else{if(job.status!=='FAILED')throw httpError(409,'Only a failed preparation can be retried.');if(job.attempts>=3)throw httpError(409,'Start a new preparation after checking the service; this job reached three attempts.');await this.checkRetry?.(job,context,client);await this.assertCapacity(job.ownerKey,client);job.status='QUEUED';job.error=null;job.progress={phase:'Queued for retry'};}job.leaseToken=null;job.leaseUntil=null;job.updatedAt=new Date(this.now()).toISOString();await this.audit(job,context,action==='cancel'?'PREPARATION_CANCELLED':'PREPARATION_RETRIED',client);if(client)await this.saveSql(job,client);else await this.write(job);return preparationSummary(job);};
    return this.pool?this.transaction(async client=>{if(action!=='cancel')await client.query('select pg_advisory_xact_lock(78742008)');const job=await this.read(id,client,true);context=await this.requestContext(client,context);return change(job,client);}):this.local(async()=>change(await this.read(id)));
  }
}

export class PreparationRunner {
  constructor(jobs,execute,{intervalMs=1000,admission=null,sqlExecution=null,keepAlive=false,heartbeatMs=3000,logError=record=>console.error(JSON.stringify(record))}={}){this.jobs=jobs;this.execute=execute;this.intervalMs=intervalMs;this.admission=admission;this.sqlExecution=sqlExecution;this.keepAlive=keepAlive;this.heartbeatMs=heartbeatMs;this.logError=logError;this.running=false;this.closed=false;this.tickPromise=null;this.shutdownAborted=false;}
  unscoped(operation){return this.sqlExecution?this.sqlExecution.runUnscoped(operation):operation();}
  schedule(delay){clearTimeout(this.timer);if(this.closed)return;this.timer=setTimeout(()=>{this.tick().catch(error=>this.logError(safeBackgroundErrorRecord(error,{stage:'PREPARATION_QUEUE'})));},delay);if(!this.keepAlive)this.timer.unref();}
  wake(){if(!this.closed&&!this.running)this.schedule(0);}
  tick(){
    if(this.closed||this.running)return this.tickPromise||Promise.resolve();
    this.running=true;
    const dispatch=()=>this.runTick(),pending=Promise.resolve().then(()=>this.sqlExecution?.withoutScope?this.sqlExecution.withoutScope(dispatch):dispatch()).finally(()=>{this.running=false;if(this.tickPromise===pending)this.tickPromise=null;if(!this.closed)this.schedule(this.intervalMs);});this.tickPromise=pending;return pending;
  }
  async runTick(){
    try{
      if(this.closed)return;
      const job=await this.unscoped(()=>this.jobs.claim());
      if(job&&!this.shutdownAborted){
        const ownerKey=workloadOwnerKey(job.descriptor.owner),control=createJobExecutionControl(this.jobs,job,{sqlExecution:this.sqlExecution,keepAlive:this.keepAlive,heartbeatMs:this.heartbeatMs,leaseCode:'PREPARATION_LEASE_LOST',heartbeatStage:'PREPARATION_HEARTBEAT',jobId:job.jobId,logError:this.logError});this.controller=control.controller;
        try{
          for(;;){
            try{
              const execute=async()=>{try{return await withJobExecutionControl(this.jobs,job,control,()=>this.execute(job,control));}finally{await control.finish();}};
              if(this.admission)await this.admission.run({ownerKey,signal:control.signal},execute);else await execute();break;
            }catch(error){
              if(error.code!=='WORKLOAD_ADMISSION_BUSY')throw error;
              await control.progress('Waiting for an execution slot');
              await new Promise(resolve=>{const done=()=>{clearTimeout(timer);control.signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,1000);control.signal.addEventListener('abort',done,{once:true});if(control.signal.aborted)done();});
              if(control.signal.aborted)throw httpError(409,'Preparation lease lost.',{code:'PREPARATION_LEASE_LOST'});
            }
          }
        }catch(error){
          const handled=await resolveRunnerSqlOutcome(error,this.jobs,job,{admission:this.admission,sqlExecution:this.sqlExecution,ownerKey,logError:this.logError,stage:'PREPARATION_EXECUTE',jobId:job.jobId});
          if(!handled&&error.code!=='PREPARATION_LEASE_LOST'&&!control.signal.aborted){
            if(!error.status||error.status>=500)this.logError(safeBackgroundErrorRecord(error,{stage:'PREPARATION_EXECUTE',jobId:job.jobId}));
            await this.unscoped(()=>this.jobs.fail(job,{...(settledSqlFailure(error)||safeFileOperationFailure(error)||{status:error.status&&error.status<500?error.status:500,code:error.code||'PREPARATION_FAILED',message:error.status&&error.status<500?error.message:'File preparation failed. Retry or contact the administrator.',details:error.status&&error.status<500?error.details||[]:[]}),...(job.descriptor?.moduleId==='REGISTER_REPORT'?{correlationId:job.jobId}:{})}));
          }
        }finally{await control.finish();this.controller=null;}
      }
    }catch(error){if(error.code==='AUDIT_PROVENANCE_INVALID'&&error.stopClaimLoop===true){this.closed=true;this.originRefusalStatus=this.jobs.originRefusalStatus||Object.freeze({code:'AUDIT_PROVENANCE_INVALID',stopClaimLoop:true,requiresOperatorReview:true});clearTimeout(this.timer);}this.logError(safeBackgroundErrorRecord(error,{stage:'PREPARATION_QUEUE'}));}
  }
  abort(){this.shutdownAborted=true;this.controller?.abort();}
  close({abort=true}={}){this.closed=true;clearTimeout(this.timer);if(abort)this.abort();return this.tickPromise||Promise.resolve();}
}
