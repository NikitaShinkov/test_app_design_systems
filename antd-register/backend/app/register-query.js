import {createHash} from 'node:crypto';
import {canAccess,httpError} from './auth.js';
import {normalize} from './normalization.js';
import {rowToProposal,rowToReplacement,rowToLifecycle} from './storage.js';
import {summarize,summarizeOrders} from './dashboard.js';
import {timingModules,timingRunAllowed,observedOrderTiming,elapsedOverview,activityStage} from './order-timing.js';
import {classifyProposal} from './domain.js';
import {publishNamedRead} from './named-read.js';
import {exchangeCatalogItem} from './exchange-scope.js';
import {registerFilters,registerColumnMatches,registerColumnSql,registerRowSelection} from './register-column-filters.js';
export {registerFilters} from './register-column-filters.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const proposalFields=['proposalId','orderNo','supplier','product','productCode','productDecimalNo','productionOrder','position','origCode','origMfr','origPn','altMfr','altPn','supplierReply','supplierComment','componentStatus','clientDecision','clientComment','responsible','decisionReference','notes','workflowStatus'];
const recordFields=['recordId','proposalId','orderNo','supplier','product','productCode','productDecimalNo','productionOrder','position','origCode','origMfr','origPn','altMfr','altPn','componentStatus','decisionStatus','responsible','decisionReference','decisionComment','notes'];
const sorts={id:null,order:'orderNo',product:'productDecimalNo',supplier:'supplier',original:'origPn',alternative:'altPn',decision:null,date:'decisionDate',workflow:'workflowStatus'};
const snake=field=>field.replace(/[A-Z]/g,letter=>'_'+letter.toLowerCase()).replace(/_pn$/,'_pn');
const text=value=>String(value??'');
const compare=(a,b)=>Buffer.compare(Buffer.from(text(a)),Buffer.from(text(b)));
const allowed=(context,row)=>!context.authenticated||canAccess(context,row);
function timingSqlScope(context,values){
  const add=value=>{values.push(value);return `$${values.length}`;};
  const modules=context.role==='ADMINISTRATOR'?timingModules:timingModules.filter(id=>!['M10','M11'].includes(id));
  const parts=[`w.scope_known=true`,`cardinality(w.scope_orders)>0`,`w.module_id=any(${add(modules)}::text[])`,`w.result_json->>'status' in ('EXPORTED','COMPLETED','COMPLETED_WITH_FINDINGS')`,`w.occurred_at<=current_timestamp`];
  if(context.authenticated&&context.role!=='ADMINISTRATOR'){
    parts.push(`w.scope_orders <@ ${add((context.orders||[]).map(normalize))}::text[]`,`not (''=any(w.scope_orders))`);
    if(context.role==='SUPPLIER')parts.push(`cardinality(w.scope_suppliers)>0`,`w.scope_suppliers <@ ${add([normalize(context.organization)].filter(Boolean))}::text[]`);
  }
  return parts.join(' and ');
}
const fieldsFor=kind=>kind==='proposals'?proposalFields:recordFields;
const idFor=kind=>kind==='proposals'?'proposalId':'recordId';
const decisionFor=kind=>kind==='proposals'?'clientDecision':'decisionStatus';
const rowKind=(kind,row)=>kind==='proposals'?'p':row.recordType==='LIFECYCLE'||row.decisionStatus==='OBSOLETE'?'l':'r';
const sortField=(kind,sort)=>sort==='id'?idFor(kind):sort==='decision'?decisionFor(kind):sorts[sort];
const scopeSignature=context=>({authenticated:Boolean(context.authenticated),role:context.role,userId:context.userId||null,orders:[...new Set((context.orders||[]).map(normalize))].sort(),organization:normalize(context.organization)});

