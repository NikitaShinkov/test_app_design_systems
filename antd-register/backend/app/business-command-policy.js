import {createHash} from 'node:crypto';
import {httpError} from './auth.js';
import {executionApiFailure} from './execution-api-policy.js';
import {safeFileOperationFailure} from './file-operation-errors.js';

const roles=new Set(['ADMINISTRATOR','SUPPLIER','CLIENT']);
const workflows=new Set(['M10','M90','M91']);
const imports=new Set(['M02','M04','M08']);
const statuses=new Set(['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED']);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const text=(value,limit)=>typeof value==='string'&&value.length<=limit&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=(message='Provide a valid confirmed business command.',code='COMMAND_DESCRIPTOR_INVALID')=>httpError(422,message,{code});

function record(value,allowed,required=[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw invalid();
  const properties=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(properties).some(key=>typeof key!=='string'||!allowed.includes(key)||!Object.hasOwn(properties[key],'value'))||required.some(key=>!Object.hasOwn(properties,key)))throw invalid();
  return value;
}
function intent(descriptor) {
  record(descriptor,['kind','batchId','revision','acceptFindings','moduleId','options'],['kind']);
  if(descriptor.kind==='IMPORT_COMMIT'){
    record(descriptor,['kind','batchId','revision','acceptFindings'],['kind','batchId','revision','acceptFindings']);
    if(!uuid(descriptor.batchId)||!Number.isSafeInteger(descriptor.revision)||descriptor.revision<1||descriptor.revision>2147483647||typeof descriptor.acceptFindings!=='boolean')throw invalid('An import command requires a batch UUID, a positive reviewed revision and an explicit findings acknowledgement.');
    return {kind:'IMPORT_COMMIT',batchId:descriptor.batchId.toLowerCase(),revision:descriptor.revision,acceptFindings:descriptor.acceptFindings};
  }
  if(descriptor.kind==='WORKFLOW'){
    record(descriptor,['kind','moduleId','options'],['kind','moduleId']);
    if(!workflows.has(descriptor.moduleId))throw invalid('Only M10, M90 and M91 can run as workflow commands.');
    const options=Object.hasOwn(descriptor,'options')?record(descriptor.options,['orderNo']):{};
    if(Object.hasOwn(options,'orderNo')&&(!text(options.orderNo,250)||!options.orderNo.trim()||/[\r\n\t]/.test(options.orderNo)))throw invalid('Order number must be nonblank text of at most 250 characters without control characters.');
    // Preserve the exact confirmed order value in the descriptor and its hash.
    // Business selection is applied by the selected workflow at execution.
    return {kind:'WORKFLOW',moduleId:descriptor.moduleId,options:Object.hasOwn(options,'orderNo')?{orderNo:options.orderNo}:{}};
  }
  throw invalid('Only confirmed import commits and M10, M90 or M91 workflow commands are supported.');
}

/** Validates a required HTTP Idempotency-Key; neither header nor owner enters the intent. */
export function parseBusinessCommand(descriptor,idempotencyKey) {
  if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9._:-]{1,120}$/.test(idempotencyKey))throw invalid('Provide an idempotency key of 1–120 letters, numbers, dots, colons, dashes or underscores.','COMMAND_IDEMPOTENCY_REQUIRED');
  return intent(descriptor);
}

/** Only call with server-authenticated context, or explicit loopback preview context. */
export function commandOwner(context) {
  if(!context||![true,false].includes(context.authenticated)||!roles.has(context.role)||context.enabled===false||context.mustChangePassword===true||(context.authenticated&&(!uuid(context.userId)||context.enabled!==true)))throw httpError(403,'The initiating account is unavailable or has changed.',{code:'COMMAND_ACCOUNT_CHANGED'});
  const actor=context.actor??context.displayName;
  const organization=context.organization??'',orders=context.orders??[];
  if(!text(actor,250)||!actor.trim()||!text(organization,250)||!Array.isArray(orders)||orders.some(order=>!text(order,250)||!order.trim()))throw httpError(403,'The initiating account has invalid authorization fields.',{code:'COMMAND_ACCOUNT_CHANGED'});
  return {authenticated:context.authenticated,userId:context.authenticated?context.userId.toLowerCase():null,role:context.role,actor,organization,orders:[...new Set(orders)].sort()};
}

