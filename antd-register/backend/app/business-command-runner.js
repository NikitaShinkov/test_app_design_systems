import {safeBackgroundErrorRecord} from './request-errors.js';
import {workloadOwnerKey} from './workload-admission.js';

const retryableCodes=new Set(['08000','08003','08006','57P01','57P02','57P03','ECONNRESET','ECONNREFUSED','ETIMEDOUT']);
const sqlFailures=Object.freeze({
  SQL_EXECUTION_ABORTED:[409,'The operation was cancelled after its SQL work was rolled back.'],
  SQL_OPERATION_TIMEOUT:[504,'The operation exceeded its time limit and its SQL work was rolled back.'],
  SQL_STATEMENT_TIMEOUT:[504,'A database statement exceeded its time limit and its SQL work was rolled back.'],
  SQL_LOCK_TIMEOUT:[504,'A database lock wait exceeded its time limit and its SQL work was rolled back.'],
  SQL_TRANSACTION_INCOMPLETE:[500,'The operation left an incomplete database transaction, which was rolled back.']
});
const commandRollbackMessages=Object.freeze({
  SQL_EXECUTION_ABORTED:'The command transaction was rolled back after cancellation. Refresh the saved status before trying again.',
  SQL_OPERATION_TIMEOUT:'The command transaction was rolled back after its time limit was reached. Refresh the saved status before trying again.',
  SQL_STATEMENT_TIMEOUT:'The command transaction was rolled back after a database statement exceeded its time limit. Refresh the saved status before trying again.',
  SQL_LOCK_TIMEOUT:'The command transaction was rolled back after a database lock wait exceeded its time limit. Refresh the saved status before trying again.'
});
export function settledSqlFailure(error){
  const definition=error?.outcome==='ROLLED_BACK'&&Object.hasOwn(sqlFailures,error.code)&&sqlFailures[error.code];
  return definition?{status:definition[0],code:error.code,message:definition[1],details:[],retryable:error.code!=='SQL_TRANSACTION_INCOMPLETE'}:null;
}
export function witnessedSqlRollbackFailure(sqlExecution,error){
  // Public/forged error fields are not evidence. Only the adapter which owned
  // the settled scope can vouch for this exact final Error identity.
  const witness=sqlExecution?.getSettledOutcome?.(error);
  if(!witness||!Object.isFrozen(witness)||witness.kind!=='CHECK_RECEIPT'||witness.cleanupProven!==true||!['SQL_EXECUTION_ABORTED','SQL_OPERATION_TIMEOUT','SQL_STATEMENT_TIMEOUT','SQL_LOCK_TIMEOUT'].includes(witness.causeCode))return null;
  return {...settledSqlFailure({code:witness.causeCode,outcome:'ROLLED_BACK'}),message:commandRollbackMessages[witness.causeCode]};
}
export function businessCommandFailure(error){
  const sql=settledSqlFailure(error);if(sql)return sql;
  const client=Number.isInteger(error?.status)&&error.status>=400&&error.status<500;
  return {status:client?error.status:500,code:client&&typeof error.code==='string'?error.code:'COMMAND_FAILED',message:client?error.message:'The confirmed operation could not be completed. Check the service and retry only when offered.',details:client&&Array.isArray(error.details)?error.details:[],retryable:!client&&retryableCodes.has(error?.code)};
}

