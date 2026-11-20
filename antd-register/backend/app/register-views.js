import {createHash,randomUUID} from 'node:crypto';
import {httpError,lockNamedReleaseAccount,currentNamedReleaseContext} from './auth.js';
import {normalize} from './normalization.js';
import {parseRegisterView} from './register-column-filters.js';
import {copyAuditContext} from './audit-provenance.js';

const rr='replacement_register',roles=new Set(['ADMINISTRATOR','SUPPLIER','CLIENT']);
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const copy=value=>structuredClone(value),iso=value=>value instanceof Date?value.toISOString():new Date(value).toISOString();
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const registerViewDigest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same=(a,b)=>registerViewDigest(a)===registerViewDigest(b);
const fail=(status,code,message,extra={})=>{throw httpError(status,message,{code,...extra});};
const missing=()=>fail(404,'REGISTER_VIEW_NOT_FOUND','Saved register view not found.');
const invalid=()=>fail(409,'REGISTER_VIEW_INTEGRITY','The saved register view history failed its integrity check. Ask an administrator to verify the retained history.');
const id=value=>{if(!uuid(value))fail(422,'REGISTER_VIEW_FIELDS','Use a valid view and request identifier.');return value.toLowerCase();};
function kind(value){if(!['proposals','database'].includes(value))fail(422,'REGISTER_VIEW_FIELDS','Select the proposals or historical database register.');return value;}
function name(value){if(typeof value!=='string'||!value.isWellFormed()||!value.trim()||value.trim().length>120||/[\x00-\x1f\x7f]/.test(value))fail(422,'REGISTER_VIEW_FIELDS','Give the saved view a name of 1–120 valid text characters.');return value.trim();}
function contextFor(context){if(!context||!roles.has(context.role)||context.authenticated&&!uuid(context.userId))fail(403,'REGISTER_VIEW_FORBIDDEN','Sign in with a permitted account to manage personal register views.');return context;}
export function registerViewOwnerKey(context){contextFor(context);return context.authenticated?'USER:'+context.userId.toLowerCase():'PREVIEW:'+JSON.stringify([context.role,String(context.actor||'Local user')]);}
const binding=context=>registerViewDigest({owner:registerViewOwnerKey(context),role:context.role,organization:normalize(context.organization),orders:[...new Set((context.orders||[]).map(normalize))].sort()});

