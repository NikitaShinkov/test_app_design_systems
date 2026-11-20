import {createHash} from 'node:crypto';
import {executionCoordinationTables,executionCoordinationColumns,executionCoordinationConfig} from './execution-coordination.js';

export {executionCoordinationTables};
const rr='replacement_register',object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const typed=(names,type)=>Object.fromEntries(names.split(' ').map(name=>[name,[type]]));
export const executionCoordinationSchemaColumns={
  execution_instances:{...typed('instance_id host_id store_id','uuid'),...typed('process_id control_backend_pid','int4'),...typed('role application_hash config_fingerprint database_name database_user state','text'),config_json:['jsonb'],...typed('control_backend_start registered_at heartbeat_at stopped_at','timestamptz')},
  execution_permits:{...typed('permit_id instance_id permit_token recovered_by_instance_id','uuid'),...typed('owner_key state','text'),...typed('acquired_at released_at','timestamptz')}
};
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value,json=value=>JSON.stringify(canonical(value)),same=(a,b)=>json(a)===json(b);
const insist=(test,detail)=>{if(!test)throw Error('Execution coordination integrity failed: '+detail);};
const time=value=>{insist(typeof value==='string'&&Number.isFinite(Date.parse(value)),'invalid retained timestamp');return Date.parse(value);};
const positive=value=>Number.isSafeInteger(value)&&value>0&&value<=2147483647;

/** Never rewrite historical JSON. The runtime owns canonical field order and
 * authoritative SQL/workload bounds; JSONB key order does not affect its hash. */
export function validateRetainedExecutionConfiguration(config,fingerprint){
  const fields=['version','maxActive','maxPerOwner','retryAfterSeconds','heartbeatMs','readyMs'];
  insist(object(config)&&[1,2].includes(config.version)&&same(Object.keys(config).sort(),[...fields,...(config.version===2?['sqlExecution']:[])].sort()),'invalid shared execution configuration');
  insist(fields.every(field=>Number.isSafeInteger(config[field])),'shared execution configuration fields must be integers');
  let ordered;
  try{ordered=executionCoordinationConfig({limits:{maxActive:config.maxActive,maxPerOwner:config.maxPerOwner,retryAfterSeconds:config.retryAfterSeconds},heartbeatMs:config.heartbeatMs,readyMs:config.readyMs,...(config.version===2?{sqlPolicy:config.sqlExecution}:{})});}
  catch{insist(false,'invalid retained workload/readiness/SQL policy');}
  insist(same(config,ordered),'retained shared configuration differs from canonical numeric fields');
  insist(typeof fingerprint==='string'&&/^[a-f0-9]{64}$/.test(fingerprint)&&createHash('sha256').update(JSON.stringify(ordered)).digest('hex')===fingerprint,'shared configuration fingerprint differs');
  return ordered;
}