// Ephemeral phase ownership never enters a descriptor, audit, receipt or clone.
// Stop and settle pulses BEFORE acquiring the row which those pulses update.
const executionControls=new WeakMap();
const executionKey=job=>`${job.commandId||job.jobId}:${job.leaseToken}`;
export async function withJobExecutionControl(repository,job,control,operation){
  let controls=executionControls.get(repository);if(!controls){controls=new Map();executionControls.set(repository,controls);}
  const key=executionKey(job);if(controls.has(key))throw Error('A job already has an execution owner.');controls.set(key,control);
  try{return await operation();}finally{controls.delete(key);if(!controls.size)executionControls.delete(repository);}
}
export function publishJobExecution(repository,job,{terminal=false}={},operation){
  const control=executionControls.get(repository)?.get(executionKey(job));
  return control?control.publish({terminal},operation):operation();
}
export function createJobExecutionControl(jobs,job,{sqlExecution=null,keepAlive=false,heartbeatMs=3000,leaseCode,heartbeatStage,jobId,logError}={}){
  if(!Number.isSafeInteger(heartbeatMs)||heartbeatMs<1)throw TypeError('A positive heartbeat interval is required.');
  const controller=new AbortController(),unscoped=operation=>sqlExecution?sqlExecution.runUnscoped(operation):operation();
  const lost=()=>Object.assign(new Error('The job worker stopped or lost its current execution lease.'),{status:409,code:leaseCode});
  let pulsePending=null,paused=0,terminal=false,finished=false;
  const check=()=>{if(controller.signal.aborted)throw lost();};
  const renew=phase=>{
    check();if(paused||terminal||finished)return Promise.resolve();
    if(pulsePending)return pulsePending.then(()=>renew(phase));
    const pending=Promise.resolve().then(()=>unscoped(()=>jobs.heartbeat(job,phase===undefined?null:{phase}))).then(owned=>{if(!owned)throw lost();}).catch(error=>{
      controller.abort(error);logError(safeBackgroundErrorRecord(error,{stage:heartbeatStage,jobId}));throw error;
    });
    pulsePending=pending;pending.then(()=>{if(pulsePending===pending)pulsePending=null;},()=>{if(pulsePending===pending)pulsePending=null;});return pending;
  };
  const timer=setInterval(()=>{if(!paused&&!terminal&&!finished&&!pulsePending&&!controller.signal.aborted)renew().catch(()=>{});},heartbeatMs);if(!keepAlive)timer.unref();
  return {
    controller,signal:controller.signal,progress:phase=>renew(phase),
    async publish({terminal:completing=false},operation){
      paused++;if(completing){terminal=true;clearInterval(timer);}
      try{await pulsePending;check();return await operation();}finally{paused--;}
    },
    async finish(){
      finished=true;clearInterval(timer);
      // Rejected pulses have already aborted/logged execution. Cleanup cannot
      // replace a committed result with a later heartbeat error.
      await pulsePending?.catch(()=>{});
    }
  };
}
export async function resolveRunnerSqlOutcome(error,jobs,job,{admission,sqlExecution,ownerKey,logError,stage,jobId,allowFailure=false}){
  if(error?.code==='SQL_EXECUTION_UNCERTAIN'||error?.outcome==='UNKNOWN'||error?.code==='SQL_EXECUTION_CLOSED')return true;
  if(error?.code!=='SQL_EXECUTION_RECHECK_REQUIRED'&&error?.outcome!=='CHECK_RECEIPT')return false;
  // The original scope has settled. Retained-result reads need a fresh bounded
  // admission; an auxiliary/read-only COMMIT is never proof of job success.
  try{
    if(typeof jobs.resolveExecution==='function'){
      const resolve=()=>jobs.resolveExecution(job,{error,allowFailure});
      if(admission)await admission.run({ownerKey},resolve);
      else if(sqlExecution)await sqlExecution.run({},resolve);
      else await resolve();
    }
  }catch(caught){logError(safeBackgroundErrorRecord(caught,{stage,jobId}));}
  return true;
}

