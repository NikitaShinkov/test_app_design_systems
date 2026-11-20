import {moduleFor} from './workflow.js';

const policy=(kind,roles=null,extra={})=>Object.freeze({kind,...(roles?{roles:Object.freeze([...roles])}:{}),...extra});
const administrator=['ADMINISTRATOR'];
const fixed=new Map([
  ['GET /api/admin/operations/status',policy('ADMIN_OPERATIONS_STATUS',administrator)],
  ['GET /api/review-state',policy('REVIEW_SNAPSHOT',administrator,{previewOnly:true})],
  ['GET /api/workflows/M07/products',policy('PERMIT_PRODUCT_SNAPSHOT',administrator)],
  ['GET /api/final-approval',policy('FINAL_APPROVAL_SNAPSHOT')],
  ['POST /api/admin/references',policy('REFERENCE_CHANGE',administrator)],
  ['POST /api/admin/references/preview',policy('REFERENCE_PREVIEW',administrator)],
  ['POST /api/workflows/M11/reviews',policy('WORKSPACE_REVIEW',administrator)],
  ['POST /api/workflows/M11/run',policy('WORKSPACE_CONFIRM',administrator)],
  ['POST /api/audit/exports',policy('AUDIT_REPORT',administrator)]
]);
const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const exportIssue=new RegExp('^/api/exports/'+uuid+'/issue$');
const exportFile=new RegExp('^/api/exports/'+uuid+'/file$');
const storedFile=new RegExp('^/api/files/'+uuid+'(?:/preview)?$');
const importRows=new RegExp('^/api/imports/'+uuid+'(?:/report)?$');
const archiveRows=new RegExp('^/api/workflows/M11/reviews/'+uuid+'$');

/** Classification only. Call after authentication, CSRF and password checks.
 * A static role precheck may precede admission; object/session/source/version
 * authorization stays in the original endpoint. Queue acceptance and small
 * status/catalog/page paths intentionally remain outside this resource. */
export function apiExecutionPolicy(method,pathname){
  const exact=fixed.get(method+' '+pathname);if(exact)return exact;
  if(method==='GET'){
    const suggestion=typeof pathname==='string'&&pathname.match(/^\/api\/workflows\/(M03|M05|M06|M07|M09)\/suggestion$/);
    if(suggestion)return policy('WORKFLOW_SUGGESTION',moduleFor(suggestion[1]).roles,{moduleId:suggestion[1]});
    if(exportFile.test(pathname))return policy('EXPORT_FILE');
    if(storedFile.test(pathname))return policy('STORED_FILE');
    // An import review contains its full retained row/findings payload. Queue
    // status is served by preparations/commands, not by these content routes.
    if(importRows.test(pathname))return policy('IMPORT_REVIEW_CONTENT');
    if(archiveRows.test(pathname))return policy('WORKSPACE_REVIEW_CONTENT',administrator);
  }
  if(method==='POST'&&exportIssue.test(pathname))return policy('EXPORT_ISSUE');
  return null;
}

const executionCodes=new Set(['EXECUTION_COORDINATION_UNAVAILABLE','EXECUTION_CONFIG_MISMATCH','EXECUTION_PERMIT_CHANGED','EXECUTION_IDENTITY_CHANGED']);
const sqlFailures=Object.freeze({
  SQL_OPERATION_TIMEOUT:[504,'The operation reached its time limit. Refresh its saved status before trying again.'],
  SQL_STATEMENT_TIMEOUT:[504,'The operation reached its time limit. Refresh its saved status before trying again.'],
  SQL_LOCK_TIMEOUT:[504,'The operation could not finish while another change was in progress. Refresh its saved status before trying again.'],
  SQL_EXECUTION_ABORTED:[409,'Processing was interrupted. Check the saved operation status before trying again.'],
  SQL_EXECUTION_UNCERTAIN:[503,'The operation result could not be confirmed. Refresh its status before starting another attempt.'],
  SQL_EXECUTION_RECHECK_REQUIRED:[409,'Some work may already be saved. Refresh the operation status before starting another attempt.'],
  SQL_EXECUTION_UNSUPPORTED:[500,'This operation could not be safely started. Ask an administrator to check the service.'],
  SQL_TRANSACTION_INCOMPLETE:[500,'The operation could not be completed safely. Refresh its status before trying again.'],
  SQL_EXECUTION_CLOSED:[503,'The service is stopping or restarting. Refresh and try again when it is available.']
});
/** A backend error code never makes its arbitrary message/details public. */
export function executionApiFailure(error){
  const sql=Object.hasOwn(sqlFailures,error?.code)?sqlFailures[error.code]:null;
  if(sql)return {status:sql[0],code:error.code,message:sql[1],details:[]};
  if(!executionCodes.has(error?.code))return null;
  return {status:503,code:error.code,message:'Shared execution capacity could not be verified. Check the service and refresh before trying again.',details:[]};
}
