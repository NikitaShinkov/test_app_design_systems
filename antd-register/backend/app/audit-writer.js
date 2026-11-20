import {AuditProvenanceError,auditBasisForWriter,identityFromTrustedContext,maintenanceIdentity,unknownIdentity,serializeAuditEnvelope} from './audit-provenance.js';

const previewRoles=new Set(['ADMINISTRATOR','SUPPLIER','CLIENT']);

export function auditEventProvenance(context,auditRuntime=null){
  if(auditRuntime==null)return null;
  const basis=auditBasisForWriter(context);
  if(!basis){
    if(context?.requestId||context?.authenticated===true)throw Object.assign(new Error('Audit request provenance is unavailable. Retry the request before saving.'),{code:'AUDIT_PROVENANCE_CONTEXT_MISSING',status:500});
    const actor=context?.role==='SYSTEM'?maintenanceIdentity(context.actor||'System maintenance'):unknownIdentity();
    const envelope=auditRuntime.maintenance({actor});
    if(envelope==null)throw new AuditProvenanceError();
    serializeAuditEnvelope(envelope);return envelope;
  }
  const actor=context?.role==='SYSTEM'?maintenanceIdentity(context.actor||'System maintenance')
    :context?.authenticated===true||previewRoles.has(context?.role)?identityFromTrustedContext(context):unknownIdentity();
  const envelope=auditRuntime.forWriter(context,{actor});
  // Validate even when a caller supplies a runtime adapter.
  if(envelope==null)throw new AuditProvenanceError();
  serializeAuditEnvelope(envelope);return envelope;
}

export function serializeEventProvenance(context,auditRuntime=null){
  return serializeAuditEnvelope(auditEventProvenance(context,auditRuntime));
}
