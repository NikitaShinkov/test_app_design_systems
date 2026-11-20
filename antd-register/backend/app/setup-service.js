import fs from 'node:fs/promises';
import {validateSetup,inspectSetupSchema,setupSchemaUsable,finalizeSetupReport} from './setup-validation.js';
import {rowToProposal,rowToReplacement,rowToLifecycle} from './storage.js';
import {seedReferenceCatalog} from './reference-catalog.js';
import {httpError} from './auth.js';
import {roundManagementTables,verifyRoundManagementSchema,roundManagementInventory} from './round-management-operations.js';
import {businessCommandTables,businessCommandInventory,localBusinessCommandInventory} from './business-command-operations.js';
import {sourceBomTables,sourceBomInventory,localSourceBomInventory} from './source-bom-operations.js';
import {registerGridTables,registerGridInventory,localRegisterGridInventory} from './register-grid-operations.js';
import {registerReportInventory,localRegisterReportInventory} from './register-report-operations.js';
import {executionCoordinationTables,executionCoordinationInventory} from './execution-coordination-operations.js';
import {captureAuditProvenanceValidation,localAuditProvenanceValidation} from './setup-audit-provenance.js';
import {captureWorkingOrderValidation,localWorkingOrderValidation} from './setup-working-order.js';

const rr='replacement_register';
const artifactRow=row=>({artifactId:row.artifact_id,logicalKey:row.logical_key,version:row.version,sha256:row.sha256,filename:row.filename,contentType:row.content_type,bytes:Number(row.bytes),kind:row.kind,moduleId:row.module_id,scope:row.scope_json,ownerUserId:row.owner_user_id,ownerActor:row.owner_actor,ownerOnly:row.owner_only,scanStatus:row.scan_status,scanDetail:row.scan_detail,createdAt:row.created_at,...(row.attachment_json?{attachmentMetadata:row.attachment_json}:{})});

