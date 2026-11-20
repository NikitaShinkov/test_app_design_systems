import {roundRequest,managedRoundId} from './round-management.js';
import {associationRequest} from './round-association-plan.js';
import {normalize} from './normalization.js';
import {roundDigest} from './workflow-rounds.js';
import {httpError} from './auth.js';

const invalid=()=>{throw httpError(409,'The retained round receipt failed its integrity check. Ask an administrator to verify the saved history.',{code:'ROUND_RECEIPT_INVALID'});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const same=(left,right)=>roundDigest(left)===roundDigest(right);
/** Validate retained intent, not an intent reconstructed from mutable heads. */
export function roundReceiptRequest(receipt){
  try{
    if(!object(receipt)||typeof receipt.ownerKey!=='string'||!receipt.ownerKey||!object(receipt.requestJson)||!object(receipt.payload))invalid();
    const parse=receipt.kind==='LIFECYCLE'?roundRequest:receipt.kind==='ASSOCIATION'?associationRequest:null;if(!parse)invalid();
    const request=parse(receipt.requestJson),payload=receipt.payload;
    if(!same(request,receipt.requestJson)||receipt.requestId!==request.requestId||receipt.requestHash!==roundDigest(request)||payload.requestId!==request.requestId||payload.action!==request.action)invalid();
    if(receipt.kind==='LIFECYCLE'){
      const roundId=request.action==='CREATE'?managedRoundId(request.workflowId,normalize(request.roundLabel)):request.roundId,status=request.action==='CLOSE'?'CLOSED':request.action==='CANCEL'?'CANCELLED':'OPEN';
      if(payload.roundId!==roundId||payload.reason!==request.reason||payload.status!==status||!Number.isSafeInteger(payload.version)||payload.version!==request.expectedVersion+1)invalid();
      if(request.action==='CREATE'&&(payload.workflowId!==request.workflowId||payload.roundLabel!==request.roundLabel))invalid();
    }else{
      const ids=request.selections.map(item=>item.exchangeId),changed=payload.changedExchangeIds,unchanged=payload.unchangedExchangeIds;
      if(payload.requestHash!==receipt.requestHash||payload.targetRoundId!==request.targetRoundId||payload.selected!==ids.length||!same(payload.exchangeIds,ids)||!Array.isArray(changed)||!Array.isArray(unchanged)||!Array.isArray(payload.associations))invalid();
      if(payload.changed!==changed.length||payload.unchanged!==unchanged.length||changed.length+unchanged.length!==ids.length||!same([...changed,...unchanged].sort(),[...ids].sort())||new Set([...changed,...unchanged]).size!==ids.length||payload.associations.length!==ids.length)invalid();
      const heads=new Map(payload.associations.map(head=>[head.exchangeId,head]));if(heads.size!==ids.length)invalid();
      for(const selection of request.selections){const head=heads.get(selection.exchangeId);if(!head||head.roundId!==request.targetRoundId||head.version!==selection.expectedVersion+(changed.includes(selection.exchangeId)?1:0))invalid();}
    }
    return request;
  }catch{invalid();}
}
export function roundReceiptIntegrity(receipt){try{roundReceiptRequest(receipt);return true;}catch{return false;}}
export function createRoundReceipt(ownerKey,request,kind,payload){const receipt={ownerKey,requestId:request.requestId,requestHash:roundDigest(request),requestJson:structuredClone(request),kind,payload:structuredClone(payload)};roundReceiptRequest(receipt);return receipt;}