export function parseRegisterViewRequest(input){
  if(!object(input)||!['CREATE','UPDATE','DELETE'].includes(input.action))fail(422,'REGISTER_VIEW_FIELDS','Select a supported saved-view action.');
  const fields=['action','requestId','viewId','expectedVersion',...(input.action==='DELETE'?[]:['name','registerKind','view'])];
  if(Object.keys(input).some(key=>!fields.includes(key)))fail(422,'REGISTER_VIEW_FIELDS','The saved-view request contains an unsupported field.');
  const request={action:input.action,requestId:id(input.requestId),viewId:id(input.viewId),expectedVersion:input.expectedVersion};
  if(!Number.isSafeInteger(request.expectedVersion)||request.expectedVersion<(request.action==='CREATE'?0:1)||(request.action==='CREATE'&&request.expectedVersion!==0))fail(422,'REGISTER_VIEW_FIELDS','Use the saved view version you reviewed.');
  if(request.action!=='DELETE'){request.name=name(input.name);request.registerKind=kind(input.registerKind);request.view=parseRegisterView(request.registerKind,input.view);}
  return request;
}
export function registerViewSummary(head){return copy(Object.fromEntries(['viewId','registerKind','name','version','view','active','createdAt','updatedAt'].map(key=>[key,head[key]])));}
export function registerViewAuditSnapshot(item){return item===null?null:Object.fromEntries(['viewId','registerKind','version','active'].map(key=>[key,item[key]]));}
export function registerViewFromSql(row){return row?{viewId:row.view_id,ownerKey:row.owner_key,ownerUserId:row.owner_user_id,ownerRole:row.owner_role,registerKind:row.register_kind,name:row.name,nameKey:row.name_key,version:Number(row.version),view:row.view_json,active:row.active,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),lastEventId:row.last_event_id}:null;}
export function registerViewEventFromSql(row){return row?{eventId:row.event_id,ownerKey:row.owner_key,requestId:row.request_id,viewId:row.view_id,version:Number(row.version),action:row.action,before:row.before_json,after:row.after_json,auditEventId:String(row.audit_event_id),actorUserId:row.actor_user_id,actorRole:row.actor_role,createdAt:iso(row.created_at)}:null;}
export function registerViewReceiptFromSql(row){return row?{ownerKey:row.owner_key,requestId:row.request_id,eventId:row.event_id,requestHash:row.request_hash,requestJson:row.request_json,resultHash:row.result_hash,resultJson:row.result_json,createdAt:iso(row.created_at)}:null;}
function validateSummary(value){
  if(!object(value)||!uuid(value.viewId)||!Number.isSafeInteger(value.version)||value.version<1||typeof value.active!=='boolean'||name(value.name)!==value.name||!same(parseRegisterView(kind(value.registerKind),value.view),value.view)||Object.keys(value).sort().join('|')!==['viewId','registerKind','name','version','view','active','createdAt','updatedAt'].sort().join('|'))invalid();
  for(const key of ['createdAt','updatedAt'])if(typeof value[key]!=='string'||iso(value[key])!==value[key])invalid();
  if(value.updatedAt<value.createdAt)invalid();return value;
}
export function validateRegisterViewHead(head){
  try{
    if(!object(head)||Object.keys(head).some(key=>!['viewId','ownerKey','ownerUserId','ownerRole','registerKind','name','nameKey','version','view','active','createdAt','updatedAt','lastEventId'].includes(key)))invalid();
    validateSummary(registerViewSummary(head));
    if(typeof head.ownerKey!=='string'||!roles.has(head.ownerRole)||head.nameKey!==normalize(head.name)||!uuid(head.lastEventId))invalid();
    if(head.ownerUserId){if(!uuid(head.ownerUserId)||head.ownerKey!=='USER:'+head.ownerUserId.toLowerCase())invalid();}
    else{if(!head.ownerKey.startsWith('PREVIEW:'))invalid();const owner=JSON.parse(head.ownerKey.slice(8));if(!Array.isArray(owner)||owner.length!==2||owner[0]!==head.ownerRole||typeof owner[1]!=='string'||head.ownerKey!=='PREVIEW:'+JSON.stringify(owner))invalid();}
    return head;
  }catch{invalid();}
}
export function validateRegisterViewEvent(event){
  try{
    if(!object(event)||Object.keys(event).some(key=>!['eventId','ownerKey','requestId','viewId','version','action','before','after','auditEventId','actorUserId','actorRole','createdAt'].includes(key))||!uuid(event.eventId)||!uuid(event.requestId)||!uuid(event.viewId)||!roles.has(event.actorRole)||typeof event.ownerKey!=='string'||!/^\d+$/.test(event.auditEventId)||event.actorUserId!==null&&!uuid(event.actorUserId))invalid();
    validateSummary(event.after);if(event.after.viewId!==event.viewId||event.after.version!==event.version||event.after.updatedAt!==event.createdAt)invalid();
    if(event.version===1){if(event.action!=='CREATE'||event.before!==null||!event.after.active)invalid();}
    else{validateSummary(event.before);if(!['UPDATE','DELETE'].includes(event.action)||event.before.viewId!==event.viewId||event.before.registerKind!==event.after.registerKind||event.before.version!==event.version-1||!event.before.active||event.after.active!==(event.action==='UPDATE')||event.before.createdAt!==event.after.createdAt)invalid();}
    if(event.ownerKey.startsWith('USER:')){if(!uuid(event.actorUserId)||event.ownerKey!=='USER:'+event.actorUserId)invalid();}
    else{if(!event.ownerKey.startsWith('PREVIEW:')||event.actorUserId!==null)invalid();const owner=JSON.parse(event.ownerKey.slice(8));if(!Array.isArray(owner)||owner.length!==2||owner[0]!==event.actorRole||typeof owner[1]!=='string'||event.ownerKey!=='PREVIEW:'+JSON.stringify(owner))invalid();}
    return event;
  }catch{invalid();}
}
export function validateRegisterViewReceipt(receipt,event){
  try{
    if(!object(receipt)||Object.keys(receipt).some(key=>!['ownerKey','requestId','eventId','requestHash','requestJson','resultHash','resultJson','createdAt'].includes(key)))invalid();
    validateRegisterViewEvent(event);const request=parseRegisterViewRequest(receipt.requestJson),result={requestId:request.requestId,action:request.action,item:event.after};
    if(receipt.ownerKey!==event.ownerKey||receipt.requestId!==event.requestId||request.requestId!==receipt.requestId||receipt.eventId!==event.eventId||receipt.createdAt!==event.createdAt||request.viewId!==event.viewId||request.expectedVersion!==event.version-1||request.action!==event.action||!same(request,receipt.requestJson)||registerViewDigest(request)!==receipt.requestHash||registerViewDigest(receipt.resultJson)!==receipt.resultHash||!same(receipt.resultJson,result)||request.action!=='DELETE'&&(request.name!==event.after.name||request.registerKind!==event.after.registerKind||!same(request.view,event.after.view)))invalid();
    return copy(receipt.resultJson);
  }catch{invalid();}
}
function auditMatches(event,audit){
  if(!audit||String(audit.id)!==event.auditEventId||audit.action!=='REGISTER_VIEW_'+event.action||audit.subject!==event.viewId||audit.role!==event.actorRole||(audit.actorUserId??null)!==event.actorUserId||audit.requestId!==event.requestId||!same(audit.before,registerViewAuditSnapshot(event.before))||!same(audit.after,registerViewAuditSnapshot(event.after)))invalid();
}
const auditFromSql=row=>row?{id:row.id,action:row.action,subject:row.subject,role:row.actor_role,actorUserId:row.actor_user_id,requestId:row.request_id,before:row.before_json,after:row.after_json}:null;
function stored(head,event,receipt,audit){validateRegisterViewHead(head);validateRegisterViewReceipt(receipt,event);auditMatches(event,audit);if(head.lastEventId!==event.eventId||head.ownerKey!==event.ownerKey||!same(registerViewSummary(head),event.after))invalid();return head;}

