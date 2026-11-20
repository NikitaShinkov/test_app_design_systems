import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import {isDeepStrictEqual} from 'node:util';
import {assertSqlClient,sqlWireQuery,sqlProtocolCancel,assertSqlDriverCompatibility} from './sql-execution-driver.js';

export const sqlExecutionDefaults=Object.freeze({version:1,statementMs:30000,lockMs:10000,operationMs:120000,cleanupMs:10000,cancelMs:5000});
export const sqlExecutionBounds=Object.freeze(Object.fromEntries(Object.entries({statementMs:[25,300000],lockMs:[25,60000],operationMs:[25,900000],cleanupMs:[25,60000],cancelMs:[25,10000]}).map(([key,value])=>[key,Object.freeze(value)])));
const environment={statementMs:'RR_SQL_STATEMENT_MS',lockMs:'RR_SQL_LOCK_MS',operationMs:'RR_SQL_OPERATION_MS',cleanupMs:'RR_SQL_CLEANUP_MS',cancelMs:'RR_SQL_CANCEL_MS'};
function validate(policy){
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(key=>!Object.hasOwn(sqlExecutionDefaults,key))||policy.version!==1)throw TypeError('SQL execution policy version or fields are invalid.');
  const value={version:1};for(const [key,[low,high]]of Object.entries(sqlExecutionBounds)){if(!Number.isSafeInteger(policy[key])||policy[key]<low||policy[key]>high)throw TypeError(environment[key]+' is outside its supported integer range.');value[key]=policy[key];}
  if(value.lockMs>value.statementMs||value.cancelMs>value.cleanupMs)throw TypeError('SQL lock/cancellation budgets cannot exceed statement/cleanup budgets.');return Object.freeze(value);
}
export function sqlExecutionConfig(env={}){
  if(!env||typeof env!=='object'||Array.isArray(env))throw TypeError('SQL execution environment must be an object.');
  const values={...sqlExecutionDefaults};for(const [key,name]of Object.entries(environment))if(env[name]!==undefined){if(typeof env[name]!=='string'||!/^\d+$/.test(env[name]))throw TypeError(name+' must be a positive decimal integer.');values[key]=Number(env[name]);}return validate(values);
}

