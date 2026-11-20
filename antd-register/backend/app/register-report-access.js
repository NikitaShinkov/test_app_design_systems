import {createHash} from 'node:crypto';

export const reportModule='REGISTER_REPORT';
const namespacePrefix=reportModule+':';
export const isRegisterReportNamespace=value=>typeof value==='string'&&value.startsWith(namespacePrefix);
const token=context=>context.authenticated?context.userId:createHash('sha256').update(JSON.stringify({role:context.role,actor:context.actor||'Local administrator'})).digest('hex');
export const registerReportNamespace=(context,mode)=>`${namespacePrefix}${mode}:${token(context)}`;
export function registerReportArtifactScope(capture,context){
  const scope=structuredClone(capture.scope);scope.reportOwnerRole=context.role;
  if(!scope.orderNos.length)scope.orderNos=[registerReportNamespace(context,capture.rowCount===0?'EMPTY':'UNASSIGNED')];
  return scope;
}
export function registerReportPublicScope(scope){return {...scope,orderNos:scope.orderNos.filter(value=>!isRegisterReportNamespace(value))};}
/** Report access is personal and role-bound before ordinary order checks. */
export function registerReportArtifactOwner(context,artifact){
  if(artifact.moduleId!==reportModule)return null;
  if(!['WORKFLOW_INPUT','WORKFLOW_OUTPUT'].includes(artifact.kind)||!artifact.ownerOnly||artifact.scope?.reportOwnerRole!==context.role)return false;
  if(context.authenticated){if(!context.userId||artifact.ownerUserId!==context.userId)return false;}
  else if(artifact.ownerUserId||artifact.ownerActor!==(context.actor||'Local administrator'))return false;
  const privateOrders=artifact.scope.orderNos.filter(isRegisterReportNamespace);
  if(privateOrders.length){
    const empty=artifact.scanStatus==='GENERATED'&&privateOrders.length===1&&artifact.scope.orderNos.length===1&&privateOrders[0]===registerReportNamespace(context,'EMPTY')&&['suppliers','productDecimalNos','proposalIds'].every(key=>Array.isArray(artifact.scope[key])&&artifact.scope[key].length===0);
    return empty?'EMPTY':false;
  }
  return true;
}
