import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MAX_ENVELOPE_BYTES,inspectStoredEnvelope,inspectStoredInitiator,serializeAuditEnvelope,serializeAcceptedInitiator} from './audit-provenance.js';

const rr='replacement_register',pageSize=64;
const sourcePins={
 '004_identity.sql':'7d8c5ae26771a472dfdc4235302deb68f75f722e0c00e79808436747b9ed0133',
 '033_business_commands.sql':'29c0501ad846a61d0dbb544d0fc70221dacad87d1e7b1582fb153a5da11b9cb5',
 '039_audit_provenance.sql':'5e36944ae1d68f3de539156cdb2c54d0d6fb1d4ed96bd41dbb8f02de23e17a9f'
};
const fields=[
 {table:'audit_events',key:'id',type:'bigint',column:'provenance_json',kind:'AUDIT'},
 {table:'preparation_jobs',key:'job_id',type:'uuid',column:'initiator_provenance_json',kind:'PREPARATION'},
 {table:'business_command_jobs',key:'command_id',type:'uuid',column:'initiator_provenance_json',kind:'BUSINESS_COMMAND'}
];
const guards=[
 {table:'audit_events',name:'audit_append_only',type:58,fn:'reject_event_changes'},
 {table:'preparation_jobs',name:'preparation_descriptor_immutable',type:19,fn:'protect_preparation_descriptor'},
 {table:'business_command_jobs',name:'business_command_job_guard',type:27,fn:'protect_business_command_job'},
 {table:'business_command_jobs',name:'business_command_jobs_retained',type:34,fn:'reject_event_changes'},
 {table:'business_command_receipts',name:'business_command_receipts_immutable',type:58,fn:'reject_event_changes'}
];
const sha=value=>createHash('sha256').update(value).digest('hex');
const normalizeBody=value=>typeof value==='string'?value.replaceAll('\r\n','\n'):null;
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const error=reason=>Object.assign(Error('Audit provenance integrity failed: '+reason),{code:'AUDIT_PROVENANCE_INTEGRITY'});

// This parser accepts only the expression grammar used by the three pinned039
// CHECKs. It preserves Boolean grouping; it never evaluates database SQL.
function checkTree(sql){
 const tokens=[];let offset=0;
 while(offset<sql.length){
  const rest=sql.slice(offset),space=rest.match(/^\s+/);if(space){offset+=space[0].length;continue;}
  const match=rest.match(/^(?:'(?:''|[^'])*'|#>>|::|[(),=\[\]]|[A-Za-z_][A-Za-z0-9_.]*)/);
  if(!match)throw error('Unsupported039 CHECK expression.');tokens.push(match[0]);offset+=match[0].length;
 }
 let index=0;const peek=()=>tokens[index]?.toLowerCase(),take=value=>{if(peek()!==value)throw error('Malformed039 CHECK expression.');index++;};
 const expression=()=>{let value=conjunction();while(peek()==='or'){index++;value=['or',value,conjunction()];}return value;};
 const conjunction=()=>{let value=comparison();while(peek()==='and'){index++;value=['and',value,comparison()];}return value;};
 const comparison=()=>{let value=path();if(peek()==='is'){index++;take('null');return ['is-null',value];}if(peek()==='='){index++;return ['=',value,path()];}return value;};
 const path=()=>{let value=cast();while(peek()==='#>>'){index++;let right=cast();if(right[0]==='cast'&&right[2]==='text[]')right=right[1];if(right[0]!=='string')throw error('Unsupported039 JSON path.');value=['#>>',value,right];}return value;};
 const cast=()=>{let value=atom();while(peek()==='::'){index++;let type=peek();if(!['text','text[]','boolean','pg_catalog.text','pg_catalog.boolean'].includes(type))throw error('Unsupported039 cast.');index++;type=type.replace('pg_catalog.','');if(peek()==='['){index++;take(']');type+='[]';}
   if(type==='text'&&value[0]==='string'||type==='boolean'&&value[0]==='boolean')continue;value=['cast',value,type];}return value;};
 const atom=()=>{
  if(peek()==='('){index++;const value=expression();take(')');return value;}
  const token=tokens[index++];if(!token)throw error('Incomplete039 expression.');
  if(token.startsWith("'"))return ['string',token.slice(1,-1).replaceAll("''", "'")];
  const identifier=token.toLowerCase();if(identifier==='true'||identifier==='false')return ['boolean',identifier==='true'];
  if(peek()==='('){index++;const args=[];if(peek()!==')'){args.push(expression());while(peek()===','){index++;args.push(expression());}}take(')');
   return ['call',identifier.includes('.')?identifier:rr+'.'+identifier,args];}
  return ['column',identifier];
 };
 const tree=expression();if(index!==tokens.length)throw error('Unexpected039 CHECK tokens.');return tree;
}