// The capture is read-only. It must also work when reference integrity is the
// reason the administrator opened M90; normal reference lookup would throw.
export async function captureSetup(storage,artifacts) {
  if(storage.rawPool){
    const client=await storage.rawPool.connect();
    try{
      await client.query('begin isolation level repeatable read read only');
      const schema=await inspectSetupSchema(client);
      const extraFindings=[],extraChecks=[];
      const read=async(table,convert)=>{
        if(!setupSchemaUsable(schema,table))return null;
        await client.query('savepoint setup_capture');
        try{const rows=(await client.query(`select * from ${rr}.${table}`)).rows.map(convert);await client.query('release savepoint setup_capture');return rows;}
        catch(error){await client.query('rollback to savepoint setup_capture');await client.query('release savepoint setup_capture');extraFindings.push({section:'schema',code:'SETUP_CAPTURE_FAILED',severity:'ERROR',field:table,message:`The ${table} snapshot could not be read (${error.code||'read error'}). Check migrations and application database permissions.`});return null;}
      };
      const proposals=await read('proposals',rowToProposal);
      const normal=await read('replacement_records',rowToReplacement),lifecycle=await read('lifecycle_records',rowToLifecycle);
      const references=await read('reference_catalog',row=>row.catalog_json),catalog=references?.[0]??null;
      const objects=await read('artifacts',artifactRow);
      if(roundManagementTables.every(table=>setupSchemaUsable(schema,table))){
        await client.query('savepoint round_management_capture');
        try{const protection=await verifyRoundManagementSchema(client);if(!protection.ok)throw Error(protection.missing.join('; '));const integrity=await roundManagementInventory(client);extraChecks.push({id:'round_management',status:'PASSED',checked:integrity.records,message:'Verified retained round lifecycle/association histories, current heads, immutable source bindings and canonical request receipts.'});await client.query('release savepoint round_management_capture');}
        catch(error){await client.query('rollback to savepoint round_management_capture');await client.query('release savepoint round_management_capture');extraChecks.push({id:'round_management',status:'FAILED',checked:0,message:'Round management operational integrity failed.'});extraFindings.push({section:'round_management',code:'ROUND_MANAGEMENT_INTEGRITY',severity:'ERROR',field:'roundManagement',message:error.message});}
      }else extraChecks.push({id:'round_management',status:'NOT_CHECKED',checked:0,message:'Round management storage columns are missing or inaccessible; apply migration 032 and runtime grants.'});
      if(businessCommandTables.every(table=>setupSchemaUsable(schema,table))){
        await client.query('savepoint business_command_capture');
        try{const integrity=await businessCommandInventory(client);extraChecks.push({id:'business_commands',status:'PASSED',checked:integrity.jobs.records,message:'Verified confirmed-command states, canonical private intent, publication receipts and retained domain references.'});await client.query('release savepoint business_command_capture');}
        catch(error){await client.query('rollback to savepoint business_command_capture');await client.query('release savepoint business_command_capture');extraChecks.push({id:'business_commands',status:'FAILED',checked:0,message:'Confirmed-command operational integrity failed.'});extraFindings.push({section:'business_commands',code:'BUSINESS_COMMAND_INTEGRITY',severity:'ERROR',field:'commandJobs',message:error.message});}
      }else extraChecks.push({id:'business_commands',status:'NOT_CHECKED',checked:0,message:'Confirmed-command storage columns are missing or inaccessible; apply migration 033 and runtime grants.'});
      if(sourceBomTables.every(table=>setupSchemaUsable(schema,table))){
        await client.query('savepoint source_bom_capture');
        try{const integrity=await sourceBomInventory(client);extraChecks.push({id:'source_boms',status:'PASSED',checked:integrity.sources,message:'Verified immutable source-BOM geometry, exact source identity, typed rows and source-derived order references.'});await client.query('release savepoint source_bom_capture');}
        catch(error){await client.query('rollback to savepoint source_bom_capture');await client.query('release savepoint source_bom_capture');extraChecks.push({id:'source_boms',status:'FAILED',checked:0,message:'Source-BOM operational integrity failed.'});extraFindings.push({section:'source_boms',code:'SOURCE_BOM_INTEGRITY',severity:'ERROR',field:'sourceBoms',message:error.message});}
      }else extraChecks.push({id:'source_boms',status:'NOT_CHECKED',checked:0,message:'Source-BOM storage columns are missing or inaccessible; apply migration 034 and append-only runtime grants.'});
      if(registerGridTables.every(table=>setupSchemaUsable(schema,table))){
        await client.query('savepoint register_grid_capture');
        try{const integrity=await registerGridInventory(client);extraChecks.push({id:'register_grid',status:'PASSED',checked:integrity.heads,message:'Verified private saved-view version histories, canonical idempotent receipts, current heads and redacted shared audit links.'});await client.query('release savepoint register_grid_capture');}
        catch(error){await client.query('rollback to savepoint register_grid_capture');await client.query('release savepoint register_grid_capture');extraChecks.push({id:'register_grid',status:'FAILED',checked:0,message:'Saved register-view operational integrity failed.'});extraFindings.push({section:'register_grid',code:'REGISTER_GRID_INTEGRITY',severity:'ERROR',field:'registerViews',message:error.message});}
      }else extraChecks.push({id:'register_grid',status:'NOT_CHECKED',checked:0,message:'Saved register-view storage is missing or inaccessible; apply migration035 and its explicit runtime grants.'});
      await client.query('savepoint register_reports_capture');
      try{const integrity=await registerReportInventory(client,{artifactRoot:artifacts.root});extraChecks.push({id:'register_reports',status:'PASSED',checked:integrity.sources,message:'Verified original report owner/role, immutable requests, full streamed frozen row captures, selection predicates and source/footer/review/issued-output references.'});await client.query('release savepoint register_reports_capture');}
      catch(error){await client.query('rollback to savepoint register_reports_capture');await client.query('release savepoint register_reports_capture');extraChecks.push({id:'register_reports',status:'FAILED',checked:0,message:'Register-report operational integrity failed.'});extraFindings.push({section:'register_reports',code:'REGISTER_REPORT_INTEGRITY',severity:'ERROR',field:'reportCaptures',message:error.message});}
      if(executionCoordinationTables.every(table=>setupSchemaUsable(schema,table))){
        await client.query('savepoint execution_coordination_capture');
        try{const integrity=await executionCoordinationInventory(client);extraChecks.push({id:'execution_coordination',status:'PASSED',checked:Object.values(integrity.tables).reduce((sum,table)=>sum+table.records,0),message:'Verified retained execution instance and permit integrity, configuration fingerprints and recovery links. This snapshot does not establish live worker readiness.'});await client.query('release savepoint execution_coordination_capture');}
        catch(error){await client.query('rollback to savepoint execution_coordination_capture');await client.query('release savepoint execution_coordination_capture');extraChecks.push({id:'execution_coordination',status:'FAILED',checked:0,message:'Execution coordinator operational integrity failed.'});extraFindings.push({section:'execution_coordination',code:'EXECUTION_COORDINATION_INTEGRITY',severity:'ERROR',field:'executionInstances',message:error.message});}
      }else extraChecks.push({id:'execution_coordination',status:'NOT_CHECKED',checked:0,message:'Execution coordination storage is missing or inaccessible; apply migration037 and its explicit runtime grants.'});
      const auditProvenance=await captureAuditProvenanceValidation(client);extraChecks.push(auditProvenance.check);extraFindings.push(...auditProvenance.findings);
      const workingOrder=await captureWorkingOrderValidation(client);extraChecks.push(workingOrder.check);extraFindings.push(...workingOrder.findings);
      const capturedAt=(await client.query('select transaction_timestamp() as time')).rows[0].time.toISOString();
      await client.query('commit');
      return {schema,catalog,proposals,replacements:normal&&lifecycle?[...normal,...lifecycle]:null,artifacts:objects,capturedAt,extraFindings,extraChecks};
    }catch(error){await client.query('rollback').catch(()=>{});throw error;}finally{client.release();}
  }
  const capture=async()=>{
    const operation=async()=>{
      const state=structuredClone(storage.state);let objects=null,catalogState=null;const extraFindings=[],extraChecks=[{id:'execution_coordination',status:'NOT_APPLICABLE',checked:0,message:'Dedicated execution coordination requires named PostgreSQL mode; local desktop review has no SQL execution instances.'}];
      try{catalogState=await artifacts.localState();objects=structuredClone(catalogState.items);}catch{extraFindings.push({section:'attachments',code:'ARTIFACT_CATALOG_UNREADABLE',severity:'ERROR',field:'catalog',message:'The local file catalog could not be read. Restore a verified file catalog before continuing.'});}
      if(catalogState)try{const integrity=localSourceBomInventory(catalogState);extraChecks.push({id:'source_boms',status:'PASSED',checked:integrity.sources,message:'Verified source-BOM projections and source file identities retained together in the atomic local file catalog.'});}catch(error){extraChecks.push({id:'source_boms',status:'FAILED',checked:0,message:'Local source-BOM operational integrity failed.'});extraFindings.push({section:'source_boms',code:'SOURCE_BOM_INTEGRITY',severity:'ERROR',field:'sourceBoms',message:error.message});}
      try{const integrity=localBusinessCommandInventory(state);extraChecks.push({id:'business_commands',status:'PASSED',checked:integrity.jobs.records,message:'Verified local confirmed-command states, canonical intent, saved receipts and workflow results in the atomic state file.'});}catch(error){extraChecks.push({id:'business_commands',status:'FAILED',checked:0,message:'Local confirmed-command integrity failed.'});extraFindings.push({section:'business_commands',code:'BUSINESS_COMMAND_INTEGRITY',severity:'ERROR',field:'commandJobs',message:error.message});}
      try{const integrity=localRegisterGridInventory(state);extraChecks.push({id:'register_grid',status:'PASSED',checked:integrity.heads,message:'Verified private local saved views, full retained version histories, idempotent receipts and redacted audit links in the atomic state file.'});}catch(error){extraChecks.push({id:'register_grid',status:'FAILED',checked:0,message:'Local saved register-view integrity failed.'});extraFindings.push({section:'register_grid',code:'REGISTER_GRID_INTEGRITY',severity:'ERROR',field:'registerViews',message:error.message});}
      if(catalogState)try{const integrity=await localRegisterReportInventory(artifacts,undefined,undefined,{catalog:catalogState});extraChecks.push({id:'register_reports',status:'PASSED',checked:integrity.sources,message:'Verified full retained local report captures, canonical requests/row fingerprints, original role-bound owners, recoverable failed preparations and report review/output references.'});}catch(error){extraChecks.push({id:'register_reports',status:'FAILED',checked:0,message:'Local register-report operational integrity failed.'});extraFindings.push({section:'register_reports',code:'REGISTER_REPORT_INTEGRITY',severity:'ERROR',field:'reportCaptures',message:error.message});}
      const auditProvenance=localAuditProvenanceValidation();extraChecks.push(auditProvenance.check);
      const workingOrder=localWorkingOrderValidation();extraChecks.push(workingOrder.check);
      return {schema:{mode:'local'},catalog:state.referenceCatalog||seedReferenceCatalog(),proposals:state.proposals,replacements:state.replacements,artifacts:objects,capturedAt:new Date().toISOString(),extraFindings,extraChecks};
    };
    const task=(storage.queue||Promise.resolve()).then(operation);if(storage.queue)storage.queue=task.catch(()=>{});return task;
  };
  // Same lock order as file/import publication: artifact queue, then state queue.
  const task=(artifacts.queue||Promise.resolve()).then(capture);artifacts.queue=task.catch(()=>{});return task;
}

