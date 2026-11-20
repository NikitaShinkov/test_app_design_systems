import {httpError} from './auth.js';
import {snapshotDigest} from './export-jobs.js';

export async function captureApprovalAttachments(artifacts,context,rows){
  const ids=new Set(rows.map(row=>row.proposalId).filter(Boolean)),latest=new Map();
  for(const item of await artifacts.list(context,{kind:'ATTACHMENT'}))if(!latest.has(item.logicalKey)||latest.get(item.logicalKey).version<item.version)latest.set(item.logicalKey,item);
  const selected=[...latest.values()].filter(item=>item.attachmentMetadata?.confidentiality==='ORDER_PARTICIPANTS'&&['Supplier_Datasheet','Client_Datasheet'].includes(item.attachmentMetadata?.attachmentRole)&&item.scope.proposalIds.some(id=>ids.has(id))).sort((a,b)=>a.artifactId.localeCompare(b.artifactId));
  if(selected.length>100)throw httpError(422,'This approval package exceeds its 100-attachment limit. Split the selected approval scope.',{code:'APPROVAL_PACKAGE_ATTACHMENT_LIMIT'});
  let bytes=0;for(const item of selected){bytes+=item.bytes;if(bytes>24*1024*1024)throw httpError(422,'Datasheets exceed the 24 MB package source limit. Split the selected approval scope.',{code:'APPROVAL_PACKAGE_SOURCE_LIMIT'});if(item.scanStatus!=='CLEAN')throw httpError(423,`Datasheet '${item.filename}' is not verified (${item.scanStatus}). Verify its latest version before preparing approval files.`,{code:'APPROVAL_DATASHEET_QUARANTINED'});}
  const attachments=[];for(const item of selected)attachments.push({...item,buffer:await artifacts.read(item)});
  return {attachments,inputs:selected.map(item=>({artifactId:item.artifactId,sha256:item.sha256,bytes:item.bytes,attachmentMetadataHash:snapshotDigest(item.attachmentMetadata)}))};
}
