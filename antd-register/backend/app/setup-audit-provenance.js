import {auditProvenanceInventory} from './audit-provenance-operations.js';

const savepoint='m90_audit_provenance';
const tables=['audit_events','preparation_jobs','business_command_jobs'];
const invalid=()=>new Error('The audit provenance inventory summary is invalid.');
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function summary(inventory){
 if(!plain(inventory)||inventory.formatVersion!==1||Object.keys(inventory).sort().join(',')!==['formatVersion',...tables].sort().join(','))throw invalid();
 let records=0,legacy=0,recorded=0;
 for(const table of tables){
  const item=inventory[table];
  if(!plain(item)||Object.keys(item).sort().join(',')!=='legacySqlNull,recorded,records,sha256'||!['records','legacySqlNull','recorded'].every(key=>Number.isSafeInteger(item[key])&&item[key]>=0)||item.legacySqlNull+item.recorded!==item.records||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw invalid();
  records+=item.records;legacy+=item.legacySqlNull;recorded+=item.recorded;
 }
 if(![records,legacy,recorded].every(Number.isSafeInteger))throw invalid();
 return {records,legacy,recorded};
}

/** The caller owns the read-only repeatable-read transaction. The existing
 * inventory verifies physical039 guards even on empty tables, then transfers
 * only bounded metadata pages. No source row, JSON payload or SQL error escapes. */
export async function captureAuditProvenanceValidation(client,{inspect=auditProvenanceInventory}={}){
 await client.query('savepoint '+savepoint);
 let totals;
 try{totals=summary(await inspect(client));}
 catch{
  // A rollback/release failure belongs to the enclosing transaction owner;
  // do not return a report while its SQL state is uncertain.
  await client.query('rollback to savepoint '+savepoint);
  await client.query('release savepoint '+savepoint);
  return {check:{id:'audit_provenance',status:'FAILED',checked:0,message:'Audit provenance schema or retained metadata integrity could not be verified.'},findings:[{section:'audit_provenance',code:'AUDIT_PROVENANCE_INTEGRITY',severity:'ERROR',field:'auditProvenance',message:'Check the trusted migration039 columns, functions, enforced checks, immutable guards, runtime read grants and retained audit/job origin metadata. Restore a verified schema or metadata source; M90 does not repair records or invent legacy provenance.'}]};
 }
 await client.query('release savepoint '+savepoint);
 return {check:{id:'audit_provenance',status:'PASSED',checked:totals.records,message:`Verified migration039 physical protections and ${totals.recorded} recorded origin value(s); ${totals.legacy} legacy SQL-NULL value(s) remain explicitly not recorded. No provenance was backfilled.`},findings:[]};
}

export function localAuditProvenanceValidation(){
 return {check:{id:'audit_provenance',status:'NOT_APPLICABLE',checked:0,message:'PostgreSQL migration039 physical audit protections and SQL-NULL metadata inventory apply to named server mode. Local desktop files do not establish SQL schema integrity.'},findings:[]};
}
