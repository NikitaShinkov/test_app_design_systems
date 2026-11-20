import {lockNamedReleaseAccount,currentNamedReleaseContext,httpError} from './auth.js';
import {normalize} from './normalization.js';

const binding=context=>JSON.stringify({userId:context.userId||null,role:context.role,organization:normalize(context.organization),orders:[...new Set((context.orders||[]).map(normalize))].sort()});

/** Await slow payload work without locking out logout, then fence publication. */
export async function publishNamedRead(pool,context,read,{code='REGISTER_ACCOUNT_CHANGED'}={}){
  const payload=await read();if(!pool||!context.authenticated)return payload;
  const client=await pool.connect();
  try{
    await client.query('begin');await lockNamedReleaseAccount(client,context);
    const current=await currentNamedReleaseContext(client,context);
    if(binding(current)!==binding(context))throw httpError(403,'Your account or assigned scope changed. Refresh the register before continuing.',{code});
    await client.query('commit');return payload;
  }catch(error){await client.query('rollback').catch(()=>{});throw error;}
  finally{client.release();}
}