let packaged;
async function profile(){
 return packaged??=(async()=>{
  try{
   const sources={};for(const [file,pin]of Object.entries(sourcePins)){const url=new URL('../database/'+file,import.meta.url),stat=await fs.stat(url);if(!stat.isFile()||stat.size>65536)throw error('Invalid packaged schema profile.');const bytes=await fs.readFile(url);if(sha(bytes)!==pin)throw error('Packaged schema profile hash differs.');sources[file]=bytes.toString('utf8');}
   const functions=[];
   for(const [file,source]of Object.entries(sources))for(const match of source.matchAll(/create(?: or replace)? function replacement_register\.([a-z_]+)\(([^)]*)\)\s+returns\s+(boolean|trigger)\s+language\s+(\w+)([^]*?)\bas\s+\$\$([^]*?)\$\$;/gi)){
    const [,name,parameters,result,language,options,body]=match;if(file!=='039_audit_provenance.sql'&&!['reject_event_changes','protect_business_command_job'].includes(name))continue;
    const args=parameters.trim()?parameters.split(',').map(parameter=>{const arg=parameter.trim().match(/^([a-z_]+)\s+(jsonb|text\[\]|boolean)(?:\s+default\s+(false))?$/i);if(!arg)throw error('Unsupported packaged039 signature.');return {name:arg[1],type:arg[2],default:arg[3]??null};}):[];
    functions.push({name,args,result,language:language.toLowerCase(),body:normalizeBody(body),volatility:/\bimmutable\b/i.test(options)?'i':'v',defaults:args.filter(arg=>arg.default!==null).map(arg=>arg.default).join(', ')||null});
   }
   if(functions.length!==14||new Set(functions.map(fn=>fn.name)).size!==14)throw error('Incomplete packaged039 functions.');
   const checks=[...sources['039_audit_provenance.sql'].matchAll(/alter table replacement_register\.([a-z_]+) add constraint ([a-z_]+)\s+check\s*\(([^]*?)\);/g)].map(([,table,name,expression])=>({table,name,tree:checkTree(expression),fn:table==='audit_events'?'audit_provenance_envelope_valid(jsonb)':'audit_provenance_initiator_valid(jsonb, boolean)'}));
   if(checks.length!==3)throw error('Incomplete packaged039 CHECKs.');return {functions,checks};
  }catch{throw error('Trusted packaged039 profile is unavailable.');}
 })();
}

