import {createHash} from 'node:crypto';
import {httpError} from './auth.js';
import {validBusinessDate} from './validation.js';

const text=value=>String(value??'');
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const own=(value,key)=>Object.hasOwn(value,key);
const error=(message,code='INVALID_REGISTER_COLUMN_FILTER')=>httpError(422,message,{code});
const kinds=new Set(['proposals','database']);
const sorts={id:null,order:'orderNo',product:'productDecimalNo',supplier:'supplier',original:'origPn',alternative:'altPn',decision:null,date:'decisionDate',workflow:'workflowStatus'};
const spec=(field,label,header,type='text')=>Object.freeze({field,label,header,type});
const common=[
  spec('orderNo','Заказ','Order_No'),spec('supplier','Поставщик','Supplier'),spec('product','Изделие','Product'),
  spec('productCode','Код изделия 1С','Product_1C_Code'),spec('productDecimalNo','Децимальный номер','Product_Decimal_No'),
  spec('productionOrder','Производственный заказ','Production_Order'),spec('position','Позиционное обозначение','Position'),
  spec('origCode','Исходный код 1С','Orig_Code'),spec('origMfr','Исходный производитель','Designation'),spec('origPn','Исходный артикул','Nomenclature'),
  spec('componentStatus','Статус компонента','Component_Status'),spec('altMfr','Производитель замены','Alt_Mfr'),spec('altPn','Артикул замены','Alt_PN')
];
const source=[spec('sourceSheet','Исходный лист','Source_Sheet'),spec('sourceRow','Исходная строка','Source_Row','integer'),spec('rowVersion','Версия строки','Row_Version','integer')];
const reportFields={
  proposals:Object.freeze([
    spec('proposalId','Предложение','Proposal_ID'),spec('round','Раунд','Round'),...common,
    spec('supplierReply','Ответ поставщика','Supplier_Reply'),spec('supplierComment','Комментарий поставщика','Supplier_Comment'),
    spec('manufacturerRelationship','Связь производителей','Manufacturer_Relationship'),spec('responsible','Ответственный','Responsible'),
    spec('clientDecision','Решение клиента','Client_Decision'),spec('clientReplyRaw','Исходный ответ клиента','Client_Reply_Raw'),spec('clientComment','Комментарий клиента','Client_Comment'),
    spec('decisionReference','Документ решения','Decision_Reference'),spec('decisionDate','Дата решения','Decision_Date','date'),
    spec('historicalStatus','Статус истории','Historical_Status'),spec('historicalReference','Документ истории','Historical_Reference'),spec('historicalDate','Дата истории','Historical_Date','date'),
    spec('notes','Примечания','Notes'),spec('workflowStatus','Этап согласования','Workflow_Status'),spec('canRecord','Готово к записи','Can_Record','boolean'),spec('archived','Архивная строка','Archived','boolean'),...source
  ]),
  database:Object.freeze([
    spec('recordId','Запись базы','Record_ID'),spec('recordType','Тип записи','Record_Type'),spec('proposalId','Предложение','Proposal_ID'),...common,
    spec('decisionStatus','Решение','Decision_Status'),spec('responsible','Ответственный','Responsible'),spec('decisionReference','Документ решения','Decision_Reference'),
    spec('decisionDate','Дата решения','Decision_Date','date'),spec('decisionComment','Комментарий решения','Decision_Comment'),spec('notes','Примечания','Notes'),...source
  ])
};
const operators=Object.freeze({text:Object.freeze(['contains','equals','isEmpty','isNotEmpty']),date:Object.freeze(['eq','from','to','isEmpty','isNotEmpty']),boolean:Object.freeze(['eq'])});
const fieldMaps=Object.fromEntries(Object.entries(reportFields).map(([kind,fields])=>[kind,new Map(fields.filter(field=>field.type!=='integer').map(field=>[field.field,field]))]));
function assertKind(kind){if(!kinds.has(kind))throw httpError(404,'Register collection not found.');}
export function registerReportFields(kind){assertKind(kind);return reportFields[kind].map(field=>({...field}));}
export function registerColumnFields(kind){assertKind(kind);return [...fieldMaps[kind].values()].map(({field,label,type})=>({field,label,type,operators:[...operators[type]]}));}

