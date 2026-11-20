export const ADMIN_STATUS_LIMITS=Object.freeze({responseBytes:65536,migrations:128,hashGroups:10,templateBytes:16*1024*1024,migrationFileBytes:2*1024*1024,migrationCatalogBytes:8*1024*1024});
export const adminStatusError=(status,code,message)=>Object.assign(new Error(message),{status,code});
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():null;
const count=value=>{if(!['string','number'].includes(typeof value)||typeof value==='string'&&!/^\d+$/.test(value))return null;const result=Number(value);return Number.isSafeInteger(result)&&result>=0?result:null;};
const filename=value=>typeof value==='string'?value.replaceAll('\\','/').split('/').at(-1).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255):'';
const version=value=>typeof value==='string'&&/^\d{3}_[A-Za-z0-9_-]{1,100}$/.test(value)?value:null;
const allowed=(value,values)=>values.includes(value)?value:null;
export function requireStatusAdministrator(context){if(context?.role!=='ADMINISTRATOR')throw adminStatusError(403,'ADMIN_OPERATIONS_FORBIDDEN','Administrator access is required.');}
export function sourceIdentityDto(info={}){
 const result={sourceFile:filename(info.sourceFile),sourceSha256:digest(info.sourceSha256),authority:'BUNDLED_METADATA_CLAIM'};
 for(const key of ['sourceModified','extractedAt'])if(typeof info[key]==='string'&&info[key].length<=64&&Number.isFinite(Date.parse(info[key])))result[key]=info[key];
 return result;
}
export function sourceSection({info={},bundledInfo={},backend,sql}){
 const loaded={sourceSha256:digest(info.sourceSha256),sourceState:allowed(info.sourceState,['UNKNOWN','CURRENT_HASH','PREVIOUS_HASH']),provenanceKind:allowed(info.provenanceKind,['ADOPTION_RECEIPT_RECORDED','LOADED_ENVELOPE_CLAIM']),persistenceState:allowed(info.persistenceState,['RELOAD_REQUIRED'])};
 const base={bundled:sourceIdentityDto(bundledInfo),observedExternalWorkbook:{state:'NOT_CHECKED'},loadedPreview:backend==='preview'?loaded:null,sql:{state:backend==='preview'?'NOT_APPLICABLE':'UNAVAILABLE'}};
 if(backend!=='postgres'||!sql)return base;
 if(!Array.isArray(sql.groups)||sql.groups.some(row=>row===null||typeof row!=='object'||Array.isArray(row)))return base;
 const groups=sql.groups,mapped=groups.slice(0,ADMIN_STATUS_LIMITS.hashGroups).map(row=>({entityKind:allowed(row.entity_kind,['proposal','replacement']),sourceSha256:digest(row.source_hash),records:count(row.records)}));
 const versions=count(sql.versionCount),conflicts=count(sql.conflictCount);
 if(versions===null||mapped.some(row=>!row.entityKind||!row.sourceSha256||row.records===null))return base;
 base.sql={state:'RECORDED_POINTERS_ONLY',coverage:'SOURCE_BINDINGS_SUPPORTED_KINDS_ONLY_NOT_COMPLETE_LIFECYCLE_OR_LIVE_WORKBOOK_PROOF',groups:mapped,truncated:groups.length>ADMIN_STATUS_LIMITS.hashGroups,versionCount:versions,unresolvedConflicts:conflicts,unresolvedConflictsState:conflicts===null?'UNAVAILABLE':'AVAILABLE'};return base;
}
export function schemaSection(catalog,applied,{backend='postgres'}={}){
 if(!Array.isArray(catalog)||!catalog.length||catalog.length>ADMIN_STATUS_LIMITS.migrations)return {state:'UNAVAILABLE'};
 const expected=catalog.map(row=>({version:version(row.version),sha256:digest(row.sha256)}));if(expected.some(row=>!row.version||!row.sha256)||new Set(expected.map(row=>row.version)).size!==expected.length)return {state:'UNAVAILABLE'};
 const base={packagedFiles:expected,comparison:'VERSION_NAMES_ONLY',databaseDdlIntegrityVerified:false};
 if(backend==='preview')return {...base,state:'NOT_APPLICABLE',applied:[],pending:[],unknownApplied:[]};
 if(!Array.isArray(applied)||applied.length>ADMIN_STATUS_LIMITS.migrations)return {...base,state:'UNAVAILABLE'};
 const names=applied.map(row=>version(typeof row==='string'?row:row.version));if(names.some(row=>!row)||new Set(names).size!==names.length)return {...base,state:'UNAVAILABLE'};
 const wanted=new Set(expected.map(row=>row.version)),actual=new Set(names),pending=expected.map(row=>row.version).filter(row=>!actual.has(row)),unknownApplied=names.filter(row=>!wanted.has(row));
 return {...base,state:unknownApplied.length?'UNKNOWN':pending.length?'PENDING':'MATCH',applied:names,pending,unknownApplied};
}
export function templateSection(observation={}){
 const expected=digest(observation.expectedSha256),actual=digest(observation.actualSha256),unavailable=allowed(observation.state,['MISSING','UNAVAILABLE','LIMIT_EXCEEDED']);
 return {file:'Card_of_Deviation_Template_v6.docx',state:unavailable||(expected&&actual?(expected===actual?'MATCH':'MISMATCH'):'UNVERIFIED'),expectedSha256:expected,actualSha256:actual,authority:'PACKAGED_EXPECTED_HASH',layoutVerification:'NOT_VERIFIED',nativeOfficeAccepted:false};
}
export function statusDto({backend,authMode,capturedAt,source,schema,template}){
 if(!['preview','named'].includes(authMode))throw adminStatusError(503,'ADMIN_OPERATIONS_AUTH_MODE_UNVERIFIED','Authentication mode is not confirmed.');
 const result={version:1,capturedAt:new Date(capturedAt).toISOString(),authMode,metadataBackend:backend,readOnly:true,sections:{schema,source,template,retention:{policyState:'UNCONFIGURED',automaticDeletionEnabled:null,moduleAutomaticDeletionEnabled:false,deploymentDeletionState:'NOT_OBSERVED',legalHoldState:'NOT_CONFIGURED_OR_NOT_VERIFIED',rpoRto:'UNAPPROVED',capacityDoesNotAuthorizeDeletion:true}}};
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>ADMIN_STATUS_LIMITS.responseBytes)throw adminStatusError(503,'ADMIN_OPERATIONS_STATUS_TOO_LARGE','Status evidence exceeds its response limit.');return result;
}
