// A scoped workflow row does not prove access to its private import workbook or
// a combined export package. Keep immutable evidence intact; project at read.
export function publicRoundSource(source,kind){
  if(kind==='EXPORTED')return {files:[]};
  if(!source||typeof source!=='object'||Array.isArray(source))return {};
  const fields=['moduleId','sha256','sheet','row','round','normalizationVersion','referenceRevision','referenceHash'];
  return Object.fromEntries(fields.filter(field=>Object.hasOwn(source,field)&&['string','number'].includes(typeof source[field])).map(field=>[field,source[field]]));
}

export function roundExchangeProjection(event,context){
  if(context.role==='ADMINISTRATOR')return structuredClone(event);
  const fields=['exchangeId','roundId','moduleId','kind','occurredAt','actor','role','recordId','proposalId','snapshotCount','normalizationVersion','ordinal'];
  const projected=Object.fromEntries(fields.filter(field=>Object.hasOwn(event,field)&&(event[field]===null||['string','number','boolean'].includes(typeof event[field]))).map(field=>[field,event[field]]));
  return {...projected,source:publicRoundSource(event.source,event.kind)};
}
