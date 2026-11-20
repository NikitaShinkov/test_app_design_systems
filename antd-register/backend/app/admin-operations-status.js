import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ADMIN_STATUS_LIMITS as limits,requireStatusAdministrator,sourceSection,schemaSection,templateSection,statusDto} from './admin-operations-dto.js';

// Trusted deployment paths only. No pathname, database target or command is accepted from HTTP.
async function hashRegularFile(file,maxBytes){
 const original=await fs.lstat(file);if(!original.isFile()||original.isSymbolicLink()||original.size>maxBytes)throw Object.assign(Error('Unverifiable configured file'),{code:original.size>maxBytes?'STATUS_FILE_LIMIT':'STATUS_FILE_TYPE'});
 if(path.resolve(await fs.realpath(file))!==path.resolve(file))throw Object.assign(Error('Redirected configured file'),{code:'STATUS_FILE_TYPE'});
 const handle=await fs.open(file,'r');
 try{const before=await handle.stat();if(!before.isFile()||before.ino!==original.ino||before.dev!==original.dev||before.size!==original.size)throw Error('Configured file changed');const hash=createHash('sha256');let bytes=0;
  for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>maxBytes)throw Object.assign(Error('Configured file exceeds limit'),{code:'STATUS_FILE_LIMIT'});hash.update(chunk);}
  const after=await handle.stat();if(bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('Configured file changed');return {sha256:hash.digest('hex'),bytes};
 }finally{await handle.close();}
}
export async function readTrustedMigrationCatalog(directory){
 const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await fs.realpath(directory))!==path.resolve(directory))throw Error('Invalid configured migration directory');
 const names=(await fs.readdir(directory)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();if(names.length>limits.migrations)throw Error('Migration catalog exceeds status limit');if(names.some(name=>!/^\d{3}_[A-Za-z0-9_-]{1,100}\.sql$/.test(name)))throw Object.assign(Error('Unsupported packaged migration filename'),{code:'STATUS_MIGRATION_NAME'});const result=[];let bytes=0;
 for(const name of names){const observed=await hashRegularFile(path.join(directory,name),limits.migrationFileBytes);bytes+=observed.bytes;if(bytes>limits.migrationCatalogBytes)throw Error('Migration catalog exceeds status byte limit');result.push({version:name.slice(0,-4),sha256:observed.sha256});}return result;
}
export async function inspectTrustedTemplate({file,expectedSha256}){
 try{const observed=await hashRegularFile(file,limits.templateBytes);return {expectedSha256,actualSha256:observed.sha256};}
 catch(error){return {expectedSha256,state:error.code==='ENOENT'?'MISSING':error.code==='STATUS_FILE_LIMIT'?'LIMIT_EXCEEDED':'UNAVAILABLE'};}
}
async function captureSqlStatus(pool){
 if(!pool)return null;const client=await pool.connect();let active=false;
 try{await client.query('begin isolation level repeatable read read only');active=true;
  const probe=async(name,work)=>{await client.query('savepoint '+name);try{const result=await work();await client.query('release savepoint '+name);return result;}catch{await client.query('rollback to savepoint '+name);await client.query('release savepoint '+name);return null;}};
  const applied=await probe('admin_status_schema',async()=>{const result=await client.query('select version from replacement_register.schema_migrations order by version limit $1',[limits.migrations+1]);return result.rows;});
  const source=await probe('admin_status_source',async()=>{const groups=(await client.query('select entity_kind,source_hash,count(*)::text as records from replacement_register.source_bindings group by entity_kind,source_hash order by entity_kind,source_hash limit $1',[limits.hashGroups+1])).rows;const versionCount=(await client.query('select count(*)::text as records from replacement_register.source_versions')).rows[0]?.records;return {groups,versionCount};});
  // Conflict records have a separate authority boundary. The runtime may read
  // source pointers while intentionally having no access to migration conflicts.
  if(source)source.conflictCount=await probe('admin_status_conflicts',async()=>(await client.query('select count(*)::text as records from replacement_register.migration_conflicts where resolved_at is null')).rows[0]?.records);
  await client.query('commit');active=false;return {applied,source};
 }finally{if(active)await client.query('rollback').catch(()=>{});client.release();}
}
export function createAdminOperationsStatusService({readPool=null,backend=readPool?'postgres':'preview',authMode,readSourceInfo,readBundledSourceInfo,readMigrationCatalog,readTemplate,publishNamedRead,now=()=>new Date()}){
 if(!['postgres','preview'].includes(backend)||!['preview','named'].includes(authMode)||typeof readSourceInfo!=='function'||typeof readBundledSourceInfo!=='function'||typeof readMigrationCatalog!=='function'||typeof readTemplate!=='function'||typeof publishNamedRead!=='function')throw Error('Explicit administrator status dependencies are required');
 return {async status(context){requireStatusAdministrator(context);return publishNamedRead(readPool,context,async()=>{
  // Probe transactions finish before the final named-publication transaction takes authority locks.
  const safe=callback=>Promise.resolve().then(callback);const [info,bundledInfo,catalog,template,sql]=await Promise.all([safe(readSourceInfo).catch(()=>({})),safe(readBundledSourceInfo).catch(()=>({})),safe(readMigrationCatalog).catch(()=>null),safe(readTemplate).catch(()=>({state:'UNAVAILABLE'})),captureSqlStatus(readPool).catch(()=>null)]);
  return statusDto({backend,authMode,capturedAt:now(),source:sourceSection({info,bundledInfo,backend,sql:sql?.source}),schema:schemaSection(catalog,sql?.applied,{backend}),template:templateSection(template)});
 },{code:'ADMIN_OPERATIONS_ACCOUNT_CHANGED'});}};
}