/** The host explicitly starts polling and owns an awaited drain on shutdown. */
export class BusinessCommandRunner {
  constructor(jobs,service,{intervalMs=1000,admission=null,sqlExecution=null,keepAlive=false,heartbeatMs=3000,logError=record=>console.error(JSON.stringify(record))}={}){
    this.jobs=jobs;this.service=service;this.intervalMs=intervalMs;this.admission=admission;this.sqlExecution=sqlExecution;this.keepAlive=keepAlive;this.heartbeatMs=heartbeatMs;this.logError=logError;this.closed=false;this.running=false;this.tickPromise=null;this.shutdownAborted=false;
  }
  unscoped(operation){return this.sqlExecution?this.sqlExecution.runUnscoped(operation):operation();}
  schedule(delay){clearTimeout(this.timer);if(this.closed)return;this.timer=setTimeout(()=>{this.tick().catch(error=>this.logError(safeBackgroundErrorRecord(error,{stage:'COMMAND_QUEUE'})));},delay);if(!this.keepAlive)this.timer.unref();}
  wake(){if(!this.closed&&!this.running)this.schedule(0);}
  tick(){
    if(this.closed||this.running)return this.tickPromise||Promise.resolve();this.running=true;
    const dispatch=()=>this.runTick(),pending=Promise.resolve().then(()=>this.sqlExecution?.withoutScope?this.sqlExecution.withoutScope(dispatch):dispatch()).finally(()=>{this.running=false;if(this.tickPromise===pending)this.tickPromise=null;if(!this.closed)this.schedule(this.intervalMs);});this.tickPromise=pending;return pending;
  }
  async runTick(){
    try{
      if(this.closed)return;
      const job=await this.unscoped(()=>this.jobs.claim());
      if(job&&!this.shutdownAborted){
        const ownerKey=workloadOwnerKey(job.owner),control=createJobExecutionControl(this.jobs,job,{sqlExecution:this.sqlExecution,keepAlive:this.keepAlive,heartbeatMs:this.heartbeatMs,leaseCode:'COMMAND_LEASE_LOST',heartbeatStage:'COMMAND_HEARTBEAT',jobId:job.commandId,logError:this.logError});this.controller=control.controller;
        try{
          for(;;){
            try{
              const execute=async()=>{try{return await withJobExecutionControl(this.jobs,job,control,()=>this.service.execute(job,control));}finally{await control.finish();}};
              if(this.admission)await this.admission.run({ownerKey,signal:control.signal},execute);else await execute();
              break;
            }catch(error){
              if(error.code!=='WORKLOAD_ADMISSION_BUSY')throw error;
              await control.progress('Waiting for execution slot');
              await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);control.signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,1000);control.signal.addEventListener('abort',finish,{once:true});if(control.signal.aborted)finish();});
              if(control.signal.aborted)throw Object.assign(new Error('Command lease lost.'),{status:409,code:'COMMAND_LEASE_LOST'});
            }
          }
        }catch(error){
          const handled=await resolveRunnerSqlOutcome(error,this.jobs,job,{admission:this.admission,sqlExecution:this.sqlExecution,ownerKey,logError:this.logError,stage:'COMMAND_EXECUTE',jobId:job.commandId,allowFailure:!control.signal.aborted});
          if(!handled&&error.code!=='COMMAND_LEASE_LOST'&&!control.signal.aborted){
            if(!error.status||error.status>=500)this.logError(safeBackgroundErrorRecord(error,{stage:'COMMAND_EXECUTE',jobId:job.commandId}));
            await this.unscoped(()=>this.jobs.fail(job,{...businessCommandFailure(error),correlationId:job.commandId}));
          }
        }finally{await control.finish();this.controller=null;}
      }
    }catch(error){if(error.code==='AUDIT_PROVENANCE_INVALID'&&error.stopClaimLoop===true){this.closed=true;this.originRefusalStatus=this.jobs.originRefusalStatus||Object.freeze({code:'AUDIT_PROVENANCE_INVALID',stopClaimLoop:true,requiresOperatorReview:true});clearTimeout(this.timer);}this.logError(safeBackgroundErrorRecord(error,{stage:'COMMAND_QUEUE'}));}
  }
  abort(){this.shutdownAborted=true;this.controller?.abort();}
  close({abort=true}={}){this.closed=true;clearTimeout(this.timer);if(abort)this.abort();return this.tickPromise||Promise.resolve();}
}
