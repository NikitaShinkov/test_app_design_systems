import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {fileURLToPath} from "node:url";
import {createStorage} from "./storage.js";
import {AuthService,httpError} from "./auth.js";
import {ArtifactRepository} from "./artifacts.js";
import {roles} from "./workflow.js";
import {exchangeScope,roundSequenceValue} from './exchange-scope.js';
import {ExportJobRepository,snapshotDigest} from './export-jobs.js';
import {sourceMetadata} from './demo-data.js';
import {normalize,currentReferenceContext} from './normalization.js';
import {withCatalog} from './reference-catalog.js';
import {AuditFeed} from './audit-feed.js';
import {RegisterQuery} from './register-query.js';
import {PreparationJobs,PreparationRunner,preparationOwner} from './preparation-jobs.js';
import {ExportGenerator} from './export-worker.js';
import {importPreparationResult} from './import-preparation.js';
import {verifyQueuedImport,checkImportRetry} from './import-verification.js';
import {verifyQueuedUpload,checkUploadRetry} from './upload-verification.js';
import {FilePreparationService} from './file-preparation-service.js';
import {RegisterReportService} from './register-report-service.js';
import {filePreparationKinds,checkFilePreparationRetry} from './file-preparations.js';
import {requestAdmissionConfig} from './request-admission.js';
import {WorkloadAdmission,workloadAdmissionConfig} from './workload-admission.js';
import {captureApprovalAttachments} from './approval-package-service.js';
import {RoundManagementRead} from './round-management-read.js';
import {BusinessCommandJobs} from './business-command-jobs.js';
import {BusinessCommandService} from './business-command-service.js';
import {BusinessCommandRunner} from './business-command-runner.js';
import {SourceBomRead} from './source-bom-read.js';
import {RegisterViews} from './register-views.js';

import {storageAdmissionLimits} from './storage-admission.js';
import {prepareExecutionIdentity,assertExecutionIdentity} from './execution-identity.js';
import {ExecutionCoordinator,executionWorkApplicationName} from './execution-coordination.js';
import {selectedM01Product} from './m01-metadata.js';
import {createProvenanceRuntime,copyAuditContext} from './audit-provenance.js';
import {queueWorkerContext} from './audit-queue-origin.js';
import {bindLocalProposalWorkingOrder,stageProposalWorkingOrder,exportProposalWorkingOrder,validateProposalWorkingOrderResult,workingOrderSensitiveModules} from './working-order-operations.js';

export function processRoleConfiguration(env=process.env){
 const role=env.RR_PROCESS_ROLE??'combined';
 if(!['combined','api','worker'].includes(role))throw new Error('RR_PROCESS_ROLE must be combined, api or worker.');
 if(role!=='combined'&&(env.RR_STORAGE!=='postgres'||env.RR_AUTH!=='named'))throw new Error('Dedicated API and worker roles require RR_STORAGE=postgres and RR_AUTH=named.');
 const raw=env.RR_SHUTDOWN_GRACE_MS??'120000';
 if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>120000)throw new Error('RR_SHUTDOWN_GRACE_MS must be an integer from 0 to 120000 milliseconds.');
 return {processRole:role,shutdownGraceMs:Number(raw),forcedShutdownMs:130000};
}

/** One global uncertainty handler covers admitted and non-admitted scopes.
 * Poison shared admission synchronously before an uncertain scope unwinds. */
export function bindRuntimeSqlExecution(storage,coordinator,onFatal){
 const uncertain=error=>{coordinator?.fail(error);onFatal(error);};
 storage.sqlExecution?.setUncertainHandler(uncertain);
 const poolFailure=()=>uncertain(Object.assign(new Error('The database connection could not be verified. Check the execution service before retrying.'),{status:503,code:'EXECUTION_COORDINATION_UNAVAILABLE'}));
 const pools=[...new Set([storage.rawPool||storage.pool,storage.executionControlPool].filter(Boolean))];
 for(const pool of pools)pool.on('error',poolFailure);
 return()=>{for(const pool of pools)pool.removeListener('error',poolFailure);};
}
async function closeApplicationStorage(storage){if(typeof storage.close==='function')await storage.close();else await (storage.rawPool||storage.pool)?.end();}

