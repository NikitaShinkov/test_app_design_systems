import {createHash} from 'node:crypto';

export const WORKING_ORDER_VERSION=1;
export const workingOrderMigration='040_proposal_working_order';
export const workingOrderColumns=Object.freeze({proposals:Object.freeze({working_ordinal:Object.freeze(['int8'])})});
export const workingOrderArtifacts=Object.freeze({
  column:'working_ordinal',sequence:'proposal_working_ordinal_seq',index:'proposal_working_ordinal_unique',check:'proposal_working_ordinal_positive',
  functions:Object.freeze(['protect_proposal_working_order','complete_proposal_working_order','assign_legacy_proposal_working_order']),
  triggers:Object.freeze(['proposal_working_order_guard','proposal_working_order_complete'])
});
const rr='replacement_register',maximum='9223372036854775807',pageSize=64,maxKeyBytes=4096;
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const decimal=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=BigInt(maximum);
const key=value=>typeof value==='string'&&Buffer.byteLength(value,'utf8')>0&&Buffer.byteLength(value,'utf8')<=maxKeyBytes;
const unavailable=()=>Object.assign(new Error('Proposal working order could not be verified. Apply and verify migration040 before retrying this operation.'),{status:503,code:'WORKING_ORDER_UNAVAILABLE'});
const unknown=()=>Object.assign(new Error('The selected source rows have no verified working order. Restore a complete verified legacy order before preparing this operation.'),{status:409,code:'WORKING_ORDER_UNKNOWN'});
const insist=value=>{if(!value)throw unavailable();};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const bodyHash=value=>sha(value.replaceAll('\r\n','\n').trim());
// Generated from the reviewed040 candidate. No database body is trusted merely
// because a function with the expected name exists.
const functionProfiles=Object.freeze({
  protect_proposal_working_order:{arguments:[],names:null,result:'trigger',sha256:'2bef09c2f3d0da13c34d4755eee9f2e038e2ae412a2cc66c0c158730050e9e89'},
  complete_proposal_working_order:{arguments:[],names:null,result:'trigger',sha256:'01cb80357250c778c73a688895f82c2060bbf2f7b5dd4109ac44af4c78a00210'},
  assign_legacy_proposal_working_order:{arguments:['text[]'],names:['ordered_ids'],result:'bigint',sha256:'14fe27323c484c68bbaaf8a60f17e76dd68487f886f7cf0cbc962860edc51b44'}
});

/** Pre040 omission is allowed only when neither the marker nor any040 object
 * exists. Adapter callers decide their existing deployment/migration policy. */
export async function proposalWorkingOrderState(client){
  const row=(await client.query(`select
    exists(select 1 from ${rr}.schema_migrations where version=$1) as "migrationDeclared",
    (exists(select 1 from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass($2) and attname=$3 and not attisdropped)
      or pg_catalog.to_regclass($4) is not null or pg_catalog.to_regclass($5) is not null
      or exists(select 1 from pg_catalog.pg_constraint where conrelid=pg_catalog.to_regclass($2) and conname=$6)
      or exists(select 1 from pg_catalog.pg_proc where pronamespace=pg_catalog.to_regnamespace($7) and proname=any($8::text[]))
      or exists(select 1 from pg_catalog.pg_trigger where tgrelid=pg_catalog.to_regclass($2) and tgname=any($9::text[]))) as "artifactsPresent"`,
  [workingOrderMigration,rr+'.proposals',workingOrderArtifacts.column,rr+'.'+workingOrderArtifacts.sequence,rr+'.'+workingOrderArtifacts.index,workingOrderArtifacts.check,rr,workingOrderArtifacts.functions,workingOrderArtifacts.triggers])).rows[0];
  insist(plain(row)&&typeof row.migrationDeclared==='boolean'&&typeof row.artifactsPresent==='boolean');
  return Object.freeze({migrationDeclared:row.migrationDeclared,artifactsPresent:row.artifactsPresent});
}

/** Physical-only check, including empty tables. Caller owns SQL deadlines and
 * a stable snapshot; this function neither repairs nor assigns an order. */