/** SELECT-only physical gate. No row scan; required even for empty039 tables. */
export async function verifyAuditProvenanceSchema(client){
 const expected=await profile(),missing=[];
 const version=(await client.query("select current_setting('server_version_num')::int as server_version")).rows[0]?.server_version;
 if(!Number.isInteger(version)||version<140000)return {ok:false,missing:['supported server version for039 enforcement']};
 // PG18 introduced conenforced. Pre18 CHECKs are enforced implicitly and the
 // absent column must never be referenced while preparing the query there.
 const enforced=version>=180000?'k.conenforced':'true';
 const columns=(await client.query("select table_name,column_name,udt_name,udt_schema,domain_name,is_nullable,column_default is null as default_absent from information_schema.columns where table_schema=$1 and table_name=any($2::text[]) and column_name=any($3::text[]) order by table_name,column_name limit $4",[rr,fields.map(field=>field.table),['provenance_json','initiator_provenance_json'],fields.length+1])).rows;
 if(columns.length>fields.length)missing.push('039 column catalog overflow');
 for(const field of fields){const row=columns.find(row=>row.table_name===field.table&&row.column_name===field.column);if(!row||row.udt_name!=='jsonb'||row.udt_schema!=='pg_catalog'||row.domain_name!==null||row.is_nullable!=='YES'||row.default_absent!==true)missing.push(field.table+'.'+field.column+' plain nullable jsonb without default');}
 const functions=(await client.query("select p.proname as name,p.pronargs as argument_count,(coalesce(p.proargnames,'{}'::text[]))[1:3] as argument_names,array(select format_type(t,null) from unnest(p.proargtypes::oid[]) with ordinality x(t,n) order by n limit 3) as argument_types,format_type(p.prorettype,null) as return_type,p.pronargdefaults as default_count,octet_length(convert_to(pg_get_expr(p.proargdefaults,0),'UTF8')) as default_bytes,case when octet_length(convert_to(pg_get_expr(p.proargdefaults,0),'UTF8'))<=$5 then pg_get_expr(p.proargdefaults,0) else null end as argument_defaults,octet_length(convert_to(p.prosrc,'UTF8')) as body_bytes,case when octet_length(convert_to(p.prosrc,'UTF8'))<=$4 then p.prosrc else null end as body,p.provolatile as volatility,p.prosecdef as security_definer,p.proisstrict as strict,p.proretset as returns_set,p.prokind as kind,p.proargmodes is null as all_input,p.provariadic=0 as non_variadic,p.proconfig is null as configuration_absent,l.lanname as language from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname=$1 and p.proname=any($2::text[]) order by p.proname,p.oid limit $3",[rr,expected.functions.map(fn=>fn.name),expected.functions.length+1,65536,128])).rows;
 if(functions.length!==expected.functions.length)missing.push('exact039 function catalog cardinality');
 for(const fn of expected.functions){const matches=functions.filter(row=>row.name===fn.name),row=matches[0],defaults=fn.args.filter(arg=>arg.default!==null).length;
  if(matches.length!==1||!row||row.argument_count!==fn.args.length||!same(row.argument_names,fn.args.map(arg=>arg.name))||!same(row.argument_types,fn.args.map(arg=>arg.type))||row.return_type!==fn.result||row.language!==fn.language||row.volatility!==fn.volatility||row.security_definer!==false||row.strict!==false||row.returns_set!==false||row.kind!=='f'||row.all_input!==true||row.non_variadic!==true||row.configuration_absent!==true||row.default_count!==defaults||row.argument_defaults!==fn.defaults||row.default_bytes!==(fn.defaults===null?null:Buffer.byteLength(fn.defaults,'utf8'))||typeof row.body!=='string'||!Number.isSafeInteger(row.body_bytes)||row.body_bytes>65536||row.body_bytes!==Buffer.byteLength(row.body,'utf8')||normalizeBody(row.body)!==fn.body)missing.push('exact trusted '+fn.name+' signature/body/properties');
 }
 const checks=(await client.query("select c.relname as table_name,k.conname as name,k.contype as type,k.convalidated as validated,"+enforced+" as enforced,k.conislocal as local,k.coninhcount as inheritance_count,k.conparentid=0 as parentless,k.connoinherit as no_inherit,k.condeferrable as deferrable,k.condeferred as deferred,octet_length(convert_to(pg_get_expr(k.conbin,k.conrelid,false),'UTF8')) as expression_bytes,case when octet_length(convert_to(pg_get_expr(k.conbin,k.conrelid,false),'UTF8'))<=$4 then pg_get_expr(k.conbin,k.conrelid,false) else null end as expression,cardinality(k.conkey) as column_count,array(select a.attname::text from unnest(k.conkey) x(n) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.n order by a.attname limit 3) as columns,array(select case when octet_length(n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')')<=512 then n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')' else null end from pg_depend d join pg_proc p on d.refclassid='pg_proc'::regclass and p.oid=d.refobjid join pg_namespace n on n.oid=p.pronamespace where d.classid='pg_constraint'::regclass and d.objid=k.oid order by 1 limit 2) as function_signatures,not exists(select 1 from pg_depend d join pg_operator o on d.refclassid='pg_operator'::regclass and o.oid=d.refobjid join pg_namespace n on n.oid=o.oprnamespace where d.classid='pg_constraint'::regclass and d.objid=k.oid and n.nspname<>'pg_catalog') as builtin_operators_only from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and k.conname=any($2::text[]) order by c.relname,k.conname limit $3",[rr,expected.checks.map(check=>check.name),expected.checks.length+1,8192])).rows;
 if(checks.length!==expected.checks.length)missing.push('exact039 CHECK catalog cardinality');
 for(const check of expected.checks){const matches=checks.filter(row=>row.name===check.name&&row.table_name===check.table),row=matches[0],field=fields.find(field=>field.table===check.table),columns=[field.column,...(field.kind==='AUDIT'?[]:[field.key])].sort();let valid=false;
  try{valid=matches.length===1&&row.type==='c'&&row.validated===true&&row.enforced===true&&row.local===true&&row.inheritance_count===0&&row.parentless===true&&row.no_inherit===false&&row.deferrable===false&&row.deferred===false&&row.column_count===columns.length&&same(row.columns,columns)&&same(row.function_signatures,[rr+'.'+check.fn])&&row.builtin_operators_only===true&&typeof row.expression==='string'&&Number.isSafeInteger(row.expression_bytes)&&row.expression_bytes<=8192&&row.expression_bytes===Buffer.byteLength(row.expression,'utf8')&&same(checkTree(row.expression),check.tree);}catch{}
  if(!valid)missing.push('validated enforced exact '+check.name+' CHECK');
 }
 const triggers=(await client.query("select c.relname as table_name,t.tgname as name,t.tgtype as type,t.tgenabled as enabled,t.tgqual is null as unconditional,cardinality(t.tgattr::smallint[])=0 as all_columns,t.tgnargs as argument_count,octet_length(t.tgargs) as argument_bytes,t.tgconstraint=0 as regular,t.tgdeferrable as deferrable,t.tginitdeferred as initially_deferred,n.nspname as function_schema,p.proname as function_name from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where c.relnamespace=to_regnamespace($1) and t.tgname=any($2::text[]) and not t.tgisinternal order by c.relname,t.tgname limit $3",[rr,guards.map(guard=>guard.name),guards.length+1])).rows;
 if(triggers.length!==guards.length)missing.push('exact039 guard catalog cardinality');
 for(const guard of guards){const row=triggers.find(row=>row.table_name===guard.table&&row.name===guard.name);if(!row||row.type!==guard.type||!['O','A'].includes(row.enabled)||row.unconditional!==true||row.all_columns!==true||row.argument_count!==0||row.argument_bytes!==0||row.regular!==true||row.deferrable!==false||row.initially_deferred!==false||row.function_schema!==rr||row.function_name!==guard.fn)missing.push('enabled unconditional all-column '+guard.name+' guard');}
 return {ok:missing.length===0,missing};
}