/** Services only: no HTTP listener, signal handler, timer or queue claim. */
export async function createApplicationRuntime({env=process.env}={}){
 const configuration=processRoleConfiguration(env),{processRole}=configuration,instanceId=randomUUID();
 const auditRuntime=createProvenanceRuntime({processRole,instanceId,trustProxyLoopback:env.RR_TRUST_PROXY==='loopback'});
 let started=false,closing=false,startPromise=null,closePromise=null,fatalError=null;const fatalHandlers=new Set();
const root = path.dirname(fileURLToPath(import.meta.url));
const appStorage = await createStorage({applicationName:executionWorkApplicationName(instanceId),env});
// createStorage returns the writer instance itself (including FilePreviewStorage).
appStorage.auditRuntime=auditRuntime;
let coordinator=null,generator=null,commandRunner=null,preparationRunner=null,unbindSql=null;
try{
const preview = env.RR_AUTH === "preview";
const host=env.RR_HOST||"127.0.0.1",port=Number(env.RR_PORT||4173);
if (preview && !["127.0.0.1", "::1"].includes(host)) throw new Error("Role preview is restricted to the loopback interface.");
if (!preview && !appStorage.pool) throw new Error("Named-user mode requires PostgreSQL. Configure RR_STORAGE=postgres, or use explicit RR_AUTH=preview for local review.");
const auth = preview ? null : new AuthService(appStorage.pool, { secure: env.RR_COOKIE_SECURE !== "false", origin: env.RR_PUBLIC_ORIGIN || `http://${host}:${port}`,trustProxyLoopback:env.RR_TRUST_PROXY==='loopback',auditRuntime });
// File-library ACL uses stored scope and canonical text, not manufacturer aliases.
// Its READ ONLY page keeps the managed SQL adapter without the mutation catalog lock.
const artifacts = new ArtifactRepository(path.resolve(env.RR_DATA_ROOT || path.join(root,'..','.replacement-register','files')), {pool:appStorage.pool,pagePool:appStorage.rawPool||appStorage.pool,preview,storageLimits:storageAdmissionLimits(env),auditRuntime});
const runtimeHash=createHash('sha256');for(const name of (await fs.readdir(root)).filter(name=>name.endsWith('.js')).sort()){runtimeHash.update(name);runtimeHash.update(await fs.readFile(path.join(root,name)));}runtimeHash.update(await fs.readFile(path.join(root,'data/reference-data.json')));const applicationHash=runtimeHash.digest('hex');
if(!preview&&(appStorage.rawPool||appStorage.pool)){
 if(appStorage.sqlExecution&&!appStorage.executionControlPool)throw new Error('SQL execution requires its private control pool.');
 const identity=await prepareExecutionIdentity({dataRoot:artifacts.root,...(env.RR_RUNTIME_ROOT?{controlRoot:path.resolve(env.RR_RUNTIME_ROOT)}:{})});
 coordinator=new ExecutionCoordinator({rawPool:appStorage.executionControlPool||appStorage.rawPool||appStorage.pool,sqlExecution:appStorage.sqlExecution||null,instanceId,hostId:identity.hostId,role:processRole,applicationHash,storeId:identity.storeId,processAlive:identity.processAlive,verifyIdentity:()=>assertExecutionIdentity(identity),onFatal:handleFatal,limits:workloadAdmissionConfig(env)});
}
unbindSql=bindRuntimeSqlExecution(appStorage,coordinator,handleFatal);
const workloadAdmission=coordinator?coordinator.admission:new WorkloadAdmission(workloadAdmissionConfig(env));
const sourceBomRead=new SourceBomRead(artifacts,{pool:appStorage.rawPool||appStorage.pool});
const exportJobs=new ExportJobRepository(artifacts,appStorage,{auditRuntime});
const preparations=new PreparationJobs(artifacts,appStorage,{admission:requestAdmissionConfig(env),auditRuntime});
const commandJobs=new BusinessCommandJobs(appStorage,{auditRuntime});
const commandService=new BusinessCommandService(appStorage,artifacts,commandJobs,{auth});
commandRunner=processRole==='api'?null:new BusinessCommandRunner(commandJobs,commandService,{admission:workloadAdmission,sqlExecution:appStorage.sqlExecution||null,keepAlive:processRole==='worker'});
const commandContext=context=>preview?copyAuditContext(context,{...context,authenticated:false}):context;
async function enqueueCommand(body,context,request){
  const job=await commandService.enqueue(body,commandContext(context),request.headers['idempotency-key']);
  wakeCommands();return job;
}
generator=new ExportGenerator({timeoutMs:Number(env.RR_FILE_TASK_TIMEOUT_MS??120000)});
const auditFeed=new AuditFeed(appStorage,artifacts,exportJobs,preparations,{generator});
const registerQuery=new RegisterQuery(appStorage);
const registerViews=new RegisterViews(appStorage);
const managedRoundRead=new RoundManagementRead(appStorage);

const fileScope = items => Object.fromEntries(Object.entries({orderNos:items.map(item=>item.orderNo),suppliers:items.map(item=>item.supplier),productDecimalNos:items.map(item=>item.productDecimalNo),proposalIds:items.map(item=>item.proposalId)}).map(([key,values])=>[key,[...new Set(values.filter(Boolean))]]));
const reviewedHistoryHash=history=>snapshotDigest({history,referenceHash:currentReferenceContext()?.hash||null});
async function archiveInput(moduleId,bytes,filename,items,context,scan) {
  const scope=fileScope(items);if(moduleId==='M01'&&!scope.orderNos.some(Boolean))scope.orderNos=['Unassigned'];
  return artifacts.put(bytes,{kind:'WORKFLOW_INPUT',moduleId,filename,ownerOnly:true,scope},context,{scan,reusePendingInput:['M01','M02','M04','M08'].includes(moduleId)&&scan?.status==='PENDING'});
}
function importOptions(value) {
  return Object.fromEntries(['orderNo','supplier','product','productCode','productDecimalNo','productionOrder','round','mapping'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,key==='mapping'?value[key]:String(value[key]??'').trim().slice(0,1000)]));
}
async function enqueueImport(moduleId,input,filename,options,context,request,existing=null,refresh={}) {
  // Retain exact bytes before background parsing, including workbooks with invalid headers.
  const fallback={orderNo:context.orders?.[0]||options.orderNo||'Unassigned',supplier:context.organization||options.supplier||''};
  const archived=existing||await archiveInput(moduleId,input,filename,[fallback],context,{status:'PENDING',detail:'Queued for background import verification.'});
  const result=await preparations.enqueue({kind:'IMPORT',moduleId,filename,options:importOptions(options),input:{artifactId:archived.artifactId,sha256:archived.sha256,bytes:archived.bytes},...refresh},context,request.headers['idempotency-key']);
  wakePreparations();return result;
}
function exportKey(moduleId,items,options) {
  const values=value=>{if(Array.isArray(value))return value;try{const parsed=JSON.parse(value);if(Array.isArray(parsed))return parsed;}catch{}return value?[value]:[];};
  const unique=values=>[...new Set(values.filter(Boolean).map(value=>String(value).trim().toUpperCase()))].sort();
  const stable=['M03','M05','M06'].includes(moduleId);
  return JSON.stringify({moduleId,orders:unique(values(options.orderNos).length?values(options.orderNos):options.orderNo?[options.orderNo]:items.map(item=>item.orderNo)),products:stable?[]:unique(values(options.productDecimalNos).length?values(options.productDecimalNos):options.productDecimalNo?[options.productDecimalNo]:items.map(item=>item.productDecimalNo)),suppliers:stable?[]:unique(options.supplier?[options.supplier]:items.map(item=>item.supplier)),round:stable?roundSequenceValue(options):0,...(stable?{scope:'ORDER_ROUND'}:{})});
}
function exportOptions(value) {return Object.fromEntries(['orderNo','orderNos','productDecimalNos','productDecimalNo','product','productCode','productCodes','supplier','productionOrder','round','includeApproved','sourceArtifactId','sourceArtifactIds','m01HistoryHash','m01SourceHash'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));}
function exportDrafts(moduleId,file,fallback,kind=moduleId==='M01'?'ORIGINAL_BOM':'WORKFLOW_OUTPUT') {
  const items=file.scopeRows||fallback;const scope=fileScope(items);const unassigned=!scope.orderNos.some(Boolean);if(unassigned)scope.orderNos=['Unassigned'];
  return [...(file.members||[]).flatMap(member=>exportDrafts(moduleId,member,member.scopeRows||items,kind)),{filename:file.filename,buffer:file.buffer,contentType:file.contentType,kind,scope,ownerOnly:unassigned,affected:file.affected??items.length,product:items[0]?.product||'',productDecimalNo:items[0]?.productDecimalNo||'',supplier:items[0]?.supplier||''}];
}
async function prepareExportPlan(moduleId,rawOptions,context,input=null,filename='',archivedInput=null,expectedVersion=null,{progress,signal}) {
  await progress('Capturing register and historical data');
  const options=exportOptions(rawOptions),ordered=workingOrderSensitiveModules.includes(moduleId);const state=await appStorage.exportState(context,options,{workingOrder:ordered});
  if(ordered){if(!appStorage.pool)bindLocalProposalWorkingOrder(state.proposals);state.proposals=stageProposalWorkingOrder(state.proposals);}
  const orderTransfer=ordered?exportProposalWorkingOrder(state.proposals):null;const inputs=[];let items=state.proposals;
  if(['M03','M05','M06'].includes(moduleId))options.orderNo=exchangeScope(moduleId,state.proposals,options).orderNo;
  if(moduleId==='M01') {
    const selectedProduct=selectedM01Product(options);
    let meta;
    await progress('Inspecting the original BOM');
    try{meta=await generator.run({operation:'ANALYZE',input,replacements:state.replacements,options,filename},currentReferenceContext().catalog,{signal});}
    catch(error){error.details=[...(error.details||[]),`Exact source retained as ${archivedInput.artifactId}.`];throw error;}
    const detectedScope=fileScope([meta]);if(!detectedScope.orderNos.length)detectedScope.orderNos=['Unassigned'];
    const archived=await artifacts.linkM01Input(archivedInput.artifactId,detectedScope,context,archivedInput.sha256);inputs.push({artifactId:archived.artifactId,sha256:archived.sha256});Object.assign(options,meta,{sourceFilename:filename});if(selectedProduct!==undefined)options.product=selectedProduct;items=[meta];
    if(options.m01SourceHash&&String(options.m01SourceHash).toLowerCase()!==archived.sha256)throw httpError(409,'The source workbook changed after match review. Select and review it again.',{code:'M01_SOURCE_CHANGED'});
    if(options.m01HistoryHash&&options.m01HistoryHash!==reviewedHistoryHash(state.replacements))throw httpError(409,'Historical decisions or reference data changed after M01 match review. Review the matches and history choice again before exporting.',{code:'M01_HISTORY_CHANGED'});
  }
  if(moduleId==='M09') {
    let selected=options.sourceArtifactIds;
    if(typeof selected==='string')try{selected=JSON.parse(selected);}catch{throw httpError(422,'Select the source BOMs again.',{code:'M09_SOURCE_SELECTION_INVALID'});}
    selected=selected??(options.sourceArtifactId?[options.sourceArtifactId]:[]);
    if(!Array.isArray(selected)||selected.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))||new Set(selected).size!==selected.length)throw httpError(422,'Select each source BOM once.',{code:'M09_SOURCE_SELECTION_INVALID'});
    if(!selected.length)throw httpError(422,'Select the original supplier BOMs before running M09.',{code:'M09_SOURCE_REQUIRED'});
    options.originalBoms=[];const groups=new Set();
    for(const id of selected){
      const source=await artifacts.get(id,context);if(source.kind!=='ORIGINAL_BOM')throw httpError(422,'Select an original supplier BOM.');
      if(options.orderNo&&!source.scope.orderNos.some(order=>normalize(order)===normalize(options.orderNo)))throw httpError(422,'The selected original BOM belongs to a different order.');
      const group=JSON.stringify(['orderNos','productDecimalNos','suppliers'].map(key=>(source.scope[key]||[]).map(normalize).sort()));
      if(groups.has(group))throw httpError(422,'Select one source version for each product and supplier.',{code:'M09_DUPLICATE_SOURCE_VERSION'});groups.add(group);
      options.originalBoms.push({buffer:await artifacts.read(source),filename:source.filename,scope:source.scope});inputs.push({artifactId:source.artifactId,sha256:source.sha256});
    }
  }
  options.version=1;options.exportDate=new Intl.DateTimeFormat('en-CA',{timeZone:env.RR_BUSINESS_TIMEZONE||'Asia/Dubai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(state.asOf));
  await progress('Generating native files');
  const generate=()=>generator.run({operation:'GENERATE',moduleId,proposals:state.proposals,replacements:state.replacements,options,input,...(ordered?{workingOrder:orderTransfer}:{})},currentReferenceContext().catalog,{signal});
  let file=await generate(),workingOrder=ordered?validateProposalWorkingOrderResult(state.proposals,file.workingOrder):null;items=file.scopeRows||items;
  const key=exportKey(moduleId,items,options);const version=await artifacts.exportVersion(key);
  if(expectedVersion!==null&&Number(expectedVersion)!==version)throw httpError(409,'An export was issued after the filename review. Reopen export settings.',{code:'EXPORT_VERSION_CHANGED'});
  if(version!==1){options.version=version;file=await generate();if(ordered)workingOrder=validateProposalWorkingOrderResult(state.proposals,file.workingOrder);}
  const provenance={asOf:state.asOf,applicationHash,sourceSha256:sourceMetadata.sourceSha256,referenceRevision:currentReferenceContext()?.revision,referenceHash:currentReferenceContext()?.hash,proposalVersions:state.proposals.map(row=>({proposalId:row.proposalId,rowVersion:row.rowVersion||1})),historyHash:createHash('sha256').update(JSON.stringify(state.replacements)).digest('hex')};
  if(workingOrder)provenance.workingOrder=workingOrder;
  if(file.templateSha256)provenance.templateSha256=file.templateSha256;
  if(['M03','M06'].includes(moduleId)){
    const capture=await captureApprovalAttachments(artifacts,context,items);
    if(capture.attachments.length){
      await progress('Packaging verified approval datasheets');
      const native=file,packageName=file.filename.replace(/\.[^.]+$/,'').replace(/_v\d+$/i,'')+`_Docs_v${version}.zip`,packaged=await generator.run({operation:'APPROVAL_PACKAGE',moduleId,package:{moduleId,filename:packageName,nativeFiles:file.members?.length?file.members:[file],attachments:capture.attachments,exportedRows:items,provenance,version,...(Object.hasOwn(options,'round')?{round:options.round}:{})}},currentReferenceContext().catalog,{signal});
      inputs.push(...capture.inputs);file={...native,...packaged,members:[native]};provenance.attachmentManifest=packaged.manifest;
    }
  }
  const {originalBoms,...savedOptions}=options;
  const businessRows=moduleId==='M09'?[...items,...state.proposals.filter(row=>items.some(meta=>['orderNo','supplier','productDecimalNo'].every(field=>normalize(row[field])===normalize(meta[field]))))]:items;
  return {moduleId,key,version,options:savedOptions,files:exportDrafts(moduleId,file,items),provenance,inputs,metadataPlan:file.metadataPlan||null,businessRows};
}

async function preparationContext(job,client=null){const owner=job.descriptor.owner;let current=owner;if(owner.authenticated){current=await auth.preparationContext(owner.userId,client||appStorage.pool,{lock:Boolean(client)});const key=context=>snapshotDigest({...preparationOwner(context),actor:null});if(key(current)!==key(owner))throw httpError(403,'The account role or assigned scope changed. Start a new preparation with the current account.',{code:'PREPARATION_ACCOUNT_CHANGED'});}return queueWorkerContext({...current,requestId:randomUUID()},job,'PREPARATION',auditRuntime);}
const filePreparations=new FilePreparationService(appStorage,artifacts,preparations,{generator,currentContext:preparationContext,checkInputs:(...args)=>exportJobs.checkInputs(...args)});
const registerReports=new RegisterReportService(appStorage,artifacts,exportJobs,preparations,{generator,currentContext:preparationContext,admission:null});
preparations.resolveExisting=async(job,context)=>{try{if(filePreparationKinds.has(job.descriptor.kind))return filePreparations.resolve(job,context);if(job.descriptor.kind==='IMPORT')return importPreparationResult(await appStorage.getImportBatch(job.descriptor.batchId||job.jobId,context),job.jobId);return await exportJobs.get(job.jobId,context);}catch(error){if(error.status===404)return null;throw error;}};
preparations.checkRetry=async(job,context,client)=>{if(filePreparationKinds.has(job.descriptor.kind))return checkFilePreparationRetry(job,context,artifacts,client);await checkImportRetry(job,context,artifacts,client);await checkUploadRetry(job,context,artifacts,client);};
preparationRunner=processRole==='api'?null:new PreparationRunner(preparations,async(job,control)=>{
  const context=await preparationContext(job),catalog=await appStorage.getReferenceCatalog();
  if(job.descriptor.moduleId==='REGISTER_REPORT')return registerReports.execute(job,control,catalog);
  if(filePreparationKinds.has(job.descriptor.kind))return filePreparations.execute(job,control,catalog);
  if(job.descriptor.kind==='IMPORT')return withCatalog(catalog,async()=>{
    const existing=await preparations.resolveExisting(job,context);let batch=null;
    if(!existing){
      await control.progress('Reading retained import workbook');
      const {archived,input}=await verifyQueuedImport(job,{artifacts,preparations,context,control,currentContext:preparationContext});
      await control.progress('Inspecting worksheets and parsing import rows');
      const data=await generator.run({operation:'IMPORT_PARSE',moduleId:job.descriptor.moduleId,input,filename:job.descriptor.filename,options:job.descriptor.options,artifact:{artifactId:archived.artifactId},context},catalog,{signal:control.signal});
      await control.progress('Capturing register and historical data');
      const snapshot=await appStorage.captureImportPreparation(data,context,job.descriptor.batchId||null,job.descriptor.revision??null);
      await control.progress('Calculating row findings and proposed changes');
      batch=await generator.run({operation:'IMPORT_REVIEW',snapshot,data,context,jobId:job.jobId},catalog,{signal:control.signal});
    }
    if(batch?.status==='READY'&&batch.rows.length)await artifacts.linkWorkflowInput(job.descriptor.moduleId,job.descriptor.input.artifactId,fileScope(batch.rows),context,job.descriptor.input.sha256);
    await control.progress('Saving the import review');
    return preparations.complete(job,context,async client=>{
      const current=await preparationContext(job,client);
      if(existing)return existing;
      if(client){const reference=(await client.query('select catalog_hash from replacement_register.reference_catalog where singleton=true for share')).rows[0];if(reference.catalog_hash!==catalog.hash)throw httpError(409,'Reference data changed during preparation. Refresh the import preview with current data.',{code:'REFERENCE_CHANGED'});}
      await exportJobs.checkInputs({snapshot:{inputs:[job.descriptor.input]}},current,client);
      const saved=await appStorage.savePreparedImport(batch,current,client);return importPreparationResult(saved,job.jobId);
    });
  });
  await withCatalog(catalog,async()=>{
    const existing=await preparations.resolveExisting(job,context);
    let plan=null;
    if(!existing){let input=null,archived=null;if(job.descriptor.input){if(job.descriptor.moduleId==='M01')({archived,input}=await verifyQueuedUpload(job,{artifacts,preparations,context,control,currentContext:preparationContext}));else{archived=await artifacts.get(job.descriptor.input.artifactId,context);if(archived.sha256!==job.descriptor.input.sha256)throw httpError(409,'The retained input identity changed.',{code:'M01_SOURCE_CHANGED'});input=await artifacts.read(archived);}}plan=await prepareExportPlan(job.descriptor.moduleId,job.descriptor.options,context,input,job.descriptor.filename||'',archived,job.descriptor.expectedVersion??null,control);}
    await control.progress('Saving the filename review');
    await preparations.complete(job,context,async client=>{
      const current=await preparationContext(job,client);
      if(client&&plan){const reference=(await client.query('select catalog_hash from replacement_register.reference_catalog where singleton=true for share')).rows[0];if(reference.catalog_hash!==plan.provenance.referenceHash)throw httpError(409,'Reference data changed during preparation. Retry the export with current data.',{code:'REFERENCE_CHANGED'});}
      if(existing)return existing;
      await exportJobs.checkInputs({snapshot:{inputs:plan.inputs}},current,client);
      return exportJobs.prepare(plan,current,{jobId:job.jobId,transaction:client});
    });
  });
},{admission:workloadAdmission,sqlExecution:appStorage.sqlExecution||null,keepAlive:processRole==='worker'});
async function enqueueExport(moduleId,rawOptions,context,request,{input=null,filename='',scan=null,expectedVersion=null}={}){
  const options=exportOptions(rawOptions);let archived=null;
  if(moduleId==='M01')selectedM01Product(options);
  if(input)archived=await archiveInput(moduleId,input,filename,[{orderNo:options.orderNo||'Unassigned',supplier:options.supplier||'',productDecimalNo:options.productDecimalNo||''}],context,scan||(moduleId==='M01'?{status:'PENDING',detail:'Queued for background M01 verification.'}:null));
  const result=await preparations.enqueue({moduleId,options,expectedVersion,filename,...(archived?{input:{artifactId:archived.artifactId,sha256:archived.sha256,bytes:archived.bytes}}:{})},context,request.headers['idempotency-key']);wakePreparations();return result;
}

function handleFatal(error){
 if(fatalError)return;fatalError=error;commandRunner?.close();preparationRunner?.close();
 for(const handler of fatalHandlers)try{Promise.resolve(handler(error)).catch(()=>{});}catch{}
}
function onFatal(handler){if(typeof handler!=='function')throw TypeError('A fatal handler must be a function.');fatalHandlers.add(handler);if(fatalError)queueMicrotask(()=>handler(fatalError));return()=>fatalHandlers.delete(handler);}
function wakeCommands(){if(started&&!closing)commandRunner?.wake();}
function wakePreparations(){if(started&&!closing)preparationRunner?.wake();}
function startExecution(){
 if(closing)return Promise.reject(new Error('Application runtime is closing.'));
 if(startPromise)return startPromise;
 startPromise=(async()=>{if(coordinator)await coordinator.start();if(closing||fatalError)throw fatalError||new Error('Application runtime is closing.');started=true;wakeCommands();wakePreparations();return runtime;})();return startPromise;
}
function close({graceMs=configuration.shutdownGraceMs,httpDrained=Promise.resolve()}={}){
 if(closePromise)return closePromise;if(!Number.isSafeInteger(graceMs)||graceMs<0||graceMs>120000)throw TypeError('Shutdown grace must be from 0 to 120000 milliseconds.');closing=true;
 closePromise=(async()=>{
  const drains=[commandRunner?.close({abort:false}),preparationRunner?.close({abort:false})];
  const timer=setTimeout(()=>{commandRunner?.abort();preparationRunner?.abort();},graceMs);
  try{if(started&&coordinator)try{await coordinator.beginDrain();}catch(error){handleFatal(error);}await Promise.all(drains);await httpDrained;await generator.close();}
  finally{clearTimeout(timer);try{if(coordinator)await coordinator.close();}finally{try{await closeApplicationStorage(appStorage);}finally{unbindSql?.();}}}
 })();return closePromise;
}
const runtime={...configuration,instanceId,auditRuntime,preview,appStorage,auth,artifacts,sourceBomRead,exportJobs,preparations,commandJobs,commandService,commandContext,generator,auditFeed,registerQuery,registerViews,managedRoundRead,applicationHash,workloadAdmission,coordinator,filePreparations,registerReports,commandRunner,preparationRunner,fileScope,reviewedHistoryHash,archiveInput,importOptions,enqueueImport,exportKey,exportOptions,exportDrafts,prepareExportPlan,preparationContext,enqueueCommand,enqueueExport,wakeCommands,wakePreparations,startExecution,close,onFatal,get fatalError(){return fatalError;},get closing(){return closing;},get started(){return started;}};
return runtime;
}catch(error){await generator?.close().catch(()=>{});await coordinator?.close().catch(()=>{});await closeApplicationStorage(appStorage).catch(()=>{});unbindSql?.();throw error;}
}