export async function verifyProposalWorkingOrderSchema(client){
  const missing=[],state=await proposalWorkingOrderState(client);
  if(!state.migrationDeclared||!state.artifactsPresent)return {ok:false,missing:['complete migration040 marker and physical objects']};
  const version=(await client.query("select current_setting('server_version_num')::int as version")).rows[0]?.version;
  if(!Number.isInteger(version)||version<140000)return {ok:false,missing:['supported server version for040 enforcement']};
  const column=(await client.query(`select c.relkind,c.relispartition,
    not exists(select 1 from pg_catalog.pg_inherits where inhrelid=c.oid or inhparent=c.oid) as uninherited,
    a.atttypid='pg_catalog.int8'::pg_catalog.regtype as plain_bigint,a.attnotnull,
    pg_catalog.octet_length(pg_catalog.pg_get_expr(d.adbin,d.adrelid)) as default_bytes,
    case when pg_catalog.octet_length(pg_catalog.pg_get_expr(d.adbin,d.adrelid))<=512 then pg_catalog.pg_get_expr(d.adbin,d.adrelid) else null end as default_expression,
    exists(select 1 from pg_catalog.pg_depend x where x.classid='pg_catalog.pg_attrdef'::pg_catalog.regclass and x.objid=d.oid and x.refclassid='pg_catalog.pg_class'::pg_catalog.regclass and x.refobjid=pg_catalog.to_regclass($2)) as sequence_dependency,
    not exists(select 1 from pg_catalog.pg_depend x where x.classid='pg_catalog.pg_attrdef'::pg_catalog.regclass and x.objid=d.oid and x.refclassid='pg_catalog.pg_proc'::pg_catalog.regclass and x.refobjid<>'pg_catalog.nextval(regclass)'::pg_catalog.regprocedure) as builtin_function
    from pg_catalog.pg_class c join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='working_ordinal' and not a.attisdropped
    left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where c.oid=pg_catalog.to_regclass($1) limit 2`,[rr+'.proposals',rr+'.'+workingOrderArtifacts.sequence])).rows;
  const col=column[0],defaultPattern=/^(?:pg_catalog\.)?nextval\('(?:replacement_register\.)?proposal_working_ordinal_seq'::(?:pg_catalog\.)?regclass\)$/;
  if(column.length!==1||!col||col.relkind!=='r'||col.relispartition!==false||col.uninherited!==true||col.plain_bigint!==true||col.attnotnull!==false||col.sequence_dependency!==true||col.builtin_function!==true||typeof col.default_expression!=='string'||!Number.isSafeInteger(col.default_bytes)||col.default_bytes>512||!defaultPattern.test(col.default_expression))missing.push('plain nullable working_ordinal with exact sequence default');
  const sequence=(await client.query(`select s.seqtypid='pg_catalog.int8'::pg_catalog.regtype as bigint_type,s.seqstart::text as start,s.seqincrement::text as increment,s.seqmin::text as minimum,s.seqmax::text as maximum,s.seqcache::text as cache,s.seqcycle as cycle,
    exists(select 1 from pg_catalog.pg_depend d join pg_catalog.pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid where d.classid='pg_catalog.pg_class'::pg_catalog.regclass and d.objid=s.seqrelid and d.deptype='a' and d.refobjid=pg_catalog.to_regclass($2) and a.attname='working_ordinal') as owned,
    (select c.relowner from pg_catalog.pg_class c where c.oid=s.seqrelid)=(select c.relowner from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass($2)) as owner_matches
    from pg_catalog.pg_sequence s where s.seqrelid=pg_catalog.to_regclass($1) limit 2`,[rr+'.'+workingOrderArtifacts.sequence,rr+'.proposals'])).rows;
  const seq=sequence[0];
  if(sequence.length!==1||!seq||seq.bigint_type!==true||!decimal(seq.start)||seq.increment!=='1'||seq.minimum!=='1'||seq.maximum!==maximum||seq.cache!=='1'||seq.cycle!==false||seq.owned!==true||seq.owner_matches!==true)missing.push('owned ascending bigint working-order sequence');
  const enforced=version>=180000?'k.conenforced':'true';
  const checks=(await client.query(`select k.contype,k.convalidated,${enforced} as enforced,k.conislocal,k.coninhcount,k.conparentid=0 as parentless,k.connoinherit,k.condeferrable,k.condeferred,
    cardinality(k.conkey) as columns,a.attname as column_name,
    pg_catalog.octet_length(pg_catalog.pg_get_expr(k.conbin,k.conrelid,false)) as expression_bytes,
    case when pg_catalog.octet_length(pg_catalog.pg_get_expr(k.conbin,k.conrelid,false))<=512 then pg_catalog.pg_get_expr(k.conbin,k.conrelid,false) else null end as expression,
    not exists(select 1 from pg_catalog.pg_depend d join pg_catalog.pg_operator o on d.refclassid='pg_catalog.pg_operator'::pg_catalog.regclass and o.oid=d.refobjid where d.classid='pg_catalog.pg_constraint'::pg_catalog.regclass and d.objid=k.oid and o.oprnamespace<>'pg_catalog'::pg_catalog.regnamespace) as builtin_operators
    from pg_catalog.pg_constraint k left join pg_catalog.pg_attribute a on a.attrelid=k.conrelid and a.attnum=k.conkey[1] where k.conrelid=pg_catalog.to_regclass($1) and k.conname=$2 limit 2`,[rr+'.proposals',workingOrderArtifacts.check])).rows;
  const check=checks[0];
  if(checks.length!==1||!check||check.contype!=='c'||check.convalidated!==true||check.enforced!==true||check.conislocal!==true||check.coninhcount!==0||check.parentless!==true||check.connoinherit!==false||check.condeferrable!==false||check.condeferred!==false||check.columns!==1||check.column_name!=='working_ordinal'||check.builtin_operators!==true||typeof check.expression!=='string'||!Number.isSafeInteger(check.expression_bytes)||check.expression_bytes>512||check.expression.replace(/[\s()]/g,'')!=='working_ordinalISNULLORworking_ordinal>0')missing.push('validated enforced exact positive-or-NULL CHECK');
  const nullsNotDistinct=version>=150000?'i.indnullsnotdistinct':'false';
  const indexes=(await client.query(`select i.indisunique,i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisprimary,i.indnkeyatts,i.indnatts,${nullsNotDistinct} as nulls_not_distinct,i.indpred is null as unfiltered,i.indexprs is null as unexpressed,c.relkind,am.amname,a.attname as column_name,
    pg_catalog.octet_length(pg_catalog.pg_get_indexdef(i.indexrelid,1,false)) as first_key_bytes,
    case when pg_catalog.octet_length(pg_catalog.pg_get_indexdef(i.indexrelid,1,false))<=512 then pg_catalog.pg_get_indexdef(i.indexrelid,1,false) else null end as first_key
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid join pg_catalog.pg_am am on am.oid=c.relam
    left join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=i.indkey[0]
    where i.indexrelid=pg_catalog.to_regclass($1) and i.indrelid=pg_catalog.to_regclass($2) limit 2`,[rr+'.'+workingOrderArtifacts.index,rr+'.proposals'])).rows;
  const index=indexes[0];
  if(indexes.length!==1||!index||index.indisunique!==true||index.indisvalid!==true||index.indisready!==true||index.indislive!==true||index.indimmediate!==true||index.indisprimary!==false||index.indnkeyatts!==1||index.indnatts!==1||index.nulls_not_distinct!==false||index.unfiltered!==true||index.unexpressed!==true||index.relkind!=='i'||index.amname!=='btree'||index.column_name!=='working_ordinal'||!Number.isSafeInteger(index.first_key_bytes)||index.first_key_bytes>512||index.first_key!=='working_ordinal')missing.push('valid immediate unique working-order index');
  const functions=(await client.query(`select p.proname,p.pronargs,case when cardinality(p.proargnames)=1 and pg_catalog.octet_length(p.proargnames[1])<=64 then p.proargnames[1:1] else null end as proargnames,cardinality(p.proargnames) as argument_name_count,
    array(select pg_catalog.format_type(t,null) from pg_catalog.unnest(p.proargtypes::oid[]) with ordinality x(t,n) order by n limit 2) as argument_types,
    pg_catalog.format_type(p.prorettype,null) as result,l.lanname,p.provolatile,p.prosecdef,p.proisstrict,p.proretset,p.prokind,p.pronargdefaults,p.proargmodes is null as all_input,p.provariadic=0 as nonvariadic,case when cardinality(p.proconfig)=1 and pg_catalog.octet_length(p.proconfig[1])<=64 then p.proconfig[1:1] else null end as configuration,cardinality(p.proconfig) as configuration_count,
    pg_catalog.octet_length(pg_catalog.convert_to(p.prosrc,'UTF8')) as body_bytes,
    case when pg_catalog.octet_length(pg_catalog.convert_to(p.prosrc,'UTF8'))<=16384 then p.prosrc else null end as body
    from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang where p.pronamespace=pg_catalog.to_regnamespace($1) and p.proname=any($2::text[]) order by p.proname,p.oid limit 4`,[rr,workingOrderArtifacts.functions])).rows;
  if(functions.length!==3)missing.push('exact040 function cardinality');
  for(const [name,expected]of Object.entries(functionProfiles)){
    const matches=functions.filter(row=>row.proname===name),fn=matches[0];
    if(matches.length!==1||!fn||fn.pronargs!==expected.arguments.length||fn.argument_name_count!==(expected.names===null?null:expected.names.length)||!same(fn.proargnames,expected.names)||!same(fn.argument_types,expected.arguments)||fn.result!==expected.result||fn.lanname!=='plpgsql'||fn.provolatile!=='v'||fn.prosecdef!==false||fn.proisstrict!==false||fn.proretset!==false||fn.prokind!=='f'||fn.pronargdefaults!==0||fn.all_input!==true||fn.nonvariadic!==true||fn.configuration_count!==1||!same(fn.configuration,['search_path=pg_catalog'])||typeof fn.body!=='string'||!Number.isSafeInteger(fn.body_bytes)||fn.body_bytes>16384||fn.body_bytes!==Buffer.byteLength(fn.body,'utf8')||bodyHash(fn.body)!==expected.sha256)missing.push('exact invoker '+name+' function');
  }
  const triggers=(await client.query(`select t.tgname,t.tgtype,t.tgenabled,t.tgqual is null as unconditional,cardinality(t.tgattr::smallint[])=0 as all_columns,t.tgnargs,pg_catalog.octet_length(t.tgargs) as argument_bytes,t.tgconstraint=0 as regular,t.tgdeferrable,t.tginitdeferred,t.tgoldtable,t.tgnewtable,n.nspname,p.proname
    from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where t.tgrelid=pg_catalog.to_regclass($1) and t.tgname=any($2::text[]) and not t.tgisinternal order by t.tgname limit 3`,[rr+'.proposals',workingOrderArtifacts.triggers])).rows;
  if(triggers.length!==2)missing.push('exact040 trigger cardinality');
  for(const expected of [{name:'proposal_working_order_guard',type:23,fn:'protect_proposal_working_order',old:null,new:null},{name:'proposal_working_order_complete',type:16,fn:'complete_proposal_working_order',old:'old_working_order_rows',new:'new_working_order_rows'}]){
    const t=triggers.find(row=>row.tgname===expected.name);
    if(!t||t.tgtype!==expected.type||t.tgenabled!=='A'||t.unconditional!==true||t.all_columns!==true||t.tgnargs!==0||t.argument_bytes!==0||t.regular!==true||t.tgdeferrable!==false||t.tginitdeferred!==false||t.tgoldtable!==expected.old||t.tgnewtable!==expected.new||t.nspname!==rr||t.proname!==expected.fn)missing.push('always-enabled unconditional '+expected.name+' guard');
  }
  return {ok:missing.length===0,missing};
}

