import {roundDigest} from './workflow-rounds.js';
import {roundAdministrator,roundAccessible,requireRoundAccess,roundIdentifier,managementSummary} from './round-management.js';
import {memoryRoundContext,memoryRoundCounts,sqlRoundContext,sqlRoundHead,sqlRoundInstance} from './round-management-store.js';
import {memoryAssociationSources,sqlAssociationSources} from './round-association-store.js';
import {normalize,cleanText} from './normalization.js';
import {httpError} from './auth.js';
import {roundExchangeProjection} from './round-exchange-visibility.js';

const rr='replacement_register',maximum=9223372036854775807n,copy=value=>structuredClone(value);
const fail=(status,code,message)=>{throw httpError(status,message,{code});};
const changed=()=>fail(409,'ROUND_READ_CHANGED','Approval-round membership or lifecycle changed. Refresh this view before continuing.');
const invalidState=()=>fail(409,'ROUND_READ_STATE_INVALID','The retained round view is inconsistent. Refresh or ask an administrator to review it.');
function contextFor(context){if(!context||!['ADMINISTRATOR','SUPPLIER','CLIENT'].includes(context.role)||context.authenticated&&!context.userId)fail(403,'ROUND_READ_FORBIDDEN','Sign in with a permitted account to read approval rounds.');return context;}
const binding=context=>({authenticated:Boolean(context.authenticated),role:context.role,userId:context.userId||null,...(!context.authenticated?{actor:context.actor||''}:{}),orders:[...new Set((context.orders||[]).map(normalize))].sort(),organization:normalize(context.organization)});
const ordinal=value=>{const text=String(value);if(!/^[1-9]\d{0,18}$/.test(text)||BigInt(text)>maximum)invalidState();return text;};
const count=value=>{const number=Number(value);if(!Number.isSafeInteger(number)||number<0)invalidState();return number;};
const version=value=>{const number=count(value);if(number<1)invalidState();return number;};
const text=(value,label)=>{if(typeof value!=='string'||value.length>250||/[\x00-\x1f\x7f]/.test(value))fail(422,'ROUND_READ_FILTER_INVALID',`Invalid ${label} filter.`);return cleanText(value);};

