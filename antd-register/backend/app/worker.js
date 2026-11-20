import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApplicationRuntime,processRoleConfiguration} from './application-runtime.js';
import {safeBackgroundErrorRecord} from './request-errors.js';

/** Named PostgreSQL queue host. Importing this module starts no process work. */
export async function runWorker({env=process.env}={}){
  const configuration=processRoleConfiguration(env);
  if(configuration.processRole!=='worker')throw new Error('The worker entry point requires RR_PROCESS_ROLE=worker.');
  const runtime=await createApplicationRuntime({env});let shuttingDown=null,shutdownExitCode=0;
  async function shutdown(exitCode=0){
    shutdownExitCode=Math.max(shutdownExitCode,exitCode);
    if(shuttingDown)return shuttingDown;
    // A blocked database operation retains its durable execution permit until
    // the actual owned process/backends are gone. Never reset queue rows here.
    const forced=setTimeout(()=>process.exit(1),configuration.forcedShutdownMs);
    shuttingDown=runtime.close().then(()=>{clearTimeout(forced);process.exitCode=runtime.fatalError?1:shutdownExitCode;},()=>{process.exitCode=1;});return shuttingDown;
  }
  runtime.onFatal(()=>{shutdown(1).catch(()=>{});});
  process.on('SIGINT',()=>{shutdown().catch(()=>{});});
  process.on('SIGTERM',()=>{shutdown().catch(()=>{});});
  try{
    await runtime.startExecution();
    console.log(JSON.stringify({event:'EXECUTION_WORKER_READY',role:runtime.processRole,instanceId:runtime.instanceId,applicationHash:runtime.applicationHash}));
    return runtime;
  }catch(error){await runtime.close({graceMs:0});throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  await runWorker().catch(error=>{console.error(JSON.stringify(safeBackgroundErrorRecord(error,{stage:'WORKER_STARTUP'})));process.exitCode=1;});
}