export async function verifyProposalWorkingOrderPrivileges(client,role=null){
  role??=(await client.query('select current_user as role')).rows[0]?.role;
  if(typeof role!=='string'||!role||Buffer.byteLength(role,'utf8')>63)return {ok:false,missing:['actual runtime role identity']};
  const version=(await client.query("select current_setting('server_version_num')::int as version")).rows[0]?.version;
  if(!Number.isInteger(version)||version<140000)return {ok:false,missing:['supported server version for040 runtime privileges']};
  const parameterRight=version>=150000?"pg_catalog.has_parameter_privilege($1,'session_replication_role','SET')":'false';
  const row=(await client.query(`select pg_catalog.has_sequence_privilege($1,$2,'USAGE') as allocate,pg_catalog.has_sequence_privilege($1,$2,'SELECT') as inspect,pg_catalog.has_sequence_privilege($1,$2,'UPDATE') as reset,
    pg_catalog.has_function_privilege($1,$3,'EXECUTE') as assign,
    ${parameterRight} as replication_set,exists(select 1 from pg_catalog.pg_roles where rolname=$1 and rolsuper) as superuser,
    exists(select 1 from pg_catalog.pg_roles where rolname=$1 and rolcreaterole) as create_role,
    exists(select 1 from pg_catalog.pg_class c where c.oid=pg_catalog.to_regclass($4) and pg_catalog.pg_has_role($1,c.relowner,'MEMBER')) as owner_member`,[role,rr+'.'+workingOrderArtifacts.sequence,rr+'.assign_legacy_proposal_working_order(text[])',rr+'.proposals'])).rows[0];
  const missing=[];
  if(!row||row.allocate!==true||row.inspect!==true||row.reset!==false)missing.push('runtime sequence USAGE/SELECT without UPDATE');
  if(!row||row.assign!==false||row.owner_member!==false)missing.push('runtime cannot execute owner legacy mapping or become table owner');
  if(!row||row.replication_set!==false||row.superuser!==false||row.create_role!==false)missing.push('runtime cannot bypass trigger policy or acquire owner role through administrative privileges');
  return {ok:missing.length===0,missing};
}
export async function assertProposalWorkingOrderSchema(client){const schema=await verifyProposalWorkingOrderSchema(client);if(!schema.ok)throw unavailable();}

