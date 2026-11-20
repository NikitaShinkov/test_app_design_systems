import {lockNamedReleaseAccount,currentNamedReleaseContext,httpError} from './auth.js';
import {normalize} from './normalization.js';

const binding=context=>JSON.stringify({authenticated:Boolean(context.authenticated),userId:context.userId||null,role:context.role,organization:normalize(context.organization),orders:[...new Set((context.orders||[]).map(normalize))].sort()});
const changed=()=>httpError(403,'Your account or assigned scope changed. Refresh the source BOM page.',{code:'BOM_ACCOUNT_CHANGED'});

/** Read immutable projections first; recheck the original named session at publication. */
export class SourceBomRead {
  constructor(artifacts,{pool=artifacts.pool}={}){this.artifacts=artifacts;this.pool=pool;}
  list(context,filters={}){return this.guard(()=>this.publish(context,()=>this.artifacts.listBoms(context,filters)));}
  get(id,context){return this.guard(()=>this.publish(context,()=>this.artifacts.getBom(id,context)));}
  rows(id,context,filters={}){return this.guard(()=>this.publish(context,()=>this.artifacts.listBomRows(id,context,filters),id));}
  async guard(read){
    try{return await read();}
    catch(error){
      if(error.status)throw error;
      const schema=['42P01','42703','42883','3F000'].includes(error.code);
      if(schema||['ECONNREFUSED','ECONNRESET','ETIMEDOUT','08006','08003','57P01','53300','57014','55P03'].includes(error.code))throw httpError(503,'The source BOM catalog is temporarily unavailable.',{code:'BOM_CATALOG_UNAVAILABLE',details:[schema?'Required source BOM schema is unavailable. Apply ordered migrations and run preflight.':'Source BOM storage could not complete this read. Check the database service, then retry.']});
      throw error;
    }
  }
  async publish(context,read,rowArtifactId=null){
    const payload=await read();
    if(!this.pool){
      if(rowArtifactId)await this.artifacts.assertBomReadable(rowArtifactId,context);
      return payload;
    }
    const client=await this.pool.connect();
    try{
      await client.query('begin');
      await lockNamedReleaseAccount(client,context);
      // File verdict publication uses the exclusive form. Wait before checking
      // the original session, so logout can finish while this read is delayed.
      if(rowArtifactId)await client.query('select pg_advisory_xact_lock_shared(78742004)');
      const current=await currentNamedReleaseContext(client,context);
      if(binding(current)!==binding(context))throw changed();
      if(rowArtifactId)await this.artifacts.assertBomReadable(rowArtifactId,current,{transaction:client});
      await client.query('commit');return payload;
    }catch(error){await client.query('rollback').catch(()=>{});throw error;}
    finally{client.release();}
  }
}
