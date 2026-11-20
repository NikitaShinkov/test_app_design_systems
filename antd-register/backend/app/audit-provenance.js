// Server-only audit metadata; no application import, authority decision or I/O.
import {isIP} from 'node:net';
import {randomUUID} from 'node:crypto';

export const MAX_ENVELOPE_BYTES=8192;
export const MAX_USER_AGENT_BYTES=512;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const loopback=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const roles=new Set(['ADMINISTRATOR','SUPPLIER','CLIENT']);
const processRoles=new Set(['api','worker','combined','maintenance']);
const inspectionResults=new WeakSet(),contextOrigins=new WeakMap();

export class AuditProvenanceError extends Error{
 constructor(){super('Audit provenance failed validation.');this.name='AuditProvenanceError';this.code='AUDIT_PROVENANCE_INVALID';}
}
const fail=()=>{throw new AuditProvenanceError();};
const check=condition=>{if(!condition)fail();};
function record(value,keys){
 check(value!==null&&typeof value==='object'&&!Array.isArray(value));
 check([Object.prototype,null].includes(Object.getPrototypeOf(value)));
 const descriptors=Object.getOwnPropertyDescriptors(value),actual=Reflect.ownKeys(descriptors);
 check(actual.length===keys.length&&actual.every(key=>typeof key==='string'&&keys.includes(key)&&Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable===true));
 return value;
}
const scalarString=value=>{
 if(typeof value!=='string')return false;
 for(const point of value){const cp=point.codePointAt(0);if(cp>=0xd800&&cp<=0xdfff||cp===0)return false;}
 return true;
};
const validLabel=value=>scalarString(value)&&value.length<=250&&Boolean(value.trim());
const validUuid=value=>typeof value==='string'&&UUID.test(value);
const validIp=value=>typeof value==='string'&&isIP(value)>0;
function freeze(value){if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}
function canonical(value){
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
// Validated provenance contains closed object shapes, scalar strings and only
// small integer numeric fields. JSONB::text adds one space after each object
// colon and comma; object key ordering cannot change this byte count. This is
// a budget for this contract, not a general JSON/JSONB number or array codec.
function jsonbStructuralSpaceBytes(value){
 if(value===null||typeof value!=='object')return 0;
 const keys=Object.keys(value);
 return keys.length+Math.max(0,keys.length-1)+keys.reduce((total,key)=>total+jsonbStructuralSpaceBytes(value[key]),0);
}
function boundedClone(value){
 const text=canonical(value),bytes=Buffer.byteLength(text,'utf8');
 check(bytes<=MAX_ENVELOPE_BYTES&&bytes+jsonbStructuralSpaceBytes(value)<=MAX_ENVELOPE_BYTES);
 return freeze(JSON.parse(text));
}

export function sanitizeUserAgent(value){
 if(value==null)return freeze({value:null,state:'ABSENT',sanitized:false,truncated:false});
 if(typeof value!=='string')return freeze({value:null,state:'INVALID',sanitized:false,truncated:false});
 let text='',bytes=0,sanitized=false,truncated=false;
 for(const point of value){
  const cp=point.codePointAt(0);let retained=point,changed=false;
  if(cp>=0xd800&&cp<=0xdfff){retained='\ufffd';changed=true;}
  else if(cp<=0x1f||cp>=0x7f&&cp<=0x9f||cp===0x2028||cp===0x2029||cp>=0x202a&&cp<=0x202e||cp>=0x2066&&cp<=0x2069){retained=' ';changed=true;}
  const size=Buffer.byteLength(retained,'utf8');
  if(bytes+size>MAX_USER_AGENT_BYTES){truncated=true;break;}
  text+=retained;bytes+=size;sanitized||=changed;
 }
 return freeze({value:text,state:'PRESENT',sanitized,truncated});
}
function headerValue(headers,key){
 try{const field=headers&&Object.getOwnPropertyDescriptor(headers,key);if(!field)return {absent:true,value:undefined};if(!Object.hasOwn(field,'value'))return {absent:false,value:null,invalid:true};return {absent:field.value==null,value:field.value};}
 catch{return {absent:false,value:null,invalid:true};}
}
function validateAgent(value){
 record(value,['value','state','sanitized','truncated']);check(['ABSENT','INVALID','PRESENT'].includes(value.state));check(typeof value.sanitized==='boolean'&&typeof value.truncated==='boolean');
 if(value.state!=='PRESENT')check(value.value===null&&value.sanitized===false&&value.truncated===false);
 else{check(scalarString(value.value)&&Buffer.byteLength(value.value,'utf8')<=MAX_USER_AGENT_BYTES);check(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value.value));}
}
function validateRequest(value){
 record(value,['serverRequestId','requestIdState','peerIp','peerState','sourceIp','addressSource','forwardedState','userAgent']);
 check(['VALID','ABSENT','INVALID'].includes(value.requestIdState));check(value.requestIdState==='VALID'?validUuid(value.serverRequestId):value.serverRequestId===null);
 check(['VALID','ABSENT','INVALID'].includes(value.peerState));check(value.peerState==='VALID'?validIp(value.peerIp):value.peerIp===null);
 check(value.sourceIp===null||validIp(value.sourceIp));check(['SOCKET_PEER','TRUSTED_LOOPBACK_X_REAL_IP','UNKNOWN'].includes(value.addressSource));check(['USED','ABSENT','INVALID','IGNORED'].includes(value.forwardedState));
 if(value.addressSource==='TRUSTED_LOOPBACK_X_REAL_IP')check(loopback.has(value.peerIp)&&value.forwardedState==='USED'&&validIp(value.sourceIp));
 else{check(value.forwardedState!=='USED');if(value.addressSource==='SOCKET_PEER')check(validIp(value.peerIp)&&value.sourceIp===value.peerIp);else check(value.peerIp===null&&value.sourceIp===null);}
 validateAgent(value.userAgent);
}
export function captureHttpOrigin(request,{serverRequestId,trustProxyLoopback=false}={}){
 check(typeof trustProxyLoopback==='boolean');
 const peer=request?.socket?.remoteAddress,headers=request?.headers,forwarded=headerValue(headers,'x-real-ip'),agent=headerValue(headers,'user-agent');
 const peerState=validIp(peer)?'VALID':peer==null||peer===''?'ABSENT':'INVALID',peerIp=peerState==='VALID'?peer:null;
 let sourceIp=peerIp,addressSource=peerIp?'SOCKET_PEER':'UNKNOWN',forwardedState=forwarded.absent?'ABSENT':'IGNORED';
 if(trustProxyLoopback&&loopback.has(peer)){
  if(!forwarded.absent&&typeof forwarded.value==='string'&&isIP(forwarded.value)){sourceIp=forwarded.value;addressSource='TRUSTED_LOOPBACK_X_REAL_IP';forwardedState='USED';}
  else forwardedState=forwarded.absent?'ABSENT':'INVALID';
 }
 const requestIdState=validUuid(serverRequestId)?'VALID':serverRequestId==null?'ABSENT':'INVALID';
 const origin={serverRequestId:requestIdState==='VALID'?serverRequestId:null,requestIdState,peerIp,peerState,sourceIp,addressSource,forwardedState,userAgent:agent.invalid?{value:null,state:'INVALID',sanitized:false,truncated:false}:sanitizeUserAgent(agent.value)};
 validateRequest(origin);return boundedClone(origin);
}

