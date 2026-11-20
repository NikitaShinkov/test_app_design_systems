import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseRegisterReport,registerReportSummary,registerReportSequenceKey,registerReportFilename,REGISTER_REPORT} from './register-report.js';
import {registerReportFields,registerReportProjection,registerRowSelection} from './register-column-filters.js';
import {registerMemoryMatches} from './register-query.js';
import {registerReportArtifactScope} from './register-report-access.js';
import {readRegisterReportCapture,canonicalRegisterReportJson} from './register-report-spool.js';
import {snapshotDigest} from './export-jobs.js';
import {canAccess} from './auth.js';

const rr='replacement_register',uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value),roles=new Set(['ADMINISTRATOR','SUPPLIER','CLIENT']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),same=(a,b)=>canonicalRegisterReportJson(a)===canonicalRegisterReportJson(b);
const metadataValue=value=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(metadataValue):object(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,metadataValue(value[key])])):value;
const metadataJson=value=>JSON.stringify(metadataValue(value));
const insist=(condition,message)=>{if(!condition)throw Error('Register-report integrity failed: '+message);};
let migrationSource;
async function source036(){return migrationSource??=await fs.readFile(new URL('../database/036_register_reports.sql',import.meta.url),'utf8');}

export async function verifyRegisterReportSchema(client){
  const missing=[],constraints=(await client.query("select c.relname as table,k.conname,k.convalidated,k.contype,pg_get_constraintdef(k.oid) as definition,pg_get_expr(k.conbin,k.conrelid) as expression from pg_constraint k join pg_class c on c.oid=k.conrelid where c.relnamespace=to_regnamespace($1) and ((c.relname='preparation_jobs' and k.conname='preparation_kind_module') or (c.relname='artifacts' and k.conname='register_report_artifact_shape'))",[rr])).rows;
  const preparation=constraints.find(row=>row.table==='preparation_jobs'&&row.conname==='preparation_kind_module'&&row.contype==='c'&&row.convalidated);
  if(!preparation||!['EXPORT','M01','M03','M05','M06','M07','M09','REGISTER_REPORT','IMPORT','M02','M04','M08','INSPECT','REGISTER_BOM','ATTACHMENT','RESCAN','null','false'].every(value=>preparation.definition.includes(value)))missing.push('validated preparation_kind_module with all029 branches and REGISTER_REPORT');
  else{
    // Reject unexpected executable tokens before evaluating a bounded truth
    // table. Only the bundled predicate's JSON operators and built-ins remain.
    const words=preparation.expression.replace(/'(?:''|[^'])*'/g,"''").replace(/\b(?:descriptor|coalesce|any|array|text|jsonb|false|true|and|or|in)\b/gi,'').replace(/[\s()\[\]:=<>!?,.'+\-]/g,'');
    if(words)missing.push('preparation_kind_module contains an unexpected expression');
    else{
      const descriptors=[];for(const kind of [undefined,null,'EXPORT','IMPORT','INSPECT','REGISTER_BOM','ATTACHMENT','RESCAN','OTHER'])for(const moduleId of [undefined,null,'M01','M02','M03','M04','M05','M06','M07','M08','M09',REGISTER_REPORT,'M10','OTHER'])descriptors.push({...kind!==undefined?{kind}:{},...moduleId!==undefined?{moduleId}:{}});
      const expected=d=>(d.kind??'EXPORT')==='EXPORT'&&['M01','M03','M05','M06','M07','M09',REGISTER_REPORT].includes(d.moduleId)||d.kind==='IMPORT'&&['M02','M04','M08'].includes(d.moduleId)||['INSPECT','REGISTER_BOM'].includes(d.kind)&&d.moduleId==='M01'||['ATTACHMENT','RESCAN'].includes(d.kind)&&Object.hasOwn(d,'moduleId')&&d.moduleId===null;
      const rows=(await client.query(`select descriptor,(${preparation.expression}) as allowed from jsonb_array_elements($1::jsonb) as inputs(descriptor)`,[JSON.stringify(descriptors)])).rows;
      if(rows.length!==descriptors.length||rows.some(row=>row.allowed!==Boolean(expected(row.descriptor))))missing.push('preparation_kind_module rejects old exchanges or accepts an unsupported kind/module');
    }
  }
  const shape=constraints.find(row=>row.table==='artifacts'&&row.conname==='register_report_artifact_shape'&&row.contype==='c'&&row.convalidated);
  if(!shape||!['REGISTER_REPORT','WORKFLOW_INPUT','WORKFLOW_OUTPUT','owner_only','reportOwnerRole','ADMINISTRATOR','SUPPLIER','CLIENT','false'].every(value=>shape.definition.includes(value)))missing.push('validated register_report_artifact_shape');
  const trigger=(await client.query("select t.tgtype,t.tgenabled,n.nspname as function_schema,p.proname as function_name,p.prosrc,l.lanname from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where t.tgrelid=to_regclass($1) and t.tgname='register_report_artifact_identity' and not t.tgisinternal",[rr+'.artifacts'])).rows[0];
  const expectedBody=(await source036()).match(/create function replacement_register\.protect_register_report_artifact\(\)[^]*?as \$\$([^]*?)\$\$;/)?.[1];
  if(!trigger||Number(trigger.tgtype)!==23||!['O','A'].includes(trigger.tgenabled)||trigger.function_schema!==rr||trigger.function_name!=='protect_register_report_artifact'||trigger.lanname!=='plpgsql'||!expectedBody||trigger.prosrc.replaceAll('\r\n','\n').trim()!==expectedBody.replaceAll('\r\n','\n').trim())missing.push('enabled register_report_artifact_identity with exact bundled036 function');
  return {ok:missing.length===0,missing};
}

