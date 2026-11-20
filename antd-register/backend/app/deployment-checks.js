import path from 'node:path';
import {sqlExecutionConfig} from './sql-execution.js';
import {Client} from 'pg';
import {assertSqlDriverCompatibility} from './sql-execution-driver.js';

export function deploymentConfiguration(env,platform=process.platform) {
  const findings=[];const requireValue=(ok,message)=>{if(!ok)findings.push(message);};
  requireValue(platform==='linux','The Ubuntu service package must be verified on Linux.');
  requireValue(env.RR_AUTH==='named','RR_AUTH must be named; preview roles cannot be exposed on the server.');
  requireValue(env.RR_STORAGE==='postgres','RR_STORAGE must be postgres for named accounts.');
  requireValue(env.RR_PROCESS_ROLE===undefined||['api','worker','combined'].includes(env.RR_PROCESS_ROLE),'RR_PROCESS_ROLE must be api, worker or combined.');
  requireValue(['127.0.0.1','::1'].includes(env.RR_HOST),'Bind the application to loopback behind the reverse proxy.');
  requireValue(env.RR_COOKIE_SECURE==='true','RR_COOKIE_SECURE must be true for HTTPS accounts.');
  requireValue(env.RR_TRUST_PROXY==='loopback','RR_TRUST_PROXY must be loopback for this local reverse-proxy package.');
  let origin;try{origin=new URL(env.RR_PUBLIC_ORIGIN);}catch{}
  requireValue(origin?.protocol==='https:'&&!origin.username&&!origin.password&&!origin.search&&!origin.hash&&origin.pathname==='/'&&!/REPLACE|example\.(?:com|org)|localhost/i.test(origin.hostname)&&env.RR_PUBLIC_ORIGIN===origin.origin,'Set the actual HTTPS public origin without placeholders, credentials, a path or trailing slash.');
  requireValue(Boolean(env.RR_DATA_ROOT)&&path.posix.isAbsolute(env.RR_DATA_ROOT)&&!env.RR_DATA_ROOT.includes('\\'),'RR_DATA_ROOT must be an absolute Linux storage path.');
  if(env.RR_RUNTIME_ROOT!==undefined){
    const runtime=env.RR_RUNTIME_ROOT,data=env.RR_DATA_ROOT;
    requireValue(typeof runtime==='string'&&path.posix.isAbsolute(runtime)&&!runtime.includes('\\'),'RR_RUNTIME_ROOT must be an absolute Linux host-runtime path.');
    if(typeof runtime==='string'&&typeof data==='string'){const first=path.posix.resolve(runtime),second=path.posix.resolve(data),inside=(a,b)=>a===b||b.startsWith(a+'/');requireValue(!inside(first,second)&&!inside(second,first),'RR_RUNTIME_ROOT and backed-up RR_DATA_ROOT must be separate directories.');}
  }
  if(env.RR_SHUTDOWN_GRACE_MS!==undefined)requireValue(typeof env.RR_SHUTDOWN_GRACE_MS==='string'&&/^\d+$/.test(env.RR_SHUTDOWN_GRACE_MS)&&Number.isSafeInteger(Number(env.RR_SHUTDOWN_GRACE_MS))&&Number(env.RR_SHUTDOWN_GRACE_MS)<=120000,'RR_SHUTDOWN_GRACE_MS must be0–120000 so forced shutdown fits the135-second service bound.');
  requireValue(Boolean(env.RR_CLAMAV_SOCKET)&&path.posix.isAbsolute(env.RR_CLAMAV_SOCKET),'Set the local ClamAV Unix socket path.');
  requireValue(Boolean(env.PGHOST)&&env.PGHOST.startsWith('/'),'This same-host package requires a PostgreSQL Unix socket (PGHOST).');
  requireValue(Boolean(env.PGDATABASE)&&Boolean(env.PGUSER),'Set PGDATABASE and the restricted runtime PGUSER.');
  try{sqlExecutionConfig(env);}catch{findings.push('SQL execution policy is invalid. Use supported positive decimal RR_SQL_* millisecond values, with lock at most statement and cancel at most cleanup; check the shared server configuration.');}
  try{assertSqlDriverCompatibility();}catch{findings.push('Install the supplied lockfile PostgreSQL driver, protocol and pool versions; review the SQL settlement adapter before upgrading them.');}
  return findings;
}

/** Inspect actual merged driver parameters without opening a socket. A URL
 * can override literal query_timeout, so Pool.options alone is insufficient. */
export function validatePreflightPostgresOptions(options){
  try{assertSqlDriverCompatibility();const client=new Client(options);if(client.pipeline||client.connectionParameters.query_timeout)throw Error();}
  catch{throw Error('Preflight requires the reviewed PostgreSQL adapter without pipelining or driver query_timeout. Check the actual merged connection configuration.');}
  return true;
}

/** Administrator details need these existing migration-source read tables.
 * This is a dependency probe, not a new source-write or role policy. */
export async function verifySourceProvenanceReadPrivileges(client){
  const missing=[];
  for(const table of ['source_bindings','source_versions']){
    const qualified='replacement_register.'+table,result=(await client.query("select to_regclass($1) as relation,has_table_privilege(current_user,to_regclass($1),'SELECT') as allowed",[qualified])).rows[0];
    if(!result?.relation||result.allowed!==true)missing.push(qualified+' SELECT');
  }
  return {ok:missing.length===0,missing};
}

export function preflightConfiguration(args=[],env=process.env){
  const invalid=()=>{throw Error('Use preflight.mjs with no arguments for full verification, or --startup with optional --role=api or --role=worker for bounded service startup probes.');};
  if(!Array.isArray(args)||args.some(value=>typeof value!=='string'||!['--startup','--role=api','--role=worker'].includes(value))||new Set(args).size!==args.length)invalid();
  const startup=args.includes('--startup'),roles=args.filter(value=>value.startsWith('--role='));
  if(roles.length>1||roles.length&&!startup)invalid();
  if(roles.length&&env.RR_PROCESS_ROLE!==roles[0].slice(7))throw Error(`Service role mismatch: this unit requires RR_PROCESS_ROLE=${roles[0].slice(7)}. Remove RR_PROCESS_ROLE from its shared EnvironmentFile.`);
  return Object.freeze({startup,full:!startup});
}