function ownerSnapshot(value) {
  // Stored owners intentionally have no enabled/password/session fields. They
  // are compared to a separately refreshed and validated current context.
  return commandOwner({...value,...(value?.authenticated===true?{enabled:true,mustChangePassword:false}:{})});
}
export function commandOwnerKey(context) {
  const owner=ownerSnapshot(context);
  return owner.authenticated?owner.userId:'LOCAL:'+hash(owner);
}
export function commandScopeHash(context) {
  const owner=ownerSnapshot(context);
  return hash({authenticated:owner.authenticated,userId:owner.userId,role:owner.role,organization:owner.organization,orders:owner.orders});
}
export function commandRequestHash(descriptor) {return hash(intent(descriptor));}

/** Read-only admin inspection is not authorization to execute another owner's intent. */
export function commandAllowed(job,context,{execute=false}={}) {
  try{
    if(!job)return false;
    const current=commandOwner(context),owner=ownerSnapshot(job.owner),descriptor=intent(job.descriptor);
    if(job.ownerKey!==commandOwnerKey(owner))return false;
    if(descriptor.kind==='WORKFLOW'&&current.role!=='ADMINISTRATOR')return false;
    if(!execute&&current.role==='ADMINISTRATOR')return true;
    return commandOwnerKey(current)===job.ownerKey&&commandScopeHash(current)===commandScopeHash(owner);
  }catch{return false;}
}

const countFields=['imported','updated','skipped','skippedSheets','obsoleteRecorded'];
const findingTextFields=['sheet','field','code','message'];
function importResult(job) {
  const value=job.result;
  if(!value||typeof value!=='object'||Array.isArray(value)||!uuid(value.batchId)||value.batchId.toLowerCase()!==job.descriptor.batchId.toLowerCase())return null;
  const result={batchId:job.descriptor.batchId.toLowerCase()};
  for(const key of job.moduleId==='M02'?[...countFields,'ignored']:countFields)if(integer(value[key]))result[key]=value[key];
  if(typeof value.duplicate==='boolean')result.duplicate=value.duplicate;
  if(['COMPLETED','COMPLETED_WITH_FINDINGS'].includes(value.status))result.status=value.status;
  if(text(value.message,8000))result.message=value.message;
  if(uuid(value.artifactId))result.artifactId=value.artifactId.toLowerCase();
  if(Array.isArray(value.findings))result.findings=value.findings.filter(finding=>finding&&typeof finding==='object'&&!Array.isArray(finding)).map(finding=>{
    const output={};
    for(const key of findingTextFields)if(text(finding[key],key==='message'?8000:500))output[key]=finding[key];
    if(integer(finding.row)||finding.row===null)output.row=finding.row;
    if(Array.isArray(finding.fields)&&finding.fields.every(field=>text(field,250)))output.fields=[...finding.fields];
    return output;
  });
  return result;
}

