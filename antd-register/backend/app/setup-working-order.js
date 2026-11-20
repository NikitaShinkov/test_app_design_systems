import {proposalWorkingOrderInventory} from './working-order-operations.js';

const savepoint='m90_proposal_working_order',maximum=9223372036854775807n;
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value,names)=>plain(value)&&Object.keys(value).sort().join(',')===names;
const decimal=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=maximum;
function summary(value){
 const p=value?.proposals,s=value?.sequence;
 if(!keys(value,'formatVersion,proposals,sequence')||value.formatVersion!==1||!keys(p,'known,records,sha256,unknown')||!keys(s,'cache,cycle,increment,isCalled,lastValue,maximum,minimum,start')||!['records','known','unknown'].every(key=>Number.isSafeInteger(p[key])&&p[key]>=0)||!Number.isSafeInteger(p.known+p.unknown)||p.known+p.unknown!==p.records||typeof p.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.sha256)||!decimal(s.start)||!decimal(s.lastValue)||BigInt(s.lastValue)<BigInt(s.start)||s.increment!=='1'||s.minimum!=='1'||s.maximum!==String(maximum)||s.cache!=='1'||s.cycle!==false||typeof s.isCalled!=='boolean')throw Error('Invalid working-order inventory.');
 return {records:p.records,known:p.known,unknown:p.unknown};
}

/** Read-only inventory in the caller's repeatable-read capture. Unknown legacy
 * order is a readiness finding, separate from invalid schema or metadata. */
export async function captureWorkingOrderValidation(client,{inspect=proposalWorkingOrderInventory}={}){
 await client.query('savepoint '+savepoint);
 let counts;
 try{counts=summary(await inspect(client));}
 catch{
  await client.query('rollback to savepoint '+savepoint);await client.query('release savepoint '+savepoint);
  return {check:{id:'proposal_working_order',status:'FAILED',checked:0,message:'Proposal working-order schema or retained metadata integrity could not be verified.'},findings:[{section:'proposal_working_order',code:'WORKING_ORDER_INTEGRITY',severity:'ERROR',field:'workingOrder',message:'Verify migration040 columns, sequence, enforced unique/positive constraints, immutable guards and retained order metadata. M90 does not assign order or derive it from proposal IDs, dates or supplier source rows.'}]};
 }
 await client.query('release savepoint '+savepoint);
 const findings=counts.unknown?[{section:'proposal_working_order',code:'WORKING_ORDER_UNKNOWN',severity:'WARNING',field:'workingOrder',message:`${counts.unknown} legacy proposal(s) have no verified Check working order. Order-sensitive operations refuse any selected scope containing them. Restore one complete proven legacy mapping through the database owner; unrelated known scopes remain usable. M90 does not repair records.`}]:[];
 return {check:{id:'proposal_working_order',status:counts.unknown?'WARN':'PASSED',checked:counts.records,message:`Verified migration040 physical protections and ${counts.known} known proposal order value(s); ${counts.unknown} legacy SQL-NULL value(s) remain unknown. No order was assigned.`},findings};
}

export function localWorkingOrderValidation(){
 return {check:{id:'proposal_working_order',status:'NOT_APPLICABLE',checked:0,message:'Local desktop proposals use their retained array order. This check does not establish PostgreSQL migration040 schema or server order readiness.'},findings:[]};
}