function pageOptions(input,context){
  if(!object(input)||Object.keys(input).some(key=>!['registerKind','limit','cursor'].includes(key)))fail(422,'REGISTER_VIEW_PAGE','Unsupported saved-view page filter.');
  const registerKind=input.registerKind===undefined?null:kind(input.registerKind),limit=input.limit===undefined?30:Number(input.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||input.limit!==undefined&&!/^[1-9]\d*$/.test(String(input.limit)))fail(422,'REGISTER_VIEW_PAGE','Choose a saved-view page size from 1 to 100.');
  const ownerKey=registerViewOwnerKey(context),signature=registerViewDigest({ownerKey,registerKind});let after=null;
  if(input.cursor!==undefined&&input.cursor!==null&&input.cursor!==''){try{if(typeof input.cursor!=='string'||input.cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(input.cursor))throw Error();const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));if(value.v!==1||value.signature!==signature||!uuid(value.after))throw Error();after=value.after.toLowerCase();}catch{fail(422,'REGISTER_VIEW_PAGE','This saved-view cursor belongs to another account or register.');}}
  return {ownerKey,registerKind,limit,after,signature};
}
const cursor=(signature,after)=>Buffer.from(JSON.stringify({v:1,signature,after})).toString('base64url');
const headSelect=`select v.*,to_jsonb(e) as event_row,to_jsonb(r) as receipt_row,to_jsonb(a) as audit_row from ${rr}.register_views v left join ${rr}.register_view_events e on e.event_id=v.last_event_id left join ${rr}.register_view_receipts r on r.event_id=e.event_id left join ${rr}.audit_events a on a.id=e.audit_event_id`;

