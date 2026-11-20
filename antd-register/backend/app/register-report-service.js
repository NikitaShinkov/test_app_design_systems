import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseRegisterReport,REGISTER_REPORT,registerReportSequenceKey,registerReportFilename,registerReportSummary} from './register-report.js';
import {RegisterReportQuery} from './register-report-query.js';
import {createRegisterReportCapture,readRegisterReportCapture,canonicalRegisterReportJson} from './register-report-spool.js';
import {registerReportFields} from './register-column-filters.js';
import {registerReportArtifactScope} from './register-report-access.js';
import {httpError} from './auth.js';
import {queueWorkerContext} from './audit-queue-origin.js';

const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
const lost=()=>httpError(409,'This register report preparation was cancelled or its execution lease expired.',{code:'PREPARATION_LEASE_LOST'});
const invalid=()=>httpError(409,'The retained register report source does not match this preparation.',{code:'REGISTER_REPORT_SOURCE_INVALID'});
export class RegisterReportService {
  constructor(storage,artifacts,exports,jobs,{generator,currentContext,admission=null}={}){Object.assign(this,{storage,artifacts,exports,jobs,generator,currentContext,admission});this.query=new RegisterReportQuery(storage);}
  async context(job,client=null){const current=await this.currentContext(job,client);return queueWorkerContext(current,job,'PREPARATION',this.jobs.auditRuntime||this.storage.auditRuntime);}
  async enqueue(body,context,key){if(typeof key!=='string'||!key)throw httpError(422,'An Idempotency-Key is required before preparing a register report.',{code:'REGISTER_REPORT_KEY_REQUIRED'});return this.jobs.enqueue({moduleId:REGISTER_REPORT,options:parseRegisterReport(body)},context,key);}
  async resolve(job,context,client=null){try{return await this.exports.get(job.jobId,context,client?{transaction:client}:{});}catch(error){if(error.status===404)return null;throw error;}}
  async source(job,context){
    const key='REGISTER_REPORT_SOURCE:'+job.jobId;
    if(this.artifacts.pool){const row=(await this.artifacts.pool.query('select artifact_id from replacement_register.artifacts where logical_key=$1 and version=1',[key])).rows[0];return row?this.artifacts.get(row.artifact_id,context):null;}
    await this.artifacts.queue;const item=(await this.artifacts.localCatalog()).find(item=>item.logicalKey===key&&item.version===1);return item?this.artifacts.get(item.artifactId,context):null;
  }
  async currentLease(job,client){
    if(client){const row=(await client.query("select 1 from replacement_register.preparation_jobs where job_id=$1 and lease_token=$2 and status='RUNNING' and lease_until>clock_timestamp()",[job.jobId,job.leaseToken])).rows[0];if(!row)throw lost();}
    else if(!this.jobs.owns(await this.jobs.read(job.jobId),job))throw lost();
  }
  async retainedCapture(job,request,context,control){
    const retained=await this.source(job,context);
    if(!retained)return null;
    const buffer=await this.artifacts.read(retained),source={buffer,sha256:retained.sha256,bytes:retained.bytes};
    const iterator=readRegisterReportCapture(source)[Symbol.asyncIterator](),first=await iterator.next();
    if(first.done||first.value.type!=='header'||canonicalRegisterReportJson(first.value.header.request)!==canonicalRegisterReportJson(request))throw invalid();
    const rows=async function*(){for await(const entry of iterator){if(entry.type==='row')yield {key:entry.key,values:entry.values};}};
    const capture=await createRegisterReportCapture({root:this.artifacts.root,jobId:job.jobId,header:first.value.header,rows:rows(),maxBytes:this.artifacts.maxBytes,signal:control.signal});
    return {...capture,retained,source};
  }
  async execute(job,control,catalog){
    const perform=async()=>{
      let context=await this.context(job),capture=null;
      const existing=await this.resolve(job,context);
      if(existing)return this.jobs.complete(job,context,async client=>{await this.context(job,client);await this.currentLease(job,client);return existing;});
      const request=parseRegisterReport(job.descriptor.options);
      try{
        await control.progress('Capturing the complete register report');
        capture=await this.retainedCapture(job,request,context,control);
        if(!capture)capture=await this.query.capture(request,context,(asOf,rows)=>createRegisterReportCapture({root:this.artifacts.root,jobId:job.jobId,header:{reportFormatVersion:1,dataAsOf:asOf,request,fields:registerReportFields(request.registerKind)},rows,maxBytes:this.artifacts.maxBytes,signal:control.signal}),{signal:control.signal});
        let source=capture.retained?capture.source:null;
        if(!source){const buffer=await fs.readFile(capture.source.path);if(buffer.length!==capture.source.bytes||digest(buffer)!==capture.source.sha256)throw invalid();source={buffer,sha256:capture.source.sha256,bytes:capture.source.bytes};}
        const key=registerReportSequenceKey(request,context,capture.capture),version=await this.artifacts.exportVersion(key),filename=registerReportFilename(request,capture.capture,version);
        await control.progress('Generating the register report file');
        await this.artifacts.checkSpace(capture.directory,this.artifacts.maxBytes,{limits:this.artifacts.storageLimits});
        const file=await this.generator.run({operation:'REGISTER_REPORT',request,capture:capture.capture,source,directory:capture.directory,filename,maxBytes:this.artifacts.maxBytes},catalog,{signal:control.signal});
        await control.progress('Saving the register report filename review');
        return await this.jobs.complete(job,context,async client=>{
          const current=await this.context(job,client),already=await this.resolve(job,current,client);if(already){await this.currentLease(job,client);return already;}
          if(client)await client.query('select pg_advisory_xact_lock(78742004)');
          await this.currentLease(job,client);
          const scope=registerReportArtifactScope(capture.capture,current);
          const archived=capture.retained||await this.artifacts.put(source.buffer,{kind:'WORKFLOW_INPUT',moduleId:REGISTER_REPORT,filename:`Report_Source_${job.jobId}.ndjson.gz`,logicalKey:'REGISTER_REPORT_SOURCE:'+job.jobId,version:1,contentType:'application/gzip',scope,ownerOnly:true},current,{generated:true,transaction:client,preparationId:job.jobId});
          const registerReport=registerReportSummary(request,capture.capture,source),provenance={asOf:capture.capture.asOf,reportFormatVersion:1,registerReport,reportCapture:capture.capture,sourceHash:source.sha256,sourceBytes:source.bytes,sourceArtifactId:archived.artifactId,format:request.format==='csv'?'CSV UTF-8 BOM; Excel formula prefixes protected':'XLSX; explicit text cells',completeFilteredReport:request.selection.mode==='FILTERED'};
          return this.exports.prepare({moduleId:REGISTER_REPORT,key,version,options:request,provenance,inputs:[{artifactId:archived.artifactId,sha256:archived.sha256,bytes:archived.bytes,registerReportSource:true}],files:[{...file,kind:'WORKFLOW_OUTPUT',scope,ownerOnly:true}]},current,{jobId:job.jobId,transaction:client});
        });
      }finally{if(capture)await capture.cleanup();}
    };
    if(!this.admission)return perform();
    for(;;){
      if(control.signal.aborted)throw lost();
      try{return await this.admission.run({ownerKey:job.ownerKey},perform);}
      catch(error){if(error.code!=='WORKLOAD_ADMISSION_BUSY')throw error;await control.progress('Waiting for an execution slot');await new Promise(resolve=>{const done=()=>{clearTimeout(timer);control.signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,1000);control.signal.addEventListener('abort',done,{once:true});if(control.signal.aborted)done();});}
    }
  }
}
