import {randomUUID} from 'node:crypto';
import {RegisterQuery,registerMemoryMatches,registerMemoryCompare} from './register-query.js';
import {registerFilters,registerReportProjection,registerRowSelection} from './register-column-filters.js';
import {rowToProposal,rowToReplacement,rowToLifecycle} from './storage.js';
import {canAccess,httpError} from './auth.js';
import {reportIdentityKey} from './register-report.js';

const selectionChanged=()=>httpError(409,'Selected register rows changed or are no longer available. Refresh the register, review the current rows and select them again.',{code:'REGISTER_SELECTION_CHANGED'});
const abort=signal=>{if(signal?.aborted)throw httpError(409,'Register report preparation stopped or lost its lease.',{code:'PREPARATION_LEASE_LOST'});};
export class RegisterReportQuery {
  constructor(storage){this.storage=storage;this.pool=storage.rawPool||storage.pool;this.query=new RegisterQuery(storage);}
  async capture(request,context,consume,{signal}={}){
    if(this.pool){
      const client=await this.pool.connect();let complete=false,cursorOpen=false;const cursor='rr_report_'+randomUUID().replaceAll('-','');
      try{
        await client.query('begin isolation level repeatable read read only');
        const asOf=(await client.query('select transaction_timestamp() as at')).rows[0].at.toISOString();
        const filters=registerFilters(request.registerKind,request.filters),values=[],source=this.query.sources(request.registerKind,filters,context,values);
        let selected='';if(request.selection.mode==='SELECTED'){values.push(request.selection.items.map(reportIdentityKey));selected=` where (kind||':'||id)=any($${values.length}::text[])`;}
        await client.query(`declare ${cursor} no scroll cursor for select * from (${source}) source${selected} order by sv ${filters.direction},id ${filters.direction},kind ${filters.direction}`,values);cursorOpen=true;
        const rows=async function*(){for(;;){abort(signal);const batch=(await client.query(`fetch forward 100 from ${cursor}`)).rows;for(const value of batch){abort(signal);yield value.kind==='p'?rowToProposal(value.payload):value.kind==='r'?rowToReplacement(value.payload):rowToLifecycle(value.payload);}if(batch.length<100)break;}};
        const result=await consume(asOf,this.checkedRows(request,rows(),signal));complete=true;return result;
      }finally{try{if(cursorOpen)await client.query('close '+cursor);await client.query(complete?'commit':'rollback');}finally{client.release();}}
    }
    const operation=async()=>{
      abort(signal);const asOf=new Date().toISOString(),filters=registerFilters(request.registerKind,request.filters),kind=request.registerKind;
      // The local writer queue retains a consistent read while only row
      // references are sorted. Canonical row values are spooled one at a time.
      const candidates=(kind==='proposals'?this.storage.state.proposals:this.storage.state.replacements).filter(row=>(!context.authenticated||canAccess(context,row))&&registerMemoryMatches(kind,row,filters)).sort((left,right)=>registerMemoryCompare(kind,filters,left,right));
      const rows=async function*(){for(const row of candidates){abort(signal);yield row;}};
      return consume(asOf,this.checkedRows(request,rows(),signal));
    };
    if(this.storage.queue){const pending=this.storage.queue.then(operation);this.storage.queue=pending.catch(()=>{});return pending;}
    return operation();
  }
  async *checkedRows(request,rows,signal){
    const selected=request.selection.mode==='SELECTED'?new Map(request.selection.items.map(item=>[reportIdentityKey(item),item])):null,excluded=new Set((request.selection.excluded||[]).map(reportIdentityKey)),seen=new Set();
    for await(const row of rows){
      abort(signal);const key=registerRowSelection(request.registerKind,row),identity=reportIdentityKey(key);
      if(selected){const expected=selected.get(identity);if(!expected)continue;if(expected.version!==key.version||expected.fingerprint!==key.fingerprint)throw selectionChanged();seen.add(identity);}
      else if(excluded.has(identity))continue;
      yield {key,values:registerReportProjection(request.registerKind,row)};
    }
    if(selected&&seen.size!==selected.size)throw selectionChanged();
  }
}