export async function verifyExecutionCoordinationPrivileges(client,role=null){
  role||=(await client.query('select current_user as role')).rows[0].role;const missing=[];
  for(const table of executionCoordinationTables){const rights=(await client.query("select has_table_privilege($1,$2,'SELECT') as read,has_table_privilege($1,$2,'INSERT') as append,has_table_privilege($1,$2,'UPDATE') as edit,has_table_privilege($1,$2,'DELETE') as remove,has_table_privilege($1,$2,'TRUNCATE') as truncate",[role,rr+'.'+table])).rows[0];if(!rights.read||!rights.append||!rights.edit||rights.remove||rights.truncate)missing.push(table+': SELECT/INSERT/UPDATE only');}
  return {ok:missing.length===0,missing};
}
export async function verifyExecutionCoordinationSchema(client){
  const missing=[],columns=(await client.query('select table_name,column_name,udt_name,is_nullable from information_schema.columns where table_schema=$1 and table_name=any($2::text[])',[rr,executionCoordinationTables])).rows;
  for(const [table,required]of Object.entries(executionCoordinationSchemaColumns)){
    insist(same(Object.keys(required).sort(),[...executionCoordinationColumns[table]].sort()),'runtime/schema column contract differs');
    for(const [column,types]of Object.entries(required)){const found=columns.find(row=>row.table_name===table&&row.column_name===column),nullable=['stopped_at','released_at','recovered_by_instance_id'].includes(column);if(!found||!types.includes(found.udt_name)||found.is_nullable!==(nullable?'YES':'NO'))missing.push(table+'.'+column+' type/nullability');}
  }
  const constraints=(await client.query("select c.relname as table,k.contype,k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid) as definition,array(select a.attname::text from unnest(k.conkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.n order by x.o) as columns,f.relname as target,fn.nspname as target_schema,array(select a.attname::text from unnest(k.confkey) with ordinality x(n,o) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.n order by x.o) as target_columns from pg_constraint k join pg_class c on c.oid=k.conrelid left join pg_class f on f.oid=k.confrelid left join pg_namespace fn on fn.oid=f.relnamespace where c.relnamespace=to_regnamespace($1) and c.relname=any($2::text[])",[rr,executionCoordinationTables])).rows;
  for(const [table,type,fields]of [['execution_instances','p',['instance_id']],['execution_instances','u',['control_backend_pid','control_backend_start','database_name']],['execution_permits','p',['permit_id']],['execution_permits','u',['permit_token']]])if(!constraints.some(row=>row.table===table&&row.contype===type&&row.convalidated&&same(row.columns,fields)))missing.push(table+' '+type+'('+fields.join(',')+')');
  if(!constraints.some(row=>row.table==='execution_permits'&&row.contype==='f'&&row.convalidated&&same(row.columns,['instance_id'])&&row.target_schema===rr&&row.target==='execution_instances'&&same(row.target_columns,['instance_id'])))missing.push('validated permit instance foreign key');
  if(!constraints.some(row=>row.table==='execution_permits'&&row.contype==='f'&&row.convalidated&&row.condeferrable&&row.condeferred&&same(row.columns,['recovered_by_instance_id'])&&row.target_schema===rr&&row.target==='execution_instances'&&same(row.target_columns,['instance_id'])))missing.push('validated initially-deferred recovery instance foreign key');
  const checks=[['execution_instances',['process_id','> 0']],['execution_instances',['control_backend_pid','> 0']],['execution_instances',['role','api','worker','combined']],['execution_instances',['application_hash','64']],['execution_instances',['config_fingerprint','64']],['execution_instances',['config_json','object']],['execution_instances',['state','READY','DRAINING','STOPPED']],['execution_instances',['STOPPED','stopped_at','IS NOT NULL']],['execution_permits',['owner_key','256']],['execution_permits',['state','ACTIVE','RELEASED','RECOVERED']],['execution_permits',['ACTIVE','released_at','IS NULL']],['execution_permits',['RECOVERED','recovered_by_instance_id','IS NOT NULL']]];
  for(const [table,fragments]of checks)if(!constraints.some(row=>row.table===table&&row.contype==='c'&&row.convalidated&&fragments.every(value=>row.definition.includes(value))))missing.push(table+' validated CHECK('+fragments.join('/')+')');
  const indexes=(await client.query('select indexname,indexdef from pg_indexes where schemaname=$1 and tablename=any($2::text[])',[rr,executionCoordinationTables])).rows;
  for(const [name,fields,partial]of [['execution_instances_readiness_idx',['role','state','heartbeat_at'],false],['execution_permits_active_idx',['permit_id'],true],['execution_permits_owner_idx',['owner_key'],true],['execution_permits_instance_idx',['instance_id'],true]])if(!indexes.some(row=>row.indexname===name&&fields.every(value=>row.indexdef.includes(value))&&(!partial||row.indexdef.includes('WHERE')&&row.indexdef.includes("'ACTIVE'"))))missing.push(name+' index');
  return {ok:missing.length===0,missing};
}
function validateInstance(row){
  for(const field of ['instance_id','host_id','store_id'])insist(uuid(row[field]),'invalid process/store/host identity');insist(positive(row.process_id)&&positive(row.control_backend_pid),'invalid OS/database process identity');
  insist(['api','worker','combined'].includes(row.role)&&['READY','DRAINING','STOPPED'].includes(row.state),'invalid process role/state');
  insist(['application_hash','config_fingerprint'].every(key=>typeof row[key]==='string'&&/^[a-f0-9]{64}$/.test(row[key])),'invalid execution build/config hash');
  insist(typeof row.database_name==='string'&&row.database_name&&typeof row.database_user==='string'&&row.database_user,'invalid retained database identity');
  validateRetainedExecutionConfiguration(row.config_json,row.config_fingerprint);
  time(row.control_backend_start);const registered=time(row.registered_at);insist(time(row.heartbeat_at)>=registered,'heartbeat predates registration');
  insist((row.state==='STOPPED')===(row.stopped_at!==null),'process stop state differs');if(row.stopped_at!==null)insist(time(row.stopped_at)>=registered,'stop timestamp predates registration');
}
function selectTimes(table,prefix=''){const qualified=name=>prefix?prefix+'.'+name:name;const names=executionCoordinationColumns[table],timestamps=new Set(table==='execution_instances'?['control_backend_start','registered_at','heartbeat_at','stopped_at']:['acquired_at','released_at']);return names.map(name=>timestamps.has(name)?`to_char(${qualified(name)} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${name}`:qualified(name)).join(',');}