export function parseRegisterColumnFilters(kind,input){
  assertKind(kind);
  if(input===undefined)return [];
  let rows=input;
  if(typeof rows==='string'){
    if(rows.length>1024*1024)throw error('The column filter request is too large.');
    try{rows=JSON.parse(rows);}catch{throw error('Column filters must be a JSON array.');}
  }
  const maximum=[...fieldMaps[kind].values()].reduce((count,field)=>count+operators[field.type].length,0);
  if(!Array.isArray(rows)||rows.length>maximum)throw error('Column filters must be an array of distinct supported field operations.');
  const seen=new Set(),result=[];
  for(const row of rows){
    if(!plain(row)||Object.keys(row).some(key=>!['field','op','value'].includes(key))||typeof row.field!=='string'||typeof row.op!=='string')throw error('Each column filter must contain a supported field and operation.');
    const field=fieldMaps[kind].get(row.field),key=row.field+':'+row.op;
    if(!field||!operators[field.type].includes(row.op))throw error('The column field or operation is unsupported.');
    if(seen.has(key))throw error('A column field operation cannot be repeated.');
    seen.add(key);
    if(['isEmpty','isNotEmpty'].includes(row.op)){
      if(own(row,'value'))throw error('Empty-value operations do not accept a value.');
      result.push({field:row.field,op:row.op});continue;
    }
    if(!own(row,'value'))throw error('This column operation requires a value.');
    if(field.type==='boolean'){
      if(typeof row.value!=='boolean')throw error('Boolean column filters require true or false.');
    }else if(typeof row.value!=='string'||row.value.length>2000||row.value.includes('\0')||!row.value.isWellFormed())throw error('Column filter values must be valid text of at most2000 characters.');
    if(field.type==='date'&&!validBusinessDate(row.value))throw error('Date column filters require a valid YYYY-MM-DD date.');
    result.push({field:row.field,op:row.op,value:row.value});
  }
  // AND operations have no user-visible order; canonical ordering binds cursors,
  // saved views and immutable report requests to the same effective predicate.
  result.sort((a,b)=>a.field<b.field?-1:a.field>b.field?1:a.op<b.op?-1:a.op>b.op?1:0);
  return result;
}

/** The previous basic-filter behavior is kept intact, including trimmed scope
 * filters and the original empty-filter response/cursor representation. */
export function registerFilters(kind,input={}){
  assertKind(kind);if(!plain(input))throw error('Register filters must be an object.','INVALID_REGISTER_FILTER');
  const result={};
  for(const [key,maximum]of [['search',200],['orderNo',200],['product',200],['supplier',200],['decision',30]]){
    if(input[key]!=null&&(typeof input[key]!=='string'||input[key].length>maximum||/[\u0000-\u001f\u007f]/.test(input[key])))throw error(`Invalid ${key} filter.`,'INVALID_REGISTER_FILTER');
    result[key]=text(input[key]).trim();
  }
  const decisions=kind==='proposals'?['','APPROVED','REJECTED','DO NOT PURCHASE','PENDING']:['','APPROVED','REJECTED','OBSOLETE'];
  if(!decisions.includes(result.decision))throw error('Select a supported decision filter.','INVALID_REGISTER_FILTER');
  const sort=input.sort||'id';if(!own(sorts,sort)||(kind==='proposals'&&sort==='date')||(kind==='database'&&sort==='workflow'))throw error('Select a supported sort column.','INVALID_REGISTER_SORT');
  const direction=input.direction||'asc';if(!['asc','desc'].includes(direction))throw error('Sort direction must be asc or desc.','INVALID_REGISTER_SORT');
  const limit=Number(input.limit??50);if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw error('Page size must be between 1 and 200.','INVALID_REGISTER_LIMIT');
  const columnFilters=parseRegisterColumnFilters(kind,input.columnFilters);
  return {...result,sort,direction,limit,...(columnFilters.length?{columnFilters}:{})};
}