const artifactSql=row=>row?{artifactId:row.artifact_id,logicalKey:row.logical_key,version:row.version,sha256:row.sha256,bytes:Number(row.bytes),kind:row.kind,moduleId:row.module_id,scope:row.scope_json,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,ownerOnly:row.owner_only,scanStatus:row.scan_status,filename:row.filename,contentType:row.content_type}:null;
const preparationSql=row=>row?{jobId:row.job_id,status:row.status,descriptor:row.descriptor,result:row.result,ownerKey:row.owner_key}:null;
const exportSql=row=>row?{jobId:row.job_id,moduleId:row.module_id,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,ownerRole:row.owner_role,status:row.status,snapshot:row.snapshot_json,...row.payload}:null;
function captureOwner(preparation){
  const owner=preparation?.descriptor?.owner;insist(preparation&&uuid(preparation.jobId)&&object(owner)&&roles.has(owner.role)&&typeof owner.authenticated==='boolean'&&Array.isArray(owner.orders),'report has no valid initiating preparation/owner');
  insist(owner.authenticated?uuid(owner.userId):owner.userId===null,'invalid original report user identity');
  insist(preparation.descriptor.moduleId===REGISTER_REPORT&&['EXPORT',undefined,null].includes(preparation.descriptor.kind),'source parent is not a register-report export');
  return owner;
}
function ownerMatches(item,owner){insist(item.ownerOnly===true&&item.scope?.reportOwnerRole===owner.role&&(owner.authenticated?item.ownerUserId===owner.userId:!item.ownerUserId&&item.ownerActor===(owner.actor||'Local administrator')),'report artifact original owner or role differs');}
function sourcePreparationId(item){const prefix='REGISTER_REPORT_SOURCE:';insist(item.kind==='WORKFLOW_INPUT'&&item.moduleId===REGISTER_REPORT&&item.logicalKey?.startsWith(prefix)&&uuid(item.logicalKey.slice(prefix.length))&&item.version===1&&item.contentType==='application/gzip'&&/^[a-f0-9]{64}$/.test(item.sha256)&&Number.isSafeInteger(item.bytes)&&item.bytes>0,'invalid immutable report-source identity');return item.logicalKey.slice(prefix.length);}
function requestFor(preparation){const request=parseRegisterReport(preparation.descriptor.options);insist(same(request,preparation.descriptor.options),'report preparation request is not canonical');return request;}
function validateReview(item,preparation,review,request){
  const owner=captureOwner(preparation);ownerMatches(item,owner);
  if(!review){insist(preparation.status!=='SUCCEEDED','completed preparation has no saved report review');return;}
  insist(review.jobId===preparation.jobId&&review.moduleId===REGISTER_REPORT&&['READY','ISSUING','COMPLETE'].includes(review.status)&&review.ownerRole===owner.role&&(owner.authenticated?review.ownerUserId===owner.userId:!review.ownerUserId&&review.ownerActor===(owner.actor||'Local administrator')),'report review owner differs from its original preparation');
  const snapshot=review.snapshot;insist(object(snapshot)&&Array.isArray(snapshot.inputs)&&snapshot.inputs.length===1&&Array.isArray(snapshot.drafts)&&snapshot.drafts.length===1,'report review requires exactly one source and output draft');
  const {snapshotHash,...unhashed}=snapshot;insist(snapshotDigest(unhashed)===snapshotHash&&same(snapshot.options,request),'report snapshot hash or canonical request differs');
  const input={artifactId:item.artifactId,sha256:item.sha256,bytes:item.bytes,registerReportSource:true};insist(same(snapshot.inputs[0],input),'report review source metadata differs');
  const provenance=snapshot.provenance,capture=provenance?.reportCapture;insist(object(provenance)&&object(capture)&&provenance.reportFormatVersion===1&&provenance.sourceHash===item.sha256&&provenance.sourceBytes===item.bytes&&provenance.sourceArtifactId===item.artifactId,'report source provenance differs');
  insist(same(provenance.registerReport,registerReportSummary(request,capture,item))&&provenance.asOf===capture.asOf&&snapshot.dataAsOf===capture.asOf&&snapshot.affected===capture.rowCount&&provenance.completeFilteredReport===(request.selection.mode==='FILTERED'),'report summary, count or capture time differs');
  insist(snapshot.key===registerReportSequenceKey(request,owner,capture)&&Number.isSafeInteger(snapshot.version)&&snapshot.version>0,'report filename sequence family or version differs');
  const scope=registerReportArtifactScope(capture,owner),draft=snapshot.drafts[0];insist(same(item.scope,scope)&&same(snapshot.scope,scope)&&same(draft.scope,scope)&&draft.ownerOnly===true&&draft.kind==='WORKFLOW_OUTPUT'&&draft.affected===capture.rowCount,'report draft count or private role-bound scope differs');
  insist(provenance.format===(request.format==='csv'?'CSV UTF-8 BOM; Excel formula prefixes protected':'XLSX; explicit text cells')&&draft.contentType===(request.format==='csv'?'text/csv; charset=utf-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')&&draft.filename===registerReportFilename(request,capture,snapshot.version),'report draft format or proposed filename differs');
  insist(!Object.hasOwn(snapshot,'businessRows')&&!Object.hasOwn(snapshot,'metadataPlan'),'register report must not contain macro business publication data');
  if(preparation.status==='SUCCEEDED')insist(preparation.result?.jobId===review.jobId&&preparation.result?.moduleId===REGISTER_REPORT&&preparation.result?.rows===capture.rowCount&&same(preparation.result?.registerReport,provenance.registerReport),'preparation result differs from its saved report capture');
}
async function validateSourceObject(item,preparation,review,open){
  const owner=captureOwner(preparation),request=requestFor(preparation);validateReview(item,preparation,review,request);
  const selected=request.selection.mode==='SELECTED'?new Map(request.selection.items.map(key=>[key.kind+':'+key.id,key])):null,excluded=new Set((request.selection.excluded||[]).map(key=>key.kind+':'+key.id));let header=null,footer=null,count=0;
  for await(const entry of readRegisterReportCapture({sha256:item.sha256,bytes:item.bytes,open})){
    if(entry.type==='header'){header=entry.header;insist(same(Object.keys(header).sort(),['dataAsOf','fields','reportFormatVersion','request'])&&header.reportFormatVersion===1&&same(header.request,request)&&same(header.fields,registerReportFields(request.registerKind)),'report source header, field catalog or canonical request differs');continue;}
    if(entry.type==='footer'){footer=entry.capture;continue;}
    insist(header&&entry.type==='row','invalid register report source entry');const projected=registerReportProjection(request.registerKind,entry.values),key=registerRowSelection(request.registerKind,entry.values);insist(same(projected,entry.values)&&same(key,entry.key),'report frozen row projection or fingerprint differs');
    insist(registerMemoryMatches(request.registerKind,entry.values,request.filters)&&(!owner.authenticated||canAccess(owner,entry.values)),'frozen report row is outside original filters or captured account scope');
    const identity=key.kind+':'+key.id;insist(!excluded.has(identity)&&(!selected||same(selected.get(identity),key)),'report row differs from explicit selection/exclusions');count++;
  }
  insist(header&&footer&&footer.rowCount===count&&(!selected||count===selected.size),'report source footer or complete selection is missing');
  const expectedScope=registerReportArtifactScope(footer,owner);insist(same(item.scope,expectedScope),'report source scope differs from actual frozen rows');
  if(review)insist(same(footer,review.snapshot.provenance.reportCapture)&&header.dataAsOf===review.snapshot.dataAsOf,'source footer, count, row hash or capture time differs from review');
  return {rows:count,capture:footer};
}

