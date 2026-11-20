import {createHash,randomUUID} from 'node:crypto';
import {workloadAdmissionConfig} from './workload-admission.js';
import {sqlExecutionConfig} from './sql-execution.js';

const rr='replacement_register',lock=78742037;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable=(code='EXECUTION_COORDINATION_UNAVAILABLE')=>Object.assign(Error('Shared execution capacity could not be verified. Check the execution service and retry.'),{status:503,code});
const busy=limits=>Object.assign(Error('An expensive report or validation is already running. Wait briefly and try again.'),{status:429,code:'WORKLOAD_ADMISSION_BUSY',retryAfter:limits.retryAfterSeconds,headers:{'Retry-After':String(limits.retryAfterSeconds)}});
export const executionCoordinationDefaults=Object.freeze({heartbeatMs:3000,readyMs:15000});
export const executionCoordinationTables=Object.freeze(['execution_instances','execution_permits']);
export const executionCoordinationColumns=Object.freeze({
 execution_instances:Object.freeze(['instance_id','host_id','process_id','role','application_hash','store_id','config_fingerprint','config_json','control_backend_pid','control_backend_start','database_name','database_user','state','registered_at','heartbeat_at','stopped_at']),
 execution_permits:Object.freeze(['permit_id','instance_id','owner_key','permit_token','state','acquired_at','released_at','recovered_by_instance_id'])
});
export function executionWorkApplicationName(instanceId){if(!uuid(instanceId))throw TypeError('Execution instance ID must be a UUID.');return 'rr-exec:'+instanceId.toLowerCase();}
export const executionControlApplicationName=instanceId=>executionWorkApplicationName(instanceId)+':control';

/** Canonical retained configuration. Version1 remains byte-compatible with
 * earlier instances; version2 adds only the finite, validated SQL policy. */
export function executionCoordinationConfig({limits={},heartbeatMs=3000,readyMs=15000,sqlPolicy}={}){
 const env={};for(const [key,name]of Object.entries({maxActive:'RR_WORKLOAD_MAX_ACTIVE',maxPerOwner:'RR_WORKLOAD_MAX_PER_OWNER',retryAfterSeconds:'RR_WORKLOAD_RETRY_AFTER_SECONDS'}))if(limits[key]!==undefined)env[name]=String(limits[key]);
 for(const key of Object.keys(limits))if(!['maxActive','maxPerOwner','retryAfterSeconds'].includes(key))throw TypeError('Unsupported execution limit.');
 const admission=workloadAdmissionConfig(env);
 if(!Number.isSafeInteger(heartbeatMs)||heartbeatMs<50||heartbeatMs>60000||!Number.isSafeInteger(readyMs)||readyMs<heartbeatMs*2||readyMs>300000)throw TypeError('Execution heartbeat/readiness intervals are invalid.');
 if(sqlPolicy===undefined)return Object.freeze({version:1,...admission,heartbeatMs,readyMs});
 const fields=['version','statementMs','lockMs','operationMs','cleanupMs','cancelMs'];
 if(!sqlPolicy||typeof sqlPolicy!=='object'||Array.isArray(sqlPolicy)||sqlPolicy.version!==1||Object.keys(sqlPolicy).length!==fields.length||fields.some(field=>!Object.hasOwn(sqlPolicy,field))||Object.keys(sqlPolicy).some(field=>!fields.includes(field))||fields.some(field=>!Number.isSafeInteger(sqlPolicy[field])))throw TypeError('Execution SQL policy must contain its complete canonical numeric fields.');
 const sqlEnv=Object.fromEntries([['statementMs','RR_SQL_STATEMENT_MS'],['lockMs','RR_SQL_LOCK_MS'],['operationMs','RR_SQL_OPERATION_MS'],['cleanupMs','RR_SQL_CLEANUP_MS'],['cancelMs','RR_SQL_CANCEL_MS']].map(([field,name])=>[name,String(sqlPolicy[field])]));
 const validated=sqlExecutionConfig(sqlEnv),policy=Object.freeze({version:1,statementMs:validated.statementMs,lockMs:validated.lockMs,operationMs:validated.operationMs,cleanupMs:validated.cleanupMs,cancelMs:validated.cancelMs});
 return Object.freeze({version:2,...admission,heartbeatMs,readyMs,sqlExecution:policy});
}