/** Private witnesses are never properties on rows, snapshots or request data. */
const rowWitness=new WeakMap(),arrayWitness=new WeakMap();
export function bindProposalWorkingOrder(proposals,rawRows){
  insist(Array.isArray(proposals)&&Array.isArray(rawRows)&&proposals.length===rawRows.length);
  const rawById=new Map();let available=true;
  for(const raw of rawRows){insist(plain(raw)&&key(raw.proposal_id)&&!rawById.has(raw.proposal_id));rawById.set(raw.proposal_id,raw);if(!own(raw,'working_ordinal'))available=false;}
  const seen=new Set();
  for(const row of proposals){insist(plain(row)&&key(row.proposalId)&&!seen.has(row.proposalId)&&rawById.has(row.proposalId));seen.add(row.proposalId);const raw=rawById.get(row.proposalId),present=own(raw,'working_ordinal'),ordinal=raw.working_ordinal;
    insist(!present||ordinal===null||decimal(ordinal));rowWitness.set(row,Object.freeze({kind:'SQL',id:row.proposalId,available:present,ordinal:present?ordinal:null}));}
  arrayWitness.set(proposals,Object.freeze({kind:'SQL',available}));return proposals;
}
export function bindLocalProposalWorkingOrder(proposals){
  insist(Array.isArray(proposals));
  // A SQL snapshot must never silently become a trusted local array. Local
  // stores may refresh their own array positions after legitimate appends.
  if(arrayWitness.get(proposals)?.kind==='SQL')return proposals;
  insist(!proposals.some(row=>rowWitness.get(row)?.kind==='SQL'));
  const seen=new Set();
  for(let index=0;index<proposals.length;index++){const row=proposals[index];insist(plain(row)&&key(row.proposalId)&&!seen.has(row.proposalId));seen.add(row.proposalId);rowWitness.set(row,Object.freeze({kind:'LOCAL',id:row.proposalId,available:true,ordinal:String(index+1)}));}
  arrayWitness.set(proposals,Object.freeze({kind:'LOCAL',available:true}));return proposals;
}
/** Explicitly carry trusted metadata across an internal parent structuredClone.
 * It cannot infer a witness from an enumerable ordinal supplied by a client. */