export class RegisterViews {
  constructor(storage,{now=()=>Date.now()}={}){this.storage=storage;this.pool=storage.rawPool||storage.pool||null;this.now=now;}
  async guard(operation){try{return await operation();}catch(error){if(error.status)throw error;if(['42P01','42703','42883','3F000','ECONNREFUSED','ECONNRESET','ETIMEDOUT','08006','08003','57P01','53300','57014','55P03','ENOSPC','EACCES','EIO','EROFS'].includes(error.code))fail(503,'REGISTER_VIEWS_UNAVAILABLE','Personal register views are temporarily unavailable.',{details:['The saved-view store could not complete the request. Check storage and ordered migrations, then retry with the same request ID.']});if(error.code==='23505')fail(409,'REGISTER_VIEW_CONFLICT','A saved view changed or its name is already in use. Refresh your personal views.');throw error;}}
  async fresh(context,client){
    contextFor(context);if(!this.pool||!context.authenticated)return context;
    await lockNamedReleaseAccount(client,context);const current=await currentNamedReleaseContext(client,context);
    if(binding(current)!==binding(context))fail(403,'REGISTER_VIEW_ACCOUNT_CHANGED','Your account or assigned scope changed. Refresh before using personal register views.');return current;
  }
  async transaction(operation){const client=await this.pool.connect();try{await client.query('begin');const result=await operation(client);await client.query('commit');return result;}catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}}
  async publish(context,read){const payload=await read();if(!this.pool)return payload;return this.transaction(async client=>{await this.fresh(context,client);return payload;});}
  async head(viewId,client=null,lock=false){
    if(client){const row=(await client.query(headSelect+' where v.view_id=$1'+(lock?' for update of v':''),[viewId])).rows[0];return row?{head:registerViewFromSql(row),event:registerViewEventFromSql(row.event_row),receipt:registerViewReceiptFromSql(row.receipt_row),audit:auditFromSql(row.audit_row)}:null;}
    const state=this.storage.state,head=state.registerViews?.find(item=>item.viewId===viewId);if(!head)return null;const event=state.registerViewEvents?.find(item=>item.eventId===head.lastEventId),receipt=state.registerViewReceipts?.find(item=>item.eventId===head.lastEventId),audit=state.audit?.find(item=>String(item.id)===event?.auditEventId);return {head,event,receipt,audit};
  }
  validate(data,ownerKey){if(!data||data.head.ownerKey!==ownerKey)missing();return stored(data.head,data.event,data.receipt,data.audit);}
  list(context,input={}){return this.guard(async()=>{const options=pageOptions(input,context);return this.publish(context,async()=>{
    let rows;
    if(this.pool)rows=(await this.pool.query(headSelect+' where v.owner_key=$1 and v.active and ($2::text is null or v.register_kind=$2) and ($3::uuid is null or v.view_id>$3::uuid) order by v.view_id limit $4',[options.ownerKey,options.registerKind,options.after,options.limit+1])).rows.map(row=>({head:registerViewFromSql(row),event:registerViewEventFromSql(row.event_row),receipt:registerViewReceiptFromSql(row.receipt_row),audit:auditFromSql(row.audit_row)}));
    else{await this.storage.queue;rows=[];for(const head of (this.storage.state.registerViews||[]).filter(item=>item.ownerKey===options.ownerKey&&item.active&&(!options.registerKind||item.registerKind===options.registerKind)&&(!options.after||item.viewId>options.after)).sort((a,b)=>a.viewId.localeCompare(b.viewId)).slice(0,options.limit+1))rows.push(await this.head(head.viewId));}
    const visible=rows.slice(0,options.limit),items=visible.map(row=>registerViewSummary(this.validate(row,options.ownerKey)));return {items,nextCursor:rows.length>options.limit?cursor(options.signature,visible.at(-1).head.viewId):null};
  });});}
  get(viewId,context){return this.guard(async()=>{const ownerKey=registerViewOwnerKey(context);if(!uuid(viewId))missing();return this.publish(context,async()=>{if(!this.pool)await this.storage.queue;return registerViewSummary(this.validate(await this.head(viewId.toLowerCase(),this.pool),ownerKey));});});}
  async receipt(ownerKey,requestId,client=null){
    if(client){const row=(await client.query(`select r.*,to_jsonb(e) as event_row,to_jsonb(a) as audit_row from ${rr}.register_view_receipts r left join ${rr}.register_view_events e using(event_id) left join ${rr}.audit_events a on a.id=e.audit_event_id where r.owner_key=$1 and r.request_id=$2`,[ownerKey,requestId])).rows[0];return row?{receipt:registerViewReceiptFromSql(row),event:registerViewEventFromSql(row.event_row),audit:auditFromSql(row.audit_row)}:null;}
    const state=this.storage.state,receipt=state.registerViewReceipts?.find(item=>item.ownerKey===ownerKey&&item.requestId===requestId);if(!receipt)return null;const event=state.registerViewEvents?.find(item=>item.eventId===receipt.eventId),audit=state.audit?.find(item=>String(item.id)===event?.auditEventId);return {receipt,event,audit};
  }
  async apply(request,context,client=null){
    const ownerKey=registerViewOwnerKey(context),prior=await this.receipt(ownerKey,request.requestId,client);
    if(prior){const result=validateRegisterViewReceipt(prior.receipt,prior.event);auditMatches(prior.event,prior.audit);if(prior.receipt.requestHash!==registerViewDigest(request))fail(409,'REGISTER_VIEW_REQUEST_REUSED','This request ID belongs to a different saved-view change.');const latest=await this.head(request.viewId,client);if(!latest)invalid();this.validate(latest,ownerKey);return result;}
    const data=await this.head(request.viewId,client,Boolean(client));let current=null;
    if(data){current=this.validate(data,ownerKey);if(request.action==='CREATE'||request.expectedVersion!==current.version)fail(409,'REGISTER_VIEW_CONFLICT','This saved view changed. Compare your settings with its current version.',{current:registerViewSummary(current)});if(!current.active)fail(409,'REGISTER_VIEW_DELETED','This saved view has already been deleted.',{current:registerViewSummary(current)});if(request.action!=='DELETE'&&request.registerKind!==current.registerKind)fail(422,'REGISTER_VIEW_FIELDS','A saved view cannot be moved to another register.');}
    else if(request.action!=='CREATE')missing();
    if(current?.version===Number.MAX_SAFE_INTEGER)fail(409,'REGISTER_VIEW_CONFLICT','This saved view cannot advance its version. Ask an administrator to review it.');
    if(request.action!=='DELETE'){
      const collision=client?(await client.query(`select view_id from ${rr}.register_views where owner_key=$1 and register_kind=$2 and name_key=$3 and active and view_id<>$4 limit 1`,[ownerKey,request.registerKind,normalize(request.name),request.viewId])).rows[0]?.view_id:this.storage.state.registerViews?.find(item=>item.ownerKey===ownerKey&&item.registerKind===request.registerKind&&item.nameKey===normalize(request.name)&&item.active&&item.viewId!==request.viewId)?.viewId;
      if(collision)fail(409,'REGISTER_VIEW_NAME_EXISTS','A personal view with this name already exists in this register.');
    }
    const stamp=new Date(Math.max(this.now(),current?Date.parse(current.updatedAt):0)).toISOString(),eventId=randomUUID(),head=current?{...copy(current),version:current.version+1,updatedAt:stamp,lastEventId:eventId}:{viewId:request.viewId,ownerKey,ownerUserId:context.authenticated?context.userId.toLowerCase():null,ownerRole:context.role,registerKind:request.registerKind,version:1,createdAt:stamp,updatedAt:stamp,lastEventId:eventId};
    if(request.action==='DELETE')head.active=false;else Object.assign(head,{name:request.name,nameKey:normalize(request.name),view:copy(request.view),active:true});
    validateRegisterViewHead(head);const before=current?registerViewSummary(current):null,after=registerViewSummary(head),actor=copyAuditContext(context,{...context,requestId:request.requestId}),action='REGISTER_VIEW_'+request.action;let auditEventId;
    const auditBefore=registerViewAuditSnapshot(before),auditAfter=registerViewAuditSnapshot(after),detail=`${head.registerKind}; version ${head.version}`;
    if(client){await this.storage.writeAudit(client,actor,action,head.viewId,detail,auditBefore,auditAfter);auditEventId=(await client.query(`select id::text as id from ${rr}.audit_events where request_id=$1 and action=$2 and subject=$3 and actor_user_id is not distinct from $4::uuid order by id desc limit 1`,[request.requestId,action,head.viewId,actor.userId||null])).rows[0]?.id;if(!auditEventId)fail(503,'REGISTER_VIEWS_UNAVAILABLE','The personal view and its audit could not be saved.',{details:['Retry with the same request ID after checking the audit store.']});}
    else auditEventId=String(this.storage.addAudit(actor,action,head.viewId,detail,auditBefore,auditAfter).id);
    const event={eventId,ownerKey,requestId:request.requestId,viewId:head.viewId,version:head.version,action:request.action,before,after,auditEventId,actorUserId:head.ownerUserId,actorRole:context.role,createdAt:stamp},result={requestId:request.requestId,action:request.action,item:after},receipt={ownerKey,requestId:request.requestId,eventId,requestHash:registerViewDigest(request),requestJson:copy(request),resultHash:registerViewDigest(result),resultJson:copy(result),createdAt:stamp};validateRegisterViewReceipt(receipt,event);
    if(client){
      if(current)await client.query(`update ${rr}.register_views set name=$2,name_key=$3,version=$4,view_json=$5,active=$6,updated_at=$7,last_event_id=$8 where view_id=$1`,[head.viewId,head.name,head.nameKey,head.version,head.view,head.active,head.updatedAt,eventId]);
      else await client.query(`insert into ${rr}.register_views(view_id,owner_key,owner_user_id,owner_role,register_kind,name,name_key,version,view_json,active,created_at,updated_at,last_event_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[head.viewId,head.ownerKey,head.ownerUserId,head.ownerRole,head.registerKind,head.name,head.nameKey,head.version,head.view,head.active,head.createdAt,head.updatedAt,eventId]);
      await client.query(`insert into ${rr}.register_view_events(event_id,owner_key,request_id,view_id,version,action,before_json,after_json,audit_event_id,actor_user_id,actor_role,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[eventId,ownerKey,request.requestId,head.viewId,head.version,event.action,event.before,event.after,event.auditEventId,event.actorUserId,event.actorRole,stamp]);
      await client.query(`insert into ${rr}.register_view_receipts(owner_key,request_id,event_id,request_hash,request_json,result_hash,result_json,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)`,[ownerKey,request.requestId,eventId,receipt.requestHash,receipt.requestJson,receipt.resultHash,receipt.resultJson,stamp]);
    }else{this.storage.state.registerViews||=[];this.storage.state.registerViewEvents||=[];this.storage.state.registerViewReceipts||=[];if(current)this.storage.state.registerViews[this.storage.state.registerViews.findIndex(item=>item.viewId===head.viewId)]=copy(head);else this.storage.state.registerViews.push(copy(head));this.storage.state.registerViewEvents.push(copy(event));this.storage.state.registerViewReceipts.push(copy(receipt));this.localDirty=true;}
    return copy(result);
  }
  change(input,context){return this.guard(async()=>{
    const request=parseRegisterViewRequest(input);registerViewOwnerKey(context);
    if(this.pool)return this.transaction(async client=>{await client.query('select pg_advisory_xact_lock(78742025)');const current=await this.fresh(context,client);return this.apply(request,current,client);});
    const storage=this.storage;storage.queue||=Promise.resolve();const task=storage.queue.then(async()=>{const before=copy(storage.state),receipts=storage.importReceipts?new Map(storage.importReceipts):null,floor=storage.proposalSequenceFloor,allocation=copy(storage.proposalAllocationSnapshot);try{this.localDirty=false;const result=await this.apply(request,context);if(this.localDirty&&storage.persist)await storage.persist();return result;}catch(error){storage.state=before;if(receipts)storage.importReceipts=receipts;storage.proposalSequenceFloor=floor;storage.proposalAllocationSnapshot=allocation;throw error;}});storage.queue=task.catch(()=>{});return task;
  });}
}
