import {Worker,isMainThread,parentPort} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {withCatalog} from './reference-catalog.js';
import {safeFileOperationFailure} from './file-operation-errors.js';

const restoreFile=file=>({...file,buffer:Buffer.from(file.buffer),...(file.members?{members:file.members.map(restoreFile)}:{})});
export class ExportGenerator {
  constructor({timeoutMs=Number(process.env.RR_FILE_TASK_TIMEOUT_MS??120000),workerFactory=(url,options)=>new Worker(url,options)}={}){
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('RR_FILE_TASK_TIMEOUT_MS must be an integer from 1 to 600000 milliseconds.');
    this.timeoutMs=timeoutMs;this.workerFactory=workerFactory;this.worker=null;this.queue=Promise.resolve();this.pending=null;this.closed=false;
  }
  run(task,catalog,{signal}={}){const pending=this.queue.then(()=>{if(this.closed)throw Object.assign(new Error('File processing is shutting down.'),{status:503,code:'FILE_WORKER_CLOSED'});return this.perform(task,catalog,signal);});this.queue=pending.catch(()=>{});return pending;}
  perform(task,catalog,signal){
    if(signal?.aborted)return Promise.reject(Object.assign(new Error('Preparation lease lost.'),{status:409,code:'PREPARATION_LEASE_LOST'}));
    // Every task gets a fresh JS realm. A parser must not carry mutable global
    // or prototype state from an uploaded workbook into another account's job.
    const worker=this.workerFactory(new URL('./export-worker.js',import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:384}});this.worker=worker;
    return new Promise((resolve,reject)=>{
      const id=randomUUID();let settled=false,timer;
      const settle=(error,result)=>{
        if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(this.pending?.id===id)this.pending=null;if(this.worker===worker)this.worker=null;
        // Observe termination before the serialized queue starts another task.
        Promise.resolve(worker.terminate()).then(()=>{
          if(error){reject(error);return;}
          try{resolve(['GENERATE','APPROVAL_PACKAGE','REGISTER_REPORT','AUDIT_REPORT'].includes(task.operation)?restoreFile(result):result);}
          catch{reject(Object.assign(new Error('The file worker returned an invalid result.'),{status:500,code:'FILE_WORKER_OUTPUT_INVALID'}));}
        },terminationError=>reject(error||terminationError));
      };
      const abort=()=>settle(Object.assign(new Error('Preparation lease lost.'),{status:409,code:'PREPARATION_LEASE_LOST'}));
      this.pending={id,worker,settle};
      worker.on('message',message=>{if(message.id!==id)return;settle(message.error?Object.assign(new Error(message.error.message),message.error):null,message.result);});
      worker.on('error',error=>settle(error));worker.on('exit',code=>{if(!settled)settle(new Error(`File worker exited with code ${code}.`));});
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>settle(Object.assign(new Error('Workbook processing exceeded its time limit.'),{status:422,code:'FILE_TASK_TIMEOUT',details:[`File: ${task.filename||task.options?.sourceFilename||task.moduleId||'workbook'}; limit: ${this.timeoutMs} ms. No register changes or issued files were produced by this task. Retry with a valid workbook or ask an administrator to review the processing limit.`]})),this.timeoutMs);
      if(signal?.aborted){abort();return;}
      try{worker.postMessage({id,task,catalog});}catch(error){settle(error);}
    });
  }
  async close(){this.closed=true;const worker=this.worker;this.pending?.settle(new Error('File worker is shutting down.'));await worker?.terminate();}
}

if(!isMainThread){
  parentPort.on('message',async({id,task,catalog})=>{
    try{
      // Audit captures have no reference catalog or macro workbook dependency.
      // Dispatch before loading the other workbook paths or entering a catalog.
      let result;
      if(task.operation==='AUDIT_REPORT'){
        const {generateAuditReport}=await import('./audit-report-generator.js');result=await generateAuditReport(task);
      }else if(['INSPECT_ORIGINAL','ANALYZE','BOM_METADATA'].includes(task.operation)){
        // Source inspection needs the bounded SheetJS reader, not ExcelJS,
        // DOCX templates, ZIP export generators or measured font profiles.
        const {analyzeOriginalBOM,inspectWorkflowWorkbook}=await import('./original-bom-inspection.js');
        const input=task.input?Buffer.from(task.input):null,options={...task.options};
        result=await withCatalog(catalog,()=>task.operation==='BOM_METADATA'?inspectWorkflowWorkbook('M09',input,task.filename).metadata:task.operation==='ANALYZE'?analyzeOriginalBOM(input,task.replacements,{...options,sourceFilename:task.filename}).metadata:analyzeOriginalBOM(input,task.replacements,{...options,sourceFilename:task.filename}));
      }else{
      const {createWorkflowFile}=await import('./workbook.js');
      const input=task.input?Buffer.from(task.input):null,options={...task.options};if(options.originalBoms)options.originalBoms=options.originalBoms.map(row=>({...row,buffer:Buffer.from(row.buffer)}));
      result=await withCatalog(catalog,async()=>{
        if(task.operation==='REGISTER_REPORT'){const {generateRegisterReport}=await import('./register-report-generator.js');return generateRegisterReport({...task,source:{...task.source,...(task.source?.buffer?{buffer:Buffer.from(task.source.buffer)}:{})}});}
        if(task.operation==='APPROVAL_PACKAGE'){const {buildApprovalPackage}=await import('./approval-package.js');return buildApprovalPackage({...task.package,nativeFiles:task.package.nativeFiles.map(file=>({...file,buffer:Buffer.from(file.buffer)})),attachments:task.package.attachments.map(item=>({...item,buffer:Buffer.from(item.buffer)}))});}
        if(task.operation==='IMPORT_PARSE'){const {parsedImport}=await import('./import-preparation.js');return parsedImport(task.moduleId,input,task.filename,options,task.artifact,task.context);}
        if(task.operation==='IMPORT_REVIEW'){const {prepareImportInWorker}=await import('./import-preparation.js');return prepareImportInWorker(task.snapshot,task.data,task.context,task.jobId);}
        if(task.operation==='BOM_PROJECTION'){const {extractSourceBom}=await import('./source-bom.js');return extractSourceBom(input,task.filename);}
        return createWorkflowFile(task.moduleId,task.proposals,task.replacements,options,input,task.workingOrder||null);
      });
      }
      parentPort.postMessage({id,result});
    }catch(error){parentPort.postMessage({id,error:safeFileOperationFailure(error)||{message:error.status&&error.status<500?error.message:'The native file generator failed.',status:error.status||500,code:error.code||'EXPORT_GENERATOR_FAILED',details:error.status&&error.status<500?error.details||[]:[]}});}
  });
}