const messages={SQL_EXECUTION_UNCERTAIN:'SQL execution could not be verified. Check the saved result before retrying.',SQL_EXECUTION_ABORTED:'The operation was cancelled after its SQL work was rolled back.',SQL_OPERATION_TIMEOUT:'The operation exceeded its time limit and its SQL work was rolled back.',SQL_STATEMENT_TIMEOUT:'A database statement exceeded its time limit and its SQL work was rolled back.',SQL_LOCK_TIMEOUT:'A database lock wait exceeded its time limit and its SQL work was rolled back.',SQL_EXECUTION_RECHECK_REQUIRED:'Check the saved result or receipt before retrying this operation.',SQL_EXECUTION_UNSUPPORTED:'This SQL query or transport is unsupported by the execution policy.',SQL_TRANSACTION_INCOMPLETE:'The operation left an incomplete database transaction, which was rolled back.',SQL_EXECUTION_CLOSED:'SQL execution is closing; refresh before trying again.'};
function failure(code){const unknown=code==='SQL_EXECUTION_UNCERTAIN',recheck=code==='SQL_EXECUTION_RECHECK_REQUIRED',cancelled=code==='SQL_EXECUTION_ABORTED'||code.endsWith('_TIMEOUT');return Object.assign(Error(messages[code]),{code,status:unknown||code==='SQL_EXECUTION_CLOSED'?503:code.endsWith('_TIMEOUT')?504:cancelled||recheck?409:500,outcome:unknown?'UNKNOWN':recheck?'CHECK_RECEIPT':cancelled||code==='SQL_TRANSACTION_INCOMPLETE'?'ROLLED_BACK':'NOT_STARTED',retryable:cancelled});}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Deliberately reject callback/custom-query/cursor-object/query_timeout paths.
// String DECLARE/FETCH/CLOSE statements remain supported. A single protocol
// statement prevents hidden COMMITs behind another command in one SQL string.
function queryArguments(args){
  let [text,values]=args;
  if(args.length>2||typeof text!=='string'||!text.trim()||values!==undefined&&!Array.isArray(values))throw failure('SQL_EXECUTION_UNSUPPORTED');
  let clean='',quote=null,dollar=null,escape=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i],next=text[i+1];
    if(dollar){if(text.startsWith(dollar,i)){i+=dollar.length-1;dollar=null;}continue;}
    if(quote){if(ch===quote){if(next===quote)i++;else quote=null;}else if(ch==='\\'&&escape)i++;continue;}
    if(ch==='-'&&next==='-'){while(i<text.length&&text[i]!=='\n')i++;clean+=' ';continue;}
    if(ch==='/'&&next==='*'){let depth=1;i+=2;for(;i<text.length&&depth;i++){if(text[i]==='/'&&text[i+1]==='*'){depth++;i++;}else if(text[i]==='*'&&text[i+1]==='/'){depth--;i++;}}i--;clean+=' ';continue;}
    if(ch==="'"||ch==='"'){quote=ch;escape=ch==="'"&&/(?:^|[^a-zA-Z0-9_$])e$/i.test(text.slice(0,i));clean+=' ';continue;}
    if(ch==='$'&&(i===0||!/[a-zA-Z0-9_$\u0080-\uFFFF]/.test(text[i-1]))){const match=text.slice(i).match(/^\$(?:[a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\u0080-\uFFFF]*)?\$/);if(match){dollar=match[0];i+=dollar.length-1;clean+=' ';continue;}}
    clean+=ch;
  }
  if(quote||dollar||clean.trim().replace(/;\s*$/,'').includes(';'))throw failure('SQL_EXECUTION_UNSUPPORTED');
  return {text,values,command:clean.trim().replace(/;\s*$/,'').split(/\s+/)[0].toUpperCase()};
}

/** One adapter owns one work pool and independent control pool. Storage keeps
 * their fixed sizes7/2; the driver owns at most one transient cancel socket. */