export function copyProposalWorkingOrder(sourceRows,targetRows){
  insist(Array.isArray(sourceRows)&&Array.isArray(targetRows));
  const sourceArray=arrayWitness.get(sourceRows);if(!sourceArray)throw unavailable();
  const byId=new Map();for(const row of sourceRows){const witness=rowWitness.get(row);insist(witness&&witness.id===row.proposalId&&!byId.has(witness.id));byId.set(witness.id,witness);}
  const seen=new Set();for(const row of targetRows){insist(plain(row)&&!seen.has(row.proposalId)&&byId.has(row.proposalId));seen.add(row.proposalId);rowWitness.set(row,byId.get(row.proposalId));}
  arrayWitness.set(targetRows,sourceArray);return targetRows;
}
export function requireKnownWorkingOrder(proposals){
  insist(Array.isArray(proposals));const scope=arrayWitness.get(proposals);
  if(scope&&scope.available!==true)throw unavailable();
  if(!scope&&!proposals.length)throw unavailable();
  const used=new Set(),kinds=new Set(),entries=[];
  for(const row of proposals){const witness=rowWitness.get(row);insist(witness&&witness.available===true&&witness.id===row.proposalId);kinds.add(witness.kind);if(witness.ordinal===null)throw unknown();insist(decimal(witness.ordinal)&&!used.has(witness.ordinal));used.add(witness.ordinal);entries.push({row,ordinal:witness.ordinal});}
  insist(kinds.size<=1);entries.sort((a,b)=>BigInt(a.ordinal)<BigInt(b.ordinal)?-1:BigInt(a.ordinal)>BigInt(b.ordinal)?1:0);
  const result=entries.map(entry=>entry.row);arrayWitness.set(result,scope||Object.freeze({kind:[...kinds][0],available:true}));return result;
}
export function proposalWorkingOrderProof(proposals){
  const rows=requireKnownWorkingOrder(proposals),hash=createHash('sha256');
  for(const row of rows){const w=rowWitness.get(row);hash.update(JSON.stringify([w.id,w.ordinal])+'\n');}
  return Object.freeze({formatVersion:WORKING_ORDER_VERSION,sha256:hash.digest('hex')});
}
export function proposalWorkingOrderKnown(proposals){try{requireKnownWorkingOrder(proposals);return true;}catch(error){if(error.code==='WORKING_ORDER_UNKNOWN')return false;throw error;}}

