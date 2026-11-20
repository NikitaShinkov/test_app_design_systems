import {replacePrivateFile,createPrivateFile} from './atomic-file.js';
import {canonicalExportFilename} from './public/export-name-policy.js';
import {auditEventProvenance,serializeEventProvenance} from './audit-writer.js';
import {copyAuditContext} from './audit-provenance.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {httpError,lockNamedReleaseAccount,currentNamedReleaseContext} from './auth.js';
import {canUseModule,moduleFor} from './workflow.js';
import {safeFilename,artifactAccess} from './artifacts.js';
import {permitMetadataSummary} from './permit-metadata.js';
import {roundValue} from './exchange-scope.js';
import {normalize,cleanText} from './normalization.js';
import {publishNamedRead} from './named-read.js';
import {reportModule,registerReportPublicScope} from './register-report-access.js';
import {readExportReviewPage} from './export-review-pages.js';
import {isProposalWorkingOrderProof,requireProposalWorkingOrderReview,workingOrderSensitiveModules} from './working-order-operations.js';

const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,stable(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export {digest as snapshotDigest};
const allowedJob=(moduleId,role)=>moduleId==='AUDIT'?role==='ADMINISTRATOR':canUseModule(moduleFor(moduleId),role);
function access(job,context) {
  if(!job||!allowedJob(job.moduleId,context.role))return false;
  if(context.role==='ADMINISTRATOR')return true;
  if(job.moduleId===reportModule){if(job.ownerRole!==context.role)return false;return artifactAccess(context,{scope:job.snapshot.scope,moduleId:job.moduleId,kind:'WORKFLOW_OUTPUT',scanStatus:'GENERATED',ownerOnly:true,ownerUserId:job.ownerUserId,ownerActor:job.ownerActor});}
  if(context.authenticated)return job.ownerUserId===context.userId&&artifactAccess(context,{scope:job.snapshot.scope,moduleId:job.moduleId,kind:'WORKFLOW_OUTPUT'});
  return !job.ownerUserId&&job.ownerRole===context.role&&job.ownerActor===context.actor;
}
function requireJob(job,context){if(!access(job,context))throw httpError(404,'Export review not found.');return job;}
function requireReportIssuer(job,context){if(job.moduleId===reportModule&&(job.ownerRole!==context.role||(context.authenticated?job.ownerUserId!==context.userId:job.ownerUserId||job.ownerActor!==(context.actor||'Local administrator'))))throw httpError(403,'Only the initiating account can issue this personal register report.',{code:'REGISTER_REPORT_OWNER_REQUIRED'});}
const scopeBinding=context=>digest({userId:context.userId||null,role:context.role,organization:normalize(context.organization),orders:[...new Set((context.orders||[]).map(normalize))].sort()});
function fromRow(row){return row?{jobId:row.job_id,moduleId:row.module_id,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,ownerRole:row.owner_role,status:row.status,snapshot:row.snapshot_json,...row.payload,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at}:null;}
export function exportSummary(job) {
  const snapshot=job.snapshot;const main=snapshot.drafts.at(-1),scope=job.moduleId===reportModule?registerReportPublicScope(snapshot.scope):snapshot.scope;
  return {jobId:job.jobId,moduleId:job.moduleId,status:job.status,revision:1,createdAt:job.createdAt,dataAsOf:snapshot.dataAsOf,snapshotHash:snapshot.snapshotHash,referenceRevision:snapshot.provenance?.referenceRevision||null,referenceHash:snapshot.provenance?.referenceHash||null,ownerActor:job.ownerActor,filename:job.approvedFilename||main.filename,version:snapshot.version,rows:snapshot.affected,round:snapshot.round,orderNos:scope.orderNos,productDecimalNos:scope.productDecimalNos,files:snapshot.drafts.slice(0,-1).map(item=>({filename:item.filename,product:item.product,productDecimalNo:item.productDecimalNo,supplier:item.supplier,rows:item.affected,contentType:item.contentType})),...(snapshot.metadataPlan?{productCodes:permitMetadataSummary(snapshot.metadataPlan)}:{}),...(job.moduleId==='AUDIT'?{reportFilters:snapshot.provenance.filters,reportFormat:snapshot.provenance.reportFormat==='xlsx'?'xlsx':'csv'}:{}),...(job.moduleId===reportModule?{registerReport:snapshot.provenance.registerReport}:{}),approvalPackage:snapshot.provenance?.attachmentManifest||null,result:job.result};
}
function issuedFilename(value,draft,version,moduleId) {
  let name=String(value||draft.filename).trim();if(name!==safeFilename(name))throw httpError(422,'Use a filename without reserved characters or trailing dots.',{code:'EXPORT_FILENAME_INVALID'});
  const extension=path.extname(draft.filename);if(!path.extname(name))name+=extension;
  if(path.extname(name).toLowerCase()!==extension.toLowerCase())throw httpError(422,`This export requires the ${extension} filename extension.`,{code:'EXPORT_FILENAME_EXTENSION'});
  name=canonicalExportFilename(name,version,moduleId);
  if(name.length>180)throw httpError(422,'Shorten the filename to leave room for its version and extension.',{code:'EXPORT_FILENAME_TOO_LONG'});return name;
}
// Retained approvals keep their original name when an interrupted issue is
// resumed. New M01 reviews use the suffix-free first-version naming policy.
const issueNameModule=job=>job.moduleId==='M01'&&job.snapshot.version===1&&/_v1(?=\.[^.]+$)/i.test(job.approvedFilename||'')?undefined:job.moduleId;
function draftIssueIdentity(job,filename,index,draft){
  const issuedName=index===job.snapshot.drafts.length-1?filename:draft.filename;
  const {proposalIds,...documentScope}=draft.scope;const normalizedScope=Object.fromEntries(Object.entries(documentScope).map(([key,values])=>[key,Array.isArray(values)?[...new Set(values)].sort():values]));
  return {issuedName,logicalKey:`EXPORT:${job.moduleId}:${job.snapshot.key}:${JSON.stringify(normalizedScope)}:${issuedName.toLowerCase().replace(/_v\d+(?=\.[^.]+$)/,'')}:${draft.ownerOnly?job.ownerUserId||job.ownerActor:''}`};
}
export class ExportJobRepository {
  constructor(artifacts,storage,{pool=storage.pool||null,afterStep=null,auditRuntime=null}={}){this.artifacts=artifacts;this.storage=storage;this.pool=pool;this.directory=path.join(artifacts.root,'export-jobs');this.queue=Promise.resolve();this.afterStep=afterStep;this.auditRuntime=auditRuntime;}
  localPath(id){if(!/^[a-f0-9-]{36}$/.test(id))throw httpError(404,'Export review not found.');return path.join(this.directory,`${id}.json`);}
  async writeLocal(job){await fs.mkdir(this.directory,{recursive:true,mode:0o700});await replacePrivateFile(this.localPath(job.jobId),JSON.stringify(job));}
  async createLocal(job){await fs.mkdir(this.directory,{recursive:true,mode:0o700});return createPrivateFile(this.localPath(job.jobId),JSON.stringify(job));}
  localEvent(job,context,action){const provenance=auditEventProvenance(context,this.auditRuntime);job.events||=[];if(job.events.some(event=>event.action===action))return;job.events.push({id:randomUUID(),jobId:job.jobId,sequence:job.events.length+1,occurredAt:new Date().toISOString(),actor:context.actor||'Local administrator',actorUserId:context.userId||null,requestId:context.requestId||null,role:context.role||'ADMINISTRATOR',action,subject:job.jobId,detail:`${job.moduleId}: ${job.approvedFilename||job.snapshot.drafts.at(-1).filename}`,before:null,after:exportSummary(job),provenance});}
  async writeAudit(client,context,action,subject,detail,before=null,after=null){const provenance=serializeEventProvenance(context,this.auditRuntime);await client.query('insert into replacement_register.audit_events(actor,actor_role,action,subject,detail,before_json,after_json,actor_user_id,request_id,provenance_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[context.actor||'Local user',context.role||'ADMINISTRATOR',action,subject,detail,before,after,context.userId||null,context.requestId||null,provenance]);}
  async listAuditEvents(){if(this.pool)return [];let names=[];try{names=await fs.readdir(this.directory);}catch(error){if(error.code!=='ENOENT')throw error;}return (await Promise.all(names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).map(async name=>(JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8')).events||[])))).flat();}
  async load(id,context,client=this.pool,lock=false) {
    let job;
    if(this.pool)job=fromRow((await client.query(`select * from replacement_register.export_jobs where job_id=$1${lock?' for update':''}`,[id])).rows[0]);
    else try{job=JSON.parse(await fs.readFile(this.localPath(id),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    requireJob(job,context);const {snapshotHash,...snapshot}=job.snapshot;if(digest(snapshot)!==snapshotHash)throw httpError(409,'The saved export snapshot failed its integrity check. Prepare a new review or contact an administrator.',{code:'EXPORT_SNAPSHOT_INVALID'});return job;
  }
  async get(id,context,{transaction=null}={}){if(transaction)return exportSummary(await this.load(id,context,transaction));return publishNamedRead(this.pool,context,async()=>exportSummary(await this.load(id,context)),{code:'EXPORT_ACCOUNT_CHANGED'});}
  async page(context,input={}) {return publishNamedRead(this.pool,context,()=>readExportReviewPage({pool:this.pool,directory:this.directory,input,context,access}),{code:'EXPORT_ACCOUNT_CHANGED'});}
  // Legacy internal array callers retain one first page. Discovery uses page()
  // and its explicit continuation; this adapter does not claim full history.
  async list(context) {return (await this.page(context,{limit:100})).items;}
  async prepare({moduleId,key,version,options,files,provenance,inputs=[],metadataPlan=null,businessRows=null},context,{jobId:preparedId=null,transaction=null}={}) {
    auditEventProvenance(context,this.auditRuntime);
    if(!allowedJob(moduleId,context.role))throw httpError(403,'This export is unavailable for your role.');
    if(metadataPlan&&moduleId!=='M07')throw httpError(422,'Product-code updates belong to M07 only.');
    if(preparedId){let existing;if(this.pool)existing=(await (transaction||this.pool).query('select job_id from replacement_register.export_jobs where job_id=$1',[preparedId])).rowCount;else existing=await fs.access(this.localPath(preparedId)).then(()=>true,error=>{if(error.code!=='ENOENT')throw error;return false;});if(existing)return exportSummary(await this.load(preparedId,context,transaction||this.pool));}
    if(workingOrderSensitiveModules.includes(moduleId)&&!isProposalWorkingOrderProof(provenance?.workingOrder))throw httpError(503,'The export has no verified working-order capture. Prepare a new review after migration040 is verified.',{code:'WORKING_ORDER_UNAVAILABLE'});
    const drafts=[];for(const file of files){const {buffer,...metadata}=file;drafts.push({...metadata,...await this.artifacts.writeObject(buffer)});}
    const main=drafts.at(-1);const snapshot={key,version,round:['M03','M05'].includes(moduleId)?roundValue(options):options.round??null,options,affected:main.affected,dataAsOf:provenance.asOf,provenance,inputs,drafts,scope:main.scope,...(metadataPlan?{metadataPlan}:{}),...(businessRows?{businessRows:structuredClone(businessRows)}:{})};snapshot.snapshotHash=digest(snapshot);
    const job={jobId:preparedId||randomUUID(),moduleId,ownerUserId:context.userId||null,ownerActor:context.actor||'Local administrator',ownerRole:context.role,status:'READY',snapshot,createdAt:new Date().toISOString()};
    if(this.pool){const client=transaction||await this.pool.connect();try{if(!transaction)await client.query('begin');
      if(moduleId==='AUDIT'&&context.authenticated){
        // Rendering and object persistence can be slow. Fence the actual review
        // insertion with the current named session/account in this transaction.
        await lockNamedReleaseAccount(client,context);const current=await currentNamedReleaseContext(client,context);
        if(current.role!=='ADMINISTRATOR'||scopeBinding(current)!==scopeBinding(context))throw httpError(403,'Administrator access changed. Prepare the audit report again with the current account.',{code:'AUDIT_ACCOUNT_CHANGED'});
        context=copyAuditContext(context,current);Object.assign(job,{ownerUserId:current.userId,ownerActor:current.actor||'Local administrator',ownerRole:current.role});
      }
      const inserted=await client.query('insert into replacement_register.export_jobs(job_id,module_id,owner_user_id,owner_actor,owner_role,status,snapshot_json,payload) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(job_id) do nothing returning job_id',[job.jobId,moduleId,job.ownerUserId,job.ownerActor,job.ownerRole,job.status,snapshot,{}]);if(inserted.rowCount)await this.writeAudit(client,context,'EXPORT_REVIEW_PREPARED',job.jobId,`${moduleId}: ${main.filename}; ${snapshot.snapshotHash}`,null,exportSummary(job));else {const existing=exportSummary(await this.load(job.jobId,context,client));if(!transaction)await client.query('commit');return existing;}if(!transaction)await client.query('commit');}catch(error){if(!transaction)await client.query('rollback');throw error;}finally{if(!transaction)client.release();}}
    else {this.localEvent(job,context,'EXPORT_REVIEW_PREPARED');if(!await this.createLocal(job))return this.get(job.jobId,context);}
    return exportSummary(job);
  }
  async checkInputs(job,context,client=null,{localUnlocked=false}={}) {
    if(client) {
      if(!job.snapshot.inputs.length)return;
      const hashes=[...new Set(job.snapshot.inputs.map(item=>item.sha256))];const rows=(await client.query('select * from replacement_register.artifacts where sha256=any($1::text[]) for share',[hashes])).rows;
      if(rows.some(row=>row.scan_status==='INFECTED'))throw httpError(423,'A source file is quarantined; this export cannot be issued.',{code:'EXPORT_SOURCE_QUARANTINED'});
      for(const input of job.snapshot.inputs) {
        const row=rows.find(row=>row.artifact_id===input.artifactId&&row.sha256===input.sha256);
        if(!row||!artifactAccess(context,{scope:row.scope_json,moduleId:row.module_id,kind:row.kind,scanStatus:row.scan_status,ownerOnly:row.owner_only,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,attachmentMetadata:row.attachment_json}))throw httpError(404,'Source file is unavailable.');
        if(input.attachmentMetadataHash&&(digest(row.attachment_json||null)!==input.attachmentMetadataHash||row.scan_status!=='CLEAN'))throw httpError(423,'A packaged datasheet or its recorded metadata changed or is quarantined. Prepare a new approval package after verification.',{code:'APPROVAL_DATASHEET_CHANGED'});
        if(!['CLEAN','GENERATED'].includes(row.scan_status)&&!(this.artifacts.preview&&row.scan_status==='ERROR'))throw httpError(423,'A source file is quarantined; this export cannot be issued.',{code:'EXPORT_SOURCE_QUARANTINED'});
        await this.artifacts.readObject({sha256:row.sha256,bytes:Number(row.bytes),filename:row.filename});
      }
      return;
    }
    const localItems=localUnlocked?await this.artifacts.localCatalog():null;
    for(const input of job.snapshot.inputs){const item=localItems?localItems.find(row=>row.artifactId===input.artifactId):await this.artifacts.get(input.artifactId,context);if(!item||!artifactAccess(context,item))throw httpError(404,'Source file is unavailable.');if(item.sha256!==input.sha256)throw httpError(409,'The retained source identity changed.',{code:'EXPORT_SOURCE_CHANGED'});if(input.attachmentMetadataHash&&(digest(item.attachmentMetadata||null)!==input.attachmentMetadataHash||item.scanStatus!=='CLEAN'))throw httpError(423,'A packaged datasheet or its metadata changed or is quarantined.',{code:'APPROVAL_DATASHEET_CHANGED'});await this.artifacts.read(item);}
  }
  async issue(id,body,context) {
    if(body.revision!==1)throw httpError(428,'The reviewed export version is required.',{code:'EXPORT_REVIEW_REQUIRED'});
    if(this.pool)return this.issueSql(id,body,context);
    const task=this.queue.then(()=>this.issueLocal(id,body,context));this.queue=task.catch(()=>{});return task;
  }
  async publish(job,filename,context,transaction=null) {
    auditEventProvenance(context,this.auditRuntime);
    const metadataUpdated=job.snapshot.metadataPlan?await this.storage.applyPermitMetadata(job.snapshot.metadataPlan,context,job.jobId,transaction):0;
    if(job.snapshot.metadataPlan)await this.afterStep?.('metadata',job);
    const files=[];
    for(const [index,draft] of job.snapshot.drafts.entries()) {
      const {issuedName,logicalKey}=draftIssueIdentity(job,filename,index,draft);
      const item=await this.artifacts.put(await this.artifacts.readObject(draft),{kind:draft.kind,moduleId:job.moduleId,filename:issuedName,logicalKey,contentType:draft.contentType,scope:draft.scope,ownerOnly:draft.ownerOnly,version:job.snapshot.version},context,{generated:true,transaction});files.push(item);
      await this.afterStep?.('artifact',job);
    }
    const result={exportJobId:job.jobId,affected:job.snapshot.affected,filename,version:job.snapshot.version,round:job.snapshot.round,orderNo:job.snapshot.options.orderNo||'',snapshotHash:job.snapshot.snapshotHash,dataAsOf:job.snapshot.dataAsOf,artifactId:files.at(-1).artifactId,files:files.map(item=>({artifactId:item.artifactId,filename:item.filename,sha256:item.sha256,version:item.version,scope:item.scope})),...(job.snapshot.metadataPlan?{metadataUpdated,productCodes:permitMetadataSummary(job.snapshot.metadataPlan)}:{})};
    const workflowExchange=job.snapshot.businessRows?{rows:job.snapshot.businessRows,round:job.snapshot.round,exportJobId:job.jobId,snapshotHash:job.snapshot.snapshotHash,dataAsOf:job.snapshot.dataAsOf,provenance:job.snapshot.provenance,inputs:job.snapshot.inputs}:null;
    await this.storage.recordExport(job.moduleId,copyAuditContext(context,{...context,workflowExchange}),result,transaction);await this.afterStep?.('workflow',job);return result;
  }
  async issueSql(id,body,context) {
    const initial=await this.load(id,context);await this.checkInputs(initial,context);for(const draft of initial.snapshot.drafts)await this.artifacts.readObject(draft);
    const client=await this.pool.connect();
    try {
      await client.query('begin');const job=await this.load(id,context,client,true);await lockNamedReleaseAccount(client,context);
      const release=async()=>{const current=await currentNamedReleaseContext(client,context);if(scopeBinding(current)!==scopeBinding(context))throw httpError(403,'Your account or assigned scope changed. Refresh the export review before issuing it.',{code:'EXPORT_ACCOUNT_CHANGED'});requireJob(job,current);requireReportIssuer(job,current);return current;};
      const filename=issuedFilename(body.fileName||job.approvedFilename,job.snapshot.drafts.at(-1),job.snapshot.version,issueNameModule(job));
      if(job.status==='COMPLETE'){await release();if(body.fileName&&filename!==job.approvedFilename)throw httpError(409,'This review was already issued with another filename.',{code:'EXPORT_ALREADY_ISSUED'});await client.query('commit');return job.result;}
      await release();requireProposalWorkingOrderReview(job);
      await client.query('select pg_advisory_xact_lock(78742004)');
      await this.artifacts.exportVersion(job.snapshot.key,{reserve:true,expected:job.snapshot.version,transaction:client});await this.afterStep?.('reserved',job);
      const current=await release();await this.checkInputs(job,current,client);
      const result=await this.publish(job,filename,current,client);const payload={approvedFilename:filename,issuedAt:new Date().toISOString(),result};
      await client.query("update replacement_register.export_jobs set status='COMPLETE',payload=$2,updated_at=now() where job_id=$1",[id,payload]);
      await this.writeAudit(client,current,'EXPORT_REVIEW_ISSUED',id,filename,null,{...exportSummary({...job,status:'COMPLETE',...payload})});await client.query('commit');return result;
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async issueLocal(id,body,context) {
    auditEventProvenance(context,this.auditRuntime);
    const job=await this.load(id,context);requireReportIssuer(job,context);const filename=issuedFilename(body.fileName||job.approvedFilename,job.snapshot.drafts.at(-1),job.snapshot.version,issueNameModule(job));await this.checkInputs(job,context);
    if(job.status==='COMPLETE'){if(body.fileName&&filename!==job.approvedFilename)throw httpError(409,'This review was already issued with another filename.',{code:'EXPORT_ALREADY_ISSUED'});return job.result;}
    if(job.status==='APPROVED'&&filename!==job.approvedFilename)throw httpError(409,'Resume this approved export with its original filename.',{code:'EXPORT_ALREADY_APPROVED'});
    if(job.status==='APPROVED'&&workingOrderSensitiveModules.includes(job.moduleId)&&!isProposalWorkingOrderProof(job.snapshot.provenance?.workingOrder)){
      const retained=await this.retainedLocalPublication(job,filename,context);
      if(retained){job.status='COMPLETE';job.result=retained;job.issuedAt=new Date().toISOString();this.localEvent(job,context,'EXPORT_REVIEW_ISSUED');await this.writeLocal(job);return retained;}
    }
    requireProposalWorkingOrderReview(job);
    for(const draft of job.snapshot.drafts)await this.artifacts.readObject(draft);
    if(job.snapshot.metadataPlan){if(this.storage.checkPermitMetadataReady)await this.storage.checkPermitMetadataReady(job.snapshot.metadataPlan,context,job.jobId);else this.storage.checkPermitMetadata(job.snapshot.metadataPlan,context,job.jobId);}
    await this.artifacts.exportVersion(job.snapshot.key,{reserve:true,expected:job.snapshot.version,reservationId:job.jobId});await this.afterStep?.('reserved',job);
    job.status='APPROVED';job.approvedFilename=filename;this.localEvent(job,context,'EXPORT_REVIEW_APPROVED');await this.writeLocal(job);await this.afterStep?.('approved',job);
    const result=await this.publish(job,filename,context);job.status='COMPLETE';job.result=result;job.issuedAt=new Date().toISOString();this.localEvent(job,context,'EXPORT_REVIEW_ISSUED');await this.writeLocal(job);return result;
  }
  /** A historical APPROVED label alone proves nothing. Recovery links only an
   * already retained complete workflow publication; it never calls put(),
   * reserves a number, reapplies metadata or fabricates a new order proof. */
  async retainedLocalPublication(job,filename,context){
    if(this.pool||typeof this.storage.retainedExportReceipt!=='function')return null;
    const receipt=await this.storage.retainedExportReceipt(job.jobId),value=receipt?.result;
    if(receipt?.moduleId!==job.moduleId||!value||value.exportJobId!==job.jobId||value.snapshotHash!==job.snapshot.snapshotHash||value.filename!==filename||value.version!==job.snapshot.version||value.affected!==job.snapshot.affected||value.dataAsOf!==job.snapshot.dataAsOf||value.round!==job.snapshot.round||!Array.isArray(value.files)||value.files.length!==job.snapshot.drafts.length||value.artifactId!==value.files.at(-1)?.artifactId)return null;
    await this.artifacts.queue;let sequences;
    try{sequences=JSON.parse(await fs.readFile(path.join(this.artifacts.root,'export-sequences.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const reservation=sequences.__exportJobs?.[job.jobId];
    if(reservation?.key!==job.snapshot.key||reservation?.version!==job.snapshot.version||!Number.isSafeInteger(sequences[job.snapshot.key])||sequences[job.snapshot.key]<job.snapshot.version)return null;
    const scope=value=>Object.fromEntries(['orderNos','suppliers','productDecimalNos','proposalIds'].map(key=>[key,[...new Set((value?.[key]||[]).map(cleanText).filter(Boolean))].sort()]));
    for(const [index,draft]of job.snapshot.drafts.entries()){
      const file=value.files[index],identity=draftIssueIdentity(job,filename,index,draft);
      if(file.filename!==identity.issuedName||file.sha256!==draft.sha256||file.version!==job.snapshot.version)return null;
      const item=await this.artifacts.get(file.artifactId,context);
      if(item.logicalKey!==identity.logicalKey||item.filename!==identity.issuedName||item.sha256!==draft.sha256||item.bytes!==draft.bytes||item.version!==job.snapshot.version||item.moduleId!==job.moduleId||item.kind!==draft.kind||item.ownerOnly!==Boolean(draft.ownerOnly)||item.scanStatus!=='GENERATED'||digest(scope(item.scope))!==digest(scope(draft.scope))||digest(scope(file.scope))!==digest(scope(item.scope)))return null;
      await this.artifacts.read(item);
    }
    const {status,message,...result}=value;return result;
  }
  async download(id,context) {
    const job=await this.load(id,context);if(job.status!=='COMPLETE')throw httpError(409,'Confirm this export review before downloading.',{code:'EXPORT_NOT_ISSUED'});await this.checkInputs(job,context);
    return this.artifacts.download(job.result.artifactId,context,{exportJobId:job.jobId,validateSource:(client,current)=>this.checkInputs(job,current,client,{localUnlocked:!client})});
  }
  async downloadArtifact(id,context){
    const artifact=await this.artifacts.get(id,context);
    if(!artifact.logicalKey.startsWith('EXPORT:'))return this.artifacts.download(id,context);
    let jobs;
    if(this.pool)jobs=(await this.pool.query("select * from replacement_register.export_jobs where status='COMPLETE' and payload#>'{result,files}' @> $1::jsonb",[JSON.stringify([{artifactId:id}])])).rows.map(fromRow);
    else{let names=[];try{names=await fs.readdir(this.directory);}catch(error){if(error.code!=='ENOENT')throw error;}jobs=(await Promise.all(names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).map(name=>fs.readFile(path.join(this.directory,name),'utf8').then(JSON.parse)))).filter(job=>job.status==='COMPLETE'&&job.result?.files?.some(file=>file.artifactId===id));}
    if(!jobs.length)throw httpError(409,'The issued export source record is missing. Resume its saved export or contact an administrator before downloading.',{code:'EXPORT_SOURCE_RECORD_MISSING'});
    for(const job of jobs){const {snapshotHash,...snapshot}=job.snapshot;if(digest(snapshot)!==snapshotHash)throw httpError(409,'The saved export snapshot failed its integrity check.',{code:'EXPORT_SNAPSHOT_INVALID'});}
    return this.artifacts.download(id,context,{validateSource:async(client,current)=>{for(const job of jobs){if(job.moduleId===reportModule)requireJob(job,current);await this.checkInputs(job,current,client,{localUnlocked:!client});}}});
  }
}