const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function cursorFor(cursor,signature){
  if(!cursor)return null;
  try{if(typeof cursor!=='string'||cursor.length>20000||!/^[A-Za-z0-9_-]+$/.test(cursor))throw 0;const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(value.v!==1||value.signature!==signature||typeof value.value!=='string'||typeof value.id!=='string'||!['p','r','l'].includes(value.kind)||value.value.length>10000||value.id.length>1000||value.value.includes('\0')||value.id.includes('\0'))throw 0;return value;}catch{throw httpError(422,'This page cursor does not match the active account, filters or sorting. Refresh the register.',{code:'INVALID_REGISTER_CURSOR'});}
}
function memoryMatches(kind,row,filters){
  if(kind==='proposals'&&row.archived)return false;
  for(const [key,field] of [['orderNo','orderNo'],['product','productDecimalNo'],['supplier','supplier']])if(filters[key]&&normalize(row[field])!==normalize(filters[key]))return false;
  if(filters.decision&&(filters.decision==='PENDING'?['APPROVED','REJECTED','DO NOT PURCHASE'].includes(classifyProposal(row)):row[decisionFor(kind)]!==filters.decision))return false;
  return (!filters.search||fieldsFor(kind).some(field=>text(row[field]).toLowerCase().includes(filters.search.toLowerCase())))&&registerColumnMatches(kind,row,filters.columnFilters);
}
export {memoryMatches as registerMemoryMatches,sortField as registerSortField};
export function registerMemoryCompare(kind,filters,left,right){
  const field=sortField(kind,filters.sort),id=idFor(kind),factor=filters.direction==='asc'?1:-1;
  return factor*(compare(text(left[field]).toLowerCase(),text(right[field]).toLowerCase())||compare(left[id],right[id])||compare(rowKind(kind,left),rowKind(kind,right)));
}
const statsFor=(kind,items)=>({total:items.length,approved:items.filter(row=>row[decisionFor(kind)]==='APPROVED').length,rejected:items.filter(row=>row[decisionFor(kind)]==='REJECTED').length,obsolete:items.filter(row=>row.decisionStatus==='OBSOLETE').length,missingReference:items.filter(row=>row[decisionFor(kind)]==='APPROVED'&&!row.decisionReference).length});

