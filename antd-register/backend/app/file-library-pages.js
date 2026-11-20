import {createHash,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {httpError} from './auth.js';
import {normalize} from './normalization.js';

export const FILE_LIBRARY_HEAD_CONTRACT='VISIBLE_ATTACHMENT_HEAD-v1';
export const FILE_LIBRARY_ORDER='DOCUMENT_VERSION';
export const FILE_LIBRARY_PAGE_LIMITS=Object.freeze({defaultLimit:30,maxLimit:100,candidateBatch:32,maxCandidateRows:512,maxCandidateBytes:8*1024*1024,maxCandidateRowBytes:2*1024*1024,maxPageBytes:16*1024*1024,maxItemBytes:8*1024*1024});
const allowedKeys=new Set(['limit','cursor','kind','moduleId','orderNo','productDecimalNo','proposalId','documentArtifactId','mode']);
const kinds=new Set(['ATTACHMENT','ORIGINAL_BOM','WORKFLOW_INPUT','WORKFLOW_OUTPUT']);
const modules=new Set([...Array.from({length:11},(_,index)=>'M'+String(index+1).padStart(2,'0')),'M90','M91','REGISTER_REPORT']);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const invalid=()=>httpError(422,'Choose valid file-library filters and a page size from 1 to 100.',{code:'FILE_LIBRARY_FILTER_INVALID'});
const cursorInvalid=()=>httpError(422,'This file-library page cursor is invalid. Refresh the file list.',{code:'FILE_LIBRARY_CURSOR_INVALID'});
const changed=()=>httpError(409,'The file library or your access changed. Refresh the file list before continuing.',{code:'FILE_LIBRARY_CHANGED'});
const stateInvalid=()=>httpError(409,'The file-library metadata could not be verified. Ask an administrator to review the library.',{code:'FILE_LIBRARY_STATE_INVALID'});
const tooLarge=()=>httpError(422,'File-library metadata exceeds the supported request limit. Ask an administrator to review the library.',{code:'FILE_LIBRARY_METADATA_LIMIT'});
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));

/** Shared finite route/repository contract. It accepts URLSearchParams without
 * losing duplicate keys, or its own ordinary normalized flat object. */
export function fileLibraryPageOptions(input={}){
  if(input instanceof URLSearchParams){const object={};for(const[key,value]of input){if(Object.hasOwn(object,key))throw invalid();Object.defineProperty(object,key,{value,enumerable:true});}input=object;}
  if(!plain(input)||Object.keys(input).some(key=>!allowedKeys.has(key)))throw invalid();
  const raw=input.limit??30;if(input.limit===null||!(typeof raw==='number'||typeof raw==='string'&&/^[1-9]\d*$/.test(raw)))throw invalid();
  const limit=Number(raw);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw invalid();
  const result={limit,mode:input.mode??'files'};if(!['files','replacementHeads'].includes(result.mode))throw invalid();
  for(const key of ['kind','moduleId','orderNo','productDecimalNo','proposalId','documentArtifactId'])if(Object.hasOwn(input,key)){
    const value=input[key];if(typeof value!=='string'||value.length>1024||value.includes('\0'))throw invalid();if(value==='')continue;
    if(key==='kind'&&!kinds.has(value)||key==='moduleId'&&!modules.has(value)||key==='documentArtifactId'&&!uuid.test(value))throw invalid();result[key]=value;
  }
  if(Object.hasOwn(input,'cursor')){if(typeof input.cursor!=='string'||input.cursor.length>4096||!/^[A-Za-z0-9_-]+$/.test(input.cursor))throw cursorInvalid();result.cursor=input.cursor;}
  return result;
}