function filtersFor(view,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail(422,'ROUND_READ_FILTER_INVALID','Round filters must be an object.');
  const allowed=['limit','cursor',...(view==='list'?['orderNo','supplier','productDecimalNo','workflowId','status']:view==='members'?['moduleId','kind']:view==='candidates'?['assignment','moduleId','kind']:view==='management'?['action']:['exchangeId','roundId','action'])];
  for(const key of Object.keys(input))if(!allowed.includes(key))fail(422,'ROUND_READ_FILTER_INVALID',`Unsupported round filter: ${key}.`);
  const limit=input.limit===undefined?30:Number(input.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail(422,'ROUND_READ_PAGE_INVALID','Round page size must be from 1 to 100.');
  const cursor=input.cursor===undefined||input.cursor===null||input.cursor===''?null:input.cursor;if(cursor!==null&&(typeof cursor!=='string'||cursor.length>4096||!/^[a-zA-Z0-9_-]+$/.test(cursor)))fail(422,'ROUND_READ_CURSOR_INVALID','The round page cursor is invalid. Refresh the view.');
  const result={limit,cursor};for(const key of allowed.filter(key=>!['limit','cursor'].includes(key)))if(input[key]!==undefined&&input[key]!=='')result[key]=['workflowId','exchangeId','roundId'].includes(key)?roundIdentifier(input[key],key):text(input[key],key);
  if(result.status&&!['OPEN','CLOSED','CANCELLED'].includes(result.status))fail(422,'ROUND_READ_FILTER_INVALID','Choose OPEN, CLOSED or CANCELLED.');
  if(view==='candidates'){result.assignment=result.assignment||'ALL';if(!['ALL','UNASSIGNED','ASSIGNED'].includes(result.assignment))fail(422,'ROUND_READ_FILTER_INVALID','Choose ALL, UNASSIGNED or ASSIGNED.');}
  return result;
}
const criteria=filters=>Object.fromEntries(Object.entries(filters).filter(([key])=>!['limit','cursor'].includes(key)));
function pageWindow(view,scope,filters,context,parts,asOf){
  const stamp=roundDigest(parts),bound=roundDigest({view,scope,filters:criteria(filters),context:binding(context)}),ceiling=parts[view==='list'?'heads':view==='management'?'management':view==='association'?'association':'raw'][view==='list'?2:1];
  if(!filters.cursor)return {view,scope,bound,stamp,ceiling,last:null,asOf};
  let parsed;try{const bytes=Buffer.from(filters.cursor,'base64url');if(bytes.toString('base64url')!==filters.cursor)throw Error();parsed=JSON.parse(bytes.toString());if(!parsed||parsed.v!==1||Object.keys(parsed).some(key=>!['v','view','scope','bound','stamp','ceiling','last','asOf'].includes(key))||!['view','scope','bound','stamp','ceiling','last','asOf'].every(key=>typeof parsed[key]==='string')||!['bound','stamp'].every(key=>/^[a-f0-9]{64}$/.test(parsed[key]))||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.asOf)||new Date(parsed.asOf).toISOString()!==parsed.asOf)throw Error();for(const key of ['ceiling','last'])if(!/^[1-9]\d{0,18}$/.test(parsed[key])||BigInt(parsed[key])>maximum)throw Error();if(BigInt(parsed.last)>BigInt(parsed.ceiling))throw Error();}catch{fail(422,'ROUND_READ_CURSOR_INVALID','The round page cursor is invalid. Refresh the view.');}
  if(parsed.view!==view||parsed.scope!==scope||parsed.bound!==bound||parsed.stamp!==stamp||parsed.ceiling!==ceiling)changed();return {...parsed};
}
function finishPage(rows,filters,window,items,header={}){
  const extra=rows.length>filters.limit,last=rows[Math.min(rows.length,filters.limit)-1];
  return {...header,items,nextCursor:extra?Buffer.from(JSON.stringify({v:1,...window,last:ordinal(last.ordinal)})).toString('base64url'):null,asOf:window.asOf};
}
const fits=(row,window)=>BigInt(row.ordinal)<=BigInt(window.ceiling)&&(!window.last||BigInt(row.ordinal)<BigInt(window.last));
const descending=(a,b)=>BigInt(a.ordinal)>BigInt(b.ordinal)?-1:BigInt(a.ordinal)<BigInt(b.ordinal)?1:0;
function rowFilter(row,filters){return (!filters.moduleId||row.moduleId===filters.moduleId)&&(!filters.kind||row.kind===filters.kind);}

function summary(data,context,effectiveExchangeCount){
  requireRoundAccess(data.instance,context);if(data.head)version(data.head.version);if(data.head&&data.observed&&data.head.workflowId!==data.observed.workflowId)invalidState();
  const result={...managementSummary(data),effectiveExchangeCount,...(data.head?{ordinal:ordinal(data.head.ordinal)}:{})};
  if(context.role==='ADMINISTRATOR')return result;
  const keys=['workflowId','orderNo','supplier','productDecimalNo','product','roundId','roundLabel','roundKey','status','lifecycleStatus','managed','version','ordinal','createdAt','updatedAt','observedExchangeCount','effectiveExchangeCount','activityAfterClosure'];
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(result,key)).map(key=>[key,copy(result[key])]));
}
function publicWorkflow(instance,context){if(context.role==='ADMINISTRATOR')return copy(instance);return Object.fromEntries(['workflowId','orderNo','supplier','productDecimalNo','product'].map(key=>[key,instance[key]]));}
function exchangeProjection(source,metadata,context){
  const raw=copy(source.payload),named=source.roundKey!=='';let association;
  if(named)association={roundId:source.observedRoundId,roundLabel:metadata.sourceRoundLabel,version:metadata.associationVersion||0,kind:'OBSERVED',lifecycleStatus:metadata.sourceLifecycle||'UNKNOWN'};
  else{if(metadata.assignedRoundId&&!metadata.assignedStatus)invalidState();association={roundId:metadata.assignedRoundId||null,roundLabel:metadata.assignedRoundLabel||null,version:metadata.associationVersion||0,kind:metadata.assignedRoundId?'ASSIGNED':'UNASSIGNED',lifecycleStatus:metadata.assignedStatus||'UNKNOWN'};}
  const fields=roundExchangeProjection(raw,context);
  return {...fields,ordinal:ordinal(metadata.ordinal),sourceRoundId:source.observedRoundId,sourceRoundLabel:metadata.sourceRoundLabel??null,sourceHash:source.rawHash,rawExchangeHash:source.rawHash,association};
}

