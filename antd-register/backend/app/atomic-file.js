import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const creations=new Map();

// Replace a journal atomically; never unlink the previous committed target.
// Windows sharing/antivirus locks can briefly deny replacement of a closed file.
export async function replacePrivateFile(target,bytes,{platform=process.platform,rename=fs.rename,wait=delay}={}){
  const temporary=target+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600,flush:true});
    for(let attempt=0;;attempt++){
      try{await rename(temporary,target);break;}
      catch(error){if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=7)throw error;await wait(Math.min(10*2**attempt,200));}
    }
    if(platform!=='win32'){const handle=await fs.open(path.dirname(target),'r');try{await handle.sync();}finally{await handle.close();}}
  }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

// Local preview is a single-process mode. On Windows, mutable journals must
// not start as hard links: immediate replacement can remain denied until the
// creating process exits. Serialize initial publication within that process.
export async function createPrivateFile(target,bytes){
  if(process.platform==='win32'){
    const key=path.join(await fs.realpath(path.dirname(target)),path.basename(target)).toLowerCase(),previous=creations.get(key)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(async()=>{try{await fs.lstat(target);return false;}catch(error){if(error.code!=='ENOENT')throw error;}await replacePrivateFile(target,bytes);return true;});
    creations.set(key,pending);try{return await pending;}finally{if(creations.get(key)===pending)creations.delete(key);}
  }
  const temporary=target+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600,flush:true});
    try{await fs.link(temporary,target);}catch(error){if(error.code==='EEXIST')return false;throw error;}
    const handle=await fs.open(path.dirname(target),'r');try{await handle.sync();}finally{await handle.close();}return true;
  }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