/** Caller owns a stable read transaction. Metadata is paged; original users may now be disabled. */
export async function registerReportInventory(client,{artifactRoot=null}={}){
  if(artifactRoot!==null)insist(path.isAbsolute(artifactRoot),'use an absolute report object-store root');
  const schema=await verifyRegisterReportSchema(client);insist(schema.ok,schema.missing.join('; '));const hash=createHash('sha256');let cursor=null,sources=0,reviews=0,outputs=0,rows=0;
  for(;;){const page=(await client.query(`select * from ${rr}.artifacts where module_id=$1 and kind='WORKFLOW_INPUT' and ($2::uuid is null or artifact_id>$2::uuid) order by artifact_id limit 25`,[REGISTER_REPORT,cursor])).rows;for(const raw of page){const item=artifactSql(raw),parentId=sourcePreparationId(item),preparation=preparationSql((await client.query(`select * from ${rr}.preparation_jobs where job_id=$1`,[parentId])).rows[0]),review=exportSql((await client.query(`select * from ${rr}.export_jobs where job_id=$1`,[parentId])).rows[0]),owner=captureOwner(preparation),request=requestFor(preparation);ownerMatches(item,owner);validateReview(item,preparation,review,request);if(artifactRoot){const filename=path.join(artifactRoot,'objects',item.sha256.slice(0,2),item.sha256),stat=await fs.lstat(filename);insist(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===item.bytes,'source object is missing or has an invalid type/size');await validateSourceObject(item,preparation,review,()=>createReadStream(filename));}hash.update(metadataJson({source:raw,preparation,review})+'\n');sources++;if(review){reviews++;rows+=review.snapshot.affected;}cursor=item.artifactId;}if(page.length<25)break;}
  const counts=(await client.query(`select (select count(*)::text from ${rr}.export_jobs where module_id=$1) as reviews,(select count(*)::text from ${rr}.artifacts where module_id=$1 and kind='WORKFLOW_OUTPUT') as outputs`,[REGISTER_REPORT])).rows[0];insist(Number(counts.reviews)===reviews,'saved report review has no unique immutable source');
  let outputCursor=null;for(;;){const page=(await client.query(`select * from ${rr}.artifacts where module_id=$1 and kind='WORKFLOW_OUTPUT' and ($2::uuid is null or artifact_id>$2::uuid) order by artifact_id limit 25`,[REGISTER_REPORT,outputCursor])).rows;for(const raw of page){const item=artifactSql(raw),matches=(await client.query(`select * from ${rr}.export_jobs where module_id=$1 and payload->'result'->>'artifactId'=$2`,[REGISTER_REPORT,item.artifactId])).rows;insist(matches.length===1,'issued report output has no unique retained completed review');const review=exportSql(matches[0]),preparation=preparationSql((await client.query(`select * from ${rr}.preparation_jobs where job_id=$1`,[review.jobId])).rows[0]),owner=captureOwner(preparation);ownerMatches(item,owner);insist(review.status==='COMPLETE'&&same(item.scope,review.snapshot.scope)&&item.version===review.snapshot.version&&review.result?.files?.some(file=>file.artifactId===item.artifactId&&file.sha256===item.sha256&&file.filename===item.filename&&file.version===item.version&&same(file.scope,item.scope)),'issued report output scope, version or receipt differs');hash.update(metadataJson({output:raw})+'\n');outputs++;outputCursor=item.artifactId;}if(page.length<25)break;}insist(outputs===Number(counts.outputs),'orphan report output');
  return {formatVersion:1,sources,reviews,outputs,rows,sha256:hash.digest('hex'),canonicalReferencesVerified:true};
}