export function createSqlExecution({pool,controlPool,policy=sqlExecutionConfig(),applicationName,onUncertain=()=>{}}={}){
  policy=validate(policy);
  assertSqlDriverCompatibility();
  if(!pool||!controlPool||pool===controlPool||typeof pool.connect!=='function'||typeof controlPool.connect!=='function'||typeof applicationName!=='string'||!applicationName||Buffer.byteLength(applicationName)>63||typeof onUncertain!=='function')throw TypeError('SQL execution requires independent pools and a valid application identity.');
  if(pool.options?.query_timeout||pool.options?.pipeline||controlPool.options?.query_timeout||controlPool.options?.pipeline)throw TypeError('SQL execution does not support driver read timeouts or pipelining.');
  for(const key of ['host','port','database','user'])if(pool.options?.[key]!==undefined&&controlPool.options?.[key]!==undefined&&String(pool.options[key])!==String(controlPool.options[key]))throw TypeError('SQL work and observer connection identities must match.');
  const ambient=new AsyncLocalStorage(),scopes=new Set(),settledOutcomes=new WeakMap();let closed=false,closing=null,uncertain=false,handler=onUncertain;
  const notify=()=>{const error=failure('SQL_EXECUTION_UNCERTAIN');if(!uncertain){uncertain=true;try{const result=handler(error);result?.catch?.(()=>{});}catch{}}return error;};
  function scopeError(scope){return failure(scope.priorCommit?'SQL_EXECUTION_RECHECK_REQUIRED':scope.reason||'SQL_EXECUTION_ABORTED');}
  function settledScopeError(scope,cleanupProven){
    const error=scopeError(scope);
    if(cleanupProven&&error.code==='SQL_EXECUTION_RECHECK_REQUIRED'&&['SQL_EXECUTION_ABORTED','SQL_OPERATION_TIMEOUT','SQL_STATEMENT_TIMEOUT','SQL_LOCK_TIMEOUT'].includes(scope.reason))settledOutcomes.set(error,Object.freeze({kind:'CHECK_RECEIPT',causeCode:scope.reason,cleanupProven:true}));
    return error;
  }
  function seal(scope,reason){if(scope.sealed)return;scope.sealed=true;scope.reason=reason;scope.cleanupDeadline=performance.now()+policy.cleanupMs;scope.cleanupWatchdog=setTimeout(()=>{const error=notify();for(const lease of scope.leases)lease.abandon?.();scope.rejectBoundary?.(error);},policy.cleanupMs);for(const child of scope.children||[])seal(child,reason);for(const lease of scope.leases)lease.cancel();}
  function remaining(scope){const value=Math.ceil(scope.deadline-performance.now());if(scope.ended)throw failure('SQL_EXECUTION_CLOSED');if(scope.sealed||value<=0){seal(scope,'SQL_OPERATION_TIMEOUT');throw scopeError(scope);}return Math.max(1,value);}
  function track(scope,promise){scope.pending.add(promise);promise.then(()=>scope.pending.delete(promise),()=>scope.pending.delete(promise));return promise;}
  async function acquire(source,timeoutMs){
    let expired=false;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{expired=true;reject(failure('SQL_OPERATION_TIMEOUT'));},Math.max(1,timeoutMs));Promise.resolve().then(()=>source.connect()).then(client=>{clearTimeout(timer);if(expired)client.release(true);else resolve(client);},error=>{clearTimeout(timer);reject(expired?failure('SQL_OPERATION_TIMEOUT'):error);});});
  }
  const sqlIdentity="current_database() as sql_database,current_user as sql_user,extract(epoch from pg_postmaster_start_time())::text as sql_boot,host(inet_server_addr()) as sql_address,inet_server_port() as sql_port";
  const sslOptions=value=>value&&typeof value==='object'?Object.fromEntries(Object.getOwnPropertyNames(value).map(key=>[key,value[key]])):Boolean(value);
  async function control(query,values,deadline,lease){
    const budget=Math.min(policy.cancelMs,Math.ceil(deadline-performance.now()));if(budget<=0)throw notify();
    let client,broken=false;try{
      client=await acquire(controlPool,budget);assertSqlClient(client);
      const p=client.connectionParameters,target=lease.endpoint;
      if(['host','port','database','user'].some(key=>String(p[key])!==String(target[key]))||!isDeepStrictEqual(sslOptions(p.ssl),target.ssl)||(client.sslNegotiation||p.sslnegotiation||'postgres')!==target.negotiation||client.connection.stream?.remoteAddress!==target.peer)throw notify();
      const wire=(text,args)=>sqlWireQuery(client,text,args,{timeoutMs:Math.max(1,deadline-performance.now()),onUncertain:()=>{broken=true;notify();}});
      const actual=(await wire("select set_config('statement_timeout',$1,false),set_config('lock_timeout',$1,false),"+sqlIdentity,[String(Math.max(1,budget))])).result.rows[0];
      if(['sql_database','sql_user','sql_boot','sql_address','sql_port'].some(key=>actual?.[key]!==lease.identity?.[key]))throw notify();
      return (await wire(query,values)).result;
    }catch{broken=true;throw notify();}finally{client?.release(broken);}
  }
  async function backendGone(lease,deadline){
    if(!lease.identity)throw notify();
    for(;;){const result=await control('select exists(select 1 from pg_stat_activity where pid=$1 and backend_start=$2::timestamptz) as present',[lease.identity.pid,lease.identity.started],deadline,lease);if(result.rows[0]?.present===false)return;if(performance.now()>=deadline)throw notify();await wait(Math.min(20,Math.max(1,deadline-performance.now())));}
  }
  async function checkout(scope){
    const raw=await acquire(pool,remaining(scope));let released=false;
    const parameters=raw.connectionParameters,endpoint={...Object.fromEntries(['host','port','database','user'].map(key=>[key,parameters?.[key]])),ssl:sslOptions(parameters?.ssl),negotiation:raw.sslNegotiation||parameters?.sslnegotiation||'postgres',peer:raw.connection?.stream?.remoteAddress};
    const lease={raw,scope,endpoint,identity:null,status:'I',active:null,poisoned:false,cancelTask:null,releaseTask:null,released:false,busy:false};scope.leases.add(lease);
    lease.abandon=()=>{lease.poisoned=true;if(!released){raw.release(true);released=true;}};
    const wire=(text,values,timeoutMs)=>sqlWireQuery(raw,text,values,{timeoutMs,onUncertain:()=>{lease.poisoned=true;notify();}}).then(value=>{lease.status=value.status;return value.result;});
    lease.cancel=()=>{if(!lease.active||lease.cancelTask)return;lease.poisoned=true;lease.cancelTask=sqlProtocolCancel(raw,{timeoutMs:policy.cancelMs}).catch(()=>{});};
    lease.dispose=()=>{
      if(lease.releaseTask)return lease.releaseTask;
      lease.released=true;
      lease.releaseTask=(async()=>{
        const deadline=scope.cleanupDeadline||performance.now()+policy.cleanupMs;
        try{
          if(lease.active)await lease.active.catch(()=>{});
          await lease.cancelTask;
          if(lease.poisoned||uncertain){lease.abandon();await backendGone(lease,deadline);return;}
          if(lease.status!=='I'){
            scope.incomplete=true;await wire('rollback',undefined,Math.max(1,deadline-performance.now()));
            if(lease.status!=='I')throw notify();
          }
          await wire("select set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)",[String(policy.statementMs),String(policy.lockMs)],Math.max(1,deadline-performance.now()));
          raw.release();released=true;
        }catch{lease.poisoned=true;if(!released){raw.release(true);released=true;}throw notify();}
      })();lease.releaseTask.catch(()=>{});return lease.releaseTask;
    };
    lease.query=async args=>{
      const query=queryArguments(args);
      if(ambient.getStore()&&ambient.getStore()!==scope)throw failure('SQL_EXECUTION_UNSUPPORTED');
      if(lease.released){if(query.command==='ROLLBACK'&&lease.poisoned){await lease.dispose();return {command:'ROLLBACK',rows:[],rowCount:null};}throw failure('SQL_EXECUTION_CLOSED');}
      if(lease.busy)throw failure('SQL_EXECUTION_UNSUPPORTED');
      const rollback=query.command==='ROLLBACK';
      if(scope.ended&&!rollback)throw failure('SQL_EXECUTION_CLOSED');if(scope.sealed&&!rollback)throw scopeError(scope);
      if(rollback&&lease.poisoned){await lease.dispose();return {command:'ROLLBACK',rows:[],rowCount:null};}
      lease.busy=true;
      const task=(async()=>{
        try{
          const budget=rollback?Math.max(1,(scope.cleanupDeadline||performance.now()+policy.cleanupMs)-performance.now()):remaining(scope);
          // An already failed transaction accepts only rollback. SET LOCAL is
          // performed inside caller-owned transactions, never a nested BEGIN.
          if(lease.status!=='E')await wire("select set_config('statement_timeout',$1,$3),set_config('lock_timeout',$2,$3)",[String(Math.min(policy.statementMs,Math.ceil(budget))),String(Math.min(policy.lockMs,Math.ceil(budget))),lease.status==='T'],Math.min(budget+policy.cleanupMs,policy.statementMs+policy.cleanupMs));
          if(!rollback)remaining(scope);
          const priorStatus=lease.status;
          const result=await wire(query.text,query.values,rollback?budget:Math.min(budget,policy.statementMs)+policy.cleanupMs);
          // Evidence is conservative, not a claim that the workflow committed.
          // Autocommit SELECT may invoke a writing function, so it counts too.
          if(result.command==='COMMIT'||priorStatus==='I'&&lease.status==='I'&&!['ROLLBACK','SET','SHOW'].includes(result.command))scope.priorCommit=true;
          return result;
        }catch(error){
          if(error.code==='SQL_EXECUTION_UNCERTAIN')throw error;
          if(scope.sealed)throw scopeError(scope);
          if(['57014','55P03'].includes(error.code)){seal(scope,error.code==='55P03'?'SQL_LOCK_TIMEOUT':'SQL_STATEMENT_TIMEOUT');throw scopeError(scope);}
          throw error;
        }finally{lease.busy=false;}
      })();lease.active=task;track(scope,task);
      try{return await task;}finally{if(lease.active===task)lease.active=null;}
    };
    try{
      assertSqlClient(raw);lease.status=raw.getTransactionStatus();if(lease.status!=='I')throw failure('SQL_EXECUTION_UNSUPPORTED');
      const initialization=(async()=>{await wire("select set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),set_config('standard_conforming_strings','on',false)",[String(Math.min(policy.statementMs,remaining(scope))),String(Math.min(policy.lockMs,remaining(scope)))],Math.min(policy.statementMs,remaining(scope))+policy.cleanupMs);const identity=await wire('select pg_backend_pid() as pid,backend_start::text as started,application_name,'+sqlIdentity+' from pg_stat_activity where pid=pg_backend_pid()',undefined,Math.min(policy.statementMs,remaining(scope))+policy.cleanupMs);lease.identity=identity.rows[0];if(!lease.identity||lease.identity.application_name!==applicationName)throw failure('SQL_EXECUTION_UNSUPPORTED');})();lease.active=initialization;try{await initialization;}finally{lease.active=null;}
      remaining(scope);return lease;
    }catch(error){lease.poisoned=true;try{await lease.dispose();}catch{throw notify();}throw error;}
  }
  async function finish(scope){
    await Promise.all([...scope.children||[]].map(child=>child.done));await Promise.allSettled([...scope.pending]);
    const releases=[...scope.leases].map(lease=>lease.dispose());const settled=await Promise.allSettled(releases);if(settled.some(result=>result.status==='rejected')||uncertain)throw notify();
  }
  async function run(options,operation){
    if(typeof operation!=='function'||!options||typeof options!=='object'||options.signal&&!(options.signal instanceof AbortSignal)||Object.keys(options).some(key=>!['signal','operationMs'].includes(key)))throw TypeError('A SQL operation and supported scope options are required.');
    if(closed||uncertain)throw uncertain?failure('SQL_EXECUTION_UNCERTAIN'):failure('SQL_EXECUTION_CLOSED');
    const existing=ambient.getStore();if(existing)remaining(existing);
    const duration=options.operationMs??policy.operationMs;if(!Number.isSafeInteger(duration)||duration<1||duration>policy.operationMs)throw TypeError('SQL operation override must be a positive integer within its configured budget.');
    const scope={deadline:Math.min(existing?.deadline??Infinity,performance.now()+duration),leases:new Set(),children:new Set(),pending:new Set(),accepting:true,sealed:false,priorCommit:false,incomplete:false};scope.done=new Promise(resolve=>{scope.resolveDone=resolve;});scopes.add(scope);existing?.children.add(scope);
    const abort=()=>seal(scope,'SQL_EXECUTION_ABORTED'),timer=setTimeout(()=>seal(scope,'SQL_OPERATION_TIMEOUT'),Math.max(1,scope.deadline-performance.now()));options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    let value,error,completedBeforeSeal=false,cleanupProven=false;
    // A cleanup watchdog may end an uncooperative callback only as UNKNOWN:
    // notify() has already synchronously poisoned admission before rejection.
    const boundary=new Promise((resolve,reject)=>{scope.rejectBoundary=reject;Promise.resolve().then(()=>ambient.run(scope,()=>{remaining(scope);return operation();})).then(resolve,reject);});
    try{value=await boundary;if(performance.now()>=scope.deadline)seal(scope,'SQL_OPERATION_TIMEOUT');completedBeforeSeal=!scope.sealed;}catch(caught){error=caught;}scope.accepting=false;
    try{await finish(scope);cleanupProven=true;}catch(caught){error=caught;}
    finally{scope.ended=true;clearTimeout(timer);clearTimeout(scope.cleanupWatchdog);options.signal?.removeEventListener('abort',abort);scopes.delete(scope);existing?.children.delete(scope);if(scope.priorCommit&&existing)existing.priorCommit=true;scope.resolveDone();}
    if(error){if(error.code==='SQL_EXECUTION_UNCERTAIN')throw error;if(scope.sealed&&(error.code?.startsWith('SQL_')||['57014','55P03'].includes(error.code)))throw settledScopeError(scope,cleanupProven);throw error;}
    if(!completedBeforeSeal&&scope.sealed)throw settledScopeError(scope,cleanupProven);if(scope.incomplete)throw failure('SQL_TRANSACTION_INCOMPLETE');return value;
  }
  const ensure=operation=>ambient.getStore()?operation(ambient.getStore()):run({},()=>operation(ambient.getStore()));
  const wrapped={
    query(...args){queryArguments(args);return ensure(scope=>{if(!scope.accepting)throw failure('SQL_EXECUTION_CLOSED');return track(scope,(async()=>{const lease=await checkout(scope);try{return await lease.query(args);}finally{await lease.dispose();}})());});},
    async connect(...args){if(args.length)throw failure('SQL_EXECUTION_UNSUPPORTED');const scope=ambient.getStore();if(scope){if(!scope.accepting)throw failure('SQL_EXECUTION_CLOSED');return track(scope,checkout(scope).then(clientFor));}let client;await runDetached(async context=>{client=clientFor(await checkout(context));});return client;},
    on(...args){pool.on(...args);return wrapped;},once(...args){pool.once(...args);return wrapped;},off(...args){pool.off(...args);return wrapped;},removeListener(...args){pool.removeListener(...args);return wrapped;},
    end(){return close();},get totalCount(){return pool.totalCount;},get idleCount(){return pool.idleCount;},get waitingCount(){return pool.waitingCount;}
  };
  // A connect without an explicit scope owns a scope lasting until release.
  async function runDetached(acquireClient){
    const scope={deadline:performance.now()+policy.operationMs,leases:new Set(),children:new Set(),pending:new Set(),accepting:true,sealed:false,priorCommit:false,incomplete:false};scope.done=new Promise(resolve=>{scope.resolveDone=resolve;});scopes.add(scope);scope.detached=true;
    scope.timer=setTimeout(()=>seal(scope,'SQL_OPERATION_TIMEOUT'),policy.operationMs);
    try{await acquireClient(scope);}catch(error){clearTimeout(scope.timer);scopes.delete(scope);scope.resolveDone();throw error;}
  }
  function clientFor(lease){return Object.freeze({query:(...args)=>{if(!lease.scope.accepting&&!/^\s*rollback\s*;?\s*$/i.test(args[0]))return Promise.reject(failure('SQL_EXECUTION_CLOSED'));return lease.query(args);},release:destroy=>{if(destroy)lease.poisoned=true;const task=lease.dispose();if(lease.scope.detached){lease.scope.accepting=false;task.finally(()=>{lease.scope.ended=true;clearTimeout(lease.scope.timer);clearTimeout(lease.scope.cleanupWatchdog);scopes.delete(lease.scope);lease.scope.resolveDone();}).catch(()=>{});}return task;}});}
  // Pools are caller-owned. Runtime first drains its coordinator, then storage
  // closes this adapter, then storage ends its actual work/control pools.
  function close(){if(closing)return closing;closed=true;for(const scope of scopes)seal(scope,'SQL_EXECUTION_ABORTED');closing=(async()=>{const active=[...scopes];for(const scope of active)if(scope.detached){try{await finish(scope);}finally{clearTimeout(scope.timer);scopes.delete(scope);scope.resolveDone();}}await Promise.all(active.map(scope=>scope.done));if(uncertain)throw notify();})();return closing;}
  return Object.freeze({pool:Object.freeze(wrapped),run,runUnscoped:operation=>ambient.exit(()=>run({},operation)),withoutScope:operation=>ambient.exit(operation),close,policy,getSettledOutcome:error=>settledOutcomes.get(error)||null,setUncertainHandler(value){if(typeof value!=='function')throw TypeError('An uncertain SQL handler is required.');handler=value;if(uncertain)handler(failure('SQL_EXECUTION_UNCERTAIN'));}});
}