/** Staging order is not permission to consume an unknown row. Every sensitive
 * contributor set still passes requireKnownWorkingOrder at its actual read. */
export function stageProposalWorkingOrder(proposals){
  insist(Array.isArray(proposals));const scope=arrayWitness.get(proposals);insist(scope?.available===true);
  const entries=proposals.map((row,index)=>{const w=rowWitness.get(row);insist(w&&w.available===true&&w.id===row.proposalId&&(w.ordinal===null||decimal(w.ordinal)));return {row,index,ordinal:w.ordinal};});
  entries.sort((a,b)=>a.ordinal===null?(b.ordinal===null?a.index-b.index:1):b.ordinal===null?-1:BigInt(a.ordinal)<BigInt(b.ordinal)?-1:BigInt(a.ordinal)>BigInt(b.ordinal)?1:0);
  const result=entries.map(entry=>entry.row);arrayWitness.set(result,scope);return result;
}

/** This closed descriptor belongs only to the parent/worker IPC task. It must
 * never be saved in options, business rows, command hashes or review JSON. */
export function exportProposalWorkingOrder(proposals){
  insist(Array.isArray(proposals));const scope=arrayWitness.get(proposals);insist(scope&&scope.available===true&&['SQL','LOCAL'].includes(scope.kind));
  const rows=proposals.map(row=>{const w=rowWitness.get(row);insist(w&&w.kind===scope.kind&&w.available===true&&w.id===row.proposalId&&(w.ordinal===null&&w.kind==='SQL'||decimal(w.ordinal)));return Object.freeze([w.id,w.ordinal]);});
  return Object.freeze({formatVersion:WORKING_ORDER_VERSION,kind:scope.kind,rows:Object.freeze(rows),sha256:sha(JSON.stringify([WORKING_ORDER_VERSION,scope.kind,rows]))});
}
export function importProposalWorkingOrder(proposals,descriptor){
  insist(Array.isArray(proposals)&&plain(descriptor)&&Object.keys(descriptor).sort().join(',')==='formatVersion,kind,rows,sha256'&&descriptor.formatVersion===WORKING_ORDER_VERSION&&['SQL','LOCAL'].includes(descriptor.kind)&&Array.isArray(descriptor.rows)&&descriptor.rows.length===proposals.length&&typeof descriptor.sha256==='string'&&/^[a-f0-9]{64}$/.test(descriptor.sha256));
  const byId=new Map();
  for(const pair of descriptor.rows){insist(Array.isArray(pair)&&pair.length===2&&key(pair[0])&&!byId.has(pair[0])&&(pair[1]===null&&descriptor.kind==='SQL'||decimal(pair[1])));byId.set(pair[0],pair[1]);}
  insist(sha(JSON.stringify([WORKING_ORDER_VERSION,descriptor.kind,descriptor.rows]))===descriptor.sha256);
  const seen=new Set();for(const row of proposals){insist(plain(row)&&key(row.proposalId)&&!seen.has(row.proposalId)&&byId.has(row.proposalId));seen.add(row.proposalId);rowWitness.set(row,Object.freeze({kind:descriptor.kind,id:row.proposalId,available:true,ordinal:byId.get(row.proposalId)}));}
  arrayWitness.set(proposals,Object.freeze({kind:descriptor.kind,available:true}));return stageProposalWorkingOrder(proposals);
}

