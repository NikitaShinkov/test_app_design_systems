import {withCatalog} from './reference-catalog.js';
import {workflowKey,recordKey,originalKey,normalize} from './normalization.js';
import {httpError} from './auth.js';

// An explicit catalog merge must not silently make two working rows, recorded
// decisions or lifecycle index entries represent the same identity.
export function referenceIdentityImpact(beforeCatalog,afterCatalog,proposals,replacements) {
  const isLifecycle=row=>row.recordType==='LIFECYCLE'||normalize(row.decisionStatus)==='OBSOLETE';
  const lifecycle=replacements.filter(isLifecycle);
  const ordinary=replacements.filter(row=>!isLifecycle(row));
  const groups=[
    {kind:'proposal',rows:proposals.filter(row=>!row.archived),key:workflowKey,id:row=>row.proposalId},
    {kind:'historical decision',rows:ordinary,key:recordKey,id:row=>row.recordId},
    {kind:'lifecycle record',rows:lifecycle,key:row=>originalKey(row)?JSON.stringify([originalKey(row),normalize(row.supplier)]):'',id:row=>row.recordId}
  ];
  const conflicts=[],changed={};let lifecycleUpdates=[];
  for(const group of groups){
    const previous=withCatalog(beforeCatalog,()=>new Map(group.rows.map(row=>[group.id(row),group.key(row)])));
    const current=withCatalog(afterCatalog,()=>group.rows.map(row=>({id:group.id(row),key:group.key(row),old:previous.get(group.id(row)),row})));
    changed[group.kind]=current.filter(item=>item.key!==item.old).length;
    const byKey=new Map();for(const item of current)if(item.key){const members=byKey.get(item.key)||[];members.push(item);byKey.set(item.key,members);}
    for(const members of byKey.values())if(members.length>1&&(new Set(members.map(item=>item.old)).size>1||(group.kind==='lifecycle record'&&members.some(item=>item.key!==item.old))))conflicts.push(`${group.kind}: ${members.map(item=>item.id).join(', ')}`);
    if(group.kind==='lifecycle record')lifecycleUpdates=withCatalog(afterCatalog,()=>current.filter(item=>item.key!==item.old).map(item=>({recordId:item.id,originalKey:originalKey(item.row),supplierKey:normalize(item.row.supplier)})));
  }
  if(conflicts.length)throw httpError(422,'This reference identity change would merge existing business identities. Review the conflicting records before changing the catalog.',{code:'REFERENCE_IDENTITY_CONFLICT',details:conflicts});
  return {summary:{activeProposalKeysChanged:changed.proposal,historicalDecisionKeysChanged:changed['historical decision'],lifecycleKeysChanged:changed['lifecycle record']},lifecycleUpdates};
}