/** PostgreSQL owns durable credits. A control socket/heartbeat is readiness,
 * never the lifetime of a credit. No elapsed-time-only orphan recovery exists. */
export class ExecutionCoordinator {
 constructor({pool,rawPool,instanceId,hostId,pid=process.pid,role,applicationHash,storeId,processAlive,verifyIdentity=async()=>true,onFatal=()=>{},limits={},heartbeatMs=3000,readyMs=15000,sqlExecution=null,sqlPolicy}={}){
  this.pool=rawPool||pool;if(!this.pool||typeof this.pool.connect!=='function')throw TypeError('Execution coordination requires a PostgreSQL pool.');
  for(const [name,value]of Object.entries({instanceId,hostId,storeId}))if(!uuid(value))throw TypeError(name+' must be a UUID.');
  if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647||!['api','worker','combined'].includes(role))throw TypeError('Execution process identity is invalid.');
  if(typeof applicationHash!=='string'||!/^[a-f0-9]{64}$/i.test(applicationHash)||typeof processAlive!=='function'||typeof verifyIdentity!=='function'||typeof onFatal!=='function')throw TypeError('Execution build/liveness callbacks are required.');
  if(!Number.isSafeInteger(heartbeatMs)||heartbeatMs<50||heartbeatMs>60000||!Number.isSafeInteger(readyMs)||readyMs<heartbeatMs*2||readyMs>300000)throw TypeError('Execution heartbeat/readiness intervals are invalid.');
  const env={};for(const [key,name]of Object.entries({maxActive:'RR_WORKLOAD_MAX_ACTIVE',maxPerOwner:'RR_WORKLOAD_MAX_PER_OWNER',retryAfterSeconds:'RR_WORKLOAD_RETRY_AFTER_SECONDS'}))if(limits[key]!==undefined)env[name]=String(limits[key]);
  for(const key of Object.keys(limits))if(!['maxActive','maxPerOwner','retryAfterSeconds'].includes(key))throw TypeError('Unsupported execution limit.');
  this.limits=workloadAdmissionConfig(env);Object.assign(this,{instanceId:instanceId.toLowerCase(),hostId:hostId.toLowerCase(),storeId:storeId.toLowerCase(),pid,role,applicationHash:applicationHash.toLowerCase(),processAlive,verifyIdentity,onFatal,heartbeatMs,readyMs});
  if(sqlExecution!==null&&(!sqlExecution||typeof sqlExecution.run!=='function'))throw TypeError('Execution SQL bridge requires a run operation.');
  if(sqlExecution===null&&sqlPolicy!==undefined)throw TypeError('An execution SQL policy requires its scope bridge.');
  const bridgePolicy=sqlExecution===null?undefined:(sqlPolicy??sqlExecution.policy);
  if(sqlExecution!==null&&bridgePolicy===undefined)throw TypeError('Execution SQL bridge requires its complete policy.');
  this.config=executionCoordinationConfig({limits:this.limits,heartbeatMs,readyMs,sqlPolicy:bridgePolicy});
  if(sqlExecution!==null&&sqlPolicy!==undefined&&sqlExecution.policy!==undefined&&JSON.stringify(executionCoordinationConfig({limits:this.limits,heartbeatMs,readyMs,sqlPolicy:sqlExecution.policy}))!==JSON.stringify(this.config))throw TypeError('Execution SQL policy differs from its scope bridge.');
  this.sqlExecution=sqlExecution;this.configFingerprint=hash(this.config);
  // Runtime owns the sole global setUncertainHandler registration. It must
  // call coordinator.fail before any uncertain SQL scope unwinds, including
  // non-admitted API/control paths. Never replace another fatal handler here.
  this.queue=Promise.resolve();this.active=new Set();this.started=false;this.healthy=false;this.closing=false;this.fatal=false;this.heartbeatBusy=false;
  this.admission=Object.freeze({limits:this.limits,run:(options,operation)=>this.run(options,operation),snapshot:()=>this.snapshot()});
 }
 serial(operation){const task=this.queue.then(operation);this.queue=task.catch(()=>{});return task;}
 fail(error=unavailable()){
  this.healthy=false;clearInterval(this.timer);
  if(!this.fatal&&!this.closing){this.fatal=true;try{Promise.resolve(this.onFatal(error.status?error:unavailable())).catch(()=>{});}catch{}}
 }
 assertHealthy(){if(!this.started||!this.healthy||this.closing)throw unavailable();}
 async ensureIdentity(){try{if(await this.verifyIdentity()!==true)throw Error('Identity unavailable.');}catch{const error=unavailable('EXECUTION_IDENTITY_CHANGED');this.fail(error);throw error;}}
 async transaction(operation){
  const client=this.control;if(!client)throw unavailable();
  try{await client.query('begin');await client.query('select pg_advisory_xact_lock($1)',[lock]);const value=await operation(client);await client.query('commit');return value;}
  catch(error){try{await client.query('rollback');}catch{}if(error.code==='WORKLOAD_ADMISSION_BUSY')throw error;this.fail(error.status?error:unavailable());throw error.status?error:unavailable();}
 }
 async actualControl(client,instance){
  // Compare timestamps inside PostgreSQL; JS Date truncates backend_start's
  // microseconds and cannot safely establish a backend generation identity.
  return Boolean((await client.query(`select 1 from ${rr}.execution_instances i join pg_stat_activity a on a.pid=i.control_backend_pid and a.backend_start=i.control_backend_start and a.datname=i.database_name and a.usename=i.database_user and a.application_name='rr-exec:'||i.instance_id::text||':control' where i.instance_id=$1`,[instance.instance_id])).rows[0]);
 }
 async recoverIn(client){
  const candidates=(await client.query(`select i.* from ${rr}.execution_instances i where i.instance_id<>$1 and i.host_id=$2 and (i.state<>'STOPPED' or exists(select 1 from ${rr}.execution_permits p where p.instance_id=i.instance_id and p.state='ACTIVE')) order by i.registered_at for update`,[this.instanceId,this.hostId])).rows;
  let recovered=0;
  for(const instance of candidates){
   let alive;try{alive=await this.processAlive(instance.process_id);}catch{alive='unknown';}
   if(alive!==false)continue;
   // All marked connections must disappear, not merely the control backend.
   // No remote-host row or unknown/PID-reused process is automatically freed.
   const backends=await client.query('select pid from pg_stat_activity where datname=$1 and application_name=any($2::text[])',[instance.database_name,[executionWorkApplicationName(instance.instance_id),executionControlApplicationName(instance.instance_id)]]);
   if(backends.rows.length)continue;
   recovered+=(await client.query(`update ${rr}.execution_permits set state='RECOVERED',released_at=clock_timestamp(),recovered_by_instance_id=$2 where instance_id=$1 and state='ACTIVE'`,[instance.instance_id,this.instanceId])).rowCount;
   await client.query(`update ${rr}.execution_instances set state='STOPPED',stopped_at=coalesce(stopped_at,clock_timestamp()) where instance_id=$1`,[instance.instance_id]);
  }
  return recovered;
 }
 async checkPolicy(client){
  // The first registered store remains the database's file-store identity even
  // after every process stops. A wrong empty path must not silently rebind a
  // quiescent database; a legitimate move/restore preserves its store UUID.
  if((await client.query(`select 1 from ${rr}.execution_instances where store_id<>$1 limit 1`,[this.storeId])).rowCount)throw unavailable('EXECUTION_CONFIG_MISMATCH');
  const instances=(await client.query(`select i.* from ${rr}.execution_instances i where exists(select 1 from ${rr}.execution_permits p where p.instance_id=i.instance_id and p.state='ACTIVE') or (i.state<>'STOPPED' and exists(select 1 from pg_stat_activity a where a.pid=i.control_backend_pid and a.backend_start=i.control_backend_start and a.datname=i.database_name and a.usename=i.database_user and a.application_name='rr-exec:'||i.instance_id::text||':control'))`)).rows;
  if(instances.some(item=>item.application_hash!==this.applicationHash||item.store_id!==this.storeId||item.config_fingerprint!==this.configFingerprint))throw unavailable('EXECUTION_CONFIG_MISMATCH');
 }
 start(){
  if(this.starting)return this.starting;
  if(this.closing)return Promise.reject(unavailable());
  this.starting=this.serial(async()=>{
   let client;
   try{
    await this.ensureIdentity();
    client=await this.pool.connect();this.control=client;
    client.on('error',()=>this.fail());client.on('end',()=>{if(!this.closing)this.fail();});
    await client.query("select set_config('application_name',$1,false),set_config('statement_timeout','5000',false),set_config('lock_timeout','1000',false)",[executionControlApplicationName(this.instanceId)]);
    const identity=(await client.query('select pg_backend_pid() as pid,backend_start::text as backend_start,current_database() as database_name,current_user as database_user from pg_stat_activity where pid=pg_backend_pid()')).rows[0];
    if(!identity)throw unavailable();this.controlIdentity=identity;
    await this.transaction(async connection=>{
     await this.recoverIn(connection);await this.checkPolicy(connection);
     await connection.query(`insert into ${rr}.execution_instances(instance_id,host_id,process_id,role,application_hash,store_id,config_fingerprint,config_json,control_backend_pid,control_backend_start,database_name,database_user,state) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'READY')`,[this.instanceId,this.hostId,this.pid,this.role,this.applicationHash,this.storeId,this.configFingerprint,this.config,identity.pid,identity.backend_start,identity.database_name,identity.database_user]);
    });
    if(this.fatal)throw unavailable();this.started=true;this.healthy=true;
    this.timer=setInterval(()=>{if(this.heartbeatBusy||this.closing)return;this.heartbeatBusy=true;this.heartbeat().catch(()=>{}).finally(()=>{this.heartbeatBusy=false;});},this.heartbeatMs);this.timer.unref();return this;
   }catch(error){this.fail(error.status?error:unavailable());if(client){this.control=null;client.release(true);}throw error.status?error:unavailable();}
  });return this.starting;
 }
 async heartbeat(){
  this.assertHealthy();return this.serial(async()=>{await this.ensureIdentity();return this.transaction(async client=>{
   const instance=(await client.query(`select * from ${rr}.execution_instances where instance_id=$1`,[this.instanceId])).rows[0];
   if(!instance||!await this.actualControl(client,instance)||!['READY','DRAINING'].includes(instance.state))throw unavailable();
   await this.checkPolicy(client);await this.recoverIn(client);
   await client.query(`update ${rr}.execution_instances set heartbeat_at=clock_timestamp() where instance_id=$1 and state in ('READY','DRAINING')`,[this.instanceId]);return true;
  });});
 }
 async ready({role}={}){
  if(!this.started||!this.healthy||this.closing||this.draining)return false;
  if(role!==undefined&&!['api','worker','combined'].includes(role))throw TypeError('Invalid readiness role.');
  try{await this.ensureIdentity();return await this.serial(async()=>{
   const roles=role==='worker'?['worker','combined']:role==='api'?['api','combined']:role?[role]:null;
   const result=await this.control.query(`select 1 from ${rr}.execution_instances i join pg_stat_activity a on a.pid=i.control_backend_pid and a.backend_start=i.control_backend_start and a.datname=i.database_name and a.usename=i.database_user and a.application_name='rr-exec:'||i.instance_id::text||':control' where i.state='READY' and i.heartbeat_at>clock_timestamp()-$1::double precision*interval '1 millisecond' and i.application_hash=$2 and i.store_id=$3 and i.config_fingerprint=$4 and ($5::text[] is null or i.role=any($5)) and ($6::uuid is null or i.instance_id=$6) limit 1`,[this.readyMs,this.applicationHash,this.storeId,this.configFingerprint,roles,role?null:this.instanceId]);return result.rowCount>0;
  });}catch{this.fail();return false;}
 }
 async acquire(ownerKey){
  this.assertHealthy();return this.serial(async()=>{await this.ensureIdentity();return this.transaction(async client=>{
   this.assertHealthy();await this.recoverIn(client);await this.checkPolicy(client);
   const instance=(await client.query(`select * from ${rr}.execution_instances where instance_id=$1`,[this.instanceId])).rows[0];
   if(!instance||!['READY','DRAINING'].includes(instance.state)||!await this.actualControl(client,instance))throw unavailable();
   const counts=(await client.query(`select count(*)::int as active,count(*) filter(where owner_key=$1)::int as owner from ${rr}.execution_permits where state='ACTIVE'`,[ownerKey])).rows[0];
   if(counts.active>=this.limits.maxActive||counts.owner>=this.limits.maxPerOwner)throw busy(this.limits);
   const permit={id:randomUUID(),token:randomUUID()};await client.query(`insert into ${rr}.execution_permits(permit_id,instance_id,owner_key,permit_token,state) values($1,$2,$3,$4,'ACTIVE')`,[permit.id,this.instanceId,ownerKey,permit.token]);return permit;
  });});
 }
 async release(permit){
  // A lost control connection is uncertainty, not evidence that work ended.
  // The durable row is deliberately retained until safe orphan recovery.
  if(!this.healthy||!this.control)return false;
  return this.serial(()=>this.transaction(async client=>{
   const result=await client.query(`update ${rr}.execution_permits set state='RELEASED',released_at=clock_timestamp() where permit_id=$1 and permit_token=$2 and instance_id=$3 and state='ACTIVE'`,[permit.id,permit.token,this.instanceId]);
   if(result.rowCount!==1)throw unavailable('EXECUTION_PERMIT_CHANGED');return true;
  }));
 }
 run({ownerKey,signal}={},operation){
  if(typeof ownerKey!=='string'||!ownerKey||ownerKey.length>256||ownerKey.includes('\0')||typeof operation!=='function')return Promise.reject(TypeError('Execution admission requires an opaque owner key and operation.'));
  if(signal!==undefined&&(!signal||typeof signal!=='object'||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))return Promise.reject(TypeError('Execution signal must be an AbortSignal.'));
  const task=(async()=>{const permit=await this.acquire(ownerKey);try{
   if(!this.healthy||this.closing)throw unavailable();
   return this.sqlExecution?await this.sqlExecution.run(signal===undefined?{}:{signal},operation):await operation();
  }catch(error){
   // Defense for admitted scopes; the runtime's global handler is still
   // required for uncertainty raised by scopes outside this admission path.
   if(error?.code==='SQL_EXECUTION_UNCERTAIN')this.fail(unavailable('SQL_EXECUTION_UNCERTAIN'));
   throw error;
  }finally{await this.release(permit);}})();
  this.active.add(task);task.then(()=>this.active.delete(task),()=>this.active.delete(task));return task;
 }
 async snapshot(){
  this.assertHealthy();try{return await this.serial(async()=>{const active=Number((await this.control.query(`select count(*)::int as active from ${rr}.execution_permits where state='ACTIVE'`)).rows[0].active);return Object.freeze({active,remainingSlots:Math.max(0,this.limits.maxActive-active)});});}catch(error){this.fail();throw error.status?error:unavailable();}
 }
 async beginDrain(){
  // The host first stops HTTP acceptance/new claims. Accepted runner callbacks
  // can still acquire capacity while readiness is withdrawn; close seals it.
  this.assertHealthy();this.draining=true;
  return this.serial(()=>this.transaction(async client=>{await client.query(`update ${rr}.execution_instances set state='DRAINING' where instance_id=$1 and state='READY'`,[this.instanceId]);return true;}));
 }
 close(){
  if(this.closingPromise)return this.closingPromise;
  this.closing=true;clearInterval(this.timer);
  this.closingPromise=(async()=>{
   if(this.starting)await this.starting.catch(()=>{});
   if(this.healthy&&this.control)await this.serial(()=>this.transaction(client=>client.query(`update ${rr}.execution_instances set state='DRAINING' where instance_id=$1 and state='READY'`,[this.instanceId]))).catch(()=>{});
   await Promise.allSettled([...this.active]);
   if(this.healthy&&this.control)await this.serial(()=>this.transaction(async client=>{const count=(await client.query(`select count(*)::int as active from ${rr}.execution_permits where instance_id=$1 and state='ACTIVE'`,[this.instanceId])).rows[0].active;if(count)throw unavailable();await client.query(`update ${rr}.execution_instances set state='STOPPED',stopped_at=clock_timestamp() where instance_id=$1`,[this.instanceId]);})).catch(()=>{});
   clearInterval(this.timer);const client=this.control;this.control=null;this.healthy=false;if(client)client.release(true);
  })();return this.closingPromise;
 }
}