function memoryBase(state,context,filters={}){return (state.workflowInstances||[]).filter(instance=>roundAccessible(instance,context)&&(!filters.workflowId||instance.workflowId===filters.workflowId)&&(!filters.orderNo||normalize(instance.orderNo)===normalize(filters.orderNo))&&(!filters.supplier||normalize(instance.supplier)===normalize(filters.supplier))&&(!filters.productDecimalNo||normalize(instance.productDecimalNo)===normalize(filters.productDecimalNo)));}
function memoryParts(state,instances){
  const workflows=new Set(instances.map(item=>item.workflowId)),rounds=new Map((state.proposalRounds||[]).map(item=>[item.roundId,item])),heads=(state.approvalRoundHeads||[]).filter(item=>workflows.has(item.workflowId)),headMap=new Map(heads.map(item=>[item.roundId,item]));
  const raw=(state.workflowExchanges||[]).filter(item=>workflows.has(rounds.get(item.roundId)?.workflowId)),rawIds=new Set(raw.map(item=>item.exchangeId));
  const stat=(rows,versions=false)=>{let high=0n,total=0n;for(const row of rows){if(row.ordinal!==undefined){const value=BigInt(ordinal(row.ordinal));if(value>high)high=value;}if(versions)total+=BigInt(version(row.version));}return versions?[String(rows.length),total.toString(),high.toString()]:[String(rows.length),high.toString()];};
  const associations=(state.roundExchangeAssociations||[]).filter(item=>rawIds.has(item.exchangeId));
  return {heads:stat(heads,true),observed:stat([...rounds.values()].filter(item=>workflows.has(item.workflowId))),raw:stat(raw),assignments:stat(associations,true),management:stat((state.approvalRoundEvents||[]).filter(item=>headMap.has(item.roundId))),association:stat((state.roundAssociationEvents||[]).filter(item=>workflows.has(item.workflowId)))};
}
function memoryWorkflow(state,id,context){const instance=state.workflowInstances?.find(item=>item.workflowId===id);if(!roundAccessible(instance,context))fail(404,'ROUND_WORKFLOW_NOT_FOUND','Workflow not found.');return instance;}
function memoryEffective(state,id,workflowId){const rounds=new Set((state.proposalRounds||[]).filter(item=>item.workflowId===workflowId).map(item=>item.roundId)),assigned=new Set((state.roundExchangeAssociations||[]).filter(item=>item.roundId===id).map(item=>item.exchangeId));return (state.workflowExchanges||[]).filter(item=>rounds.has(item.roundId)&&(item.roundId===id||assigned.has(item.exchangeId)));}
function memoryMetadata(state,row){const observed=state.proposalRounds?.find(item=>item.roundId===row.roundId),head=state.roundExchangeAssociations?.find(item=>item.exchangeId===row.exchangeId),target=head?.roundId?state.approvalRoundHeads?.find(item=>item.roundId===head.roundId&&item.workflowId===observed.workflowId):null,sourceHead=state.approvalRoundHeads?.find(item=>item.roundId===row.roundId);return {ordinal:row.ordinal,sourceRoundLabel:observed.roundLabel??null,associationVersion:head?version(head.version):0,assignedRoundId:head?.roundId||null,assignedRoundLabel:target?.roundLabel||null,assignedStatus:target?.status||null,sourceLifecycle:sourceHead?.status||'UNKNOWN'};}

