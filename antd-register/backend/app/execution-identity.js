import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const failure=(code,message)=>Object.assign(new Error(message),{code,status:503});
const within=(parent,target)=>{const relative=path.relative(parent,target);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};

async function regularDirectory(directory){
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw failure('EXECUTION_IDENTITY_INVALID','Execution identity requires regular private directories.');
  return fs.realpath(directory);
}

async function readIdentity(filename,kind){
  const stat=await fs.lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||stat.size<2)throw failure('EXECUTION_IDENTITY_INVALID','The saved execution identity is invalid. Preserve it and review the runtime configuration.');
  if(process.platform!=='win32'&&((stat.mode&0o077)!==0||(typeof process.getuid==='function'&&stat.uid!==process.getuid())))throw failure('EXECUTION_IDENTITY_PERMISSIONS','Execution identity files must be owned by the service account and have mode0600.');
  let value;try{value=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw failure('EXECUTION_IDENTITY_INVALID','The saved execution identity is unreadable. Preserve it and review the runtime configuration.');}
  const expected=kind==='HOST'?['formatVersion','kind','id','createdAt','hostname','platform']:['formatVersion','kind','id','createdAt'];
  if(!value||Array.isArray(value)||Object.keys(value).length!==expected.length||!expected.every(key=>Object.hasOwn(value,key))||value.formatVersion!==1||value.kind!==kind||!uuid(value.id)||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))throw failure('EXECUTION_IDENTITY_INVALID','The saved execution identity does not match its expected format.');
  if(kind==='HOST'&&(value.hostname!==os.hostname()||value.platform!==process.platform))throw failure('EXECUTION_HOST_CHANGED','This host identity belongs to another host. Use its own local runtime directory; do not restore or share host identities.');
  return value;
}

async function identity(directory,name,kind){
  const filename=path.join(directory,name);
  try{return {value:await readIdentity(filename,kind),filename};}catch(error){if(error.code!=='ENOENT')throw error;}
  const value={formatVersion:1,kind,id:randomUUID(),createdAt:new Date().toISOString(),...(kind==='HOST'?{hostname:os.hostname(),platform:process.platform}:{})};
  const temporary=path.join(directory,`.identity-${randomUUID()}.tmp`);
  const handle=await fs.open(temporary,'wx',0o600);
  try{
    try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
    // Immutable identity publication: a reader sees either the complete file or
    // no file. A competing initializer keeps the first published identity.
    try{await fs.link(temporary,filename);}catch(error){if(error.code!=='EEXIST')throw error;}
    return {value:await readIdentity(filename,kind),filename};
  }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Liveness is deliberately conservative. An existing/reused PID or an access
 * error never proves the original process dead and must not free its permits. */
export function executionProcessAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647)return 'unknown';
  try{process.kill(pid,0);return true;}catch(error){return error.code==='ESRCH'?false:'unknown';}
}

export async function prepareExecutionIdentity({dataRoot,controlRoot}={}){
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot))throw failure('EXECUTION_IDENTITY_PATH','Use an absolute artifact data directory for execution identity.');
  const requestedData=path.resolve(dataRoot),requestedControl=path.resolve(controlRoot||path.join(path.dirname(requestedData),path.basename(requestedData)+'-runtime'));
  if(within(requestedData,requestedControl)||within(requestedControl,requestedData))throw failure('EXECUTION_IDENTITY_PATH','The host runtime directory and backed-up artifact directory must be separate.');
  const [dataDirectory,controlDirectory]=await Promise.all([regularDirectory(requestedData),regularDirectory(requestedControl)]);
  if(within(dataDirectory,controlDirectory)||within(controlDirectory,dataDirectory))throw failure('EXECUTION_IDENTITY_PATH','Resolved host runtime and artifact directories must be separate.');
  const [host,store]=await Promise.all([identity(controlDirectory,'host-identity.json','HOST'),identity(dataDirectory,'.store-identity.json','STORE')]);
  return {hostId:host.value.id,storeId:store.value.id,processAlive:executionProcessAlive,hostIdentityFile:host.filename,storeIdentityFile:store.filename,dataRoot:dataDirectory,controlRoot:controlDirectory};
}

/** Read-only live check: a replaced mount or copied host identity must not be
 * silently adopted by a process which already joined an execution deployment. */
export async function assertExecutionIdentity(identity){
  try{
    if(!identity||!uuid(identity.hostId)||!uuid(identity.storeId))throw Error('Invalid expected identity.');
    const [host,store,dataRoot,controlRoot]=await Promise.all([readIdentity(identity.hostIdentityFile,'HOST'),readIdentity(identity.storeIdentityFile,'STORE'),fs.realpath(identity.dataRoot),fs.realpath(identity.controlRoot)]);
    if(host.id!==identity.hostId||store.id!==identity.storeId||dataRoot!==identity.dataRoot||controlRoot!==identity.controlRoot)throw Error('Execution identity changed.');
    return true;
  }catch{throw failure('EXECUTION_IDENTITY_CHANGED','The current host or artifact store identity changed. Stop execution and review the storage configuration.');}
}