export function parseRegisterView(kind,input={}){
  assertKind(kind);
  if(!plain(input)||Object.keys(input).some(key=>!['filters','sort','direction','pageSize'].includes(key)))throw error('Saved view settings contain an unsupported field.','INVALID_REGISTER_VIEW');
  const filters=input.filters===undefined?{}:input.filters;
  if(!plain(filters)||Object.keys(filters).some(key=>!['search','orderNo','product','supplier','decision','columnFilters'].includes(key)))throw error('Saved view filters contain an unsupported field.','INVALID_REGISTER_VIEW');
  for(const key of ['search','orderNo','product','supplier','decision'])if(own(filters,key)&&typeof filters[key]!=='string')throw error('Saved view basic filters must be text.','INVALID_REGISTER_VIEW');
  if(own(input,'sort')&&(typeof input.sort!=='string'||!input.sort)||own(input,'direction')&&(typeof input.direction!=='string'||!input.direction)||own(input,'pageSize')&&(!Number.isSafeInteger(input.pageSize)||input.pageSize<1||input.pageSize>200))throw error('Saved view sorting and page size are invalid.','INVALID_REGISTER_VIEW');
  const canonical=registerFilters(kind,{...filters,sort:input.sort,direction:input.direction,limit:input.pageSize});
  return {filters:Object.fromEntries([...['search','orderNo','product','supplier','decision'].map(key=>[key,canonical[key]]),['columnFilters',canonical.columnFilters||[]]]),sort:canonical.sort,direction:canonical.direction,pageSize:canonical.limit};
}

export function registerColumnMatches(kind,row,filters=[]){
  const fields=fieldMaps[kind];
  return filters.every(filter=>{
    const value=filter.field==='recordType'?(rowKind(kind,row)==='l'?'LIFECYCLE':'REPLACEMENT'):filter.field==='archived'?Boolean(row.archived):row[filter.field],empty=value===undefined||value===null||value==='';
    if(filter.op==='isEmpty')return empty;
    if(filter.op==='isNotEmpty')return !empty;
    const field=fields.get(filter.field);
    if(field.type==='boolean')return typeof value==='boolean'&&value===filter.value;
    if(field.type==='date')return typeof value==='string'&&validBusinessDate(value)&&(filter.op==='eq'?value===filter.value:filter.op==='from'?value>=filter.value:value<=filter.value);
    const actual=text(value).toLowerCase(),expected=filter.value.toLowerCase();
    return filter.op==='equals'?actual===expected:actual.includes(expected);
  });
}

/** All identifiers originate in the finite field catalog. Values are always
 * bound parameters; ICU matches the register's existing Unicode text policy. */
export function registerColumnSql(kind,filters,fieldFor,values){
  const parsed=parseRegisterColumnFilters(kind,filters),add=value=>{values.push(value);return '$'+values.length;};
  return parsed.map(filter=>{
    const field=fieldMaps[kind].get(filter.field),column=fieldFor(filter.field);
    if(filter.op==='isEmpty')return `coalesce(${column},'')=''`;
    if(filter.op==='isNotEmpty')return `coalesce(${column},'')<>''`;
    if(field.type==='boolean')return `${column}=${add(filter.value)}::boolean`;
    if(field.type==='date'){
      const value=add(filter.value),operator={eq:'=',from:'>=',to:'<='}[filter.op];
      return `(${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and left(${column},4)<>'0000' and pg_input_is_valid(${column},'date') and ${column}${operator}${value}::text)`;
    }
    const actual=`lower(coalesce(${column},'') collate replacement_register.search_unicode)`,expected=`lower(${add(filter.value)}::text collate replacement_register.search_unicode)`;
    return filter.op==='equals'?`${actual}=${expected}`:`strpos(${actual},${expected})>0`;
  });
}

const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const rowKind=(kind,row)=>kind==='proposals'?'p':row.recordType==='LIFECYCLE'||row.decisionStatus==='OBSOLETE'?'l':'r';
export function registerReportProjection(kind,row){
  assertKind(kind);const type=rowKind(kind,row);
  return Object.fromEntries(reportFields[kind].map(({field})=>{
    const value=field==='recordType'?(type==='l'?'LIFECYCLE':'REPLACEMENT'):field==='rowVersion'?(row.rowVersion||0):row[field]===undefined?null:row[field];
    if(value!==null&&!['string','number','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw httpError(409,'A register row contains an unsupported report value.',{code:'REGISTER_REPORT_ROW_INVALID',details:[`Field: ${field}. Expected original scalar data.`]});
    return [field,value];
  }));
}
export function registerRowSelection(kind,row){
  assertKind(kind);const type=rowKind(kind,row),id=row[kind==='proposals'?'proposalId':'recordId'],version=row.rowVersion||0;
  if(typeof id!=='string'||!id||id.length>1000||!Number.isSafeInteger(version)||version<0)throw httpError(409,'This register row has no valid selection identity. Refresh the register.',{code:'REGISTER_SELECTION_INVALID'});
  const value={kind:type,id,version,projection:registerReportProjection(kind,row)};
  return {kind:type,id,version,fingerprint:createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')};
}