/** Caller owns a stable transaction. Retained READY is never proof of liveness. */
export async function executionCoordinationInventory(client){
  const schema=await verifyExecutionCoordinationSchema(client);insist(schema.ok,schema.missing.join('; '));const tables={},states={READY:0,DRAINING:0,STOPPED:0,ACTIVE:0,RELEASED:0,RECOVERED:0};let storeId=null;
  for(const [table,key]of [['execution_instances','instance_id'],['execution_permits','permit_id']]){let cursor=null,records=0;const hash=createHash('sha256');for(;;){const permitMode=table==='execution_permits',query=permitMode?`select ${selectTimes(table,'p')},i.instance_id as parent_instance_id,i.host_id as parent_host_id,i.state as parent_state,r.host_id as recovery_host_id from ${rr}.execution_permits p left join ${rr}.execution_instances i on i.instance_id=p.instance_id left join ${rr}.execution_instances r on r.instance_id=p.recovered_by_instance_id where ($1::uuid is null or p.permit_id>$1::uuid) order by p.permit_id limit 100`:`select ${selectTimes(table)} from ${rr}.${table} where ($1::uuid is null or ${key}>$1::uuid) order by ${key} limit 100`;const rows=(await client.query(query,[cursor])).rows;for(const value of rows){const {parent_instance_id,parent_host_id,parent_state,recovery_host_id,...row}=value;
      if(table==='execution_instances'){validateInstance(row);if(storeId===null)storeId=row.store_id;else insist(row.store_id===storeId,'retained instances reference different artifact stores');}
      else{insist(uuid(row.permit_id)&&uuid(row.instance_id)&&uuid(row.permit_token)&&typeof row.owner_key==='string'&&row.owner_key.length>0&&row.owner_key.length<=256&&!row.owner_key.includes('\0')&&['ACTIVE','RELEASED','RECOVERED'].includes(row.state),'invalid retained execution permit');const parent=parent_instance_id?{instance_id:parent_instance_id,host_id:parent_host_id,state:parent_state}:null;insist(parent,'permit has no retained instance');const acquired=time(row.acquired_at);insist((row.state==='ACTIVE')===(row.released_at===null),'permit release state differs');if(row.released_at!==null)insist(time(row.released_at)>=acquired,'permit release predates acquisition');if(row.state==='ACTIVE')insist(parent.state!=='STOPPED','stopped process retains an active permit');if(row.state==='RECOVERED'){insist(uuid(row.recovered_by_instance_id)&&row.recovered_by_instance_id!==row.instance_id,'invalid recovering process identity');insist(recovery_host_id===parent.host_id,'recovery is missing or crosses host identity');}else insist(row.recovered_by_instance_id===null,'non-recovered permit has recovery attribution');}
      states[row.state]++;hash.update(json(row)+'\n');records++;cursor=row[key];
    }if(rows.length<100)break;}tables[table]={records,sha256:hash.digest('hex')};}
  const activePolicies=(await client.query(`select count(distinct i.config_fingerprint)::int as policies from ${rr}.execution_instances i where exists(select 1 from ${rr}.execution_permits p where p.instance_id=i.instance_id and p.state='ACTIVE')`)).rows[0];
  insist(Number.isInteger(activePolicies?.policies)&&activePolicies.policies<=1,'active execution instances retain incompatible policies');
  return {formatVersion:1,tables,states,retainedStateVerified:true,livenessClaimed:false};
}

/** SQL/file snapshots require every writer stopped, not merely expired leases. */
export async function assertExecutionQuiescent(client){
  const inventory=await executionCoordinationInventory(client);insist(inventory.states.ACTIVE===0,'active execution permits remain; prove stopped local processes and recover them before backup');
  const identity=(await client.query("select current_user as role,(select rolsuper from pg_roles where rolname=current_user) or pg_has_role(current_user,'pg_read_all_stats','MEMBER') as all_stats")).rows[0];
  const foreign=(await client.query(`select 1 from ${rr}.execution_instances where database_user<>current_user limit 1`)).rowCount>0;insist(!foreign||identity.all_stats===true,'backup account requires visibility of all registered PostgreSQL backends (pg_read_all_stats or the registered database role)');
  const live=(await client.query(`select 1 from ${rr}.execution_instances i join pg_stat_activity a on a.datname=i.database_name and a.usename=i.database_user and a.application_name in ('rr-exec:'||i.instance_id::text,'rr-exec:'||i.instance_id::text||':control') limit 1`)).rowCount>0;
  insist(!live,'an application execution backend is still connected; stop every API/worker writer before backup');return inventory;
}