export const workingOrderSensitiveModules=Object.freeze(['M03','M05','M06','M07','M09']);
export function isProposalWorkingOrderProof(value){return plain(value)&&Object.keys(value).sort().join(',')==='formatVersion,sha256'&&value.formatVersion===WORKING_ORDER_VERSION&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256);}
export function requireProposalWorkingOrderReview(job){
  if(job.status!=='COMPLETE'&&workingOrderSensitiveModules.includes(job.moduleId)&&!isProposalWorkingOrderProof(job.snapshot?.provenance?.workingOrder))throw Object.assign(new Error('This saved review predates verified proposal working order. Prepare a new review before issuing it.'),{status:409,code:'WORKING_ORDER_REVIEW_REFRESH_REQUIRED'});
}

/** Parent rechecks the returned transient ID set against its own private
 * capture before accepting a worker proof. Only the two-field proof persists. */
export function validateProposalWorkingOrderResult(proposals,result){
  const invalid=()=>Object.assign(new Error('The file worker returned an invalid working-order result.'),{status:500,code:'FILE_WORKER_OUTPUT_INVALID'});
  if(!Array.isArray(proposals)||!plain(result)||Object.keys(result).sort().join(',')!=='contributorIds,formatVersion,sha256'||result.formatVersion!==WORKING_ORDER_VERSION||typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256)||!Array.isArray(result.contributorIds)||result.contributorIds.length>proposals.length)throw invalid();
  const ids=new Set();for(const id of result.contributorIds){if(!key(id)||ids.has(id))throw invalid();ids.add(id);}
  const selected=proposals.filter(row=>ids.has(row.proposalId));if(selected.length!==ids.size)throw invalid();
  const proof=proposalWorkingOrderProof(copyProposalWorkingOrder(proposals,selected));if(proof.sha256!==result.sha256)throw invalid();return proof;
}

/** Trusted backend scope SQL only; request fields must remain bound values.
 * This strict read checks physical040 even when the selected scope is empty. */