const cursorKey=randomBytes(32);
const roleDocuments={ADMINISTRATOR:['Supplier_Datasheet','Client_Datasheet','Supporting_Document'],SUPPLIER:['Supplier_Datasheet'],CLIENT:['Client_Datasheet']};
const notFound=()=>httpError(404,'File not found.',{code:'FILE_NOT_FOUND'});
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const compareText=(left,right)=>Buffer.compare(Buffer.from(left),Buffer.from(right));
const compareItems=(left,right)=>compareText(left.logicalKey??'',right.logicalKey??'')||Number(right.version)-Number(left.version)||compareText(right.artifactId,left.artifactId);
const visibleKind=item=>!(item.moduleId==='REGISTER_REPORT'&&item.kind==='WORKFLOW_INPUT');
const replaceAllowed=(item,context)=>!item.attachmentMetadata?.attachmentRole||Boolean(roleDocuments[context.role]?.includes(item.attachmentMetadata.attachmentRole));
function bindingFor(context,options,source){
  if(!['ADMINISTRATOR','SUPPLIER','CLIENT'].includes(context.role)||context.authenticated&&!context.userId)throw changed();
  const {cursor,...filters}=options;
  return createHash('sha256').update(JSON.stringify({source,filters,authenticated:Boolean(context.authenticated),role:context.role,userId:context.userId??null,userIdPresent:Object.hasOwn(context,'userId'),actor:context.authenticated?null:context.actor||'Local administrator',organization:normalize(context.organization),orders:[...new Set((context.orders||[]).map(normalize))].sort()})).digest('hex');
}
function encode(binding,position){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey,nonce),data=Buffer.from(JSON.stringify({v:1,b:binding,...position})),encrypted=Buffer.concat([cipher.update(data),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
}
function decode(token,binding){
  let data;
  try{
    const value=Buffer.from(token,'base64url');if(value.length<29||value.toString('base64url')!==token)throw Error();
    const cipher=createDecipheriv('aes-256-gcm',cursorKey,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));data=JSON.parse(Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8'));
    if(!plain(data)||Object.keys(data).sort().join(',')!=='a,b,h,t,v'||data.v!==1||!/^[a-f0-9]{64}$/.test(data.b)||!uuid.test(data.a)||data.h!==null&&!uuid.test(data.h)||!Number.isSafeInteger(data.t))throw Error();
  }catch{throw cursorInvalid();}
  if(data.b!==binding)throw changed();return {a:data.a,h:data.h,t:data.t};
}
function textArray(value){if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw stateInvalid();return value;}
function minimalItem(row,acl){
  if(!uuid.test(row.artifact_id)||!Number.isSafeInteger(Number(row.version))||typeof row.kind!=='string'||typeof row.owner_only!=='boolean')throw stateInvalid();
  return {artifactId:row.artifact_id,version:Number(row.version),kind:row.kind,moduleId:row.module_id,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,ownerOnly:row.owner_only,scanStatus:row.scan_status,scope:{orderNos:textArray(acl.order_nos),suppliers:textArray(acl.suppliers),reportOwnerRole:row.report_owner_role,productDecimalNos:row.products_empty===true?[]:row.products_empty===false?['NONEMPTY']:null,proposalIds:row.proposals_empty===true?[]:row.proposals_empty===false?['NONEMPTY']:null},...(row.attachment_present?{attachmentMetadata:{attachmentRole:row.attachment_role,confidentiality:row.confidentiality}}:{})};
}
function fullMatches(item,options){
  return (!options.kind||item.kind===options.kind)&&(!options.moduleId||item.moduleId===options.moduleId)&&(!options.orderNo||item.scope.orderNos.includes(options.orderNo))&&(!options.productDecimalNo||item.scope.productDecimalNos.includes(options.productDecimalNo))&&(!options.proposalId||item.scope.proposalIds?.includes(options.proposalId));
}

const summaryColumns=`a.artifact_id,a.version,a.kind,a.module_id,a.owner_user_id,a.owner_actor,a.owner_only,a.scan_status,
 a.scope_json->>'reportOwnerRole' as report_owner_role,
 case when jsonb_typeof(a.scope_json->'productDecimalNos')='array' then jsonb_array_length(a.scope_json->'productDecimalNos')=0 else null end as products_empty,
 case when jsonb_typeof(a.scope_json->'proposalIds')='array' then jsonb_array_length(a.scope_json->'proposalIds')=0 else null end as proposals_empty,
 a.attachment_json is not null as attachment_present,a.attachment_json->>'attachmentRole' as attachment_role,a.attachment_json->>'confidentiality' as confidentiality`;
// Arrays already use their escaped JSON representation. Other strings may
// require six output bytes per source byte (for example a control character).
// Count every variable-width ACL/summary field before retrieving those fields.
const aclCostSql=`coalesce(octet_length((a.scope_json->'orderNos')::text),0)::bigint+coalesce(octet_length((a.scope_json->'suppliers')::text),0)::bigint
 +6*(coalesce(octet_length(a.kind),0)::bigint+coalesce(octet_length(a.module_id),0)::bigint+coalesce(octet_length(a.owner_actor),0)::bigint
 +coalesce(octet_length(a.scan_status),0)::bigint+coalesce(octet_length(a.scope_json->>'reportOwnerRole'),0)::bigint
 +coalesce(octet_length(a.attachment_json->>'attachmentRole'),0)::bigint+coalesce(octet_length(a.attachment_json->>'confidentiality'),0)::bigint)+2048`;

async function sqlSource(client,options,context,limits,fromRow){
  const focus=options.documentArtifactId||null;
  let focusedOrphan=false;
  const loadAcl=async ids=>new Map((await client.query(`/* FILE_LIBRARY_ACL */ select ${summaryColumns},a.scope_json->'orderNos' as order_nos,a.scope_json->'suppliers' as suppliers from replacement_register.artifacts a where a.artifact_id=any($1::uuid[])`,[ids])).rows.map(row=>[row.artifact_id,row]));
  return {
    async focus(access){
      if(!focus)return;
      const row=(await client.query(`/* FILE_LIBRARY_FOCUS */ select a.artifact_id,a.logical_key='' as orphan_group,${aclCostSql} as acl_bytes from replacement_register.artifacts a where a.artifact_id=$1`,[focus])).rows[0];
      if(!row)throw notFound();
      const cost=Number(row.acl_bytes);
      if(!Number.isSafeInteger(cost)||cost<0||cost>limits.maxCandidateRowBytes){if(context.role!=='ADMINISTRATOR')throw notFound();throw tooLarge();}
      const acl=(await loadAcl([focus])).get(focus);
      if(!acl||!visibleKind({moduleId:acl.module_id,kind:acl.kind})||!access(context,minimalItem(acl,acl)))throw notFound();
      focusedOrphan=row.orphan_group===true;
    },
    async anchor(position){
      if(!position)return;
      const row=(await client.query(`/* FILE_LIBRARY_ANCHOR */ select a.artifact_id,case when a.logical_key='' then a.version else (select max(g.version) from replacement_register.artifacts g where g.logical_key collate "C"=a.logical_key collate "C") end as group_top_version from replacement_register.artifacts a where a.artifact_id=$1`,[position.a])).rows[0];
      if(!row||Number(row.group_top_version)!==position.t)throw changed();
    },
    async candidates(position,count){
      const values=[position?.a||null,focus,count];
      const filter=[];const add=value=>{values.push(value);return '$'+values.length;};
      if(options.kind)filter.push('a.kind='+add(options.kind));if(options.moduleId)filter.push('a.module_id='+add(options.moduleId));
      for(const [field,key]of [['orderNo','orderNos'],['productDecimalNo','productDecimalNos'],['proposalId','proposalIds']])if(options[field])filter.push(`(a.scope_json->'${key}') ? ${add(options[field])}`);
      const columns='a.artifact_id,a.logical_key,a.version',order='a.logical_key collate "C" asc,a.version desc,a.artifact_id desc';
      const advance='(a.version,a.artifact_id)<((select version from anchor),(select artifact_id from anchor))';
      let keys;
      if(focus){
        const match=focusedOrphan?'a.artifact_id=$2::uuid':'a.logical_key collate "C"=(select logical_key collate "C" from replacement_register.artifacts where artifact_id=$2::uuid)';
        keys=`/* ${focusedOrphan?'FILE_LIBRARY_FOCUS_ORPHAN':'FILE_LIBRARY_FOCUS_DOCUMENT'} */ select ${columns} from replacement_register.artifacts a where ${match}${position?' and '+advance:''} order by ${order} limit $3`;
      }else if(position){
        // Each branch has a direct btree start condition and its own LIMIT.
        // An OR predicate over the whole index filtered every earlier page in
        // the retained native plan. Merge at most two bounded key streams.
        keys=`select next_keys.artifact_id,next_keys.logical_key,next_keys.version from (
         (/* FILE_LIBRARY_SEEK_SAME_DOCUMENT */ select ${columns} from replacement_register.artifacts a
          where a.logical_key collate "C"=(select logical_key collate "C" from anchor) and ${advance}
          order by ${order} limit $3)
         union all
         (/* FILE_LIBRARY_SEEK_LATER_DOCUMENTS */ select ${columns} from replacement_register.artifacts a
          where a.logical_key collate "C">(select logical_key collate "C" from anchor)
          order by ${order} limit $3)
        ) next_keys order by next_keys.logical_key collate "C" asc,next_keys.version desc,next_keys.artifact_id desc limit $3`;
      }else keys=`/* FILE_LIBRARY_SEEK_FIRST */ select ${columns} from replacement_register.artifacts a order by ${order} limit $3`;
      const rows=(await client.query(`/* FILE_LIBRARY_CANDIDATES */
 with anchor as (select logical_key,version,artifact_id,$2::uuid as focus_id from replacement_register.artifacts where artifact_id=$1::uuid),
 candidates as materialized (
  ${keys}
 )
 select a.artifact_id,a.version,${aclCostSql} as acl_bytes,${filter.length?filter.join(' and '):'true'} as filter_matches,
  a.logical_key<>'' and case when row_number() over w=1 then coalesce(a.logical_key collate "C"=(select logical_key collate "C" from anchor),false)
   else a.logical_key collate "C"=lag(a.logical_key collate "C") over w end as same_group,
  case when a.logical_key='' then a.version else (select max(g.version) from replacement_register.artifacts g where g.logical_key collate "C"=a.logical_key collate "C") end as group_top_version
 from candidates c join replacement_register.artifacts a using(artifact_id) window w as (order by a.logical_key collate "C" asc,a.version desc,a.artifact_id desc)
 order by a.logical_key collate "C" asc,a.version desc,a.artifact_id desc`,values)).rows;
      return rows;
    },
    acl:loadAcl,
    async sizes(ids){return new Map((await client.query(`/* FILE_LIBRARY_SIZES */ select artifact_id,octet_length(row_to_json(a)::text) as metadata_bytes from replacement_register.artifacts a where artifact_id=any($1::uuid[])`,[ids])).rows.map(row=>[row.artifact_id,Number(row.metadata_bytes)+2048]));},
    async full(ids){return new Map((await client.query(`/* FILE_LIBRARY_SELECTED */ select artifact_id,logical_key,version,sha256,filename,content_type,bytes,kind,module_id,scope_json,owner_user_id,owner_actor,owner_only,scan_status,scan_detail,created_at,attachment_json from replacement_register.artifacts where artifact_id=any($1::uuid[])`,[ids])).rows.map(row=>[row.artifact_id,fromRow(row)]));}
  };
}

function localSource(items,options,context,limits){
  const ids=new Map();for(const item of items){if(ids.has(item.artifactId))throw stateInvalid();ids.set(item.artifactId,item);}
  const focus=options.documentArtifactId&&ids.get(options.documentArtifactId),group=item=>item.logicalKey||item.artifactId;
  const ordered=items.filter(item=>!options.documentArtifactId||focus&&group(item)===group(focus)).sort(compareItems);
  const index=new Map(ordered.map((item,position)=>[item.artifactId,position])),tops=new Map();for(const item of ordered)if(!tops.has(group(item)))tops.set(group(item),Number(item.version));
  const summary=item=>({artifact_id:item.artifactId,version:Number(item.version),kind:item.kind,module_id:item.moduleId,owner_user_id:item.ownerUserId,owner_actor:item.ownerActor,owner_only:Boolean(item.ownerOnly),scan_status:item.scanStatus,report_owner_role:item.scope?.reportOwnerRole,products_empty:Array.isArray(item.scope?.productDecimalNos)?item.scope.productDecimalNos.length===0:null,proposals_empty:Array.isArray(item.scope?.proposalIds)?item.scope.proposalIds.length===0:null,attachment_present:Boolean(item.attachmentMetadata),attachment_role:item.attachmentMetadata?.attachmentRole,confidentiality:item.attachmentMetadata?.confidentiality,acl_bytes:bytes([item.scope?.orderNos,item.scope?.suppliers])+2048+6*[item.kind,item.moduleId,item.ownerActor,item.scanStatus,item.scope?.reportOwnerRole,item.attachmentMetadata?.attachmentRole,item.attachmentMetadata?.confidentiality].reduce((sum,value)=>sum+Buffer.byteLength(String(value??'')),0),filter_matches:fullMatches(item,options),group_top_version:tops.get(group(item))});
  return {
    async focus(access){if(options.documentArtifactId&&(!focus||!visibleKind(focus)||!access(context,focus)))throw notFound();},
    async anchor(position){if(position&&(!index.has(position.a)||tops.get(group(ids.get(position.a)))!==position.t))throw changed();},
    async candidates(position,count){const start=position?index.get(position.a)+1:0;return ordered.slice(start,start+count).map((item,offset)=>({...summary(item),same_group:start+offset>0&&group(ordered[start+offset-1])===group(item)}));},
    async acl(selected){return new Map(selected.map(id=>[id,{...summary(ids.get(id)),order_nos:ids.get(id).scope?.orderNos,suppliers:ids.get(id).scope?.suppliers}]));},
    async sizes(selected){return new Map(selected.map(id=>[id,bytes(ids.get(id))+2048]));},
    async full(selected){return new Map(selected.map(id=>[id,structuredClone(ids.get(id))]));}
  };
}

export async function readFileLibraryPage({repository,input,context,access,fromRow,publicItem,limits=FILE_LIBRARY_PAGE_LIMITS}){
  const pagePool=repository.pagePool===undefined?repository.pool:repository.pagePool;
  const options=fileLibraryPageOptions(input),binding=bindingFor(context,options,{driver:pagePool?'postgres':'local',root:repository.root}),initial=options.cursor?decode(options.cursor,binding):null;
  const client=pagePool?await pagePool.connect():null;
  let complete=false;
  try{
    if(client)await client.query('begin isolation level repeatable read read only');else await repository.queue;
    const source=client?await sqlSource(client,options,context,limits,fromRow):localSource(await repository.localCatalog(),options,context,limits);
    await source.focus(access);await source.anchor(initial);
    let position=initial,rowsRead=0,aclBytes=0,hasMore=false,scanLimited=false;
    const selected=[];
    while(selected.length<options.limit&&rowsRead<limits.maxCandidateRows&&aclBytes<limits.maxCandidateBytes){
      const batchSize=Math.min(limits.candidateBatch,limits.maxCandidateRows-rowsRead),batch=await source.candidates(position,batchSize);
      if(!batch.length){hasMore=false;break;}
      const candidates=[];let byteLimited=false;
      for(const row of batch){const cost=Number(row.acl_bytes);if(!Number.isSafeInteger(cost)||cost<0)throw stateInvalid();if(cost>limits.maxCandidateRowBytes)throw tooLarge();if(aclBytes+cost>limits.maxCandidateBytes){byteLimited=true;break;}candidates.push(row);aclBytes+=cost;}
      if(!candidates.length){hasMore=true;scanLimited=true;break;}
      const acl=await source.acl(candidates.map(row=>row.artifact_id));
      let processed=0;
      for(const row of candidates){
        const before=position,top=Number(row.group_top_version);if(!Number.isSafeInteger(top))throw stateInvalid();
        const head=row.same_group===true?(position?.h||null):null;
        const metadata=acl.get(row.artifact_id)||{},item=minimalItem({...row,...metadata},metadata),allowed=visibleKind(item)&&access(context,item);
        const isHead=allowed&&item.kind==='ATTACHMENT'&&!head,canReplace=isHead&&replaceAllowed(item,context)&&(context.role==='ADMINISTRATOR'||item.attachmentMetadata?.confidentiality!=='ADMINISTRATORS');
        position={a:row.artifact_id,h:isHead?row.artifact_id:head,t:top};rowsRead++;processed++;
        if(allowed&&row.filter_matches===true&&(options.mode==='files'||canReplace))selected.push({id:row.artifact_id,before,after:position,...(item.kind==='ATTACHMENT'?{libraryState:{isVisibleHead:isHead,canReplace}}:{})});
        if(selected.length===options.limit)break;
      }
      hasMore=processed<batch.length||batch.length===batchSize;
      if(selected.length===options.limit)break;
      if(byteLimited){hasMore=true;scanLimited=true;break;}
      if(batch.length<batchSize){hasMore=false;break;}
      if(rowsRead===limits.maxCandidateRows||aclBytes===limits.maxCandidateBytes){scanLimited=true;hasMore=true;break;}
    }
    let accepted=selected,pageBytes=4096;
    if(selected.length){
      const sizes=await source.sizes(selected.map(item=>item.id));accepted=[];
      for(const item of selected){const size=sizes.get(item.id);if(!Number.isSafeInteger(size)||size<0)throw stateInvalid();if(size>limits.maxItemBytes)throw tooLarge();if(pageBytes+size>limits.maxPageBytes){if(!accepted.length)throw tooLarge();position=item.before;hasMore=true;scanLimited=true;break;}accepted.push(item);pageBytes+=size;}
    }
    const full=accepted.length?await source.full(accepted.map(item=>item.id)):new Map(),items=[];
    for(const entry of accepted){const item=full.get(entry.id);if(!item||!visibleKind(item)||!access(context,item)||!fullMatches(item,options))throw changed();items.push({...publicItem(item),...(entry.libraryState?{libraryState:entry.libraryState}:{})});}
    const response={items,nextCursor:hasMore&&position?encode(binding,position):null,scanLimited:Boolean(scanLimited),order:FILE_LIBRARY_ORDER,headContract:FILE_LIBRARY_HEAD_CONTRACT};
    if(bytes(response)>limits.maxPageBytes)throw tooLarge();
    if(client)await client.query('commit');complete=true;return response;
  }finally{if(client){if(!complete)await client.query('rollback').catch(()=>{});client.release();}}
}