async function physicalObjects(repository,objects) {
  if(!Array.isArray(objects))return {check:{id:'attachment_objects',status:'NOT_CHECKED',checked:0,message:'File metadata was unavailable; physical objects were not checked.'},findings:[]};
  const unique=new Map();for(const item of objects)if(/^[a-f0-9]{64}$/.test(item.sha256)){
    const rows=unique.get(item.sha256)||[];rows.push(item);unique.set(item.sha256,rows);
  }
  const entries=[...unique.values()],findings=[];let cursor=0,checked=0;
  await Promise.all(Array.from({length:Math.min(8,entries.length)},async()=>{
    for(;;){const index=cursor++;if(index>=entries.length)return;const rows=entries[index],item=rows[0];checked++;
      try{
        const stat=await fs.lstat(repository.objectPath(item.sha256));
        if(!stat.isFile()||stat.isSymbolicLink())throw Object.assign(Error(),{code:'OBJECT_TYPE'});
        for(const row of rows)if(stat.size!==Number(row.bytes))findings.push({section:'attachments',code:'ARTIFACT_SIZE_MISMATCH',severity:'ERROR',recordId:row.artifactId,field:'bytes',message:`Stored file size differs from the catalog for ${row.filename||row.artifactId}.`});
      }catch(error){findings.push({section:'attachments',code:error.code==='ENOENT'?'ARTIFACT_OBJECT_MISSING':'ARTIFACT_OBJECT_UNREADABLE',severity:'ERROR',recordId:item.artifactId,field:'sha256',message:`Stored file is missing, inaccessible or not a regular file: ${item.filename||item.artifactId}.`});}
    }
  }));
  return {check:{id:'attachment_objects',status:findings.length?'FAILED':'PASSED',checked,message:'Checked object existence, regular-file type and catalog byte size. Content SHA-256 and antivirus were not rerun.'},findings};
}

export async function prepareSetupValidation(storage,artifacts,options={}) {
  const input=await captureSetup(storage,artifacts),physical=await physicalObjects(artifacts,input.artifacts);
  const report=validateSetup({...input,orderNo:options.orderNo});
  report.checks.push(physical.check);report.details.push(...physical.findings);
  return finalizeSetupReport(report);
}

export async function runSetupValidation(storage,artifacts,context,options={}) {
  if(context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can run setup validation.');
  return storage.recordSetupValidation(await prepareSetupValidation(storage,artifacts,options),context);
}
