import {httpError} from './auth.js';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(left,right)=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
const withoutParent=value=>{const {supersedesArtifactId,...metadata}=value||{};return metadata;};
export function attachmentVersionPlan(item,versions,requestedParent,context,canAccess){
  const prior=versions.at(-1);
  if(requestedParent){
    const parent=versions.find(row=>row.artifactId===requestedParent);
    if(!parent||parent.kind!=='ATTACHMENT'||!canAccess(context,parent)||!same(parent.scope,item.scope))throw httpError(404,'The attachment version to replace is unavailable.',{code:'ATTACHMENT_PARENT_UNAVAILABLE'});
    if(parent.attachmentMetadata&&(parent.attachmentMetadata.attachmentRole!==item.attachmentMetadata.attachmentRole||parent.attachmentMetadata.confidentiality!==item.attachmentMetadata.confidentiality))throw httpError(409,'A replacement version must keep the attachment role and confidentiality. Upload a separate document for different settings.',{code:'ATTACHMENT_PARENT_SCOPE_CHANGED'});
  }
  const duplicate=prior?.sha256===item.sha256&&prior.filename===item.filename&&prior.contentType===item.contentType&&same(withoutParent(prior.attachmentMetadata),withoutParent(item.attachmentMetadata))&&(!requestedParent||requestedParent===prior.artifactId||requestedParent===prior.attachmentMetadata?.supersedesArtifactId);
  if(requestedParent&&requestedParent!==prior?.artifactId&&!duplicate)throw httpError(409,'A newer attachment version already exists. Review the latest version before replacing it.',{code:'ATTACHMENT_VERSION_CHANGED'});
  return {duplicate,parentId:prior?.artifactId||null};
}

export function attachmentLogicalKey(kind,moduleId,scope,filename,owner,metadata){
  const base=`${kind}:${moduleId||''}:${JSON.stringify(scope)}:${filename.toLowerCase().replace(/_v\d+(?=\.[^.]+$)/,'')}:${owner}`;
  return `${base}:${metadata.attachmentRole}:${metadata.confidentiality}`;
}