export async function readProposalWorkingOrder(client,{where='true',values=[],lock=false,convert}={}){
  insist(typeof where==='string'&&where.length>0&&!where.includes(';')&&Array.isArray(values)&&typeof convert==='function'&&[false,'share','update'].includes(lock));
  const schema=await verifyProposalWorkingOrderSchema(client);if(!schema.ok)throw unavailable();
  // Row-lock acquisition follows the existing proposal-ID discipline shared by
  // M07/other writers. Working order is processing order, never a new lock order.
  const order=lock?'p.proposal_id':'p.working_ordinal nulls last,p.proposal_id';
  const raw=(await client.query(`select p.* from ${rr}.proposals p where ${where} order by ${order}${lock?' for '+lock:''}`,values)).rows;
  return stageProposalWorkingOrder(bindProposalWorkingOrder(raw.map(convert),raw));
}

/** Caller owns a read-only stable snapshot/quiescence. Transfer64 metadata rows
 * at a time, never raw business JSON, and distinguish SQL NULL explicitly. */
export async function proposalWorkingOrderInventory(client){
  const schema=await verifyProposalWorkingOrderSchema(client);if(!schema.ok)throw unavailable();
  const rawSeq=(await client.query(`select s.seqstart::text as start,s.seqincrement::text as increment,s.seqmin::text as minimum,s.seqmax::text as maximum,s.seqcache::text as cache,s.seqcycle as cycle,q.last_value::text as "lastValue",q.is_called as "isCalled" from pg_catalog.pg_sequence s cross join ${rr}.proposal_working_ordinal_seq q where s.seqrelid='${rr}.proposal_working_ordinal_seq'::pg_catalog.regclass`)).rows;
  insist(rawSeq.length===1);const s=rawSeq[0];
  insist(decimal(s.start)&&decimal(s.lastValue)&&s.increment==='1'&&s.minimum==='1'&&s.maximum===maximum&&s.cache==='1'&&s.cycle===false&&typeof s.isCalled==='boolean'&&BigInt(s.lastValue)>=BigInt(s.start));
  const sequence=Object.freeze({start:s.start,lastValue:s.lastValue,isCalled:s.isCalled,increment:s.increment,minimum:s.minimum,maximum:s.maximum,cache:s.cache,cycle:s.cycle});
  let cursor=null,records=0,known=0,unknownCount=0,legacyKnown=0,maxKnown=0n;const reserved=BigInt(s.start)-1n,hash=createHash('sha256');
  for(;;){
    const rows=(await client.query(`select case when pg_catalog.octet_length(pg_catalog.convert_to(proposal_id,'UTF8'))<=$3 then proposal_id else null end as id,pg_catalog.octet_length(pg_catalog.convert_to(proposal_id,'UTF8')) as bytes,working_ordinal is null as "sqlNull",working_ordinal::text as ordinal from ${rr}.proposals where ($1::text is null or proposal_id collate "C">$1 collate "C") order by proposal_id collate "C" limit $2`,[cursor,pageSize,maxKeyBytes])).rows;
    insist(Array.isArray(rows)&&rows.length<=pageSize);
    for(const row of rows){insist(key(row.id)&&Number.isSafeInteger(row.bytes)&&row.bytes===Buffer.byteLength(row.id,'utf8')&&row.bytes<=maxKeyBytes&&(cursor===null||Buffer.compare(Buffer.from(row.id,'utf8'),Buffer.from(cursor,'utf8'))>0));
      if(row.sqlNull===true){insist(row.ordinal===null);unknownCount++;}
      else{insist(row.sqlNull===false&&decimal(row.ordinal));known++;const ordinal=BigInt(row.ordinal);if(ordinal<=reserved)legacyKnown++;if(ordinal>maxKnown)maxKnown=ordinal;}
      hash.update(JSON.stringify([row.id,row.sqlNull,row.ordinal])+'\n');records++;insist(Number.isSafeInteger(records));cursor=row.id;
    }
    if(rows.length<pageSize)break;
  }
  insist(unknownCount===0?BigInt(legacyKnown)===reserved:BigInt(unknownCount)===reserved&&legacyKnown===0);
  insist(s.isCalled?maxKnown<=BigInt(s.lastValue):maxKnown<BigInt(s.lastValue));
  return Object.freeze({formatVersion:WORKING_ORDER_VERSION,proposals:Object.freeze({records,known,unknown:unknownCount,sha256:hash.digest('hex')}),sequence});
}
