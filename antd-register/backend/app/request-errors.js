import {randomUUID} from 'node:crypto';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const names=new Set(['Error','TypeError','RangeError','SyntaxError','WorkflowFileError']);
const codes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOSPC','EACCES','EIO','23505','23514','23503','40001','40P01','55P03','57014','53300','08006','08003','FILE_STORAGE_RESERVE','FILE_STORAGE_UNAVAILABLE','PREPARATION_ADMISSION_UNAVAILABLE','SETUP_REPORT_NOT_SAVED','BOM_CATALOG_UNAVAILABLE']);
for(const code of ['SQL_OPERATION_TIMEOUT','SQL_STATEMENT_TIMEOUT','SQL_LOCK_TIMEOUT','SQL_EXECUTION_ABORTED','SQL_EXECUTION_UNCERTAIN','SQL_EXECUTION_RECHECK_REQUIRED','SQL_EXECUTION_UNSUPPORTED','SQL_TRANSACTION_INCOMPLETE','SQL_EXECUTION_CLOSED'])codes.add(code);
const families=new Set(['auth','session','health','proposals','database','workflows','rounds','approval-rounds','exchanges','files','original-boms','register-views','register-columns','register-reports','preparations','commands','exports','imports','audit','admin','decision-history','review-state','final-approval','orders']);
for(const code of ['WORKING_ORDER_UNKNOWN','WORKING_ORDER_UNAVAILABLE','WORKING_ORDER_REVIEW_REFRESH_REQUIRED'])codes.add(code);

/** Application-generated only: an incoming X-Request-ID never becomes trusted. */
export function beginRequestTrace(request,response){const id=randomUUID();request.requestId=id;response.setHeader('X-Request-ID',id);return id;}
export function errorStatus(error){const status=Number(error?.status);return Number.isInteger(status)&&status>=400&&status<=599?status:500;}
export function correlatedErrorBody(response,status,body){
  const id=response.getHeader('X-Request-ID');
  return status>=400&&body&&typeof body==='object'&&!Array.isArray(body)&&typeof id==='string'&&uuid.test(id)?{...body,correlationId:id}:body;
}
function safeError(error){return {errorType:names.has(error?.name)?error.name:'Error',code:codes.has(error?.code)?error.code:'INTERNAL_ERROR',status:errorStatus(error)};}
export function safeRequestErrorRecord(error,request,{aborted=false}={}){
  const method=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(request?.method)?request.method:'OTHER';
  const family=String(request?.url||'').match(/^\/api\/(?:v1\/)?([a-z-]+)(?:[/?#]|$)/)?.[1];
  return {occurredAt:new Date().toISOString(),event:'HTTP_REQUEST_FAILED',requestId:uuid.test(request?.requestId||'')?request.requestId:null,method,route:families.has(family)?`api.${family}`:'other',...safeError(error),aborted:Boolean(aborted)};
}
export function safeBackgroundErrorRecord(error,{stage,jobId}={}){
  const command=['COMMAND_QUEUE','COMMAND_HEARTBEAT','COMMAND_EXECUTE'].includes(stage);
  return {occurredAt:new Date().toISOString(),event:command?'COMMAND_FAILED':'PREPARATION_FAILED',stage:command?stage:['PREPARATION_QUEUE','PREPARATION_CLAIM','PREPARATION_HEARTBEAT','PREPARATION_EXECUTE'].includes(stage)?stage:'PREPARATION',jobId:typeof jobId==='string'&&uuid.test(jobId)?jobId:null,...safeError(error)};
}
