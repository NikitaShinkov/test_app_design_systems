import {replacePrivateFile} from './atomic-file.js';
import {auditEventProvenance} from './audit-writer.js';
import {serializeAuditEnvelope} from './audit-provenance.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { httpError,lockNamedReleaseAccount,currentNamedReleaseContext } from './auth.js';
import { canUseModule, moduleFor } from './workflow.js';
import {normalize} from './normalization.js';
import {validateAttachment} from './attachment-policy.js';
import {attachmentVersionPlan,attachmentLogicalKey} from './attachment-metadata.js';
import {checkObjectStorageSpace,storageAdmissionLimits} from './storage-admission.js';
import {reportModule,registerReportArtifactOwner,registerReportPublicScope} from './register-report-access.js';
import {validateBomProjection,publishBomProjection,projectionSummary,assertSameBomProjection,bomPageOptions,sourceBomId,bomRowSearchMatches} from './bom-catalog.js';
import {readFileLibraryPage} from './file-library-pages.js';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const kinds = new Set(['ATTACHMENT','ORIGINAL_BOM','WORKFLOW_INPUT','WORKFLOW_OUTPUT']);
const unique = values => [...new Set((values || []).map(String).filter(Boolean))].sort();
function versionScope(key) {try{const value=JSON.parse(key);return value.scope==='ORDER_ROUND'?value:null;}catch{return null;}}
function versionBaseline(entries,key,scope) {
  let maximum=0;
  for(const [candidate,version] of entries){if(candidate===key){maximum=Math.max(maximum,Number(version));continue;}if(!scope)continue;try{const previous=JSON.parse(candidate);if(previous.moduleId===scope.moduleId&&JSON.stringify(previous.orders)===JSON.stringify(scope.orders)&&previous.round===scope.round)maximum=Math.max(maximum,Number(version));}catch{}}
  return maximum;
}
export function safeFilename(value) {
  const name = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,180);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name==='.' || name==='..') throw httpError(422,'Choose a valid file name.');
  return name;
}
export function artifactAccess(context, artifact) {
  if (context.role==='ADMINISTRATOR') return true;
  const reportOwner=registerReportArtifactOwner(context,artifact);if(reportOwner===false)return false;if(reportOwner==='EMPTY')return true;
  if(artifact.attachmentMetadata?.confidentiality==='ADMINISTRATORS')return false;
  const scope = artifact.scope;
  if (artifact.ownerOnly && reportOwner===null && artifact.ownerUserId !== context.userId) return false;
  if (context.authenticated && (!scope.orderNos.length || !scope.orderNos.every(order => context.orders?.some(assigned=>normalize(assigned)===normalize(order))))) return false;
  if (context.authenticated && context.role==='SUPPLIER' && (!normalize(context.organization)||!scope.suppliers.length || scope.suppliers.some(supplier => normalize(supplier)!==normalize(context.organization)))) return false;
  if (artifact.moduleId && artifact.kind!=='ORIGINAL_BOM' && !canUseModule(moduleFor(artifact.moduleId),context.role)) return false;
  return true;
}
export async function scanWithClamAV(bytes, {host=process.env.RR_CLAMAV_HOST||'127.0.0.1',port=Number(process.env.RR_CLAMAV_PORT||3310),socketPath=process.env.RR_CLAMAV_SOCKET,timeout=20000,signal}={}) {
  return new Promise(resolve => {
    if(signal?.aborted){resolve({status:'ERROR',detail:'Antivirus verification was cancelled.'});return;}
    const socket = net.createConnection(socketPath ? {path:socketPath} : {host,port});
    let result = ''; let finished=false;
    const cancelled=()=>finish('ERROR','Antivirus verification was cancelled.');
    const finish = (status,detail) => { if (finished) return; finished=true;signal?.removeEventListener('abort',cancelled); socket.destroy(); resolve({status,detail}); };
    signal?.addEventListener('abort',cancelled,{once:true});if(signal?.aborted){cancelled();return;}
    socket.setTimeout(timeout,()=>finish('ERROR','Antivirus service timed out.'));
    socket.on('error',()=>finish('ERROR','Antivirus service is unavailable.'));
    socket.on('data',chunk=>{ result+=chunk.toString(); if(result.includes('\0')||result.includes('\n')) {
      if(/:\s*OK\s*[\0\n]/.test(result)) finish('CLEAN','ClamAV: clean');
      else if(/ FOUND/.test(result)) finish('INFECTED','ClamAV reported an infected upload.');
      else finish('ERROR','Antivirus could not verify this upload.');
    }});
    socket.on('end',()=>{if(!finished) finish('ERROR','Antivirus returned an incomplete response.');});
    socket.on('connect',async()=>{
      try {
        socket.write('zINSTREAM\0');
        for(let offset=0;offset<bytes.length;offset+=65536) {
          const chunk=bytes.subarray(offset,offset+65536); const length=Buffer.alloc(4);length.writeUInt32BE(chunk.length);
          if(!socket.write(Buffer.concat([length,chunk]))) await new Promise((resolve,reject)=>{
            const cleanup=()=>{socket.off('drain',drained);socket.off('error',failed);socket.off('close',closed);};
            const drained=()=>{cleanup();resolve();}; const failed=error=>{cleanup();reject(error);}; const closed=()=>failed(new Error('Scanner closed'));
            socket.once('drain',drained);socket.once('error',failed);socket.once('close',closed);
          });
        }
        socket.write(Buffer.alloc(4));
      } catch {finish('ERROR','Antivirus transfer failed.');}
    });
  });
}
function fromRow(row) {
  return {artifactId:row.artifact_id,logicalKey:row.logical_key,version:row.version,sha256:row.sha256,filename:row.filename,contentType:row.content_type,bytes:Number(row.bytes),kind:row.kind,moduleId:row.module_id,scope:row.scope_json,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,ownerOnly:row.owner_only,scanStatus:row.scan_status,scanDetail:row.scan_detail,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,...(row.attachment_json?{attachmentMetadata:row.attachment_json}:{})};
}
const scanGenerationSql=`coalesce((select max(e.id) from replacement_register.audit_events e where e.subject=a.artifact_id::text and e.action in ('FILE_RESCANNED','FILE_SCAN_COMPLETED')),0)::text as scan_generation`;
const localScanGeneration=(state,id)=>String(state.events.filter(event=>event.subject===id&&['FILE_RESCANNED','FILE_SCAN_COMPLETED'].includes(event.action)).reduce((maximum,event)=>Math.max(maximum,event.sequence||0),0));
const bomIndexAudit=(item,entry,preparationId)=>({after:{artifactId:item.artifactId,projectionHash:entry.projectionHash,rowCount:entry.projection.rows.length,sourceSha256:item.sha256,sourceBytes:item.bytes,metadata:entry.projection.metadata,sourceMetadata:entry.projection.sourceMetadata,...(preparationId?{preparationId}:{})}});
function fileAudit(context,action,item,{before=null,after=null,detail=''}={},auditRuntime=null) {return {id:randomUUID(),occurredAt:new Date().toISOString(),actor:context.actor||'Local administrator',actorUserId:context.userId||null,requestId:context.requestId||null,role:context.role||'ADMINISTRATOR',action,subject:item.artifactId,detail:detail||`${item.filename}; version ${item.version}; ${item.sha256}; ${item.scanStatus}`,before,after,provenance:auditEventProvenance(context,auditRuntime)};}
export class ArtifactRepository {
  constructor(root,{pool=null,pagePool=pool,preview=false,scanner=scanWithClamAV,maxBytes=30*1024*1024,storageLimits=storageAdmissionLimits(process.env),checkSpace=checkObjectStorageSpace,auditRuntime=null}={}) {
    this.root=path.resolve(root);this.pool=pool;this.pagePool=pagePool;this.preview=preview;this.scanner=scanner;this.storageLimits=storageLimits;this.checkSpace=checkSpace;this.maxBytes=Math.min(maxBytes,storageLimits.maxObjectBytes);this.queue=Promise.resolve();
    this.auditRuntime=auditRuntime;
  }
  objectPath(hash) { if(!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid content hash'); return path.join(this.root,'objects',hash.slice(0,2),hash); }
  async localState() {try{const value=JSON.parse(await fs.readFile(path.join(this.root,'catalog.json'),'utf8'));if(Array.isArray(value))return {formatVersion:2,items:value,events:[],boms:{}};if(value.formatVersion!==2||!Array.isArray(value.items)||!Array.isArray(value.events)||value.boms!==undefined&&(!value.boms||typeof value.boms!=='object'||Array.isArray(value.boms)))throw new Error('Invalid local file catalog. Restore a verified catalog before continuing.');return {...value,boms:value.boms||{}};}catch(error){if(error.code==='ENOENT')return {formatVersion:2,items:[],events:[],boms:{}};throw error;}}
  async localCatalog(){return (await this.localState()).items;}
  async listAuditEvents(){await this.queue;return structuredClone((await this.localState()).events);}
  async writeAudit(client,context,action,item,values={}) {const event=fileAudit(context,action,item,values,this.auditRuntime);await client.query('insert into replacement_register.audit_events(actor,actor_role,action,subject,detail,before_json,after_json,actor_user_id,request_id,provenance_json,occurred_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,clock_timestamp())',[event.actor,event.role,event.action,event.subject,event.detail,event.before,event.after,event.actorUserId,event.requestId,serializeAuditEnvelope(event.provenance)]);}
  addLocalAudit(state,context,action,item,values={}){const event={...fileAudit(context,action,item,values,this.auditRuntime),sequence:(state.events.at(-1)?.sequence||0)+1};state.events.push(event);return event;}
  async exportVersion(key,{reserve=false,expected,transaction=null,reservationId=null}={}) {
    const scope=versionScope(key);const check=version=>{if(reserve&&expected!==undefined&&Number(expected)!==version)throw httpError(409,'An export was issued after this filename review. Reopen export settings to review the current filenames.',{code:'EXPORT_VERSION_CHANGED',details:[`Reviewed version ${expected}; next available version ${version}. No new number was issued.`]});};
    if(this.pool) {
      if(scope) {
        const client=transaction||(reserve?await this.pool.connect():this.pool);
        try {
          if(reserve){if(!transaction)await client.query('begin');await client.query('select pg_advisory_xact_lock(78742005)');}
          const prefix=JSON.stringify({moduleId:scope.moduleId,orders:scope.orders}).slice(0,-1)+',';
          const rows=(await client.query('select export_key,last_version from replacement_register.export_sequences where export_key like $1',[prefix.replace(/[\\%_]/g,'\\$&')+'%'])).rows;
          const version=versionBaseline(rows.map(row=>[row.export_key,row.last_version]),key,scope)+1;check(version);
          if(reserve){await client.query('insert into replacement_register.export_sequences(export_key,last_version) values($1,$2) on conflict(export_key) do update set last_version=excluded.last_version',[key,version]);if(!transaction)await client.query('commit');}
          return version;
        }catch(error){if(reserve&&!transaction)await client.query('rollback');throw error;}finally{if(reserve&&!transaction)client.release();}
      }
      if(transaction&&reserve){await transaction.query('select pg_advisory_xact_lock(78742005)');const prior=(await transaction.query('select last_version from replacement_register.export_sequences where export_key=$1',[key])).rows[0]?.last_version||0;const version=prior+1;check(version);await transaction.query('insert into replacement_register.export_sequences(export_key,last_version) values($1,$2) on conflict(export_key) do update set last_version=excluded.last_version',[key,version]);return version;}
      if(reserve)return (await this.pool.query('insert into replacement_register.export_sequences(export_key,last_version) values($1,1) on conflict(export_key) do update set last_version=export_sequences.last_version+1 returning last_version',[key])).rows[0].last_version;
      return ((await this.pool.query('select last_version from replacement_register.export_sequences where export_key=$1',[key])).rows[0]?.last_version||0)+1;
    }
    const task=this.queue.then(async()=>{
      await fs.mkdir(this.root,{recursive:true,mode:0o700});const filename=path.join(this.root,'export-sequences.json');let sequences={};
      try{sequences=JSON.parse(await fs.readFile(filename,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(reserve&&reservationId&&sequences.__exportJobs?.[reservationId]){const prior=sequences.__exportJobs[reservationId];if(prior.key!==key)throw httpError(409,'This export reservation belongs to different settings.');return prior.version;}
      const version=versionBaseline(Object.entries(sequences),key,scope)+1;check(version);
      if(reserve){sequences[key]=version;if(reservationId){sequences.__exportJobs||={};sequences.__exportJobs[reservationId]={key,version};}await replacePrivateFile(filename,JSON.stringify(sequences));}
      return version;
    });this.queue=task.catch(()=>{});return task;
  }
  async writeCatalog(items,events=null,boms=null) {await fs.mkdir(this.root,{recursive:true,mode:0o700});const prior=events===null||boms===null?await this.localState():null;await replacePrivateFile(path.join(this.root,'catalog.json'),JSON.stringify({formatVersion:2,items,events:events??prior.events,...(Object.keys(boms??prior.boms).length?{boms:boms??prior.boms}:{})}));}
  async all() {if(this.pool)return (await this.pool.query('select * from replacement_register.artifacts order by created_at desc,version desc')).rows.map(fromRow);await this.queue;return (await this.localCatalog()).reverse();}
  async list(context,{kind,moduleId,orderNo,productDecimalNo}={}) {return (await this.all()).filter(item=>!(item.moduleId===reportModule&&item.kind==='WORKFLOW_INPUT')&&artifactAccess(context,item)&&(!kind||item.kind===kind)&&(!moduleId||item.moduleId===moduleId)&&(!orderNo||item.scope.orderNos.includes(orderNo))&&(!productDecimalNo||item.scope.productDecimalNos.includes(productDecimalNo))).map(item=>item.moduleId===reportModule?{...item,scope:registerReportPublicScope(item.scope)}:item);}
  async page(context,input={}) {return readFileLibraryPage({repository:this,input,context,access:artifactAccess,fromRow,publicItem:item=>item.moduleId===reportModule?{...item,scope:registerReportPublicScope(item.scope)}:item});}
  async get(id,context) {
    let item;
    if(this.pool){
      // PostgreSQL returns canonical lowercase UUID text. Preserve the exact
      // ID comparison of the previous catalog lookup, including its 404s.
      if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw httpError(404,'File not found.');
      const row=(await this.pool.query('select artifact_id,logical_key,version,sha256,filename,content_type,bytes,kind,module_id,scope_json,owner_user_id,owner_actor,owner_only,scan_status,scan_detail,created_at,attachment_json from replacement_register.artifacts where artifact_id=$1',[id])).rows[0];
      item=row?fromRow(row):null;
    }else item=(await this.all()).find(value=>value.artifactId===id);
    if(!item||!artifactAccess(context,item))throw httpError(404,'File not found.');return item;
  }
  async getBom(id,context,{transaction=null}={}) {
    if(!sourceBomId(id))throw httpError(404,'Original BOM not found.',{code:'BOM_NOT_FOUND'});
    if(this.pool){const row=(await (transaction||this.pool).query('select a.*,b.summary_json,b.projection_hash from replacement_register.artifacts a left join replacement_register.source_boms b using(artifact_id) where a.artifact_id=$1 and a.kind=\'ORIGINAL_BOM\'',[id])).rows[0],item=row&&fromRow(row);if(!item||!artifactAccess(context,item))throw httpError(404,'Original BOM not found.',{code:'BOM_NOT_FOUND'});return row.summary_json?{...item,...row.summary_json,indexed:true,projectionHash:row.projection_hash}:{...item,indexed:false,rowCount:null};}
    await this.queue;const state=await this.localState(),item=state.items.find(row=>row.artifactId===id&&row.kind==='ORIGINAL_BOM');if(!item||!artifactAccess(context,item))throw httpError(404,'Original BOM not found.',{code:'BOM_NOT_FOUND'});return projectionSummary(item,state.boms[id]);
  }
  async listBoms(context,filters={}, {transaction=null}={}) {
    const options=bomPageOptions(filters),eligible=item=>artifactAccess(context,item)&&(!options.orderNo||item.scope.orderNos.includes(options.orderNo))&&(!options.supplier||item.scope.suppliers.includes(options.supplier))&&(!options.productDecimalNo||item.scope.productDecimalNos.includes(options.productDecimalNo));
    if(!this.pool){await this.queue;const state=await this.localState(),items=state.items.filter(item=>item.kind==='ORIGINAL_BOM'&&(!options.cursor||item.artifactId>options.cursor)&&eligible(item)).map(item=>projectionSummary(item,state.boms[item.artifactId])).sort((a,b)=>a.artifactId.localeCompare(b.artifactId));return {items:items.slice(0,options.limit),nextCursor:items.length>options.limit?items[options.limit-1].artifactId:null};}
    const selected=[],client=transaction||this.pool;let cursor=options.cursor;
    // Scope equivalence uses the same JavaScript canonical algorithm as every
    // artifact read. Scan bounded metadata pages, never materialize source rows
    // or all unauthorized file payloads to construct one authorized page.
    while(selected.length<=options.limit){
      const params=[cursor],where=["a.kind='ORIGINAL_BOM'",'($1::uuid is null or a.artifact_id>$1::uuid)'];
      for(const [key,scope] of [['orderNo','orderNos'],['supplier','suppliers'],['productDecimalNo','productDecimalNos']])if(options[key]){params.push(options[key]);where.push(`a.scope_json->'${scope}' @> jsonb_build_array($${params.length}::text)`);}
      const rows=(await client.query(`select a.*,b.summary_json,b.projection_hash from replacement_register.artifacts a left join replacement_register.source_boms b using(artifact_id) where ${where.join(' and ')} order by a.artifact_id limit 100`,params)).rows;
      for(const row of rows){const item=fromRow(row);if(eligible(item))selected.push(row.summary_json?{...item,...row.summary_json,indexed:true,projectionHash:row.projection_hash}:{...item,indexed:false,rowCount:null});if(selected.length>options.limit)break;}
      if(rows.length<100||selected.length>options.limit)break;cursor=rows.at(-1).artifact_id;
    }
    return {items:selected.slice(0,options.limit),nextCursor:selected.length>options.limit?selected[options.limit-1].artifactId:null};
  }
  async assertBomReadable(id,context,{transaction=null}={}) {
    const item=await this.getBom(id,context,{transaction});
    if(!['CLEAN','GENERATED'].includes(item.scanStatus)&&!(this.preview&&item.scanStatus==='ERROR'))throw httpError(423,'Complete antivirus verification before viewing source BOM rows.',{code:'FILE_QUARANTINED'});
    if(await this.infectedContent(item.sha256,transaction||this.pool))throw httpError(423,'This source BOM has quarantined content with an infection finding.',{code:'FILE_CONTENT_QUARANTINED'});
    return item;
  }
  async listBomRows(id,context,filters={}, {transaction=null}={}) {
    const options=bomPageOptions(filters,true);if(Object.keys(filters).some(key=>!['limit','cursor','q'].includes(key)))throw httpError(422,'Unsupported BOM row filter.',{code:'BOM_FILTER_INVALID'});
    const item=await this.assertBomReadable(id,context,{transaction});if(!item.indexed)throw httpError(409,'Register this source workbook again to create its inspectable source rows.',{code:'BOM_NOT_INDEXED'});
    let rows;
    if(this.pool){
      const client=transaction||this.pool;
      const page=async(after,limit)=>(await client.query('select row_json from replacement_register.source_bom_rows where artifact_id=$1 and source_row>$2 order by source_row limit $3',[id,after,limit])).rows.map(row=>row.row_json);
      let after=options.cursor?Number(options.cursor):0;
      if(!options.q)rows=await page(after,options.limit+1);
      else{
        // Database collations differ in their Unicode case mappings. Use the
        // same source-value matcher as local review, keeping SQL pages bounded.
        rows=[];
        for(;;){
          const candidates=await page(after,100);
          for(const row of candidates){if(bomRowSearchMatches(row,options.q))rows.push(row);if(rows.length>options.limit)break;}
          if(candidates.length<100||rows.length>options.limit)break;
          after=candidates.at(-1).sourceRow;
        }
      }
    }
    else{await this.queue;const state=await this.localState();rows=state.boms[id].projection.rows.filter(row=>(!options.cursor||row.sourceRow>Number(options.cursor))&&(!options.q||bomRowSearchMatches(row,options.q))).slice(0,options.limit+1);}
    return {items:rows.slice(0,options.limit),nextCursor:rows.length>options.limit?String(rows[options.limit-1].sourceRow):null};
  }
  async read(item,{internal=false,transaction=null}={}) {
    if(!internal && !['CLEAN','GENERATED'].includes(item.scanStatus) && !(this.preview&&item.scanStatus==='ERROR')) throw httpError(423,`File '${item.filename}' is quarantined (verification: ${item.scanStatus}). An administrator must complete antivirus verification before it can be downloaded.`,{code:'FILE_QUARANTINED'});
    if(!internal) {
      const infected=this.pool?(await (transaction||this.pool).query("select 1 from replacement_register.artifacts where sha256=$1 and scan_status='INFECTED' limit 1",[item.sha256])).rowCount:(await this.localCatalog()).some(row=>row.sha256===item.sha256 && row.scanStatus==='INFECTED');
      if(infected)throw httpError(423,`File '${item.filename}' has quarantined content: antivirus reported the same SHA-256 as infected. An administrator must verify every affected version before download.`,{code:'FILE_CONTENT_QUARANTINED'});
    }
    let bytes;try{bytes=await fs.readFile(this.objectPath(item.sha256));}catch(error){if(error.code!=='ENOENT')throw error;throw httpError(409,`Stored file '${item.filename}' is missing. Contact an administrator before continuing.`,{code:'FILE_OBJECT_MISSING'});}
    if(bytes.length!==item.bytes||digest(bytes)!==item.sha256)throw httpError(409,`Stored file '${item.filename}' failed its integrity check.`,{code:'FILE_INTEGRITY_FAILED'});
    return bytes;
  }
  async writeObject(bytes) {
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>this.maxBytes)throw httpError(413,`Choose a non-empty file no larger than ${Math.floor(this.maxBytes/1024/1024)} MB.`);
    const sha256=digest(bytes);const target=this.objectPath(sha256);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
    const syncParent=async()=>{if(process.platform==='win32')return;const directory=await fs.open(path.dirname(target),'r');try{await directory.sync();}finally{await directory.close();}};
    const check=async()=>{const existing=await fs.readFile(target);if(existing.length!==bytes.length||digest(existing)!==sha256)throw httpError(409,'Stored file integrity check failed. Contact an administrator.',{code:'FILE_INTEGRITY_FAILED'});};
    try{await check();await syncParent();return {sha256,bytes:bytes.length};}catch(error){if(error.code!=='ENOENT')throw error;}
    await this.checkSpace(path.dirname(target),bytes.length,{limits:this.storageLimits});
    // Publish only a completely written object. Concurrent identical uploads
    // cannot observe an empty/partially written final object or overwrite it.
    const temporary=`${target}.${randomUUID()}.tmp`;
    try{await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600,flush:true});try{await fs.link(temporary,target);}catch(error){if(error.code!=='EEXIST')throw error;await check();}await syncParent();}
    catch(error){if(['ENOSPC','EDQUOT'].includes(error.code))throw httpError(507,'File storage is full. Ask an administrator to free or expand the controlled file store before retrying.',{code:'FILE_STORAGE_RESERVE'});throw error;}
    finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    return {sha256,bytes:bytes.length};
  }
  async readObject(item) {let bytes;try{bytes=await fs.readFile(this.objectPath(item.sha256));}catch(error){if(error.code!=='ENOENT')throw error;throw httpError(409,`Prepared file '${item.filename||item.sha256}' is missing. Reopen export settings or contact an administrator.`,{code:'EXPORT_OBJECT_MISSING'});}if(bytes.length!==item.bytes||digest(bytes)!==item.sha256)throw httpError(409,`Prepared file '${item.filename||item.sha256}' failed its integrity check.`,{code:'EXPORT_OBJECT_INVALID'});return bytes;}
  async put(bytes,metadata,context,{generated=false,scan:checkedScan,transaction=null,reusePendingInput=false,preparationId=null}={}) {
    if(preparationId!==null&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(preparationId))throw new Error('Invalid file preparation association.');
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>this.maxBytes)throw httpError(413,`Choose a non-empty file no larger than ${Math.floor(this.maxBytes/1024/1024)} MB.`);
    if(!kinds.has(metadata.kind))throw httpError(422,'Invalid file category.');
    const filename=safeFilename(metadata.filename);const scope={orderNos:unique(metadata.scope?.orderNos),suppliers:unique(metadata.scope?.suppliers),productDecimalNos:unique(metadata.scope?.productDecimalNos),proposalIds:unique(metadata.scope?.proposalIds)};
    if(metadata.moduleId===reportModule){if(!generated||metadata.ownerOnly!==true||metadata.scope?.reportOwnerRole!==context.role)throw httpError(422,'Register reports require a generated, private role-bound artifact.',{code:'REGISTER_REPORT_SCOPE_INVALID'});scope.reportOwnerRole=context.role;}
    if(!scope.orderNos.length)throw httpError(422,'A file must be linked to an order.');
    let attachmentMetadata=null,canonicalContentType=metadata.contentType;
    if(metadata.kind==='ATTACHMENT'){
      const supplied=metadata.attachmentMetadata||{};
      const validated=await validateAttachment(bytes,{filename,contentType:metadata.contentType,role:supplied.role||supplied.attachmentRole,description:supplied.description,confidentiality:supplied.confidentiality,supersedesArtifactId:supplied.supersedesArtifactId},context);
      const {filename:checkedFilename,contentType,...values}=validated;attachmentMetadata=values;canonicalContentType=contentType;
    }
    const {sha256}=await this.writeObject(bytes);
    const scan=generated?{status:'GENERATED',detail:'Generated by Replacement Register'}:checkedScan||await this.scanner(bytes);
    if(!['CLEAN','ERROR','INFECTED','PENDING'].includes(scan.status)&&scan.status!=='GENERATED')throw new Error('Invalid scanner result');
    const {proposalIds,...documentScope}=scope;
    let logicalKey=metadata.logicalKey||`${metadata.kind}:${metadata.moduleId||''}:${JSON.stringify(metadata.kind==='ATTACHMENT'?scope:documentScope)}:${filename.toLowerCase().replace(/_v\d+(?=\.[^.]+$)/,'')}:${metadata.ownerOnly?context.userId||context.actor:''}`;
    if(attachmentMetadata)logicalKey=attachmentLogicalKey(metadata.kind,metadata.moduleId,scope,filename,metadata.ownerOnly?context.userId||context.actor:'',attachmentMetadata);
    const item={artifactId:randomUUID(),logicalKey,sha256,filename,contentType:canonicalContentType||'application/octet-stream',bytes:bytes.length,kind:metadata.kind,moduleId:metadata.moduleId||null,scope,ownerUserId:context.userId||null,ownerActor:context.actor||'Local administrator',ownerOnly:Boolean(metadata.ownerOnly),scanStatus:scan.status,scanDetail:scan.detail,createdAt:new Date().toISOString(),...(attachmentMetadata?{attachmentMetadata}:{})};
    const bomEntry=metadata.bomProjection?validateBomProjection(item,metadata.bomProjection):null;
    if(this.pool) {
      const client=transaction||await this.pool.connect();
      try {
        if(!transaction)await client.query('begin');await client.query('select pg_advisory_xact_lock(78742004)');
        if(attachmentMetadata?.supersedesArtifactId){const parent=(await client.query('select * from replacement_register.artifacts where artifact_id=$1',[attachmentMetadata.supersedesArtifactId])).rows[0];if(!parent||!artifactAccess(context,fromRow(parent)))throw httpError(404,'Attachment version not found.',{code:'ATTACHMENT_PARENT_UNAVAILABLE'});logicalKey=parent.logical_key;item.logicalKey=logicalKey;}
        const versions=(await client.query('select * from replacement_register.artifacts where logical_key=$1 order by version',[logicalKey])).rows;
        const prior=versions.at(-1);
        const attachmentPlan=attachmentMetadata?attachmentVersionPlan(item,versions.map(fromRow),attachmentMetadata.supersedesArtifactId,context,artifactAccess):null;
        if(attachmentPlan)item.attachmentMetadata={...attachmentMetadata,supersedesArtifactId:attachmentPlan.parentId};
        const exact=metadata.version===undefined?prior:(await client.query('select * from replacement_register.artifacts where logical_key=$1 and version=$2',[logicalKey,metadata.version])).rows[0];
        const previousBom=exact&&bomEntry?(await client.query('select projection_hash from replacement_register.source_boms where artifact_id=$1',[exact.artifact_id])).rows[0]:null;
        const sameBom=!previousBom||previousBom.projection_hash===bomEntry.projectionHash;
        if(exact&&exact.sha256===sha256&&sameBom&&(!attachmentPlan||attachmentPlan.duplicate)&&(exact.scan_status===scan.status||(reusePendingInput&&['WORKFLOW_INPUT','ATTACHMENT'].includes(metadata.kind)&&scan.status==='PENDING'))){const retained=fromRow(exact);if(bomEntry&&await publishBomProjection(client,retained,bomEntry.projection))await this.writeAudit(client,context,'SOURCE_BOM_INDEXED',retained,bomIndexAudit(retained,bomEntry,preparationId));if(preparationId)await this.writeAudit(client,context,'FILE_PREPARATION_LINKED',retained,{after:{...retained,preparationId},detail:`${retained.filename}; retained version associated with preparation ${preparationId}`});if(!transaction)await client.query('commit');return {...retained,duplicate:true};}
        if(exact&&metadata.version!==undefined)throw httpError(409,'This issued file version already contains different content.',{code:'FILE_VERSION_CONFLICT'});
        item.version=metadata.version??((prior?.version||0)+1);
        await client.query('insert into replacement_register.artifacts(artifact_id,logical_key,version,sha256,filename,content_type,bytes,kind,module_id,scope_json,owner_user_id,owner_actor,owner_only,scan_status,scan_detail,attachment_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[item.artifactId,logicalKey,item.version,sha256,filename,item.contentType,item.bytes,item.kind,item.moduleId,scope,item.ownerUserId,item.ownerActor,item.ownerOnly,item.scanStatus,item.scanDetail,item.attachmentMetadata||null]);
        if(bomEntry){await publishBomProjection(client,item,bomEntry.projection);await this.writeAudit(client,context,'SOURCE_BOM_INDEXED',item,bomIndexAudit(item,bomEntry,preparationId));}
        await this.writeAudit(client,context,'FILE_STORED',item,{after:{...item,...(preparationId?{preparationId}:{})}});
        if(!transaction)await client.query('commit');return item;
      }catch(error){if(!transaction)await client.query('rollback');throw error;}finally{if(!transaction)client.release();}
    }
    const task=this.queue.then(async()=>{
      const state=await this.localState(),items=state.items;
      if(attachmentMetadata?.supersedesArtifactId){const parent=items.find(row=>row.artifactId===attachmentMetadata.supersedesArtifactId);if(!parent||!artifactAccess(context,parent))throw httpError(404,'Attachment version not found.',{code:'ATTACHMENT_PARENT_UNAVAILABLE'});logicalKey=parent.logicalKey;item.logicalKey=logicalKey;}
      const versions=items.filter(prior=>prior.logicalKey===logicalKey).sort((a,b)=>a.version-b.version);const prior=versions.at(-1);const exact=metadata.version===undefined?prior:versions.find(row=>row.version===metadata.version);
      const attachmentPlan=attachmentMetadata?attachmentVersionPlan(item,versions,attachmentMetadata.supersedesArtifactId,context,artifactAccess):null;
      if(attachmentPlan)item.attachmentMetadata={...attachmentMetadata,supersedesArtifactId:attachmentPlan.parentId};
      const previousBom=exact&&bomEntry?state.boms[exact.artifactId]:null,sameBom=!previousBom||previousBom.projectionHash===bomEntry.projectionHash;
      if(exact?.sha256===sha256&&sameBom&&(!attachmentPlan||attachmentPlan.duplicate)&&(exact.scanStatus===scan.status||(reusePendingInput&&['WORKFLOW_INPUT','ATTACHMENT'].includes(metadata.kind)&&scan.status==='PENDING'))){let changed=false;if(bomEntry){assertSameBomProjection(state.boms[exact.artifactId],bomEntry);if(!state.boms[exact.artifactId]){state.boms[exact.artifactId]=bomEntry;this.addLocalAudit(state,context,'SOURCE_BOM_INDEXED',exact,bomIndexAudit(exact,bomEntry,preparationId));changed=true;}}if(preparationId){this.addLocalAudit(state,context,'FILE_PREPARATION_LINKED',exact,{after:{...exact,preparationId},detail:`${exact.filename}; retained version associated with preparation ${preparationId}`});changed=true;}if(changed)await this.writeCatalog(items,state.events,state.boms);return {...exact,duplicate:true};}
      if(exact&&metadata.version!==undefined)throw httpError(409,'This issued file version already contains different content.',{code:'FILE_VERSION_CONFLICT'});
      item.version=metadata.version??((prior?.version||0)+1);items.push(item);if(bomEntry){state.boms[item.artifactId]=bomEntry;this.addLocalAudit(state,context,'SOURCE_BOM_INDEXED',item,bomIndexAudit(item,bomEntry,preparationId));}this.addLocalAudit(state,context,'FILE_STORED',item,{after:{...structuredClone(item),...(preparationId?{preparationId}:{})}});await this.writeCatalog(items,state.events,state.boms);return item;
    });
    this.queue=task.catch(()=>{});return task;
  }
  async rescan(id,context) {
    if(context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can retry antivirus verification.');
    if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))throw httpError(404,'File not found.');
    const validate=item=>{if(!item||!artifactAccess(context,item))throw httpError(404,'File not found.');return item;};
    let item,generation;
    if(this.pool){const row=(await this.pool.query(`select a.*,${scanGenerationSql} from replacement_register.artifacts a where artifact_id=$1`,[id])).rows[0];item=validate(row?fromRow(row):null);generation=row.scan_generation;}
    else{const capture=this.queue.then(async()=>{const state=await this.localState();return {item:validate(state.items.find(row=>row.artifactId===id)),generation:localScanGeneration(state,id)};});this.queue=capture.catch(()=>{});({item,generation}=await capture);}
    if(item.scanStatus==='GENERATED')return item;
    const scan=await this.scanner(await this.read(item,{internal:true}));
    if(!['CLEAN','ERROR','INFECTED','PENDING'].includes(scan.status))throw new Error('Invalid scanner result');
    const update=(before,currentGeneration)=>{
      validate(before);
      if(before.sha256!==item.sha256||before.bytes!==item.bytes||before.kind!==item.kind||before.moduleId!==item.moduleId)throw httpError(409,'The retained file identity changed. Open its current version before verifying again.',{code:'FILE_SOURCE_CHANGED'});
      // A fresh infection always takes effect. Every other result must still
      // refer to the exact scan generation captured before the scanner ran,
      // including repeated infection findings with identical status/details.
      if(scan.status!=='INFECTED'&&currentGeneration!==generation)throw httpError(409,'File verification changed while this scan was running. Review the current verdict and retry verification.',{code:'FILE_SCAN_CHANGED'});
      return {...before,scanStatus:scan.status,scanDetail:scan.detail};
    };
    if(this.pool) {
      const client=await this.pool.connect();try{await client.query('begin');await client.query('select pg_advisory_xact_lock(78742004)');const row=(await client.query(`select a.*,${scanGenerationSql} from replacement_register.artifacts a where artifact_id=$1 for update of a`,[id])).rows[0],before=row?fromRow(row):null,after=update(before,row?.scan_generation);await client.query('update replacement_register.artifacts set scan_status=$2,scan_detail=$3 where artifact_id=$1',[id,scan.status,scan.detail]);await this.writeAudit(client,context,'FILE_RESCANNED',after,{before,after});await client.query('commit');return after;}catch(error){await client.query('rollback');throw error;}finally{client.release();}
    }
    const task=this.queue.then(async()=>{const state=await this.localState(),index=state.items.findIndex(row=>row.artifactId===id),before=state.items[index],after=update(before,localScanGeneration(state,id));state.items[index]=after;this.addLocalAudit(state,context,'FILE_RESCANNED',after,{before,after:structuredClone(after)});await this.writeCatalog(state.items,state.events);return after;});this.queue=task.catch(()=>{});return task;
  }
  async infectedContent(sha256,client=this.pool){return this.pool?(await client.query("select 1 from replacement_register.artifacts where sha256=$1 and scan_status='INFECTED' limit 1",[sha256])).rowCount>0:(await this.localCatalog()).some(item=>item.sha256===sha256&&item.scanStatus==='INFECTED');}
  async captureFileScan(id,context,{transaction=null}={}){
    if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw httpError(404,'File not found.');
    const validate=item=>{if(!item||!artifactAccess(context,item))throw httpError(404,'File not found.');return item;};
    if(this.pool){const row=(await (transaction||this.pool).query(`select a.*,${scanGenerationSql} from replacement_register.artifacts a where artifact_id=$1`,[id])).rows[0];return {item:validate(row?fromRow(row):null),generation:row.scan_generation};}
    const task=this.queue.then(async()=>{const state=await this.localState();return {item:validate(state.items.find(row=>row.artifactId===id)),generation:localScanGeneration(state,id)};});this.queue=task.catch(()=>{});return task;
  }
  async publishFileScan(capture,scan,context,{transaction=null,preparationId,administrative=false}={}){
    if(!capture?.item||typeof capture.generation!=='string'||!['CLEAN','ERROR','INFECTED'].includes(scan?.status)||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(preparationId||''))throw new Error('Invalid file scan publication.');
    if(administrative&&context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can retry antivirus verification.');
    const expected=capture.item,action=administrative?'FILE_RESCANNED':'FILE_SCAN_COMPLETED';
    const update=(before,generation)=>{
      if(!before||!artifactAccess(context,before))throw httpError(404,'File not found.');
      if(before.sha256!==expected.sha256||before.bytes!==expected.bytes||before.kind!==expected.kind||before.moduleId!==expected.moduleId)throw httpError(409,'The retained file identity changed.',{code:'FILE_SOURCE_CHANGED'});
      if(!administrative&&before.scanStatus==='INFECTED'&&scan.status!=='INFECTED')throw httpError(423,'An administrator must verify the infected file before this preparation can be retried.',{code:'FILE_QUARANTINED'});
      if(scan.status!=='INFECTED'&&generation!==capture.generation)throw httpError(409,'File verification changed while this scan was running. Review the current verdict and retry.',{code:'FILE_SCAN_CHANGED'});
      return {...before,scanStatus:scan.status,scanDetail:scan.detail};
    };
    if(this.pool){
      if(!transaction)throw new Error('SQL file scan publication requires the preparation lease transaction.');
      await transaction.query('select pg_advisory_xact_lock(78742004)');const row=(await transaction.query(`select a.*,${scanGenerationSql} from replacement_register.artifacts a where artifact_id=$1 for update of a`,[expected.artifactId])).rows[0],before=row?fromRow(row):null,after=update(before,row?.scan_generation);
      if(!administrative&&scan.status==='CLEAN'&&await this.infectedContent(after.sha256,transaction))throw httpError(423,'The same content has an infection finding. An administrator must verify every affected version.',{code:'FILE_CONTENT_QUARANTINED'});
      await transaction.query('update replacement_register.artifacts set scan_status=$2,scan_detail=$3 where artifact_id=$1',[after.artifactId,scan.status,scan.detail]);await this.writeAudit(transaction,context,action,after,{before,after:{...after,preparationId},detail:`${after.filename}; verification ${scan.status}; preparation ${preparationId}`});return after;
    }
    const task=this.queue.then(async()=>{const state=await this.localState(),index=state.items.findIndex(row=>row.artifactId===expected.artifactId),before=state.items[index],after=update(before,localScanGeneration(state,expected.artifactId));if(!administrative&&scan.status==='CLEAN'&&state.items.some(row=>row.sha256===after.sha256&&row.scanStatus==='INFECTED'))throw httpError(423,'The same content has an infection finding. An administrator must verify every affected version.',{code:'FILE_CONTENT_QUARANTINED'});state.items[index]=after;this.addLocalAudit(state,context,action,after,{before,after:{...after,preparationId},detail:`${after.filename}; verification ${scan.status}; preparation ${preparationId}`});await this.writeCatalog(state.items,state.events);return after;});this.queue=task.catch(()=>{});return task;
  }
  async publishedFileScan(preparationId,context,{transaction=null}={}){
    let item;
    if(this.pool)item=(await (transaction||this.pool).query("select after_json from replacement_register.audit_events where action in ('FILE_SCAN_COMPLETED','FILE_RESCANNED') and after_json->>'preparationId'=$1 order by id desc limit 1",[preparationId])).rows[0]?.after_json;
    else{await this.queue;item=(await this.localState()).events.filter(row=>['FILE_SCAN_COMPLETED','FILE_RESCANNED'].includes(row.action)&&row.after?.preparationId===preparationId).at(-1)?.after;}
    if(!item||!artifactAccess(context,item))return null;const {preparationId:association,...artifact}=item;return artifact;
  }
  async findPublishedFile(job,context,client=null){
    if(job.descriptor.kind!=='REGISTER_BOM')return null;let item;
    if(this.pool)item=(await (client||this.pool).query("select after_json from replacement_register.audit_events where action in ('FILE_STORED','FILE_PREPARATION_LINKED') and after_json->>'preparationId'=$1 order by id desc limit 1",[job.jobId])).rows[0]?.after_json;
    else{await this.queue;item=(await this.localState()).events.filter(row=>['FILE_STORED','FILE_PREPARATION_LINKED'].includes(row.action)&&row.after?.preparationId===job.jobId).at(-1)?.after;}
    if(!item||!artifactAccess(context,item))return null;
    if(item.kind!=='ORIGINAL_BOM'||item.moduleId!=='M01'||item.sha256!==job.descriptor.input.sha256||item.bytes!==job.descriptor.input.bytes)throw httpError(409,'The saved original-BOM publication does not match its preparation.',{code:'FILE_PREPARATION_RECEIPT_INVALID'});
    const {preparationId:association,...artifact}=item;return artifact;
  }
  async withImportSource(batch,context,publish,transaction=null){
    const check=async(item,infected)=>{
      if(!item||!artifactAccess(context,item))throw httpError(404,'Import source file is unavailable.');
      if(item.kind!=='WORKFLOW_INPUT'||item.moduleId!==batch.moduleId||item.sha256!==batch.sourceHash)throw httpError(409,'The retained import source identity changed. Reopen the import review.',{code:'IMPORT_SOURCE_CHANGED'});
      if(infected||(!['CLEAN','GENERATED'].includes(item.scanStatus)&&!(this.preview&&item.scanStatus==='ERROR')))throw httpError(423,'The import source is quarantined. Verify it before confirming the register update.',{code:'IMPORT_SOURCE_QUARANTINED'});
      await this.read(item,{internal:true});
    };
    if(this.pool){
      if(!transaction)throw new Error('SQL import source validation requires the business transaction.');
      await transaction.query('select pg_advisory_xact_lock_shared(78742004)');
      const row=(await transaction.query('select * from replacement_register.artifacts where artifact_id=$1 for share',[batch.artifactId])).rows[0];await check(row?fromRow(row):null,row?await this.infectedContent(row.sha256,transaction):false);return publish();
    }
    const pending=this.queue.then(async()=>{const state=await this.localState(),item=state.items.find(row=>row.artifactId===batch.artifactId);await check(item,state.items.some(row=>row.sha256===item?.sha256&&row.scanStatus==='INFECTED'));return publish();});this.queue=pending.catch(()=>{});return pending;
  }
  async publishImportScan(expected,scan,context,{transaction=null,preparationId}={}){
    if(!/^[a-f0-9-]{36}$/.test(preparationId||'')||!['M02','M04','M08'].includes(expected.moduleId)||!['CLEAN','ERROR','INFECTED'].includes(scan.status))throw new Error('Invalid import verification publication.');
    return this.publishUploadScan(expected,scan,context,{transaction,preparationId});
  }
  async publishUploadScan(expected,scan,context,{transaction=null,preparationId}={}){
    if(!/^[a-f0-9-]{36}$/.test(preparationId||'')||!['M01','M02','M04','M08'].includes(expected.moduleId)||!['CLEAN','ERROR','INFECTED'].includes(scan.status))throw new Error('Invalid upload verification publication.');
    const identityCode=expected.moduleId==='M01'?'M01_SOURCE_CHANGED':'IMPORT_SOURCE_CHANGED',verificationLabel=expected.moduleId==='M01'?'M01 source':'import';
    const update=before=>{
      if(!before||!artifactAccess(context,before))throw httpError(404,'Import file is unavailable.');
      if(before.kind!=='WORKFLOW_INPUT'||before.moduleId!==expected.moduleId||before.sha256!==expected.sha256||before.bytes!==expected.bytes)throw httpError(409,'The retained workflow input identity changed.',{code:identityCode});
      if(before.scanStatus==='INFECTED'&&scan.status!=='INFECTED')throw httpError(423,`An administrator must verify the infected input before this ${verificationLabel} preparation can be retried.`,{code:'FILE_QUARANTINED'});
      if(scan.status!=='INFECTED'&&(before.scanStatus!==expected.scanStatus||before.scanDetail!==expected.scanDetail))throw httpError(409,'File verification changed while this scan was running. Retry the import preparation.',{code:'FILE_SCAN_CHANGED'});
      return {...before,scanStatus:scan.status,scanDetail:scan.detail};
    };
    if(this.pool){
      if(!transaction)throw new Error('SQL import verification requires the preparation lease transaction.');
      await transaction.query('select pg_advisory_xact_lock(78742004)');
      const row=(await transaction.query('select * from replacement_register.artifacts where artifact_id=$1 for update',[expected.artifactId])).rows[0],before=row?fromRow(row):null,after=update(before);
      if(scan.status==='CLEAN'&&await this.infectedContent(after.sha256,transaction))throw httpError(423,'The same file content has an infection finding. An administrator must verify every affected version before importing.',{code:'FILE_CONTENT_QUARANTINED'});
      await transaction.query('update replacement_register.artifacts set scan_status=$2,scan_detail=$3 where artifact_id=$1',[after.artifactId,after.scanStatus,after.scanDetail]);
      await this.writeAudit(transaction,context,'FILE_SCAN_COMPLETED',after,{before,after:{...after,preparationId},detail:`${after.filename}; ${verificationLabel} verification ${scan.status}; preparation ${preparationId}`});return after;
    }
    const pending=this.queue.then(async()=>{const state=await this.localState(),index=state.items.findIndex(item=>item.artifactId===expected.artifactId),before=state.items[index],after=update(before);if(scan.status==='CLEAN'&&state.items.some(item=>item.sha256===after.sha256&&item.scanStatus==='INFECTED'))throw httpError(423,'The same file content has an infection finding. An administrator must verify every affected version before importing.',{code:'FILE_CONTENT_QUARANTINED'});state.items[index]=after;this.addLocalAudit(state,context,'FILE_SCAN_COMPLETED',after,{before,after:{...after,preparationId},detail:`${after.filename}; ${verificationLabel} verification ${scan.status}; preparation ${preparationId}`});await this.writeCatalog(state.items,state.events);return after;});this.queue=pending.catch(()=>{});return pending;
  }
  async linkM01Input(...args){return this.linkWorkflowInput('M01',...args);}
  async linkWorkflowInput(moduleId,id,detected,context,expectedHash) {
    if(moduleId==='M01'&&context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can associate an original M01 input.');
    if(!['M01','M02','M04','M08'].includes(moduleId)||!canUseModule(moduleFor(moduleId),context.role))throw httpError(403,'This workflow input cannot be associated by your role.');
    const update=before=>{
      if(before&&!artifactAccess(context,before))throw httpError(404,'File not found.');
      if(!before||before.kind!=='WORKFLOW_INPUT'||before.moduleId!==moduleId||!before.ownerOnly||before.sha256!==expectedHash)throw httpError(409,'The retained workflow input identity is unavailable.',{code:moduleId==='M01'?'M01_SOURCE_CHANGED':'IMPORT_SOURCE_CHANGED'});
      const scope=Object.fromEntries(['orderNos','suppliers','productDecimalNos','proposalIds'].map(key=>[key,unique([...(before.scope[key]||[]),...(detected[key]||[])])]));
      if(scope.orderNos.some(value=>value!=='Unassigned'))scope.orderNos=scope.orderNos.filter(value=>value!=='Unassigned');
      const after={...before,scope};if(!artifactAccess(context,after))throw httpError(403,'Detected workbook scope is outside your current assignments.',{code:'IMPORT_SCOPE_DENIED'});return after;
    };
    const changed=(before,after)=>Object.keys(after.scope).some(key=>JSON.stringify(before.scope[key]||[])!==JSON.stringify(after.scope[key]));
    if(this.pool){const client=await this.pool.connect();try{await client.query('begin');await client.query('select pg_advisory_xact_lock(78742004)');const row=(await client.query('select * from replacement_register.artifacts where artifact_id=$1 for update',[id])).rows[0],before=row?fromRow(row):null,after=update(before);if(changed(before,after)){await client.query('update replacement_register.artifacts set scope_json=$2 where artifact_id=$1',[id,after.scope]);await this.writeAudit(client,context,'FILE_SCOPE_LINKED',after,{before,after,detail:`${moduleId} input associated with detected order/product metadata; exact bytes and version retained.`});}await client.query('commit');return after;}catch(error){await client.query('rollback');throw error;}finally{client.release();}}
    const pending=this.queue.then(async()=>{const state=await this.localState(),index=state.items.findIndex(row=>row.artifactId===id),before=state.items[index],after=update(before);if(changed(before,after)){state.items[index]=after;this.addLocalAudit(state,context,'FILE_SCOPE_LINKED',after,{before,after,detail:`${moduleId} input associated with detected order/product metadata; exact bytes and version retained.`});await this.writeCatalog(state.items,state.events);}return after;});this.queue=pending.catch(()=>{});return pending;
  }
  async download(id,context,{exportJobId=null,previewOnly=false,validateSource=null}={}) {
    const attempt=async(item,transaction=null,current=context)=>{if(!item||!artifactAccess(current,item))throw httpError(404,'File not found.');try{await validateSource?.(transaction,current);if(previewOnly){if(item.kind!=='ATTACHMENT'||!['application/pdf','image/png','image/jpeg'].includes(item.contentType))throw httpError(415,'Preview is available only for PDF, PNG and JPEG attachments.',{code:'ATTACHMENT_PREVIEW_UNSUPPORTED'});if(item.scanStatus!=='CLEAN')throw httpError(423,'Complete antivirus verification before previewing this attachment.',{code:'FILE_QUARANTINED'});}return {item,buffer:await this.read(item,{transaction})};}catch(error){if(![409,423].includes(error.status))throw error;return {item,error};}};
    const values=result=>({after:{...result.item,exportJobId,...(result.error?{blockedCode:result.error.code||'FILE_QUARANTINED'}:{})},detail:`${result.item.filename}; version ${result.item.version}; ${result.item.sha256}${result.error?`; blocked: ${result.error.code||'FILE_QUARANTINED'}`:'; released to HTTP response (local save not confirmed)'}`});
    let result;
    const action=blocked=>previewOnly?(blocked?'FILE_PREVIEW_BLOCKED':'FILE_PREVIEW_RELEASED'):(blocked?'FILE_DOWNLOAD_BLOCKED':'FILE_DOWNLOAD_RELEASED');
    if(this.pool){
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw httpError(404,'File not found.');
      const client=await this.pool.connect();
      try{
        await client.query('begin');
        await lockNamedReleaseAccount(client,context);
        await client.query('select pg_advisory_xact_lock_shared(78742004)');
        const current=await currentNamedReleaseContext(client,context);
        const row=(await client.query('select * from replacement_register.artifacts where artifact_id=$1 for share',[id])).rows[0];
        result=await attempt(row?fromRow(row):null,client,current);
        await this.writeAudit(client,current,action(result.error),result.item,values(result));
        await client.query('commit');
      }catch(error){await client.query('rollback');throw error;}finally{client.release();}
    }
    else {const task=this.queue.then(async()=>{const state=await this.localState(),result=await attempt(state.items.find(row=>row.artifactId===id));this.addLocalAudit(state,context,action(result.error),result.item,values(result));await this.writeCatalog(state.items,state.events);return result;});this.queue=task.catch(()=>{});result=await task;}
    if(result.error)throw result.error;return {filename:result.item.filename,contentType:result.item.contentType,buffer:result.buffer,artifactId:result.item.artifactId,...(previewOnly?{inline:true}:{})};
  }
}