function validateIdentity(value){
 record(value,['kind','userId','role','label']);check(['NAMED','PREVIEW','MAINTENANCE','UNKNOWN'].includes(value.kind));
 if(value.kind==='NAMED')check(validUuid(value.userId)&&roles.has(value.role)&&validLabel(value.label));
 if(value.kind==='PREVIEW')check(value.userId===null&&roles.has(value.role)&&validLabel(value.label));
 if(value.kind==='MAINTENANCE')check(value.userId===null&&value.role==='SYSTEM'&&validLabel(value.label));
 if(value.kind==='UNKNOWN')check(value.userId===null&&value.role===null&&value.label===null);
}
export function identityFromTrustedContext(context){
 const identity={kind:context?.authenticated===true?'NAMED':'PREVIEW',userId:context?.authenticated===true?context.userId:null,role:context?.role,label:context?.actor??context?.displayName};
 validateIdentity(identity);return boundedClone(identity);
}
export const unknownIdentity=()=>freeze({kind:'UNKNOWN',userId:null,role:null,label:null});
export function maintenanceIdentity(label){const value={kind:'MAINTENANCE',userId:null,role:'SYSTEM',label};validateIdentity(value);return boundedClone(value);}
function validateJob(job){record(job,['id','kind']);check(validUuid(job.id)&&['PREPARATION','BUSINESS_COMMAND'].includes(job.kind));}
function validateInitiator(value,{acceptedOnly=false}={}){
 record(value,['version','kind','identity','request','job']);check(value.version===1);check(['HTTP_ACCEPTANCE','LEGACY_OWNER_ONLY'].includes(value.kind));validateIdentity(value.identity);validateJob(value.job);
 if(value.kind==='HTTP_ACCEPTANCE'){check(['NAMED','PREVIEW'].includes(value.identity.kind));validateRequest(value.request);}
 else{check(!acceptedOnly&&value.request===null);}
}
export function createAcceptedInitiator({identity,request,job}){
 const value={version:1,kind:'HTTP_ACCEPTANCE',identity,request,job};validateInitiator(value,{acceptedOnly:true});return boundedClone(value);
}
function inspectStored(raw,validate){
 let result;
 if(raw==null)result={status:'LEGACY',value:null,code:'NOT_RECORDED'};
 else try{
  if(typeof raw==='string')check(Buffer.byteLength(raw,'utf8')<=MAX_ENVELOPE_BYTES);
  const value=typeof raw==='string'?JSON.parse(raw):raw;validate(value);const cloned=boundedClone(value);validate(cloned);result={status:'VALID',value:cloned};
 }catch{result={status:'INVALID',value:null,code:'AUDIT_PROVENANCE_INVALID',retryable:false,denyDomainWork:true,stopClaimLoop:true,requiresOperatorReview:true};}
 freeze(result);inspectionResults.add(result);return result;
}
export const inspectStoredInitiator=raw=>inspectStored(raw,value=>validateInitiator(value,{acceptedOnly:true}));
export const inspectStoredEnvelope=raw=>inspectStored(raw,validateEnvelope);
export function serializeAcceptedInitiator(value){if(value==null)return null;validateInitiator(value,{acceptedOnly:true});return canonical(boundedClone(value));}
export function selectEnqueueOrigin({existingJob,storedInitiator,candidate}){
 check(typeof existingJob==='boolean');
 if(existingJob){const read=inspectStoredInitiator(storedInitiator);if(read.status==='INVALID')return freeze({decision:'STOP_BEFORE_CLAIM',write:false,inspection:read});return freeze({decision:'REUSE',write:false,origin:read.value});}
 validateInitiator(candidate,{acceptedOnly:true});return freeze({decision:'ACCEPT_NEW',write:true,origin:boundedClone(candidate)});
}
function initialForEvent(read,job,legacyOwner){
 check(inspectionResults.has(read));check(read.status!=='INVALID');validateJob(job);
 if(read.status==='VALID'){check(canonical(read.value.job)===canonical(job));return read.value;}
 const value={version:1,kind:'LEGACY_OWNER_ONLY',identity:legacyOwner??unknownIdentity(),request:null,job};validateInitiator(value);return boundedClone(value);
}
function validateEnvelope(value){
 record(value,['version','phase','actor','eventRequest','initiator','execution','originState']);check(value.version===1);check(['DIRECT','QUEUE','CONTROL','WORKER','REFUSAL','MAINTENANCE'].includes(value.phase));validateIdentity(value.actor);
 const ex=record(value.execution,['processRole','instanceId','traceId','job','attempt']);check(processRoles.has(ex.processRole)&&validUuid(ex.instanceId)&&validUuid(ex.traceId));
 if(ex.job===null)check(ex.attempt===null);else{validateJob(ex.job);check(Number.isInteger(ex.attempt)&&ex.attempt>=0&&ex.attempt<=3);}
 if(value.initiator!==null){validateInitiator(value.initiator);check(ex.job!==null&&canonical(value.initiator.job)===canonical(ex.job));}
 if(['DIRECT','QUEUE','CONTROL'].includes(value.phase)){
  check(['api','combined'].includes(ex.processRole));validateRequest(value.eventRequest);check(value.originState==='HTTP_CAPTURED');
  if(value.phase==='DIRECT')check(value.initiator===null&&ex.job===null&&['NAMED','PREVIEW','UNKNOWN'].includes(value.actor.kind));
  else{
   check(['NAMED','PREVIEW'].includes(value.actor.kind)&&value.initiator!==null&&ex.job!==null);
   if(value.phase==='QUEUE'){const initial=value.initiator.identity;check(ex.attempt===0&&value.initiator.kind==='HTTP_ACCEPTANCE'&&value.actor.kind===initial.kind&&value.actor.role===initial.role&&(value.actor.kind==='NAMED'?value.actor.userId===initial.userId:canonical(value.actor)===canonical(initial))&&canonical(value.eventRequest)===canonical(value.initiator.request));}
  }
 }else{
  check(value.eventRequest===null);
  if(value.phase==='MAINTENANCE')check(value.originState==='NON_HTTP'&&value.initiator===null&&ex.job===null&&['MAINTENANCE','UNKNOWN'].includes(value.actor.kind));
  else if(value.phase==='REFUSAL')check(['worker','combined'].includes(ex.processRole)&&ex.job!==null&&ex.attempt>=0&&value.originState==='CORRUPT_REFUSED'&&value.initiator===null);
  else{
   check(['worker','combined'].includes(ex.processRole)&&ex.job!==null&&ex.attempt>=1);
   check(value.initiator!==null&&value.originState===(value.initiator.kind==='HTTP_ACCEPTANCE'?'RETAINED_ACCEPTANCE':'LEGACY_NOT_RECORDED'));
   if(value.actor.kind==='NAMED'&&value.initiator.identity.kind==='NAMED')check(value.actor.userId===value.initiator.identity.userId);
  }
 }
}
export function serializeAuditEnvelope(value){if(value==null)return null;validateEnvelope(value);return canonical(boundedClone(value));}

