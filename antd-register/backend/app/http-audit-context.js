import {bindAuditContext,copyAuditContext,unknownIdentity} from './audit-provenance.js';

/** Bind server-captured transport facts without adding enumerable metadata.
 * Account selection remains the auth service's job. */
export function bindHttpRequestAudit(request,auditRuntime,serverRequestId){
  return bindAuditContext(request,auditRuntime.direct({actor:unknownIdentity(),request:auditRuntime.capture(request,{serverRequestId})}));
}

export function httpAuditContext(request,context){
  return context?copyAuditContext(request,context):context;
}
