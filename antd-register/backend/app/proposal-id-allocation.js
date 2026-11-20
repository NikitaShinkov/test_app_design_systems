import {createHash} from 'node:crypto';
import {cleanText} from './normalization.js';

export const PROPOSAL_ALLOCATION_VERSION='PROPOSAL-ALLOCATION-v1';
const LONG_MIN=-2147483648n,LONG_MAX=2147483647n;
const caches=new WeakMap();
const fail=(code,message,status=422)=>Object.assign(new Error(message),{status,code});
const invalid=()=>fail('PROPOSAL_ALLOCATION_STATE_INVALID','The proposal numbering snapshot could not be verified. Refresh the import review before continuing.',409);
const overflow=()=>fail('PROPOSAL_ALLOCATION_OVERFLOW','Proposal numbering exceeds the supported 32-bit range. Ask an administrator to review the numbering before importing.');
const unsupported=()=>fail('PROPOSAL_ALLOCATION_NUMERIC_UNSUPPORTED','Proposal numbering contains a numeric format that requires administrator review. No proposal ID was allocated.');

export const proposalIdPrefix=orderNo=>`P-${cleanText(orderNo).replaceAll(' ','')}-`;

function integerSuffix(suffix){
  if(/^[+-]?\d+$/.test(suffix)){
    const unsigned=suffix.replace(/^[+-]/,'').replace(/^0+/,'')||'0';
    if(unsigned.length>10)return {error:'OVERFLOW'};
    const value=BigInt((suffix.startsWith('-')?'-':'')+unsigned);
    return value<LONG_MIN||value>LONG_MAX?{error:'OVERFLOW'}:{value};
  }
  // These complete numeric forms depend on VBA's numeric locale/conversion.
  // Refuse them explicitly instead of guessing IsNumeric/CLng equivalence.
  // Definite nonnumeric text such as 12junk remains ignored, as in the macro.
  const numericText=suffix.replace(/^[\s\p{Sc}+-]+|[\s\p{Sc}]+$/gu,'');
  if(/^[\p{N}.,\s]+(?:[eEdD][+\-]?\d+)?$/u.test(numericText)
    ||/^\s*&[hHoO][0-9a-fA-F]+\s*$/.test(suffix)
    ||/^\s*\([\s\p{Sc}\p{N}.,]+\)\s*$/u.test(suffix))return {error:'UNSUPPORTED'};
  return null;
}

function indexId(cache,id){
  const text=cleanText(id);
  if(text.slice(0,2).toUpperCase()!=='P-')return;
  // Index every viable separator, including the boundary before a negative
  // suffix. Prefix matching is based on the ID, never its row's Order_No.
  for(let position=2;position<text.length;position++){
    if(text[position]!=='-')continue;
    const parsed=integerSuffix(text.slice(position+1));if(!parsed)continue;
    const prefix=text.slice(0,position+1).toUpperCase();
    let entry=cache.namespaces.get(prefix);
    if(!entry){entry={maximum:0n,error:null};cache.namespaces.set(prefix,entry);}
    if(parsed.error){entry.error ||= parsed.error;continue;}
    if(parsed.value>entry.maximum)entry.maximum=parsed.value;
  }
}

function cacheFor(snapshot){
  if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)
    ||snapshot.version!==PROPOSAL_ALLOCATION_VERSION||!Array.isArray(snapshot.proposalIds))throw invalid();
  let cache=caches.get(snapshot);
  if(cache&&cache.ids===snapshot.proposalIds&&cache.length===snapshot.proposalIds.length)return cache;
  cache={ids:snapshot.proposalIds,length:0,namespaces:new Map(),rawIds:new Set()};
  for(const id of snapshot.proposalIds){if(typeof id!=='string')throw invalid();cache.rawIds.add(id);indexId(cache,id);}
  cache.length=snapshot.proposalIds.length;caches.set(snapshot,cache);return cache;
}

function addId(snapshot,cache,id){
  if(cache.rawIds.has(id))return;
  snapshot.proposalIds.push(id);cache.rawIds.add(id);indexId(cache,id);cache.length=snapshot.proposalIds.length;
}

// A caller supplies a private snapshot and clones it at mutation/worker
// boundaries. WeakMap indexes never serialize or enter public DTOs. Retained
// IDs include archived rows; physical deletion/reuse is not supported here.
export function captureProposalAllocationSnapshot(proposals,previousSnapshot=null){
  if(!Array.isArray(proposals))throw invalid();
  const snapshot=previousSnapshot??{version:PROPOSAL_ALLOCATION_VERSION,proposalIds:[]},cache=cacheFor(snapshot);
  // Capture the complete current input at an operation/review boundary. This
  // also notices a repaired blank identity without assuming a stable array's
  // existing IDs never change. Per-row allocation below only reserves an ID.
  for(let index=0;index<proposals.length;index++){
    const row=proposals[index],id=typeof row==='string'?row:row?.proposalId;
    if(id!==undefined&&id!==null){if(typeof id!=='string')throw invalid();addId(snapshot,cache,id);}
  }
  return snapshot;
}

function outcome(cache,prefix){
  const entry=cache.namespaces.get(prefix.toUpperCase())||{maximum:0n,error:null};
  return {...entry,error:entry.error||(entry.maximum===LONG_MAX?'OVERFLOW':null)};
}

export function allocateProposalIdFromSnapshot(snapshot,orderNo){
  const cache=cacheFor(snapshot),prefix=proposalIdPrefix(orderNo),entry=outcome(cache,prefix);
  if(entry.error==='OVERFLOW')throw overflow();
  if(entry.error==='UNSUPPORTED')throw unsupported();
  const id=prefix+String(entry.maximum+1n).padStart(4,'0');
  addId(snapshot,cache,id);return id;
}

export function proposalAllocationFingerprint(snapshot,orderNos){
  if(!Array.isArray(orderNos))throw invalid();
  const cache=cacheFor(snapshot),prefixes=[...new Set(orderNos.map(order=>proposalIdPrefix(order).toUpperCase()))].sort();
  const namespaces=prefixes.map(prefix=>{const entry=outcome(cache,prefix);return {prefix,maximum:String(entry.maximum),error:entry.error};});
  return createHash('sha256').update(JSON.stringify({version:PROPOSAL_ALLOCATION_VERSION,namespaces})).digest('hex');
}