function sqlBase(context,filters={}){
  const values=[],where=[],add=value=>{values.push(value);return `$${values.length}`;};
  if(context.authenticated&&context.role!=='ADMINISTRATOR'){
    const orders=[...new Set((context.orders||[]).map(normalize).filter(Boolean))];where.push(orders.length?`w.order_key=any(${add(orders)}::text[])`:'false');
    if(context.role==='SUPPLIER'){const supplier=normalize(context.organization);where.push(supplier?`w.supplier_key=${add(supplier)}`:'false');}
  }
  for(const [field,column]of [['workflowId','workflow_id'],['orderNo','order_key'],['supplier','supplier_key'],['productDecimalNo','product_key']])if(filters[field])where.push(`w.${column}=${add(field==='workflowId'?filters[field]:normalize(filters[field]))}`);
  return {values,sql:`select w.workflow_id from ${rr}.workflow_instances w${where.length?' where '+where.join(' and '):''}`};
}
async function sqlParts(client,base){
  const result=(await client.query(`with base as materialized (${base.sql}) select
    (select array[count(*)::text,coalesce(sum(h.version),0)::text,coalesce(max(h.ordinal),0)::text] from ${rr}.approval_round_heads h join base b using(workflow_id)) as heads,
    (select array[count(*)::text,coalesce(max(r.ordinal),0)::text] from ${rr}.proposal_rounds r join base b using(workflow_id)) as observed,
    (select array[count(*)::text,coalesce(max(e.ordinal),0)::text] from ${rr}.workflow_exchanges e join ${rr}.proposal_rounds r using(round_id) join base b using(workflow_id)) as raw,
    (select array[count(*)::text,coalesce(sum(a.version),0)::text,'0'] from ${rr}.round_exchange_associations a join ${rr}.workflow_exchanges e using(exchange_id) join ${rr}.proposal_rounds r on r.round_id=e.round_id join base b using(workflow_id)) as assignments,
    (select array[count(*)::text,coalesce(max(v.ordinal),0)::text] from ${rr}.approval_round_events v join ${rr}.approval_round_heads h using(round_id) join base b using(workflow_id)) as management,
    (select array[count(*)::text,coalesce(max(v.ordinal),0)::text] from ${rr}.round_association_events v join base b using(workflow_id)) as association`,base.values)).rows[0];return result;
}
async function sqlWorkflow(client,id,context){const instance=sqlRoundInstance((await client.query(`select * from ${rr}.workflow_instances where workflow_id=$1`,[id])).rows[0]);if(!roundAccessible(instance,context))fail(404,'ROUND_WORKFLOW_NOT_FOUND','Workflow not found.');return instance;}
async function sqlEffectiveCount(client,id,workflowId){return count((await client.query(`select count(*)::text as value from (select e.exchange_id from ${rr}.workflow_exchanges e join ${rr}.proposal_rounds r using(round_id) where e.round_id=$1 and r.workflow_id=$2 union select e.exchange_id from ${rr}.round_exchange_associations a join ${rr}.workflow_exchanges e using(exchange_id) join ${rr}.proposal_rounds r on r.round_id=e.round_id where a.round_id=$1 and r.workflow_id=$2) ids`,[id,workflowId])).rows[0].value);}
async function sqlRoundSummary(client,id,context){const data=await sqlRoundContext(client,id);requireRoundAccess(data.instance,context);return summary(data,context,await sqlEffectiveCount(client,id,data.instance.workflowId));}
function addRowFilters(filters,values,where,alias='e'){for(const field of ['moduleId','kind'])if(filters[field]){values.push(filters[field]);where.push(`${alias}.${field==='moduleId'?'module_id':'kind'}=$${values.length}`);}}

