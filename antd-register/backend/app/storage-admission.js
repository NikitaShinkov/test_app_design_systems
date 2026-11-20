import fs from 'node:fs/promises';
import {httpError} from './auth.js';

const MiB=1024*1024,TiB=1024**4;
export const storageAdmissionDefaults=Object.freeze({minFreeBytes:256*MiB,maxObjectBytes:30*MiB,overheadBytes:MiB});
const configuration=(name)=>Object.assign(new Error(`Invalid ${name}. Use an integer byte count within the supported storage-admission range.`),{code:'FILE_STORAGE_CONFIGURATION',status:500});
const unavailable=()=>httpError(503,'Available file storage could not be verified. Ask an administrator to check the file store before retrying.',{code:'FILE_STORAGE_UNAVAILABLE'});
function integer(value){
  if(typeof value==='bigint')return value;
  if(typeof value==='number'&&Number.isSafeInteger(value))return BigInt(value);
  return null;
}
function limit(value,name,minimum,maximum){
  const parsed=integer(value);if(parsed===null||parsed<BigInt(minimum)||parsed>BigInt(maximum))throw configuration(name);return parsed;
}
function policy(limits={}){
  if(!limits||typeof limits!=='object'||Array.isArray(limits))throw configuration('storage limits');
  const minFreeBytes=limit(limits.minFreeBytes??storageAdmissionDefaults.minFreeBytes,'RR_FILE_MIN_FREE_BYTES',16*MiB,TiB);
  const maxObjectBytes=limit(limits.maxObjectBytes??storageAdmissionDefaults.maxObjectBytes,'RR_MAX_FILE_BYTES',1,30*MiB);
  const overheadBytes=limit(limits.overheadBytes??storageAdmissionDefaults.overheadBytes,'file storage overhead',MiB,MiB);
  return {minFreeBytes,maxObjectBytes,overheadBytes};
}
function environmentBytes(env,name,fallback){
  if(env[name]===undefined)return fallback;
  if(typeof env[name]!=='string'||!/^\d+$/.test(env[name])||env[name].length>16)throw configuration(name);
  const value=BigInt(env[name]);if(value>BigInt(Number.MAX_SAFE_INTEGER))throw configuration(name);return Number(value);
}

/** Startup configuration. The reserve cannot be silently disabled with zero. */
export function storageAdmissionLimits(env=process.env){
  const configured={minFreeBytes:environmentBytes(env,'RR_FILE_MIN_FREE_BYTES',storageAdmissionDefaults.minFreeBytes),maxObjectBytes:environmentBytes(env,'RR_MAX_FILE_BYTES',storageAdmissionDefaults.maxObjectBytes),overheadBytes:MiB};
  policy(configured);return configured;
}
function incoming(value,maxObjectBytes){
  const bytes=integer(value);
  if(bytes===null||bytes<=0n)throw httpError(413,'Choose a non-empty file with a valid integer byte size.',{code:'FILE_OBJECT_SIZE_INVALID'});
  if(bytes>maxObjectBytes)throw httpError(413,`The file exceeds the configured maximum of ${maxObjectBytes} bytes.`,{code:'FILE_OBJECT_TOO_LARGE'});
  return bytes;
}
function reserveFailure(missingBytes){
  return httpError(507,'The file cannot be stored while preserving the required free-space reserve. Ask an administrator to check available storage.',{code:'FILE_STORAGE_RESERVE',details:missingBytes===undefined?['No new object was admitted. Retry after available storage has been checked.']:[`${missingBytes} additional byte(s) are needed for this object and the required reserve. No new object was admitted.`]});
}

/** Pure admission check for one NEW physical object, not a stored-content dedupe. */
export function validateStorageAdmission({availableBytes,incomingBytes}={},limits={}){
  const selected=policy(limits),bytes=incoming(incomingBytes,selected.maxObjectBytes),available=integer(availableBytes);
  if(available===null||available<0n)throw unavailable();
  // Current publication writes one temporary object and hard-links the final
  // name on the same filesystem. The fixed allowance covers small metadata and
  // block-rounding estimates; it is not a reservation against concurrent writers.
  const required=selected.minFreeBytes+bytes+selected.overheadBytes;
  if(available<required)throw reserveFailure(required-available);
  return {incomingBytes:bytes.toString(),requiredBytes:required.toString(),remainingBytes:(available-bytes-selected.overheadBytes).toString(),minFreeBytes:selected.minFreeBytes.toString(),overheadBytes:selected.overheadBytes.toString()};
}

/** Read the destination filesystem only. Caller creates/selects its real parent
 * directory and bypasses this check when exact retained content already exists.
 * No mkdir, allocation, retention, deletion or content lookup occurs here. */
export async function checkObjectStorageSpace(directory,incomingBytes,{statfs=fs.statfs,limits={}}={}){
  const selected=policy(limits);incoming(incomingBytes,selected.maxObjectBytes);
  let observation;
  try{observation=await statfs(directory,{bigint:true});}
  catch(error){if(error?.code==='ENOSPC')throw reserveFailure();throw unavailable();}
  const availableBlocks=integer(observation?.bavail),blockBytes=integer(observation?.bsize);
  if(availableBlocks===null||availableBlocks<0n||blockBytes===null||blockBytes<=0n)throw unavailable();
  return validateStorageAdmission({availableBytes:availableBlocks*blockBytes,incomingBytes},selected);
}
