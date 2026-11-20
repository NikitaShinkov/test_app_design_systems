import http from "node:http";
import {createApplicationRuntime,processRoleConfiguration} from './application-runtime.js';
import path from "node:path";
import {fileURLToPath} from "node:url";
import {httpError,checkPreviewRequest} from "./auth.js";
import {scopedStorage} from "./access.js";
import {finalPreflight,recalculateProposal,createHistoryIndex} from "./domain.js";
import {validateDecision,validBusinessDate} from "./validation.js";
import {canUseModule,moduleFor,roles,workflowModules} from "./workflow.js";
import {workflowExchangeSuggestion,workflowFilenameSuggestion,WorkflowFileError} from "./workbook.js";
import {exchangeScope,selectionValues} from './exchange-scope.js';
import {snapshotDigest} from './export-jobs.js';
import {withCatalog} from './reference-catalog.js';
import {normalize} from './normalization.js';
import {permitCatalog} from './permit-metadata.js';
import {existingStateHistory} from './decision-history.js';
import {checkImportRefresh} from './import-preparation.js';
import {attachmentPreview} from './attachment-preview.js';
import {RequestAdmission,requestAdmissionConfig} from './request-admission.js';
import {workloadOwnerKey} from './workload-admission.js';
import {apiExecutionPolicy,executionApiFailure} from './execution-api-policy.js';
import {withResponseWorkload} from './execution-http.js';
import {executionReadiness} from './execution-health.js';
import {serveStaticFile} from './static-files.js';
import {beginRequestTrace,correlatedErrorBody,errorStatus,safeRequestErrorRecord} from './request-errors.js';
import {roundAdministrator,roundIdentifier} from './round-management.js';
import {registerColumnFields} from './register-column-filters.js';
import {publishNamedRead} from './named-read.js';
import {readAdministratorRecordDetail} from './record-detail-read.js';
import {publicJsonResponse,publicSourceInfo} from './public-source-projection.js';
import {fileLibraryPageOptions} from './file-library-pages.js';
import {createAdminOperationsStatusService,readTrustedMigrationCatalog,inspectTrustedTemplate} from './admin-operations-status.js';
import {adminOperationsStatusRoute} from './admin-operations-route.js';
import {sourceMetadata} from './demo-data.js';
import {bindHttpRequestAudit,httpAuditContext} from './http-audit-context.js';
import {copyAuditContext} from './audit-provenance.js';
import {bindLocalProposalWorkingOrder,stageProposalWorkingOrder,copyProposalWorkingOrder,requireKnownWorkingOrder,proposalWorkingOrderKnown} from './working-order-operations.js';

const {processRole}=processRoleConfiguration();
if(processRole==='worker')throw new Error('Run worker.js for RR_PROCESS_ROLE=worker; the worker must not open HTTP.');
const runtime=await createApplicationRuntime();
const {preview,appStorage,auth,artifacts,sourceBomRead,exportJobs,preparations,commandService,commandContext,auditFeed,registerQuery,registerViews,managedRoundRead,applicationHash,workloadAdmission,filePreparations,registerReports,fileScope,reviewedHistoryHash,importOptions,enqueueImport,exportKey,exportOptions,enqueueCommand,enqueueExport,wakeCommands,wakePreparations}=runtime;
const root=path.dirname(fileURLToPath(import.meta.url)),publicRoot=path.join(root,'public'),host=process.env.RR_HOST||'127.0.0.1',port=Number(process.env.RR_PORT||4173);
const bodyAdmission=new RequestAdmission(requestAdmissionConfig(process.env));
const adminOperationsStatus=createAdminOperationsStatusService({readPool:appStorage.rawPool||appStorage.pool||null,backend:(appStorage.rawPool||appStorage.pool)?'postgres':'preview',authMode:preview?'preview':'named',readSourceInfo:()=>appStorage.sourceInfo(),readBundledSourceInfo:()=>sourceMetadata,readMigrationCatalog:()=>readTrustedMigrationCatalog(path.join(root,'..','database')),readTemplate:()=>inspectTrustedTemplate({file:path.join(root,'assets','Card_of_Deviation_Template_v6.docx'),expectedSha256:'651bafd0aeb541ae0b1fa5e85191b9351222789c525f63b6ed69e34595ca0db0'/* antd-register: template with neutral names */}),publishNamedRead});

// Admission owns the SQL scope of an expensive operation. Auth/catalog stages
// and ordinary handlers have separate scopes, so a parent request scope cannot
// outlive an already released expensive-operation credit.
const withApiSql=operation=>appStorage.sqlExecution?appStorage.sqlExecution.run({},operation):operation();

function sendJson(response, status, body, projection={}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  response.end(JSON.stringify(publicJsonResponse(correlatedErrorBody(response,status,body),projection)));
}

async function readJson(request,maximum=1024*1024) {
  let bytes;try{bytes=await readBuffer(request,maximum);}catch(error){if(error.code==='REQUEST_BODY_TOO_LARGE'){error.code='JSON_REQUEST_TOO_LARGE';error.message=`The JSON request exceeds the ${Math.floor(maximum/(1024*1024))} MB limit.`;}throw error;}
  let body;try{body=bytes.length?JSON.parse(bytes.toString('utf8')):{};}catch{throw httpError(400,'The request body is not valid JSON. Send a JSON object and try again.',{code:'INVALID_JSON'});}
  if(!body||typeof body!=='object'||Array.isArray(body))throw httpError(400,'The request body must be a JSON object.',{code:'INVALID_JSON_OBJECT'});
  return body;
}

async function readBuffer(request, maximum = 30 * 1024 * 1024) {
  const permit=bodyAdmission.acquire({ownerKey:request.admissionOwner||'anonymous',contentLength:request.headers['content-length'],maximumBytes:maximum});
  permit.bind(request,request.admissionResponse);
  const chunks = [];
  for await (const chunk of request) {
    permit.observe(chunk.length);
    chunks.push(chunk);
  }
  permit.complete();
  return Buffer.concat(chunks);
}