export class RoundManagementRead {
  constructor(storage){this.storage=storage;this.pool=storage.rawPool||storage.pool||null;}
  async snapshot(operation){
    if(this.pool){const client=await this.pool.connect();try{await client.query('begin isolation level repeatable read read only');const asOf=(await client.query('select transaction_timestamp() as time')).rows[0].time.toISOString(),result=await operation({client,asOf});await client.query('commit');return result;}catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}}
    const run=()=>operation({state:this.storage.state,asOf:new Date().toISOString()});if(!this.storage.queue)return run();const task=this.storage.queue.then(run);this.storage.queue=task.catch(()=>{});return task;
  }
  async getRoundManagement(context,id){contextFor(context);id=roundIdentifier(id);return this.snapshot(async({client,state})=>client?sqlRoundSummary(client,id,context):summary(memoryRoundContext(state,id),context,memoryEffective(state,id,memoryRoundContext(state,id).instance?.workflowId).length));}
  async listManagedRounds(context,input={}){
    contextFor(context);const filters=filtersFor('list',input);return this.snapshot(async({client,state,asOf})=>{
      if(!client){const instances=memoryBase(state,context,filters),parts=memoryParts(state,instances),window=pageWindow('list','BASE',filters,context,parts,asOf),ids=new Set(instances.map(item=>item.workflowId));const rows=(state.approvalRoundHeads||[]).filter(row=>ids.has(row.workflowId)&&(!filters.status||row.status===filters.status)&&fits(row,window)).sort(descending).slice(0,filters.limit+1);return finishPage(rows,filters,window,rows.slice(0,filters.limit).map(row=>summary(memoryRoundContext(state,row.roundId),context,memoryEffective(state,row.roundId,row.workflowId).length)));}
      const base=sqlBase(context,filters),parts=await sqlParts(client,base),window=pageWindow('list','BASE',filters,context,parts,asOf),values=[...base.values],where=['h.ordinal<=$'+(values.push(window.ceiling))+'::bigint'];if(window.last)where.push('h.ordinal<$'+(values.push(window.last))+'::bigint');if(filters.status)where.push('h.status=$'+(values.push(filters.status)));values.push(filters.limit+1);
      const rows=(await client.query(`with base as materialized (${base.sql}),page_ids as materialized (select h.round_id from ${rr}.approval_round_heads h join base b using(workflow_id) where ${where.join(' and ')} order by h.ordinal desc limit $${values.length}) select h.*,w.order_no,w.supplier,w.product_decimal_no,w.product,w.workflow_key,w.order_key,w.supplier_key,w.product_key,r.workflow_id as observed_workflow_id,
        (select count(*)::text from ${rr}.workflow_exchanges e where e.round_id=h.round_id) as observed_count,
        (select count(*)::text from ${rr}.round_association_events v where v.from_round_id=h.round_id or v.to_round_id=h.round_id) as association_count,
        (select count(*)::text from (select e.exchange_id from ${rr}.workflow_exchanges e join ${rr}.proposal_rounds original using(round_id) where e.round_id=h.round_id and original.workflow_id=h.workflow_id union select e.exchange_id from ${rr}.round_exchange_associations a join ${rr}.workflow_exchanges e using(exchange_id) join ${rr}.proposal_rounds original on original.round_id=e.round_id where a.round_id=h.round_id and original.workflow_id=h.workflow_id) effective) as effective_count
        from page_ids p join ${rr}.approval_round_heads h using(round_id) join ${rr}.workflow_instances w using(workflow_id) left join ${rr}.proposal_rounds r on r.round_id=h.round_id order by h.ordinal desc`,values)).rows;
      const page=rows.slice(0,filters.limit).map(row=>summary({head:sqlRoundHead(row),observed:row.observed_workflow_id?{workflowId:row.observed_workflow_id}:null,instance:sqlRoundInstance(row),counts:{observedExchangeCount:count(row.observed_count),associationEventCount:count(row.association_count)}},context,count(row.effective_count)));return finishPage(rows,filters,window,page);
    });
  }
  async managedRoundExchanges(context,id,input={}){return this.exchangePage('members',context,roundIdentifier(id),input);}
  async unassignedCandidates(context,id,input={}){return this.exchangePage('candidates',context,roundIdentifier(id,'Workflow ID'),input);}
  async exchangePage(view,context,id,input){
    contextFor(context);const filters=filtersFor(view,input);return this.snapshot(async({client,state,asOf})=>{
      let instance,round;
      if(client){if(view==='members'){const data=await sqlRoundContext(client,id);requireRoundAccess(data.instance,context);instance=data.instance;round=summary(data,context,await sqlEffectiveCount(client,id,instance.workflowId));}else instance=await sqlWorkflow(client,id,context);}
      else{if(view==='members'){const data=memoryRoundContext(state,id);requireRoundAccess(data.instance,context);instance=data.instance;round=summary(data,context,memoryEffective(state,id,instance.workflowId).length);}else instance=memoryWorkflow(state,id,context);}
      const header=view==='members'?{round}:{workflow:publicWorkflow(instance,context)};
      if(!client){const parts=memoryParts(state,[instance]),window=pageWindow(view,id,filters,context,parts,asOf),observed=new Map((state.proposalRounds||[]).map(row=>[row.roundId,row]));let rows=view==='members'?memoryEffective(state,id,instance.workflowId):(state.workflowExchanges||[]).filter(row=>observed.get(row.roundId)?.workflowId===id&&observed.get(row.roundId)?.roundKey==='');rows=rows.filter(row=>rowFilter(row,filters)&&fits(row,window)&&(!(view==='candidates'&&filters.assignment!=='ALL')||Boolean(state.roundExchangeAssociations?.find(head=>head.exchangeId===row.exchangeId)?.roundId)===(filters.assignment==='ASSIGNED'))).sort(descending).slice(0,filters.limit+1);const page=rows.slice(0,filters.limit),sources=new Map(memoryAssociationSources(state,page.map(row=>row.exchangeId)).map(row=>[row.exchangeId,row]));return finishPage(rows,filters,window,page.map(row=>exchangeProjection(sources.get(row.exchangeId),memoryMetadata(state,row),context)),header);}
      const parts=await sqlParts(client,sqlBase(context,{workflowId:instance.workflowId})),window=pageWindow(view,id,filters,context,parts,asOf),values=[instance.workflowId],where=['r.workflow_id=$1'];let cte='';
      if(view==='members'){values.push(id);cte=`with member_ids as materialized (select e.exchange_id from ${rr}.workflow_exchanges e join ${rr}.proposal_rounds r using(round_id) where e.round_id=$2 and r.workflow_id=$1 union select e.exchange_id from ${rr}.round_exchange_associations a join ${rr}.workflow_exchanges e using(exchange_id) join ${rr}.proposal_rounds r on r.round_id=e.round_id where a.round_id=$2 and r.workflow_id=$1)`;where.push('e.exchange_id in (select exchange_id from member_ids)');}
      else{where.push("r.round_key=''");if(filters.assignment==='ASSIGNED')where.push('a.round_id is not null');if(filters.assignment==='UNASSIGNED')where.push('a.round_id is null');}
      values.push(window.ceiling);where.push(`e.ordinal<=$${values.length}::bigint`);if(window.last){values.push(window.last);where.push(`e.ordinal<$${values.length}::bigint`);}addRowFilters(filters,values,where);values.push(filters.limit+1);
      const rows=(await client.query(`${cte} select e.exchange_id,e.ordinal,r.round_label as source_round_label,a.version as association_version,a.round_id as assigned_round_id,t.round_label as assigned_round_label,t.status as assigned_status,s.status as source_lifecycle from ${rr}.workflow_exchanges e join ${rr}.proposal_rounds r using(round_id) left join ${rr}.round_exchange_associations a on a.exchange_id=e.exchange_id left join ${rr}.approval_round_heads t on t.round_id=a.round_id and t.workflow_id=r.workflow_id left join ${rr}.approval_round_heads s on s.round_id=e.round_id where ${where.join(' and ')} order by e.ordinal desc limit $${values.length}`,values)).rows;
      const page=rows.slice(0,filters.limit),sources=new Map((page.length?await sqlAssociationSources(client,page.map(row=>row.exchange_id)):[]).map(row=>[row.exchangeId,row]));return finishPage(rows,filters,window,page.map(row=>exchangeProjection(sources.get(row.exchange_id),{ordinal:row.ordinal,sourceRoundLabel:row.source_round_label,associationVersion:row.association_version===null?0:version(row.association_version),assignedRoundId:row.assigned_round_id,assignedRoundLabel:row.assigned_round_label,assignedStatus:row.assigned_status,sourceLifecycle:row.source_lifecycle},context)),header);
    });
  }
  async managementHistory(context,id,input={}){return this.historyPage('management',context,roundIdentifier(id),input);}
  async associationHistory(context,id,input={}){return this.historyPage('association',context,roundIdentifier(id,'Workflow ID'),input);}
  async historyPage(view,context,id,input){
    contextFor(context);roundAdministrator(context);const filters=filtersFor(view,input);return this.snapshot(async({client,state,asOf})=>{
      let instance,round;if(view==='management'){const data=client?await sqlRoundContext(client,id):memoryRoundContext(state,id);requireRoundAccess(data.instance,context);instance=data.instance;round=summary(data,context,client?await sqlEffectiveCount(client,id,instance.workflowId):memoryEffective(state,id,instance.workflowId).length);}else instance=client?await sqlWorkflow(client,id,context):memoryWorkflow(state,id,context);
      if(view==='association'&&filters.exchangeId){const found=client?(await client.query(`select r.workflow_id from ${rr}.workflow_exchanges e join ${rr}.proposal_rounds r using(round_id) where e.exchange_id=$1`,[filters.exchangeId])).rows[0]?.workflow_id:(state.proposalRounds||[]).find(row=>row.roundId===state.workflowExchanges?.find(row=>row.exchangeId===filters.exchangeId)?.roundId)?.workflowId;if(found!==instance.workflowId)fail(404,'ROUND_EXCHANGE_NOT_FOUND','Workflow exchange not found.');}
      if(view==='association'&&filters.roundId){const data=client?await sqlRoundContext(client,filters.roundId):memoryRoundContext(state,filters.roundId);if(data.instance?.workflowId!==instance.workflowId)fail(404,'ROUND_NOT_FOUND','Approval round not found.');}
      const parts=client?await sqlParts(client,sqlBase(context,{workflowId:instance.workflowId})):memoryParts(state,[instance]),window=pageWindow(view,id,filters,context,parts,asOf),header=round?{round}:{workflow:publicWorkflow(instance,context)};
      if(!client){const rows=(state[view==='management'?'approvalRoundEvents':'roundAssociationEvents']||[]).filter(row=>(view==='management'?row.roundId===id:row.workflowId===id)&&(!filters.action||row.action===filters.action)&&(!filters.exchangeId||row.exchangeId===filters.exchangeId)&&(!filters.roundId||row.fromRoundId===filters.roundId||row.toRoundId===filters.roundId)&&fits(row,window)).sort(descending).slice(0,filters.limit+1);return finishPage(rows,filters,window,copy(rows.slice(0,filters.limit)),header);}
      const values=[id,window.ceiling],where=[view==='management'?'v.round_id=$1':'v.workflow_id=$1','v.ordinal<=$2::bigint'];if(window.last){values.push(window.last);where.push(`v.ordinal<$${values.length}::bigint`);}if(filters.action){values.push(filters.action);where.push(`v.event_json->>'action'=$${values.length}`);}if(filters.exchangeId){values.push(filters.exchangeId);where.push(`v.exchange_id=$${values.length}`);}if(filters.roundId){values.push(filters.roundId);where.push(`(v.from_round_id=$${values.length} or v.to_round_id=$${values.length})`);}values.push(filters.limit+1);const table=view==='management'?'approval_round_events':'round_association_events';
      const rows=(await client.query(`with page_ids as materialized (select v.event_id,v.ordinal from ${rr}.${table} v where ${where.join(' and ')} order by v.ordinal desc limit $${values.length}) select v.event_json,p.ordinal from page_ids p join ${rr}.${table} v using(event_id) order by p.ordinal desc`,values)).rows;return finishPage(rows,filters,window,rows.slice(0,filters.limit).map(row=>({...row.event_json,ordinal:String(row.ordinal)})),header);
    });
  }
}