/** Caller owns a stable read snapshot/quiescence. Only three metadata fields
 * and their stable keys are transferred, at most64 rows/8192 bytes each. */
export async function auditProvenanceInventory(client){
 const schema=await verifyAuditProvenanceSchema(client);if(!schema.ok)throw error(schema.missing.join('; '));
 const result={formatVersion:1};
 for(const field of fields){const hash=createHash('sha256');let cursor=null,records=0,legacy=0,recorded=0;
  for(;;){const text=field.column+'::text',bytes="octet_length(convert_to("+text+",'UTF8'))";
   const rows=(await client.query(`select ${field.key}::text as key,${field.column} is null as "sqlNull",${bytes} as bytes,case when ${bytes}<=$3 then ${text} else null end as text from ${rr}.${field.table} where ($1::${field.type} is null or ${field.key}>$1::${field.type}) order by ${field.key} limit $2`,[cursor,pageSize,MAX_ENVELOPE_BYTES])).rows;
   if(!Array.isArray(rows)||rows.length>pageSize)throw error('Invalid metadata page.');
   for(const row of rows){const key=row.key,validKey=typeof key==='string'&&(field.type==='bigint'?/^-?(?:0|[1-9][0-9]{0,18})$/.test(key):/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key));
    if(!validKey||cursor!==null&&(field.type==='bigint'?BigInt(key)<=BigInt(cursor):key<=cursor))throw error('Invalid metadata cursor for '+field.table+'.');
    let canonical=null;
    if(row.sqlNull===true){if(row.text!==null||row.bytes!==null)throw error('Invalid SQLNULL witness for '+field.table+'.');legacy++;}
    else{if(row.sqlNull!==false||typeof row.text!=='string'||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>MAX_ENVELOPE_BYTES||Buffer.byteLength(row.text,'utf8')!==row.bytes)throw error('Invalid bounded metadata witness for '+field.table+'.');
     const inspect=field.kind==='AUDIT'?inspectStoredEnvelope:inspectStoredInitiator,read=inspect(row.text);if(read.status!=='VALID')throw error('Invalid stored metadata for '+field.table+'.');
     if(field.kind!=='AUDIT'&&(read.value.job.id!==key||read.value.job.kind!==field.kind))throw error('Origin/job identity differs for '+field.table+'.');
     canonical=(field.kind==='AUDIT'?serializeAuditEnvelope:serializeAcceptedInitiator)(read.value);recorded++;
    }
    hash.update(JSON.stringify([key,row.sqlNull,canonical])+'\n');records++;if(!Number.isSafeInteger(records))throw error('Metadata count exceeds supported integer range.');cursor=key;
   }
   if(rows.length<pageSize)break;
  }
  result[field.table]={records,legacySqlNull:legacy,recorded,sha256:hash.digest('hex')};
 }
 return result;
}