const errorCodes=new Set([
  'COMMAND_ACCOUNT_CHANGED','COMMAND_CANCELLED','COMMAND_INTERRUPTED','COMMAND_LEASE_LOST','COMMAND_FAILED','COMMAND_KEY_CONFLICT','COMMAND_LIMIT',
  'COMMAND_RECEIPT_INVALID','COMMAND_ALREADY_TERMINAL','COMMAND_RETRY_NOT_ALLOWED','COMMAND_ACTION_INVALID','COMMAND_PAGE_INVALID','COMMAND_NOT_FOUND','COMMAND_ROLE_DENIED',
  'WORKING_ORDER_UNKNOWN','WORKING_ORDER_UNAVAILABLE','WORKING_ORDER_REVIEW_REFRESH_REQUIRED',
  'IMPORT_REVIEW_REQUIRED','IMPORT_REVIEW_CHANGED','IMPORT_ALREADY_COMMITTED','IMPORT_DATA_CHANGED','IMPORT_NOT_READY','IMPORT_FINDINGS_ACK_REQUIRED','IMPORT_NO_VALID_ROWS','IMPORT_SCOPE_DENIED',
  'IMPORT_SOURCE_CHANGED','IMPORT_SOURCE_QUARANTINED','FILE_SOURCE_CHANGED','FILE_QUARANTINED','FILE_CONTENT_QUARANTINED','FILE_OBJECT_MISSING','FILE_INTEGRITY_FAILED','FILE_NOT_FOUND','REFERENCE_CHANGED','REFERENCE_INTEGRITY','REFERENCE_INTEGRITY_FAILED','SETUP_REPORT_NOT_SAVED','PASSWORD_CHANGE_REQUIRED'
]);
const genericError=()=>({status:500,code:'COMMAND_FAILED',message:'The confirmed operation could not be completed. Retry or contact the administrator.',details:[],retryable:false});
function publicError(error) {
  if(!error)return null;
  if(!Number.isInteger(error.status)||error.status<400||error.status>599)return genericError();
  const sql=typeof error.code==='string'&&error.code.startsWith('SQL_')?executionApiFailure(error):null;
  if(sql){
    const rollbackCodes=new Set(['SQL_OPERATION_TIMEOUT','SQL_STATEMENT_TIMEOUT','SQL_LOCK_TIMEOUT','SQL_EXECUTION_ABORTED']);
    return {status:sql.status,code:sql.code,message:sql.message,details:[],retryable:rollbackCodes.has(sql.code)&&error.status===sql.status&&error.retryable===true,...(uuid(error.correlationId)?{correlationId:error.correlationId.toLowerCase()}:{})};
  }
  if(['WORKING_ORDER_UNKNOWN','WORKING_ORDER_UNAVAILABLE','WORKING_ORDER_REVIEW_REFRESH_REQUIRED'].includes(error.code)){
    const failure=safeFileOperationFailure(error);if(!failure||failure.status!==error.status)return genericError();
    return {...failure,retryable:false,...(uuid(error.correlationId)?{correlationId:error.correlationId.toLowerCase()}:{})};
  }
  if(!errorCodes.has(error.code))return genericError();
  const safe={status:error.status,code:error.code,message:'The confirmed operation could not be completed. Reopen its review before retrying.',details:[],retryable:error.retryable===true};
  if(uuid(error.correlationId))safe.correlationId=error.correlationId.toLowerCase();
  // Domain 4xx messages are already the actionable review errors. Internal
  // exceptions (including SQL, paths and stacks) never become public messages.
  if(error.status<500&&text(error.message,8000)&&error.message)safe.message=error.message;
  if(error.status<500&&Array.isArray(error.details))safe.details=error.details.filter(detail=>text(detail,8000)).slice(0,100);
  return safe;
}
const phases=new Set(['Queued','Starting command','Resuming interrupted command','Checking account','Checking reviewed import','Committing reviewed import','Import committed','Running workflow','Validating configuration and data','Recording decisions','Recalculating workflow state','Waiting for execution slot','Completed','Failed','Cancelled','Queued for retry']);
function publicProgress(job) {
  const fallback={QUEUED:'Queued',RUNNING:'Running workflow',SUCCEEDED:'Completed',FAILED:'Failed',CANCELLED:'Cancelled'};
  const value=job.progress||{},result={phase:phases.has(value.phase)?value.phase:fallback[job.status]||'Queued'};
  if(integer(value.completed)&&integer(value.total)&&value.completed<=value.total){result.completed=value.completed;result.total=value.total;}
  return result;
}

/** Call only with freshly authorized context. Lists may avoid fetching result entirely. */
export function commandSummary(job,context,{includeResult=true}={}) {
  if(!commandAllowed(job,context))throw httpError(404,'Business command not found.',{code:'COMMAND_NOT_FOUND'});
  const moduleId=job.descriptor.kind==='WORKFLOW'?job.descriptor.moduleId:imports.has(job.moduleId)?job.moduleId:null;
  const canManage=commandAllowed(job,context,{execute:true});
  const visibleError=job.status==='FAILED'?publicError(job.error):null;
  return {
    commandId:job.commandId,kind:job.descriptor.kind,...(moduleId?{moduleId}:{}),status:statuses.has(job.status)?job.status:'FAILED',attempts:integer(job.attempts)?job.attempts:0,progress:publicProgress(job),createdAt:job.createdAt,updatedAt:job.updatedAt,
    canManage,canCancel:canManage&&['QUEUED','RUNNING'].includes(job.status),canRetry:canManage&&job.status==='FAILED'&&visibleError?.retryable===true&&job.attempts<3,
    ...(includeResult?{result:job.status==='SUCCEEDED'?(context.role==='ADMINISTRATOR'?structuredClone(job.result??null):importResult(job)):null}:{}),
    error:visibleError
  };
}
