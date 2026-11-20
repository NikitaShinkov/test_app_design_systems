import {httpError} from './auth.js';
import {registerFilters} from './register-column-filters.js';
import {safeFilename} from './artifacts.js';

export const REGISTER_REPORT='REGISTER_REPORT';
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=message=>{throw httpError(422,message,{code:'REGISTER_REPORT_INVALID'});};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=1000&&!/[\u0000-\u001f\u007f]/.test(value);
export const reportIdentityKey=selection=>`${selection.kind}:${selection.id}`;
export function parseRegisterReport(input){
  if(!plain(input)||Object.keys(input).some(key=>!['registerKind','filters','selection','format'].includes(key)))fail('Choose a register, its filters, selection and file format.');
  const {registerKind}=input;if(!['proposals','database'].includes(registerKind))fail('Choose the proposals or historical register.');
  if(!plain(input.filters??{}))fail('Register report filters must be an object.');
  if(Object.keys(input.filters??{}).some(key=>!['search','orderNo','product','supplier','decision','columnFilters','sort','direction','limit'].includes(key)))fail('The register report contains an unsupported filter.');
  const {limit,...filters}=registerFilters(registerKind,input.filters??{});
  const format=input.format??'xlsx';if(!['xlsx','csv'].includes(format))fail('Choose XLSX or CSV for this register report.');
  const raw=input.selection??{mode:'FILTERED'};if(!plain(raw)||!['FILTERED','SELECTED'].includes(raw.mode))fail('Choose all filtered rows or the explicitly selected rows.');
  const allowedKinds=registerKind==='proposals'?['p']:['r','l'];
  const identity=item=>{if(!plain(item)||!allowedKinds.includes(item.kind)||!id(item.id))fail('A selected register row has an invalid typed identity.');return {kind:item.kind,id:item.id};};
  const unique=items=>{const keys=new Set();for(const item of items){const key=reportIdentityKey(item);if(keys.has(key))fail('The register report selection contains a duplicate row.');keys.add(key);}return items.sort((a,b)=>reportIdentityKey(a)<reportIdentityKey(b)?-1:reportIdentityKey(a)>reportIdentityKey(b)?1:0);};
  let selection;
  if(raw.mode==='FILTERED'){
    if(Object.keys(raw).some(key=>!['mode','excluded'].includes(key))||raw.excluded!==undefined&&!Array.isArray(raw.excluded))fail('Filtered selection accepts only an optional excluded-row list.');
    const excluded=unique((raw.excluded??[]).map(item=>{if(Object.keys(item??{}).some(key=>!['kind','id'].includes(key)))fail('Excluded rows must contain only a typed identity.');return identity(item);}));selection={mode:'FILTERED',excluded};
  }else{
    if(Object.keys(raw).some(key=>!['mode','items'].includes(key))||!Array.isArray(raw.items)||!raw.items.length)fail('Select at least one register row before preparing its report.');
    selection={mode:'SELECTED',items:unique(raw.items.map(item=>{const key=identity(item);if(Object.keys(item).some(field=>!['kind','id','version','fingerprint'].includes(field))||!Number.isSafeInteger(item.version)||item.version<0||!/^[a-f0-9]{64}$/.test(item.fingerprint??''))fail('Selected rows require their current version and fingerprint. Refresh the register before selecting again.');return {...key,version:item.version,fingerprint:item.fingerprint};}))};
  }
  return {registerKind,filters,selection,format};
}
export function registerReportSequenceKey(request,context,capture){
  // A changed filter or selection must not issue the same visible filename as
  // another version1. Personal counters follow the actual proposed name family.
  const family=registerReportFilename(request,capture,1).replace(/_v1(?=\.[^.]+$)/i,'').toLowerCase();
  return JSON.stringify({report:REGISTER_REPORT,registerKind:request.registerKind,family,format:request.format,owner:context.authenticated?{userId:context.userId}:{role:context.role,actor:context.actor||''}});
}
const short=value=>String(value||'').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/\s+/g,' ').trim().slice(0,24).replace(/[. ]+$/g,'');
export function registerReportFilename(request,capture,version){
  const one=(values,fallback)=>values.length===1?short(values[0])||fallback:fallback;
  const scope=capture.scope;
  const name=['RR',request.registerKind==='proposals'?'Proposals':'History',one(scope.orderNos,'Orders'),one(scope.suppliers,'Suppliers'),one(scope.productDecimalNos,'Products'),String(capture.asOf).slice(0,10).replaceAll('-','')].join('_');
  return safeFilename(`${name}_v${version}.${request.format}`);
}
export function registerReportSummary(request,capture,source){
  return {registerKind:request.registerKind,filters:request.filters,selectionMode:request.selection.mode,selectedCount:request.selection.mode==='SELECTED'?request.selection.items.length:null,excludedCount:request.selection.mode==='FILTERED'?request.selection.excluded.length:0,rows:capture.rowCount,format:request.format,dataAsOf:capture.asOf,sourceHash:source.sha256,rowHash:capture.rowHash,completeFilteredReport:request.selection.mode==='FILTERED'};
}
