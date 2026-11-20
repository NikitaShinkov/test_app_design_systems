import {RequestAdmission} from './request-admission.js';
import {createHash} from 'node:crypto';
import {normalize} from './normalization.js';

// Execution ownership is shared by HTTP, command and preparation paths. This
// does not replace any durable job's original ownership or authorization key.
export function workloadOwnerKey(context={}){
  if(context.authenticated&&typeof context.userId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(context.userId))return context.userId.toLowerCase();
  const owner={role:context.role||'',actor:context.actor||'',organization:normalize(context.organization||''),orders:[...new Set((context.orders||[]).map(normalize))].sort()};
  return 'LOCAL:'+createHash('sha256').update(JSON.stringify(owner)).digest('hex');
}

export const workloadAdmissionDefaults=Object.freeze({maxActive:1,maxPerOwner:1,retryAfterSeconds:3});
const names={maxActive:'RR_WORKLOAD_MAX_ACTIVE',maxPerOwner:'RR_WORKLOAD_MAX_PER_OWNER',retryAfterSeconds:'RR_WORKLOAD_RETRY_AFTER_SECONDS'};
function configuration(values={}){
  if(!values||typeof values!=='object'||Array.isArray(values))throw TypeError('Workload admission configuration must be an object.');
  for(const key of Object.keys(values))if(!Object.hasOwn(workloadAdmissionDefaults,key))throw TypeError(`Unsupported workload admission setting: ${key}.`);
  const limits={...workloadAdmissionDefaults,...values};
  for(const [key,maximum]of [['maxActive',2],['maxPerOwner',2],['retryAfterSeconds',60]])if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>maximum)throw TypeError(`${names[key]} must be an integer from 1 to ${maximum}.`);
  if(limits.maxPerOwner>limits.maxActive)throw TypeError('Workload maxPerOwner cannot exceed maxActive.');return Object.freeze(limits);
}
export function workloadAdmissionConfig(env={}){
  if(!env||typeof env!=='object'||Array.isArray(env))throw TypeError('Workload admission environment must be an object.');
  const values={};for(const [key,name]of Object.entries(names))if(env[name]!==undefined){if(typeof env[name]!=='string'||!/^\d+$/.test(env[name]))throw TypeError(`${name} must be a positive decimal integer.`);values[key]=Number(env[name]);}return configuration(values);
}

/** An execution slot, not a body-byte or RSS reservation. It deliberately has
 * no response-close release: disconnected HTTP does not stop an awaited SQL
 * snapshot/report operation. Release only after that operation has settled. */
export class WorkloadAdmission {
  #limits;#gate;
  constructor(values={}){this.#limits=configuration(values);this.#gate=new RequestAdmission({...this.#limits,maxRequestBytes:1,maxReservedBytes:1});}
  get limits(){return this.#limits;}
  snapshot(){const state=this.#gate.snapshot();return Object.freeze({active:state.active,remainingSlots:state.remainingSlots});}
  async run({ownerKey}={},operation){
    if(typeof operation!=='function')throw TypeError('Workload admission requires an operation.');
    let permit;try{permit=this.#gate.acquire({ownerKey,contentLength:0,maximumBytes:1});}
    catch(error){if(error.code!=='UPLOAD_ADMISSION_BUSY')throw error;throw Object.assign(new Error('An expensive report or validation is already running. Wait briefly and try again.'),{status:429,code:'WORKLOAD_ADMISSION_BUSY',retryAfter:this.#limits.retryAfterSeconds,headers:{'Retry-After':String(this.#limits.retryAfterSeconds)}});}
    try{return await operation();}finally{permit.release();}
  }
}
