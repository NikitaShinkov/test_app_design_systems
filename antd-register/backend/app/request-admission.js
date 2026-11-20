// In-process body admission only. No filesystem, database, timers or hidden
// environment reads. The caller supplies an authenticated opaque owner key.
const MiB=1024*1024;
export const admissionDefaults=Object.freeze({maxActive:2,maxPerOwner:1,maxReservedBytes:60*MiB,maxRequestBytes:30*MiB,retryAfterSeconds:3,maxPending:20,maxPendingPerOwner:3});
const bounds={maxActive:[1,32],maxPerOwner:[1,32],maxReservedBytes:[1,1024*MiB],maxRequestBytes:[1,30*MiB],retryAfterSeconds:[1,60],maxPending:[1,1000],maxPendingPerOwner:[1,1000]};
const environment={maxActive:'RR_UPLOAD_MAX_ACTIVE',maxPerOwner:'RR_UPLOAD_MAX_PER_OWNER',maxReservedBytes:'RR_UPLOAD_MAX_RESERVED_BYTES',maxRequestBytes:'RR_UPLOAD_MAX_REQUEST_BYTES',retryAfterSeconds:'RR_UPLOAD_RETRY_AFTER_SECONDS',maxPending:'RR_PREPARATION_MAX_PENDING',maxPendingPerOwner:'RR_PREPARATION_MAX_PENDING_PER_OWNER'};
const error=(status,code,message,extra={})=>Object.assign(new Error(message),{status,code,...extra});
function configuration(values){
  if(!values||typeof values!=='object'||Array.isArray(values))throw TypeError('Admission configuration must be an object.');
  for(const key of Object.keys(values))if(!Object.hasOwn(admissionDefaults,key))throw TypeError(`Unsupported admission configuration field: ${key}.`);
  const result={...admissionDefaults,...values};
  for(const [key,[minimum,maximum]]of Object.entries(bounds))if(!Number.isSafeInteger(result[key])||result[key]<minimum||result[key]>maximum)throw TypeError(`Admission ${key} must be an integer from ${minimum} to ${maximum}.`);
  if(result.maxPerOwner>result.maxActive)throw TypeError('Admission maxPerOwner cannot exceed maxActive.');
  if(result.maxReservedBytes<result.maxRequestBytes)throw TypeError('Admission maxReservedBytes must cover one maxRequestBytes reservation.');
  if(result.maxPendingPerOwner>result.maxPending)throw TypeError('Admission maxPendingPerOwner cannot exceed maxPending.');
  return Object.freeze(result);
}

export function requestAdmissionConfig(env={}){
  if(!env||typeof env!=='object'||Array.isArray(env))throw TypeError('Admission environment must be an object.');
  const values={};for(const [key,name]of Object.entries(environment))if(env[name]!==undefined){
    const text=String(env[name]).trim();if(!/^\d+$/.test(text))throw TypeError(`${name} must be a positive decimal integer.`);values[key]=Number(text);
  }
  return configuration(values);
}
const retry=limits=>({retryAfter:limits.retryAfterSeconds,headers:{'Retry-After':String(limits.retryAfterSeconds)}});
function busy(limits){throw error(429,'UPLOAD_ADMISSION_BUSY','Upload capacity is busy. Wait briefly and try again.',retry(limits));}

export function assertPreparationAdmission(status,values={}){
  const limits=configuration(values);
  if(!status||!Number.isSafeInteger(status.global)||status.global<0||!Number.isSafeInteger(status.owner)||status.owner<0||status.owner>status.global)throw error(503,'PREPARATION_ADMISSION_UNAVAILABLE','Preparation capacity could not be verified. Try again shortly.',retry(limits));
  if(status.global>=limits.maxPending||status.owner>=limits.maxPendingPerOwner)throw error(429,'PREPARATION_ADMISSION_BUSY','The preparation queue is busy. Wait for an existing preparation to finish and try again.',retry(limits));
  return true;
}