function sendFile(response, file) {
  const asciiName = file.filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  response.writeHead(200, {
    "Content-Type": file.contentType,
    "Content-Length": file.buffer.length,
    "Content-Disposition": `${file.inline?'inline':'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy":"no-referrer",
    ...(file.inline?{"Content-Security-Policy":"sandbox; default-src 'none'; frame-ancestors 'self'","X-Frame-Options":"SAMEORIGIN"}:{})
    ,...(file.artifactId ? {"X-Artifact-Id":file.artifactId} : {})
  });
  response.end(file.buffer);
}

function requestContext(request) {
  const requestedRole = String(request.headers["x-user-role"] || "ADMINISTRATOR").toUpperCase();
  if (!roles.includes(requestedRole)) throw httpError(403, "Unknown preview role.");
  const role = requestedRole;
  return {
    role,
    actor: String(request.headers["x-user-name"] || (role === "ADMINISTRATOR" ? "Local administrator" : role === "SUPPLIER" ? "Supplier user" : "Client user")).slice(0, 120)
  };
}

function requireRole(response, context, allowed) {
  if (allowed.includes(context.role)) return true;
  sendJson(response, 403, { error: `The ${context.role.toLowerCase()} role cannot perform this action.`, allowedRoles: allowed });
  return false;
}

function expectedVersion(body) {
  if (!Number.isSafeInteger(body.rowVersion) || body.rowVersion < 1) throw httpError(428, "Reload the record before saving: its row version is required.", { code: "ROW_VERSION_REQUIRED" });
  return body.rowVersion;
}

function validateModeration(body, current) {
  const value = {
    decisionStatus: String(body.decisionStatus || "").trim().toUpperCase(),
    responsible: String(body.responsible || "").trim(),
    decisionReference: String(body.decisionReference || "").trim(),
    decisionDate: String(body.decisionDate || "").trim(),
    decisionComment: String(body.decisionComment || "").trim(),
    notes: String(body.notes || "").trim()
  };
  const errors = {};
  const lifecycle = current?.recordType === 'LIFECYCLE';
  if (!(lifecycle ? ['OBSOLETE'] : ["APPROVED", "REJECTED"]).includes(value.decisionStatus)) errors.decisionStatus = lifecycle ? 'Lifecycle status must remain OBSOLETE.' : "Select APPROVED or REJECTED.";
  if (!lifecycle && !value.responsible) errors.responsible = "Responsible person is required.";
  if (value.decisionStatus === "APPROVED" && !value.decisionReference) errors.decisionReference = "Decision Reference is required for an approved decision.";
  if (!validBusinessDate(value.decisionDate)) errors.decisionDate = "Enter a valid decision date (YYYY-MM-DD).";
  if (value.decisionStatus === "REJECTED" && !value.decisionComment) errors.decisionComment = "Rejection reason is required.";
  const reason = String(body.moderationReason || "").trim();
  if (!reason) errors.moderationReason = "Reason for the database change is required.";
  return { value, reason, errors };
}

async function handleApi(request, response, url) {
  if(preview)checkPreviewRequest(request,port);
  if(/^\/api\/(?:v1\/)?health\/ready$/.test(url.pathname)){
    if(request.method!=='GET'){response.setHeader('Allow','GET');return sendJson(response,405,{error:'Readiness checks require GET.',code:'EXECUTION_HEALTH_METHOD'});}
    const result=await withApiSql(()=>executionReadiness(runtime));return sendJson(response,result.ready?200:503,result);
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, app: "Replacement Register", storage: (await withApiSql(()=>appStorage.health())).storage, authMode: preview ? "preview" : "named" });
  }
  if (auth && request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(request);
    const result = await withApiSql(()=>auth.login(request, body.login, body.password));
    response.setHeader("Set-Cookie", result.cookie);
    response.setHeader('X-RR-Session',result.csrfToken);
    return sendJson(response, 200, { user: result.user, csrfToken: result.csrfToken });
  }
  const context = httpAuditContext(request,preview ? requestContext(request) : await withApiSql(()=>auth.context(request)));
  if(context)request.admissionOwner=context.userId||snapshotDigest({role:context.role,actor:context.actor,organization:context.organization||''});
  if(auth)response.setHeader('X-RR-Session',context?.csrfToken||'anonymous');
  if (context) context.requestId = request.requestId;
  if (request.method === "GET" && url.pathname === "/api/session") {
    return sendJson(response, 200, { authenticated: Boolean(context), authMode: preview ? "preview" : "named", ...(context || {}), roles: preview ? roles : undefined });
  }
  if (!context) return sendJson(response, 401, { error: "Sign in to continue.", code: "AUTHENTICATION_REQUIRED" });
  if (auth && !["GET", "HEAD"].includes(request.method)) auth.checkCsrf(request, context);
  if (auth && request.method === "POST" && url.pathname === "/api/auth/logout") {
    response.setHeader("Set-Cookie", await withApiSql(()=>auth.logout(request, context)));
    return sendJson(response, 200, { ok: true });
  }
  if (auth && request.method === "POST" && url.pathname === "/api/auth/password") {
    const body = await readJson(request);
    await withApiSql(()=>auth.changePassword(context, body.currentPassword, body.password));
    response.setHeader("Set-Cookie", auth.cookie("", 0));
    return sendJson(response, 200, { ok: true, signInAgain: true });
  }
  if (context.mustChangePassword) return sendJson(response, 403, { error: "Change your temporary password before continuing.", code: "PASSWORD_CHANGE_REQUIRED" });
  const storage = scopedStorage(appStorage, context);
  const policy=apiExecutionPolicy(request.method,url.pathname);
  const operation=()=>handleAuthorizedApi(request,response,url,context,storage);
  if(policy&&(!policy.previewOnly||preview)){
    if(policy.roles&&!requireRole(response,context,policy.roles))return;
    return withResponseWorkload(workloadAdmission,{ownerKey:workloadOwnerKey(context),response},operation);
  }
  return withApiSql(operation);
}

async function handleAuthorizedApi(request,response,url,context,storage){
  if(url.pathname==='/api/admin/operations/status'){const result=await adminOperationsStatusRoute({request,url,context,service:adminOperationsStatus});for(const [name,value]of Object.entries(result.headers))response.setHeader(name,value);return sendJson(response,result.status,result.body);}
  if(request.method==='GET'&&url.pathname==='/api/review-state'){if(!preview)return sendJson(response,404,{error:'API endpoint not found.'});if(!requireRole(response,context,['ADMINISTRATOR']))return;return sendJson(response,200,await appStorage.reviewSnapshot(),{previewReviewState:true});}
  const registerColumnsRoute=/^\/api\/(?:v1\/)?register-columns$/.test(url.pathname);
  if(registerColumnsRoute){
    if(request.method!=='GET'){response.setHeader('Allow','GET');return sendJson(response,405,{error:'Register column metadata requires GET.',code:'REGISTER_COLUMNS_METHOD_NOT_ALLOWED'});}
    const filters=Object.fromEntries(url.searchParams);if(Object.keys(filters).some(key=>key!=='registerKind'))throw httpError(422,'Select only the register kind for column metadata.',{code:'INVALID_REGISTER_COLUMN_FILTER'});
    const registerKind=filters.registerKind;return sendJson(response,200,{registerKind,fields:registerColumnFields(registerKind)});
  }
  const registerViewRoute=url.pathname.match(/^\/api\/(?:v1\/)?register-views(?:\/(.*))?$/);
  if(registerViewRoute){
    const id=registerViewRoute[1],filters=Object.fromEntries(url.searchParams);
    if(request.method==='GET'){
      if(id&&Object.keys(filters).length)throw httpError(422,'A saved-view detail does not accept list filters.',{code:'REGISTER_VIEW_FIELDS'});
      return sendJson(response,200,id?await registerViews.get(id,context):await registerViews.list(context,filters));
    }
    if(request.method==='POST'&&!id){if(Object.keys(filters).length)throw httpError(422,'Saved-view changes use the request body.',{code:'REGISTER_VIEW_FIELDS'});return sendJson(response,200,await registerViews.change(await readJson(request),context));}
    response.setHeader('Allow',id?'GET':'GET, POST');return sendJson(response,405,{error:'This saved-view endpoint does not support the requested method.',code:'REGISTER_VIEW_METHOD_NOT_ALLOWED'});
  }
  const managedRoundRoute=url.pathname.match(/^\/api\/(?:v1\/)?approval-rounds(?:\/(.*))?$/);
  if(managedRoundRoute){
    const suffix=managedRoundRoute[1]||'',filters=Object.fromEntries(url.searchParams),methodOnly=method=>{response.setHeader('Allow',method);return sendJson(response,405,{error:`This approval-round endpoint requires ${method}.`,code:'ROUND_METHOD_NOT_ALLOWED'});};
    if(suffix==='')return request.method==='GET'?sendJson(response,200,await managedRoundRead.listManagedRounds(context,filters)):methodOnly('GET');
    if(suffix==='manage'||suffix==='associate'){
      if(request.method!=='POST')return methodOnly('POST');roundAdministrator(context);const body=await readJson(request);
      return sendJson(response,200,suffix==='manage'?await appStorage.manageRound(context,body):await appStorage.associateRoundExchanges(context,body));
    }
    const workflowRoute=suffix.match(/^workflows\/([^/]+)\/(candidates|association-history)$/);
    if(workflowRoute){
      if(request.method!=='GET')return methodOnly('GET');roundAdministrator(context);const id=roundIdentifier(workflowRoute[1],'Workflow ID');
      return sendJson(response,200,workflowRoute[2]==='candidates'?await managedRoundRead.unassignedCandidates(context,id,filters):await managedRoundRead.associationHistory(context,id,filters));
    }
    const historyRoute=suffix.match(/^([^/]+)\/management-history$/);
    if(historyRoute){if(request.method!=='GET')return methodOnly('GET');roundAdministrator(context);return sendJson(response,200,await managedRoundRead.managementHistory(context,roundIdentifier(historyRoute[1]),filters));}
    if(!suffix.includes('/'))return request.method==='GET'?sendJson(response,200,await managedRoundRead.managedRoundExchanges(context,roundIdentifier(suffix),filters)):methodOnly('GET');
    return sendJson(response,404,{error:'Approval-round endpoint not found.',code:'ROUND_ENDPOINT_NOT_FOUND'});
  }
  if(request.method==='GET'&&url.pathname==='/api/rounds')return sendJson(response,200,await appStorage.listRounds(Object.fromEntries(url.searchParams),context));
  const roundMatch=url.pathname.match(/^\/api\/rounds\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  if(request.method==='GET'&&roundMatch)return sendJson(response,200,await appStorage.getRoundEvents(roundMatch[1],Object.fromEntries(url.searchParams),context));
  const snapshotsMatch=url.pathname.match(/^\/api\/exchanges\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/snapshots$/i);
  if(request.method==='GET'&&snapshotsMatch)return sendJson(response,200,await appStorage.getExchangeSnapshots(snapshotsMatch[1],Object.fromEntries(url.searchParams),context));
  const historyMatch=url.pathname.match(/^\/api\/(proposals|database)\/([^/]+)\/history$/);
  if(request.method==='GET'&&historyMatch){
    const streamType=historyMatch[1]==='database'?'RECORD':'PROPOSAL',subjectId=decodeURIComponent(historyMatch[2]),item=await storage[streamType==='RECORD'?'getReplacement':'getProposal'](subjectId);
    const page=await appStorage.listDecisionHistory({streamType,subjectId,cursor:url.searchParams.get('cursor')||'',limit:url.searchParams.get('limit')||50},context);
    if(!item&&!page.items.length)return sendJson(response,404,{error:'Decision history not found.'});
    if(item&&!page.items.length&&!url.searchParams.get('cursor'))page.items.push(existingStateHistory(streamType,item));
    return sendJson(response,200,{...page,streamType,subjectId});
  }
  if(request.method==='GET'&&url.pathname==='/api/decision-history'){
    if(!requireRole(response,context,['ADMINISTRATOR']))return;
    return sendJson(response,200,await appStorage.listDecisionHistory(Object.fromEntries(url.searchParams),context));
  }
  if(url.pathname==='/api/admin/references'||url.pathname==='/api/admin/references/preview'||url.pathname==='/api/admin/references/history'||/^\/api\/admin\/references\/history\/\d+$/.test(url.pathname)){
    if(!requireRole(response,context,['ADMINISTRATOR']))return;
    if(request.method==='GET'&&url.pathname==='/api/admin/references')return sendJson(response,200,await appStorage.getReferenceCatalog());
    if(request.method==='GET'&&url.pathname==='/api/admin/references/history')return sendJson(response,200,{items:await appStorage.listReferenceHistory()});
    if(request.method==='GET'){const revision=Number(url.pathname.split('/').at(-1)),catalog=Number.isSafeInteger(revision)?await appStorage.getReferenceRevision(revision):null;if(!catalog)return sendJson(response,404,{error:'Reference revision not found.'});return sendJson(response,200,catalog);}
    if(request.method==='POST'&&url.pathname==='/api/admin/references')return sendJson(response,200,await appStorage.changeReferenceEntry(await readJson(request),context));
    if(request.method==='POST'&&url.pathname==='/api/admin/references/preview')return sendJson(response,200,await appStorage.previewReferenceEntry(await readJson(request),context));
    return sendJson(response,405,{error:'Unsupported reference action.'});
  }
  if(request.method==='GET'&&url.pathname==='/api/exports'){
    if([...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1))throw httpError(422,'Export-history query parameters must appear once.',{code:'EXPORT_HISTORY_PAGE_INVALID'});
    return sendJson(response,200,await exportJobs.page(context,Object.fromEntries(url.searchParams)));
  }
  const reportRoute=url.pathname.match(/^\/api\/(?:v1\/)?register-reports(?:\/(.*))?$/);
  if(reportRoute){if(reportRoute[1])throw httpError(404,'Register report endpoint not found.',{code:'REGISTER_REPORT_NOT_FOUND'});if(request.method!=='POST'){response.setHeader('Allow','POST');return sendJson(response,405,{error:'Prepare register reports with POST.',code:'REGISTER_REPORT_METHOD'});}if([...url.searchParams.keys()].length)throw httpError(422,'Register report options belong in the JSON request body.',{code:'REGISTER_REPORT_INVALID'});const job=await registerReports.enqueue(await readJson(request,30*1024*1024),context,request.headers['idempotency-key']);wakePreparations();return sendJson(response,202,job);}
  const exportMatch=url.pathname.match(/^\/api\/exports\/([a-f0-9-]{36})(?:\/(issue|file))?$/);
  if(exportMatch) {
    if(request.method==='GET'&&!exportMatch[2])return sendJson(response,200,await exportJobs.get(exportMatch[1],context));
    if(request.method==='POST'&&exportMatch[2]==='issue')return sendJson(response,200,await exportJobs.issue(exportMatch[1],await readJson(request),context));
    if(request.method==='GET'&&exportMatch[2]==='file')return sendFile(response,await exportJobs.download(exportMatch[1],context));
    return sendJson(response,405,{error:'Unsupported export review action.'});
  }
  if(request.method==='GET'&&url.pathname==='/api/workflows/M07/products') {
    if(!requireRole(response,context,['ADMINISTRATOR']))return;
    const result=await publishNamedRead(appStorage.rawPool||appStorage.pool,context,async()=>{
      const state=await appStorage.exportState(context,{}, {workingOrder:true});
      if(!appStorage.pool)bindLocalProposalWorkingOrder(state.proposals);state.proposals=stageProposalWorkingOrder(state.proposals);
      const history=createHistoryIndex(state.replacements);
      const rows=copyProposalWorkingOrder(state.proposals,state.proposals.map(row=>recalculateProposal(row,history)));
      return {items:permitCatalog(rows).map(item=>{
        const orderRows=rows.filter(row=>!row.archived&&normalize(row.orderNo)===item.orderKey),labelDependsOnOrder=new Set(orderRows.map(row=>row.orderNo)).size>1;
        const contributors=copyProposalWorkingOrder(rows,labelDependsOnOrder?orderRows:orderRows.filter(row=>normalize(row.productDecimalNo)===item.productKey));
        const workingOrderKnown=proposalWorkingOrderKnown(contributors);
        return workingOrderKnown?{...item,workingOrderKnown}:{...item,product:'',storedCode:null,currentCodes:[],updatesIfStored:null,workingOrderKnown};
      })};
    });
    return sendJson(response,200,result);
  }
  const prepareMatch=url.pathname.match(/^\/api\/workflows\/(M01|M03|M05|M06|M07|M09)\/exports$/);
  if(request.method==='POST'&&prepareMatch) {
    const module=moduleFor(prepareMatch[1]);if(!requireRole(response,context,module.roles))return;
    if(module.id==='M01') {
      const input=await readBuffer(request);const filename=decodeURIComponent(String(request.headers['x-file-name']||'workbook.xlsx'));const options=Object.fromEntries(url.searchParams);
      return sendJson(response,202,await enqueueExport(module.id,options,context,request,{input,filename}));
    }
    const body=await readJson(request);return sendJson(response,202,await enqueueExport(module.id,body.options||body,context,request));
  }
  const commandMatch=url.pathname.match(/^\/api\/(?:v1\/)?commands(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(cancel|retry))?)?$/);
  if(commandMatch){
    const current=commandContext(context);
    if(request.method==='GET'&&!commandMatch[1])return sendJson(response,200,await commandService.list(current,Object.fromEntries(url.searchParams)));
    if(request.method==='POST'&&!commandMatch[1])return sendJson(response,202,await enqueueCommand(await readJson(request),context,request));
    if(request.method==='GET'&&commandMatch[1]&&!commandMatch[2])return sendJson(response,200,await commandService.get(commandMatch[1],current));
    if(request.method==='POST'&&commandMatch[2]){const job=await commandService.change(commandMatch[1],commandMatch[2],current);wakeCommands();return sendJson(response,200,job);}
    return sendJson(response,405,{error:'Unsupported confirmed operation action.'});
  }
  if(request.method==='GET'&&url.pathname==='/api/preparations')return sendJson(response,200,{items:await preparations.list(context)});
  const preparationMatch=url.pathname.match(/^\/api\/preparations\/([a-f0-9-]{36})(?:\/(cancel|retry))?$/);
  if(preparationMatch){if(request.method==='GET'&&!preparationMatch[2])return sendJson(response,200,await preparations.get(preparationMatch[1],context));if(request.method==='POST'&&preparationMatch[2]){const result=await preparations.change(preparationMatch[1],preparationMatch[2],context);wakePreparations();return sendJson(response,200,result);}return sendJson(response,405,{error:'Unsupported preparation action.'});}
  if(request.method==='GET'&&url.pathname==='/api/imports')return sendJson(response,200,{items:await appStorage.listImportBatches(context)});
  const batchMatch=url.pathname.match(/^\/api\/imports\/([a-f0-9-]{36})(?:\/(review|commit|report))?$/);
  if(batchMatch) {
    const batch=await appStorage.getImportBatch(batchMatch[1],context);
    if(request.method==='GET'&&!batchMatch[2])return sendJson(response,200,batch);
    if(request.method==='GET'&&batchMatch[2]==='report')return sendFile(response,{filename:`${batch.moduleId}_Import_Review_${batch.batchId}_v${batch.revision}.json`,contentType:'application/json',buffer:Buffer.from(JSON.stringify(publicJsonResponse(batch),null,2))});
    if(request.method==='POST'&&['review','commit'].includes(batchMatch[2])) {
      const body=await readJson(request);
      const artifact=await artifacts.get(batch.artifactId,context);
      if(batchMatch[2]==='commit'){
        return sendJson(response,202,await enqueueCommand({kind:'IMPORT_COMMIT',batchId:batch.batchId,revision:body.revision,acceptFindings:body.acceptFindings??false},context,request));
      }
      checkImportRefresh(batch,body.revision);
      const options=importOptions({...batch.options,...body.options});
      return sendJson(response,202,await enqueueImport(batch.moduleId,null,batch.filename,options,context,request,artifact,{batchId:batch.batchId,revision:body.revision}));
    }
    return sendJson(response,405,{error:'Unsupported import review action.'});
  }
  const stageMatch=url.pathname.match(/^\/api\/workflows\/(M02|M04|M08)\/imports$/);
  if(request.method==='POST'&&stageMatch) {
    const module=moduleFor(stageMatch[1]);if(!requireRole(response,context,module.roles))return;
    const input=await readBuffer(request);const filename=decodeURIComponent(String(request.headers['x-file-name']||'workbook.xlsx'));const options=importOptions(Object.fromEntries(url.searchParams));
    return sendJson(response,202,await enqueueImport(module.id,input,filename,options,context,request));
  }
  if (request.method==='GET' && url.pathname==='/api/files') {
    const options=fileLibraryPageOptions(url.searchParams);
    return sendJson(response,200,await publishNamedRead(appStorage.rawPool||appStorage.pool,context,async()=>({...await artifacts.page(context,options),preview})));
  }
  const previewMatch=url.pathname.match(/^\/api\/files\/([a-f0-9-]+)\/preview$/);
  if(previewMatch&&request.method==='GET')return sendFile(response,await attachmentPreview(artifacts,previewMatch[1],context));
  const fileMatch=url.pathname.match(/^\/api\/files\/([a-f0-9-]+)(\/rescan)?$/);
  if (fileMatch && request.method==='GET' && !fileMatch[2]) {
    return sendFile(response,await exportJobs.downloadArtifact(fileMatch[1],context));
  }
  if (fileMatch && request.method==='POST' && fileMatch[2]) {
    if(!requireRole(response,context,['ADMINISTRATOR']))return;
    const job=await filePreparations.enqueue('RESCAN',context,{artifact:await artifacts.get(fileMatch[1],context),idempotencyKey:request.headers['idempotency-key']});wakePreparations();return sendJson(response,202,job);
  }
  const attachmentMatch=url.pathname.match(/^\/api\/proposals\/([^/]+)\/attachments$/);
  if (attachmentMatch) {
    const proposal=await storage.getProposal(decodeURIComponent(attachmentMatch[1]));
    if(!proposal) throw httpError(404,'Proposal not found.');
    if(request.method==='GET') {
      const options=fileLibraryPageOptions(url.searchParams);
      if(options.kind&&options.kind!=='ATTACHMENT'||options.proposalId&&options.proposalId!==proposal.proposalId)throw httpError(422,'Attachment filters must match this proposal and the attachment file kind.',{code:'FILE_LIBRARY_FILTER_INVALID'});
      return sendJson(response,200,await publishNamedRead(appStorage.rawPool||appStorage.pool,context,async()=>({...await artifacts.page(context,{...options,kind:'ATTACHMENT',proposalId:proposal.proposalId}),preview})));
    }
    if(request.method==='POST') {
      const input=await readBuffer(request);
      let attachmentMetadata;
      try{if(request.headers['x-attachment-metadata']){attachmentMetadata=JSON.parse(decodeURIComponent(String(request.headers['x-attachment-metadata'])));if(!attachmentMetadata||typeof attachmentMetadata!=='object'||Array.isArray(attachmentMetadata))throw new Error();}}catch{throw httpError(400,'Attachment metadata must be a JSON object.',{code:'ATTACHMENT_METADATA_INVALID'});}
      const declared=request.headers['x-attachment-mime']||request.headers['content-type'];
      const contentType=declared==='application/octet-stream'?undefined:declared;
      const job=await filePreparations.enqueue('ATTACHMENT',context,{bytes:input,filename:decodeURIComponent(String(request.headers['x-file-name']||'attachment.pdf')),contentType,attachmentMetadata,proposal,idempotencyKey:request.headers['idempotency-key']});wakePreparations();return sendJson(response,202,job);
    }
  }
  if(/^\/api\/(?:v1\/)?original-boms(?:\/|$)/.test(url.pathname)){
    const sourceBomRoute=url.pathname.match(/^\/api\/(?:v1\/)?original-boms(?:\/([^/]+)(\/rows)?)?$/);
    if(!sourceBomRoute)throw httpError(404,'Source BOM endpoint not found.',{code:'BOM_ENDPOINT_NOT_FOUND'});
    const [,id,rows]=sourceBomRoute,filters=Object.fromEntries(url.searchParams);
    if(request.method==='GET'){
      if(id&&!rows&&url.searchParams.size)throw httpError(422,'The source BOM detail endpoint does not accept filters.',{code:'BOM_FILTER_INVALID'});
      return sendJson(response,200,id?(rows?await sourceBomRead.rows(id,context,filters):await sourceBomRead.get(id,context)):await sourceBomRead.list(context,filters));
    }
    if(request.method==='POST'&&!id){
      if(!requireRole(response,context,['ADMINISTRATOR']))return;
      const input=await readBuffer(request);const filename=decodeURIComponent(String(request.headers['x-file-name']||'original.xlsx'));
      const job=await filePreparations.enqueue('REGISTER_BOM',context,{bytes:input,filename,options:exportOptions(filters),idempotencyKey:request.headers['idempotency-key']});wakePreparations();return sendJson(response,202,job);
    }
    response.setHeader('Allow',id?'GET':'GET, POST');
    return sendJson(response,405,{error:id?'This source BOM endpoint requires GET.':'The source BOM catalog requires GET or POST.',code:'BOM_METHOD_NOT_ALLOWED'});
  }
  if (auth && url.pathname === "/api/admin/users") {
    if (!requireRole(response, context, ["ADMINISTRATOR"])) return;
    if (request.method === "GET") return sendJson(response, 200, { items: await auth.listUsers() });
    if (request.method === "POST") return sendJson(response, 201, await auth.createUser(await readJson(request), context));
  }
  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/);
  if (auth && request.method === "PATCH" && userMatch) {
    if (!requireRole(response, context, ["ADMINISTRATOR"])) return;
    return sendJson(response, 200, await auth.updateUser(userMatch[1], await readJson(request), context));
  }
  if (request.method === "GET" && url.pathname === "/api/source") {
    return sendJson(response, 200, publicSourceInfo(await storage.sourceInfo()));
  }
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    return sendJson(response,200,await registerQuery.dashboard(context));
  }
  if(request.method==='GET'&&url.pathname==='/api/dashboard/order-timing')return sendJson(response,200,await registerQuery.orderTiming(url.searchParams.get('orderNo')||'',context));
  if (request.method === "GET" && url.pathname === "/api/orders") {
    return sendJson(response,200,await registerQuery.orders(context));
  }
  if(request.method==='GET'&&url.pathname==='/api/workflows/catalog')return sendJson(response,200,await registerQuery.catalog(context));
  if(request.method==='GET'&&url.pathname==='/api/proposals/next-review'){if(!requireRole(response,context,['ADMINISTRATOR','CLIENT']))return;return sendJson(response,200,await registerQuery.nextReview(Object.fromEntries(url.searchParams),context));}
  if (request.method === "GET" && url.pathname === "/api/proposals") {
    return sendJson(response,200,await registerQuery.page('proposals',Object.fromEntries(url.searchParams),context));
  }

  const decisionMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/decision$/);
  if (request.method === "POST" && decisionMatch) {
    if (!requireRole(response, context, ["ADMINISTRATOR", "CLIENT"])) return;
    const body = await readJson(request);
    const validation = validateDecision(body);
    if (Object.keys(validation.errors).length) return sendJson(response, 422, { error: "Decision validation failed.", fields: validation.errors });
    const proposal = await storage.saveDecision(decodeURIComponent(decisionMatch[1]), validation.value, copyAuditContext(context,{ ...context, expectedVersion: expectedVersion(body) }));
    return proposal ? sendJson(response, 200, proposal) : sendJson(response, 404, { error: "Proposal not found." });
  }

  const proposalMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)$/);
  if (request.method === "GET" && proposalMatch) {
    const proposal = await storage.getProposal(decodeURIComponent(proposalMatch[1]));
    return proposal ? sendJson(response, 200, proposal) : sendJson(response, 404, { error: "Proposal not found." });
  }

  if (request.method === "GET" && url.pathname === "/api/database") {
    return sendJson(response,200,await registerQuery.page('database',Object.fromEntries(url.searchParams),context));
  }
  const databaseMatch = url.pathname.match(/^\/api\/database\/([^/]+)$/);
  if (request.method === "GET" && databaseMatch) {
    const id=decodeURIComponent(databaseMatch[1]);
    const item = context.role==='ADMINISTRATOR'?await readAdministratorRecordDetail(appStorage,id,context):await storage.getReplacement(id);
    return item ? sendJson(response, 200, item,{administratorRecordDetail:context.role==='ADMINISTRATOR'}) : sendJson(response, 404, { error: "Database record not found." });
  }
  if (request.method === "PATCH" && databaseMatch) {
    if (!requireRole(response, context, ["ADMINISTRATOR"])) return;
    const body = await readJson(request);
    const current = await storage.getReplacement(decodeURIComponent(databaseMatch[1]));
    if (!current) return sendJson(response,404,{error:'Database record not found.'});
    const validation = validateModeration(body,current);
    if (Object.keys(validation.errors).length) return sendJson(response, 422, { error: "Database moderation validation failed.", fields: validation.errors });
    const item = await storage.updateReplacement(decodeURIComponent(databaseMatch[1]), validation.value, copyAuditContext(context,{ ...context, reason: validation.reason, expectedVersion: expectedVersion(body) }));
    return item ? sendJson(response, 200, item) : sendJson(response, 404, { error: "Database record not found." });
  }
  if (request.method === "DELETE" && databaseMatch) {
    if (!requireRole(response, context, ["ADMINISTRATOR"])) return;
    const body = await readJson(request);
    const reason = String(body.deletionReason || "").trim();
    if (!reason) return sendJson(response, 422, { error: "Database deletion validation failed.", fields: { deletionReason: "Reason for deleting this database record is required." } });
    const item = await storage.deleteReplacement(decodeURIComponent(databaseMatch[1]), copyAuditContext(context,{ ...context, reason, expectedVersion: expectedVersion(body) }));
    return item ? sendJson(response, 200, { deleted: item }) : sendJson(response, 404, { error: "Database record not found." });
  }

  if (request.method === "GET" && url.pathname === "/api/workflows") {
    const modules = workflowModules.map((module) => ({ ...module, allowed: canUseModule(module, context.role) }));
    return sendJson(response, 200, { role: context.role, modules, runs: await storage.listWorkflowRuns({orderNo:url.searchParams.get('orderNo')||'',limit:10},context) });
  }
  const workflowInspectMatch = url.pathname.match(/^\/api\/workflows\/(M01)\/inspect$/);
  if (request.method === "POST" && workflowInspectMatch) {
    const module = moduleFor(workflowInspectMatch[1]);
    if (!requireRole(response, context, module.roles)) return;
    const input = await readBuffer(request);
    const filename = decodeURIComponent(String(request.headers["x-file-name"] || "workbook.xlsx"));
    const job=await filePreparations.enqueue('INSPECT',context,{bytes:input,filename,options:exportOptions(Object.fromEntries(url.searchParams)),idempotencyKey:request.headers['idempotency-key']});wakePreparations();return sendJson(response,202,job);
  }
  const workflowSuggestionMatch = url.pathname.match(/^\/api\/workflows\/(M(?:01|03|05|06|07|09))\/suggestion$/);
  if (request.method === "GET" && workflowSuggestionMatch) {
    const module = moduleFor(workflowSuggestionMatch[1]);
    if (!requireRole(response, context, module.roles)) return;
    const suggest=async()=>{
    const options = Object.fromEntries(url.searchParams.entries());
    delete options.exportDate;
    const state=module.id==='M01'?{proposals:[],replacements:[]}:await appStorage.exportState(context,{orderNo:options.orderNo||''},{workingOrder:true});
    if(module.id!=='M01'){if(!appStorage.pool)bindLocalProposalWorkingOrder(state.proposals);state.proposals=stageProposalWorkingOrder(state.proposals);}
    const proposals=state.proposals;
    let items=proposals;
    if(['M03','M05','M06'].includes(module.id)){const scope=exchangeScope(module.id,proposals,options);options.orderNo=scope.orderNo;items=scope.rows;}
    if(module.id==='M06'&&new Set(items.map(row=>row.orderNo)).size>1)requireKnownWorkingOrder(copyProposalWorkingOrder(proposals,items));
    if(module.id==='M07'&&!options.orderNo&&!(selectionValues(options.orderNos)||[]).length){
      const history=createHistoryIndex(state.replacements),catalog=permitCatalog(proposals.map(row=>recalculateProposal(row,history))),orders=[...new Set(catalog.map(row=>row.orderKey))];
      if(orders.length>1)throw httpError(422,'Choose the orders for the deviation permits.',{code:'M07_ORDER_SELECTION_REQUIRED'});
      if(!orders.length)throw httpError(422,'M07 cannot generate deviation permits.',{code:'M07_NO_ELIGIBLE_ROWS'});
      const orderRows=proposals.filter(row=>!row.archived&&normalize(row.orderNo)===orders[0]);if(new Set(orderRows.map(row=>row.orderNo)).size>1)requireKnownWorkingOrder(copyProposalWorkingOrder(proposals,orderRows));options.orderNo=catalog[0].orderNo;
    }
    if(module.id==='M09' && options.sourceArtifactId) {const source=await artifacts.get(options.sourceArtifactId,context);items=source.scope.orderNos.map(orderNo=>({orderNo,productDecimalNo:source.scope.productDecimalNos[0],supplier:source.scope.suppliers[0]}));}
    if(module.id==='M09'&&!options.sourceArtifactId&&!options.orderNo)items=requireKnownWorkingOrder(copyProposalWorkingOrder(proposals,proposals.filter(row=>!row.archived)));
    options.version=await artifacts.exportVersion(exportKey(module.id,items,options));
    if(['M03','M05'].includes(module.id)) {
      return workflowExchangeSuggestion(module.id,proposals,state.replacements,options,rows=>requireKnownWorkingOrder(copyProposalWorkingOrder(proposals,rows)));
    }
    return { filename: workflowFilenameSuggestion(module.id, items, options),version:options.version };
    };
    const result=await publishNamedRead(appStorage.rawPool||appStorage.pool,context,suggest);return sendJson(response,200,result);
  }
  const workflowFileMatch = url.pathname.match(/^\/api\/workflows\/(M(?:0[1-9]))\/file$/);
  if (workflowFileMatch) {
    const module = moduleFor(workflowFileMatch[1]);
    if (!module) return sendJson(response, 404, { error: "Workflow module not found." });
    if (!requireRole(response, context, module.roles)) return;
    const options = Object.fromEntries(url.searchParams.entries());
    delete options.exportDate;
    if (request.method === "GET" || request.method === "HEAD") {
      response.setHeader('Allow','POST');
      if(['M02','M04','M08'].includes(module.id))return sendJson(response,405,{error:'Importing a workflow file requires an uploaded workbook and a confirmed import review.',code:'IMPORT_REVIEW_REQUIRED',details:[`Prepare: POST /api/workflows/${module.id}/imports`, 'Confirm: POST /api/imports/{batchId}/commit']});
      return sendJson(response,405,{error:'Creating a workflow file requires a reviewed export. Open Workflow, review its scope and filename, then confirm issuance. To save an issued file again, use Saved exports.',code:'EXPORT_REVIEW_REQUIRED',details:[`Prepare: POST /api/workflows/${module.id}/exports`, 'Confirm: POST /api/exports/{jobId}/issue', 'Save issued bytes: GET /api/exports/{jobId}/file']});
    }
    if(request.method==='POST'&&['M03','M05','M06','M07','M09'].includes(module.id)){
      const body=await readJson(request);
      return sendJson(response,202,await enqueueExport(module.id,{...options,...(body.options||body)},context,request,{expectedVersion:options.version??null}));
    }
    if (request.method === "POST" && ["M01", "M02", "M04", "M08"].includes(module.id)) {
      const input = await readBuffer(request);
      const filename = decodeURIComponent(String(request.headers["x-file-name"] || "workbook.xlsx"));
      if (module.id === "M01") {
        const review=await enqueueExport(module.id,options,context,request,{input,filename,expectedVersion:options.version??null});
        return sendJson(response,202,review);
      }
      return sendJson(response,202,await enqueueImport(module.id,input,filename,options,context,request));
    }
    return sendJson(response, 405, { error: "This workflow does not support that file operation." });
  }
  const archiveReviewMatch=url.pathname.match(/^\/api\/workflows\/M11\/reviews(?:\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))?$/);
  if(archiveReviewMatch){
    if(!requireRole(response,context,['ADMINISTRATOR']))return;
    if(request.method==='POST'&&!archiveReviewMatch[1])return sendJson(response,201,await appStorage.prepareArchiveReview(context,await readJson(request)));
    if(request.method==='GET'&&archiveReviewMatch[1])return sendJson(response,200,await appStorage.getArchiveReview(archiveReviewMatch[1],context));
    return sendJson(response,405,{error:'Unsupported workspace review action.'});
  }
  const workflowMatch = url.pathname.match(/^\/api\/workflows\/(M(?:0[1-9]|1[01]|9[01]))\/run$/);
  if (request.method === "POST" && workflowMatch) {
    const module = moduleFor(workflowMatch[1]);
    if (!module) return sendJson(response, 404, { error: "Workflow module not found." });
    if (!requireRole(response, context, module.roles)) return;
    if(['EXPORT','IMPORT','DOCUMENT'].includes(module.kind))throw httpError(409,'Use the file exchange action for this module; a log-only run does not create or import its workbook.',{code:'FILE_OPERATION_REQUIRED'});
    const options=await readJson(request);
    if(['M10','M90','M91'].includes(module.id))return sendJson(response,202,await enqueueCommand({kind:'WORKFLOW',moduleId:module.id,options:options.orderNo===''?{}:options},context,request));
    const run = await storage.runWorkflow(module.id, context, options);
    return sendJson(response, run.result.status === "CONFIRMATION_REQUIRED" ? 409 : 200, run);
  }

  if (request.method === "GET" && url.pathname === "/api/final-approval") {
    if(!requireRole(response,context,moduleFor('M06').roles))return;
    const result=await publishNamedRead(appStorage.rawPool||appStorage.pool,context,async()=>{
      const orderNo = url.searchParams.get("orderNo") || "";
      const state=await appStorage.exportState(context,{orderNo},{workingOrder:true});if(!appStorage.pool)bindLocalProposalWorkingOrder(state.proposals);
      state.proposals=stageProposalWorkingOrder(state.proposals);const history=createHistoryIndex(state.replacements);
      const proposals=copyProposalWorkingOrder(state.proposals,state.proposals.filter(row=>!row.archived).map(item=>recalculateProposal(item,history)));
      const { unresolved, missingProductionOrder, rows: eligible } = finalPreflight(proposals);
      const ordered=requireKnownWorkingOrder(copyProposalWorkingOrder(proposals,eligible));
      const sheets = Object.values(ordered.reduce((groups, item) => {
        const key=normalize(item.productDecimalNo);
        groups[key] ||= { name: item.productDecimalNo, product: item.product, rows: [] };
        groups[key].rows.push(item);
        return groups;
      }, Object.create(null)));
      return { orderNo, sheets, preflight: { unresolved: unresolved.length, missingProductionOrder: missingProductionOrder.length, blocked: unresolved.length + missingProductionOrder.length > 0 } };
    });
    return sendJson(response,200,result);
  }
  if (request.method === "GET" && url.pathname === "/api/audit") {
    return sendJson(response,200,await auditFeed.list(Object.fromEntries(url.searchParams),context));
  }
  if(request.method==='POST'&&url.pathname==='/api/audit/exports'){
    if(!requireRole(response,context,['ADMINISTRATOR']))return;
    const body=await readJson(request),result=await auditFeed.prepareReport(body.filters||{},context,{format:body.format===undefined?'xlsx':body.format});
    return sendJson(response,201,result);
  }
  return sendJson(response, 404, { error: "API endpoint not found." });
}

const server = http.createServer({maxHeaderSize:32768,requestTimeout:120000,headersTimeout:15000},async (request, response) => {
  const serverRequestId=beginRequestTrace(request,response);
  request.admissionResponse=response;
  try {
    bindHttpRequestAudit(request,runtime.auditRuntime,serverRequestId);
    let url;try{url=new URL(request.url,`http://${request.headers.host||`${host}:${port}`}`);}catch{throw httpError(400,'Invalid request URL or Host header.',{code:'INVALID_REQUEST_URL'});}
    if (url.pathname.startsWith("/api/")) {
      const catalogIndependent=['/api/admin/operations/status','/api/health','/api/health/ready','/api/v1/health/ready','/api/session','/api/auth/login','/api/auth/logout','/api/auth/password','/api/workflows/M90/run','/api/audit','/api/audit/exports'].includes(url.pathname)||/^\/api\/(?:v1\/)?commands(?:\/|$)/.test(url.pathname);
      return catalogIndependent?await handleApi(request,response,url):await withCatalog(await withApiSql(()=>appStorage.getReferenceCatalog()),()=>handleApi(request,response,url));
    }
    return await serveStaticFile(request,response,url.pathname,{root:publicRoot});
  } catch (error) {
    if(request.aborted||response.destroyed){if(!['ECONNRESET','ERR_STREAM_PREMATURE_CLOSE','UPLOAD_ADMISSION_RELEASED'].includes(error.code)&&errorStatus(error)>=500)console.error(JSON.stringify(safeRequestErrorRecord(error,request,{aborted:true})));return;}
    for(const [name,value] of Object.entries(error.headers||{}))if(name.toLowerCase()==='retry-after')response.setHeader(name,value);
    const executionFailure=executionApiFailure(error);
    const status = executionFailure?.status||errorStatus(error);
    if (status >= 500) console.error(JSON.stringify(safeRequestErrorRecord(error,request)));
    if(executionFailure)return sendJson(response,status,{error:executionFailure.message,code:executionFailure.code,details:executionFailure.details});
    if (error instanceof WorkflowFileError || status < 500 || ['SETUP_REPORT_NOT_SAVED','FILE_STORAGE_RESERVE','FILE_STORAGE_UNAVAILABLE','PREPARATION_ADMISSION_UNAVAILABLE','COMMAND_QUEUE_UNAVAILABLE','BOM_CATALOG_UNAVAILABLE','REGISTER_VIEWS_UNAVAILABLE','AUDIT_XLSX_UNAVAILABLE','WORKING_ORDER_UNAVAILABLE'].includes(error.code)) {
      return sendJson(response, status, { error: error.message, code: error.code || "WORKFLOW_FILE_ERROR", details: error.details || [], current: error.current });
    }
    return sendJson(response, 500, { error: "The request could not be completed.", detail: process.env.NODE_ENV === "development" ? error.message : undefined });
  }
});

let shuttingDown=null,shutdownExitCode=0;
async function shutdown(exitCode=0){
 shutdownExitCode=Math.max(shutdownExitCode,exitCode);
 if(shuttingDown)return shuttingDown;
 const forced=setTimeout(()=>process.exit(1),runtime.forcedShutdownMs);
 const httpDrained=new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();
 shuttingDown=runtime.close({httpDrained}).then(()=>{clearTimeout(forced);process.exitCode=runtime.fatalError?1:shutdownExitCode;},()=>{process.exitCode=1;});return shuttingDown;
}
runtime.onFatal(()=>{shutdown(1).catch(()=>{});});
process.on('SIGINT',()=>{shutdown().catch(()=>{});});process.on('SIGTERM',()=>{shutdown().catch(()=>{});});
try{await runtime.startExecution();server.listen(port,host,()=>{console.log(`Replacement Register listening on http://${host}:${port}`);console.log(`Storage mode: ${process.env.RR_STORAGE==='postgres'?'PostgreSQL':'authoritative workbook preview'}`);});}catch(error){await runtime.close({graceMs:0});throw error;}
server.on('error',()=>{shutdown(1).catch(()=>{});});