export function createProvenanceRuntime({processRole,instanceId,trustProxyLoopback=false}){
 check(processRoles.has(processRole)&&validUuid(instanceId)&&typeof trustProxyLoopback==='boolean');
 const event=({phase,actor,eventRequest=null,initiator=null,job=null,attempt=null,originState})=>{
  const value={version:1,phase,actor,eventRequest,initiator,execution:{processRole,instanceId,traceId:randomUUID(),job,attempt},originState};validateEnvelope(value);return boundedClone(value);
 };
 return Object.freeze({
  capture:(request,{serverRequestId}={})=>captureHttpOrigin(request,{serverRequestId,trustProxyLoopback}),
  direct:({actor,request})=>event({phase:'DIRECT',actor,eventRequest:request,originState:'HTTP_CAPTURED'}),
  queued:({initiator})=>{validateInitiator(initiator,{acceptedOnly:true});return event({phase:'QUEUE',actor:initiator.identity,eventRequest:initiator.request,initiator,job:initiator.job,attempt:0,originState:'HTTP_CAPTURED'});},
  control:({actor,request,job,attempt,origin,legacyOwner})=>event({phase:'CONTROL',actor,eventRequest:request,initiator:initialForEvent(origin,job,legacyOwner),job,attempt,originState:'HTTP_CAPTURED'}),
  worker:({actor,job,attempt,origin,legacyOwner})=>{const initiator=initialForEvent(origin,job,legacyOwner);return event({phase:'WORKER',actor,initiator,job,attempt,originState:initiator.kind==='HTTP_ACCEPTANCE'?'RETAINED_ACCEPTANCE':'LEGACY_NOT_RECORDED'});},
  maintenance:({actor=unknownIdentity()}={})=>event({phase:'MAINTENANCE',actor,originState:'NON_HTTP'}),
  forWriter:(context,{actor})=>{const basis=auditBasisForWriter(context);return basis?event({...basis,actor}):null;},
  corruptOriginRefusal:({origin,job,attempt,actor=unknownIdentity()})=>{
   check(inspectionResults.has(origin)&&origin.status==='INVALID');
   return freeze({decision:'STOP_BEFORE_DOMAIN_WORK',code:'AUDIT_PROVENANCE_INVALID',retryable:false,stopClaimLoop:true,requiresOperatorReview:true,auditEnvelope:event({phase:'REFUSAL',actor,job,attempt,originState:'CORRUPT_REFUSED'})});
  }
 });
}

export function bindAuditContext(context,envelope){check(context!==null&&typeof context==='object');if(envelope==null)contextOrigins.delete(context);else{validateEnvelope(envelope);const basis={phase:envelope.phase,eventRequest:envelope.eventRequest,initiator:envelope.initiator,job:envelope.execution.job,attempt:envelope.execution.attempt,originState:envelope.originState};contextOrigins.set(context,boundedClone(basis));}return context;}
export function copyAuditContext(source,refreshed){check(refreshed!==null&&typeof refreshed==='object');const envelope=source&&contextOrigins.get(source);if(envelope)contextOrigins.set(refreshed,envelope);else contextOrigins.delete(refreshed);return refreshed;}
export function auditBasisForWriter(context){const basis=context&&contextOrigins.get(context);return basis?boundedClone(basis):null;}