/** Local source objects may precede a failed review; their parent preparation is retained. */
export async function localRegisterReportInventory(artifacts,readPreparation,readReview,{verifyObjects=true,catalog:capturedCatalog=null}={}){
  const record=folder=>async id=>{insist(uuid(id),'invalid local report record ID');try{return JSON.parse(await fs.readFile(path.join(artifacts.root,folder,id+'.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw Error('Register-report integrity failed: retained local report record cannot be read.');}};
  readPreparation??=record('preparations');readReview??=record('export-jobs');if(!capturedCatalog)await artifacts.queue;const catalog=capturedCatalog??await artifacts.localState(),items=catalog.items.filter(item=>item.moduleId===REGISTER_REPORT),hash=createHash('sha256'),sourceParents=new Set();let sources=0,reviews=0,outputs=0,rows=0;
  for(const item of items.filter(item=>item.kind==='WORKFLOW_INPUT').sort((a,b)=>a.artifactId.localeCompare(b.artifactId))){const parentId=sourcePreparationId(item);insist(!sourceParents.has(parentId),'ambiguous local report source preparation');sourceParents.add(parentId);const preparation=await readPreparation(parentId),review=await readReview(parentId);validateReview(item,preparation,review,requestFor(preparation));if(verifyObjects){const filename=artifacts.objectPath(item.sha256),stat=await fs.lstat(filename);insist(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===item.bytes,'local source object is missing or invalid');await validateSourceObject(item,preparation,review,()=>createReadStream(filename));}hash.update(metadataJson({source:item,preparation,review})+'\n');sources++;if(review){reviews++;rows+=review.snapshot.affected;}}
  for(const item of items.filter(item=>item.kind==='WORKFLOW_OUTPUT')){const matches=[];for(const source of items.filter(value=>value.kind==='WORKFLOW_INPUT')){const review=await readReview(sourcePreparationId(source));if(review?.result?.artifactId===item.artifactId)matches.push(review);}insist(matches.length===1&&matches[0].status==='COMPLETE','local report output has no matching completed review');const review=matches[0],preparation=await readPreparation(review.jobId);ownerMatches(item,captureOwner(preparation));insist(same(item.scope,review.snapshot.scope)&&item.version===review.snapshot.version&&review.result?.files?.some(file=>file.artifactId===item.artifactId&&file.sha256===item.sha256&&file.filename===item.filename&&file.version===item.version&&same(file.scope,item.scope)),'local output differs from report receipt');hash.update(metadataJson({output:item})+'\n');outputs++;}
  let names=[];try{names=await fs.readdir(path.join(artifacts.root,'export-jobs'));}catch(error){if(error.code!=='ENOENT')throw Error('Register-report integrity failed: local export review inventory cannot be read.');}
  let retainedReports=0;for(const name of names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name))){const review=await readReview(name.slice(0,-5));if(review?.moduleId===REGISTER_REPORT){insist(sourceParents.has(review.jobId),'local saved report has no retained source');retainedReports++;}}
  insist(retainedReports===reviews,'local report review/source inventory differs');
  return {formatVersion:1,mode:'local-files',sources,reviews,outputs,rows,sha256:hash.digest('hex'),canonicalReferencesVerified:true,sourceObjectsVerified:verifyObjects};
}