export class RegisterQuery {
  constructor(storage){this.storage=storage;this.pool=storage.rawPool||storage.pool;}
  async memory(kind,context){const {state}=await this.storage.reviewSnapshot();return (kind==='proposals'?state.proposals:state.replacements).filter(row=>allowed(context,row));}
  async page(kind,input={},context){return publishNamedRead(this.pool,context,()=>this.pageData(kind,input,context));}
  async pageData(kind,input={},context){
    const filters=registerFilters(kind,input),signature=hash({kind,filters,scope:scopeSignature(context),driver:this.pool?'sql':'local'}),cursor=cursorFor(input.cursor,signature);
    if(this.pool)return this.sqlPage(kind,filters,cursor,signature,context);
    const items=(await this.memory(kind,context)).filter(row=>memoryMatches(kind,row,filters)),field=sortField(kind,filters.sort),id=idFor(kind),factor=filters.direction==='asc'?1:-1;
    items.sort((a,b)=>registerMemoryCompare(kind,filters,a,b));
    const candidates=cursor?items.filter(row=>factor*(compare(text(row[field]).toLowerCase(),cursor.value)||compare(row[id],cursor.id)||compare(rowKind(kind,row),cursor.kind))>0):items;
    const page=candidates.slice(0,filters.limit),last=page.at(-1);
    return {items:structuredClone(page).map(row=>({...row,selectionKey:registerRowSelection(kind,row)})),count:items.length,stats:statsFor(kind,items),filters,nextCursor:candidates.length>filters.limit?encode({v:1,signature,value:text(last[field]).toLowerCase(),id:last[id],kind:rowKind(kind,last)}):null,canModerate:kind==='database'&&context.role==='ADMINISTRATOR'};
  }
  field(kind,field,alias){
    if(field==='recordType')return alias==='l'?"'LIFECYCLE'::text":"'REPLACEMENT'::text";
    if(alias==='l'){if(field==='recordId')return 'l.record_id';return `coalesce(l.payload->>'${field}','')`;}
    if(field==='round')return `${alias}.approval_round`;
    if(field==='clientReplyRaw')return `coalesce(${alias}.normalized_json->>'clientReplyRaw','')`;
    if(['decisionDate','historicalDate'].includes(field))return `coalesce(to_char(${alias}.${snake(field)},'YYYY-MM-DD'),'')`;
    const column=`${alias}.${snake(field)}`;return field==='decisionReference'?`coalesce(${column},'')`:column;
  }
  where(kind,filters,context,alias,values){
    const add=value=>{values.push(value);return `$${values.length}`;},field=name=>this.field(kind,name,alias),parts=[];
    if(kind==='proposals'&&!filters.includeArchived)parts.push(`${alias}.archived=false`);
    if(context.authenticated&&context.role!=='ADMINISTRATOR'){
      const orders=[...new Set((context.orders||[]).map(normalize))];parts.push(orders.length?`replacement_register.scope_text(${field('orderNo')})=any(${add(orders)}::text[])`:'false');
      if(context.role==='SUPPLIER')parts.push(normalize(context.organization)?`replacement_register.scope_text(${field('supplier')})=${add(normalize(context.organization))}`:'false');
    }
    for(const [key,name] of [['orderNo','orderNo'],['product','productDecimalNo'],['supplier','supplier']])if(filters[key])parts.push(`replacement_register.scope_text(${field(name)})=${add(normalize(filters[key]))}`);
    if(filters.decision==='PENDING'&&kind==='proposals')parts.push(`replacement_register.reply_kind(case when ${alias}.client_decision<>'' then ${alias}.client_decision else coalesce(${alias}.normalized_json->>'clientReplyRaw','') end) not in ('APPROVED','REJECTED','DO NOT PURCHASE')`);
    else if(filters.decision)parts.push(`${field(decisionFor(kind))}=${add(filters.decision==='PENDING'?'':filters.decision)}`);
    if(filters.search)parts.push(`${alias}.search_content like ${add('%'+filters.search.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%')} escape '\\'`);
    parts.push(...registerColumnSql(kind,filters.columnFilters,field,values));
    return parts.length?parts.join(' and '):'true';
  }
  sources(kind,filters,context,values,{payload=true}={}){
    return (kind==='proposals'?[['proposals','p']]:[['replacement_records','r'],['lifecycle_records','l']]).map(([table,alias])=>{
      const field=name=>this.field(kind,name,alias),sort=sortField(kind,filters.sort),id=field(idFor(kind));
      return `select ${payload?`to_jsonb(${alias}) as payload,`:''}'${alias}'::text as kind,${id} collate "C" as id,lower(${field(sort)} collate replacement_register.search_unicode) collate "C" as sv,${field(decisionFor(kind))} as decision,${field('decisionReference')} as reference from replacement_register.${table} ${alias} where ${this.where(kind,filters,context,alias,values)}`;
    }).join(' union all ');
  }
  statisticsQuery(kind,filters,context){
    const values=[],parts=[],missing=[];
    for(const [table,alias] of kind==='proposals'?[['proposals','p']]:[['replacement_records','r'],['lifecycle_records','l']]){
      const where=this.where(kind,filters,context,alias,values),decision=this.field(kind,decisionFor(kind),alias);
      parts.push(`select ${alias==='l'?"'OBSOLETE'::text":decision} as decision from replacement_register.${table} ${alias} where ${where}`);
      if(alias!=='l'){const missingWhere=this.where(kind,filters,context,alias,values);missing.push(`(select count(*) from replacement_register.${table} ${alias} where ${missingWhere} and ${decision}='APPROVED' and ${this.field(kind,'decisionReference',alias)}='')`);}
    }
    return {sql:`select count(*) as total,count(*) filter(where decision='APPROVED') as approved,count(*) filter(where decision='REJECTED') as rejected,count(*) filter(where decision='OBSOLETE') as obsolete,${missing.join('+')||'0'} as "missingReference" from (${parts.join(' union all ')}) counted`,values};
  }
  async sqlPage(kind,filters,cursor,signature,context){
    const client=await this.pool.connect();
    try{
      await client.query('begin isolation level repeatable read read only');
      const countQuery=this.statisticsQuery(kind,filters,context);
      const raw=(await client.query(countQuery.sql,countQuery.values)).rows[0];
      const stats=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key,Number(value)]));
      const values=[],source=this.sources(kind,filters,context,values,{payload:false});let predicate='';if(cursor){values.push(cursor.value,cursor.id,cursor.kind);predicate=`where (sv,id,kind) ${filters.direction==='asc'?'>':'<'} ($${values.length-2}::text collate "C",$${values.length-1}::text collate "C",$${values.length}::text)`;}
      const order=`sv ${filters.direction},id ${filters.direction},kind ${filters.direction}`;
      values.push(filters.limit+1);
      const details=(kind==='proposals'?[['proposals','p','proposal_id']]:[['replacement_records','r','record_id'],['lifecycle_records','l','record_id']]).map(([table,alias,key])=>`select k.id,k.sv,k.kind,to_jsonb(${alias}) as payload from keys k join replacement_register.${table} ${alias} on ${alias}.${key}=k.id collate "default" where k.kind='${alias}'`).join(' union all ');
      const rows=(await client.query(`with keys as materialized (select id,sv,kind from (${source}) candidates ${predicate} order by ${order} limit $${values.length}) select * from (${details}) selected order by ${order}`,values)).rows;
      await client.query('commit');const page=rows.slice(0,filters.limit),last=page.at(-1);
      return {items:page.map(row=>{const item=row.kind==='p'?rowToProposal(row.payload):row.kind==='r'?rowToReplacement(row.payload):rowToLifecycle(row.payload);return {...item,selectionKey:registerRowSelection(kind,item)};}),count:stats.total,stats,filters,nextCursor:rows.length>filters.limit?encode({v:1,signature,value:last.sv,id:last.id,kind:last.kind}):null,canModerate:kind==='database'&&context.role==='ADMINISTRATOR'};
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async dashboard(context){return publishNamedRead(this.pool,context,()=>this.dashboardData(context));}
  async dashboardData(context){
    if(!this.pool){const {state}=await this.storage.reviewSnapshot(),proposals=state.proposals.filter(row=>!row.archived&&allowed(context,row)),records=state.replacements.filter(row=>allowed(context,row)),orders=summarizeOrders(proposals),runs=(state.workflowRuns||[]).filter(run=>timingRunAllowed(run,context));
      const now=new Date(),first=new Map(),last=new Map();for(const run of runs){const at=Date.parse(run.occurredAt);if(!Number.isFinite(at)||at>now.getTime())continue;for(const key of run.orderKeys){if(!first.has(key)||at<first.get(key))first.set(key,at);if(!last.has(key)||at>last.get(key).at)last.set(key,{at,stage:activityStage(run)});}}
      for(const order of orders){const key=normalize(order.orderNo),at=first.get(key);order.firstActivityAt=at===undefined?null:new Date(at).toISOString();order.observedStage=last.get(key)?.stage||null;}
      return {summary:{...summarize(proposals),databaseRecords:records.length},performance:elapsedOverview(orders.map(order=>order.firstActivityAt).filter(Boolean),{now}),orders,recent:structuredClone(proposals.slice(0,8)),audit:context.role==='ADMINISTRATOR'?structuredClone(state.audit.slice(0,5)):[]};}
    const client=await this.pool.connect();try{
      await client.query('begin isolation level repeatable read read only');
      const values=[],where=this.where('proposals',{},context,'p',values);
      const classified=`select p.*,case when p.client_decision<>'' then p.client_decision when coalesce(p.normalized_json->>'clientReplyRaw','')='' then '' else replacement_register.reply_kind(p.normalized_json->>'clientReplyRaw') end as kind from replacement_register.proposals p where ${where}`;
      const aggregates=`count(*) as total,count(*) filter(where kind='APPROVED') as approved,count(*) filter(where kind='REJECTED') as rejected,count(*) filter(where kind='DO NOT PURCHASE') as "doNotPurchase",count(*) filter(where kind not in ('APPROVED','REJECTED','DO NOT PURCHASE')) as pending,
        count(*) filter(where kind in ('APPROVED','REJECTED') and (replacement_register.ui_trim(responsible)='' or decision_date is null or decision_date not between date '0001-01-01' and date '9999-12-31' or (kind='APPROVED' and replacement_register.ui_trim(decision_reference)='') or (kind='REJECTED' and replacement_register.ui_trim(client_comment)=''))) as "awaitingDocuments",
        count(*) filter(where can_record) as "readyToRecord",count(distinct nullif(replacement_register.scope_text(product_decimal_no),'')) as products,count(distinct nullif(replacement_register.scope_text(order_no),'')) as orders,count(distinct nullif(replacement_register.scope_text(supplier),'')) as suppliers`;
      const summaryRow=(await client.query(`select ${aggregates} from (${classified}) classified`,values)).rows[0];
      const orderRows=(await client.query(`select min(order_no) as "orderNo",array_remove(array_agg(distinct coalesce(nullif(product,''),product_decimal_no)), '') as "productNames",array_remove(array_agg(distinct supplier),'') as "supplierNames",${aggregates} from (${classified}) classified group by replacement_register.scope_text(order_no) order by min(order_no)`,values)).rows;
      const orders=orderRows.map(({orderNo,productNames,supplierNames,...counts})=>({orderNo,products:productNames,suppliers:supplierNames,summary:Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)]))}));
      if(orders.length){const timingValues=[orders.map(order=>normalize(order.orderNo))],scope=timingSqlScope(context,timingValues);const starts=(await client.query(`select k.order_key,min(w.occurred_at) as first_at,(array_agg(w.module_id order by w.occurred_at desc,w.id desc))[1] as last_module,(array_agg(w.result_json->>'action' order by w.occurred_at desc,w.id desc))[1] as last_action from replacement_register.workflow_runs w cross join lateral unnest(w.scope_orders) k(order_key) where k.order_key=any($1::text[]) and ${scope} group by k.order_key`,timingValues)).rows;const byOrder=new Map(starts.map(row=>[row.order_key,{at:new Date(row.first_at).toISOString(),stage:activityStage({moduleId:row.last_module,action:row.last_action})}]));for(const order of orders){const timing=byOrder.get(normalize(order.orderNo));order.firstActivityAt=timing?.at||null;order.observedStage=timing?.stage||null;}}
      const summary=Object.fromEntries(Object.entries(summaryRow).map(([key,value])=>[key,Number(value)]));
      const recordValues=[],recordSources=[['replacement_records','r'],['lifecycle_records','l']].map(([table,alias])=>`select count(*) as n from replacement_register.${table} ${alias} where ${this.where('database',{},context,alias,recordValues)}`);
      summary.databaseRecords=Number((await client.query(`select sum(n) as n from (${recordSources.join(' union all ')}) counts`,recordValues)).rows[0].n);
      const recent=(await client.query(`select p.* from replacement_register.proposals p where ${where} order by p.proposal_id limit 8`,values)).rows.map(rowToProposal);
      const audit=context.role==='ADMINISTRATOR'?(await client.query('select id,occurred_at as "occurredAt",actor,actor_role as role,action,subject,detail,before_json as before,after_json as after,actor_user_id as "actorUserId",request_id as "requestId" from replacement_register.audit_events order by occurred_at desc,id desc limit 5')).rows:[];
      await client.query('commit');return {summary,performance:elapsedOverview(orders.map(order=>order.firstActivityAt).filter(Boolean)),orders,recent,audit};
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async orderTiming(orderNo,context){return publishNamedRead(this.pool,context,async()=>{
    const key=normalize(orderNo);if(!key||String(orderNo).length>1000)throw httpError(422,'Order number is required.',{code:'ORDER_REQUIRED'});
    if(!this.pool){const {state}=await this.storage.reviewSnapshot();if(!state.proposals.some(row=>!row.archived&&normalize(row.orderNo)===key&&allowed(context,row)))throw httpError(404,'Order not found.');const runs=(state.workflowRuns||[]).filter(run=>run.orderKeys?.includes(key)&&timingRunAllowed(run,context)).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));return observedOrderTiming(runs.slice(0,2000),{truncated:runs.length>2000});}
    const client=await this.pool.connect();try{
      await client.query('begin isolation level repeatable read read only');const values=[],where=this.where('proposals',{orderNo},context,'p',values);
      if(!(await client.query(`select 1 from replacement_register.proposals p where ${where} limit 1`,values)).rows.length)throw httpError(404,'Order not found.');
      const timingValues=[key],scope=timingSqlScope(context,timingValues);const rows=(await client.query(`select w.id,w.module_id as "moduleId",w.occurred_at as "occurredAt",w.result_json->>'action' as action from replacement_register.workflow_runs w where $1=any(w.scope_orders) and ${scope} order by w.occurred_at,w.id limit 2001`,timingValues)).rows;
      await client.query('commit');return observedOrderTiming(rows.slice(0,2000),{truncated:rows.length>2000});
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  });}
  async catalog(context){return publishNamedRead(this.pool,context,()=>this.catalogData(context));}
  async catalogData(context){
    const fields=['orderNo','supplier','product','productCode','productDecimalNo','productionOrder'];
    if(!this.pool){const rows=(await this.memory('proposals',context)).filter(row=>!row.archived),groups=new Map();for(const row of rows){const item=Object.fromEntries(fields.map(field=>[field,text(row[field])])),key=JSON.stringify(item);groups.set(key,{...item,rows:(groups.get(key)?.rows||0)+1});}return {items:[...groups.values()].map(exchangeCatalogItem)};}
    const values=[],where=this.where('proposals',{},context,'p',values),columns=fields.map(field=>`p.${snake(field)}`);
    const rows=(await this.pool.query(`select ${columns.map((column,i)=>`${column} as "${fields[i]}"`).join(',')},count(*)::int as rows from replacement_register.proposals p where ${where} group by ${columns.join(',')} order by ${columns.join(',')}`,values)).rows;
    return {items:rows.map(exchangeCatalogItem)};
  }
  async nextReview(input,context){return publishNamedRead(this.pool,context,()=>this.nextReviewData(input,context));}
  async nextReviewData(input,context){
    const filters=registerFilters('proposals',{...input,limit:1});
    if(!this.pool){const rows=(await this.memory('proposals',context)).filter(row=>memoryMatches('proposals',row,filters)).sort((a,b)=>compare(a.proposalId,b.proposalId));return {item:rows.find(row=>['APPROVED','REJECTED'].includes(row.clientDecision)&&!row.canRecord)||rows[0]||null};}
    const client=await this.pool.connect();try{await client.query('begin isolation level repeatable read read only');const values=[],where=this.where('proposals',filters,context,'p',values);let rows=(await client.query(`select p.* from replacement_register.proposals p where ${where} and p.client_decision in ('APPROVED','REJECTED') and p.can_record=false order by p.proposal_id limit 1`,values)).rows;if(!rows.length)rows=(await client.query(`select p.* from replacement_register.proposals p where ${where} order by p.proposal_id limit 1`,values)).rows;await client.query('commit');return {item:rows[0]?rowToProposal(rows[0]):null};}catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async orders(context){return publishNamedRead(this.pool,context,()=>this.ordersData(context));}
  async ordersData(context){
    if(!this.pool){const proposals=await this.memory('proposals',context),records=await this.memory('database',context),orders=[...new Set([...proposals,...records].map(row=>row.orderNo).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true})),counts=new Map();for(const row of proposals)if(!row.archived)counts.set(row.orderNo,(counts.get(row.orderNo)||0)+1);return {orders,currentOrder:[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0]||orders.at(-1)||''};}
    const values=[],sources=[['proposals','p'],['replacement_records','r'],['lifecycle_records','l']].map(([table,alias])=>{const kind=alias==='p'?'proposals':'database';return `select ${this.field(kind,'orderNo',alias)} as order_no,${alias==='p'?'case when p.archived=false then 1 else 0 end':'0'} as active from replacement_register.${table} ${alias} where ${this.where(kind,{includeArchived:true},context,alias,values)}`;}).join(' union all ');
    const rows=(await this.pool.query(`select order_no,sum(active)::int as active from (${sources}) scoped where order_no<>'' group by order_no`,values)).rows,orders=rows.map(row=>row.order_no).sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));
    return {orders,currentOrder:rows.filter(row=>row.active>0).sort((a,b)=>b.active-a.active||compare(a.order_no,b.order_no))[0]?.order_no||orders.at(-1)||''};
  }
}