export function declaredRequestBytes(value,maximumBytes){
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>30*MiB)throw TypeError('Request body maximum must be a positive integer no larger than 30 MiB.');
  if(value===undefined)return null;
  if((typeof value!=='string'&&typeof value!=='number')||(typeof value==='string'&&!/^\d+$/.test(value))||(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0)))throw error(400,'INVALID_CONTENT_LENGTH','Content-Length must be one nonnegative decimal integer.');
  const bytes=Number(value);if(!Number.isSafeInteger(bytes)||bytes>maximumBytes)throw error(413,'REQUEST_BODY_TOO_LARGE','The declared request body exceeds the permitted size.');
  return bytes;
}

export class RequestAdmission {
  #limits;#active=0;#reserved=0;#owners=new Map();
  constructor(values={}){this.#limits=configuration(values);}
  get limits(){return this.#limits;}
  snapshot(){return Object.freeze({active:this.#active,reservedBytes:this.#reserved,remainingSlots:this.#limits.maxActive-this.#active,remainingReservedBytes:this.#limits.maxReservedBytes-this.#reserved});}
  acquire({ownerKey,contentLength,maximumBytes=this.#limits.maxRequestBytes,capacity}={}){
    if(typeof ownerKey!=='string'||!ownerKey||ownerKey.length>256)throw TypeError('Admission requires an opaque authenticated owner key of 1–256 characters.');
    if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>30*MiB)throw TypeError('Request body maximum must be a positive integer no larger than 30 MiB.');
    const maximum=Math.min(maximumBytes,this.#limits.maxRequestBytes),declared=declaredRequestBytes(contentLength,maximum),reservation=declared??maximum;
    if(capacity!==undefined)assertPreparationAdmission(capacity,this.#limits);
    const owned=this.#owners.get(ownerKey)||0;
    if(this.#active>=this.#limits.maxActive||owned>=this.#limits.maxPerOwner||this.#reserved+reservation>this.#limits.maxReservedBytes)busy(this.#limits);
    this.#active++;this.#reserved+=reservation;this.#owners.set(ownerKey,owned+1);
    let released=false,received=0,bound=false;const listeners=[];
    const release=()=>{
      if(released)return false;released=true;
      for(const [source,name,handler]of listeners)source.off(name,handler);listeners.length=0;
      this.#active--;this.#reserved-=reservation;const count=this.#owners.get(ownerKey)-1;if(count)this.#owners.set(ownerKey,count);else this.#owners.delete(ownerKey);return true;
    };
    const permit={reservedBytes:reservation,maximumBytes:maximum,declaredBytes:declared,get released(){return released;},release,
      observe:bytes=>{
        if(released)throw error(409,'UPLOAD_ADMISSION_RELEASED','This upload reservation has ended. Start a new request.');
        if(!Number.isSafeInteger(bytes)||bytes<0){release();throw TypeError('Observed body bytes must be a nonnegative integer.');}
        if(bytes>maximum-received){release();throw error(413,'REQUEST_BODY_TOO_LARGE','The request body exceeds the permitted size.');}
        if(declared!==null&&bytes>declared-received){release();throw error(400,'CONTENT_LENGTH_MISMATCH','The received request body exceeds Content-Length.');}
        received+=bytes;return received;
      },
      complete:()=>{if(released)throw error(409,'UPLOAD_ADMISSION_RELEASED','This upload reservation has ended. Start a new request.');if(declared!==null&&received!==declared){release();throw error(400,'CONTENT_LENGTH_MISMATCH','The received request body does not match Content-Length.');}return received;},
      finish:()=>{if(released)return false;permit.complete();return release();},
      bind:(request,response)=>{
        if(released)return permit;if(bound)throw TypeError('An admission permit may be bound only once.');
        if(!request||!response||![request,response].every(source=>typeof source.once==='function'&&typeof source.off==='function')){release();throw TypeError('Admission binding requires request and response event sources.');}
        bound=true;
        try{for(const [source,names]of [[request,['aborted','error']],[response,['finish','close','error']]])for(const name of names){const handler=()=>release();listeners.push([source,name,handler]);source.once(name,handler);}}
        catch(error){release();throw error;}
        if(request.aborted||response.destroyed||response.writableFinished)release();return permit;
      }
    };
    return Object.freeze(permit);
  }
  async run(options,operation){
    if(typeof operation!=='function')throw TypeError('Admission run requires an operation.');
    const permit=this.acquire(options);try{return await operation(permit);}finally{permit.release();}
  }
}
