import {createHash,randomUUID} from 'node:crypto';
import {referenceData,cleanText,normalize,manufacturerKey,canonicalManufacturer,withReferenceData} from './normalization.js';
import {validBusinessDate} from './validation.js';
import {httpError} from './auth.js';

export const referenceKinds={manufacturers:['name','notes'],aliases:['alias','manufacturer','notes'],relationships:['original','current','relation','effectiveDate','notes'],products:['product','productDecimalNo','notes'],suppliers:['name','notes']};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fail=(code,message,details=[])=>{throw httpError(422,message,{code,details});};
export function catalogHash(catalog){const {hash,...data}=catalog;return digest(data);}
export function seedReferenceCatalog(){
  const catalog={revision:1,source:referenceData.metadata,entries:{}};
  for(const kind of Object.keys(referenceKinds))catalog.entries[kind]=referenceData[kind].map((value,index)=>({...(typeof value==='string'?{name:value}:value),id:`${kind}-${digest([kind,index,value]).slice(0,24)}`,active:true,sourceIndex:index+1}));
  catalog.hash=catalogHash(catalog);return catalog;
}
export function catalogData(catalog){
  const result={metadata:{...catalog.source,referenceRevision:catalog.revision,referenceHash:catalog.hash}};
  for(const kind of Object.keys(referenceKinds))result[kind]=catalog.entries[kind].filter(row=>row.active).map(row=>['manufacturers','suppliers'].includes(kind)?row.name:Object.fromEntries(referenceKinds[kind].filter(key=>key in row).map(key=>[key,row[key]])));
  return result;
}
export const withCatalog=(catalog,operation)=>withReferenceData({revision:catalog.revision,hash:catalog.hash,data:catalogData(catalog),catalog},operation);
export function validateCatalog(catalog){
  const active=kind=>catalog.entries[kind].filter(row=>row.active),unique=(kind,key)=>{const seen=new Set();for(const row of active(kind)){const value=key(row);if(seen.has(value))fail('REFERENCE_DUPLICATE',`An active ${kind} entry already uses this identity.`,[value]);seen.add(value);}};
  for(const kind of ['manufacturers','suppliers'])unique(kind,row=>normalize(row.name));unique('products',row=>normalize(row.productDecimalNo));unique('aliases',row=>normalize(row.alias));
  const manufacturers=new Map(active('manufacturers').map(row=>[normalize(row.name),row.name]));
  for(const row of active('aliases')){
    if(['NOT SPECIFIED','UNKNOWN','N/A'].includes(normalize(row.manufacturer)))fail('REFERENCE_PLACEHOLDER','A placeholder cannot be an alias target.');
    if(!manufacturers.has(normalize(row.manufacturer)))fail('REFERENCE_ALIAS_TARGET','Select an active canonical manufacturer for this alias.',[`${row.alias} → ${row.manufacturer}`]);
    if(manufacturers.has(normalize(row.alias))&&normalize(row.alias)!==normalize(row.manufacturer))fail('REFERENCE_CANONICAL_ALIAS','An active canonical manufacturer cannot be an alias for another manufacturer.',[row.alias]);
    if(['NOT SPECIFIED','UNKNOWN','N/A'].includes(normalize(row.alias)))fail('REFERENCE_PLACEHOLDER','A placeholder cannot be a manufacturer alias.');
    row.manufacturer=manufacturers.get(normalize(row.manufacturer));
  }
  const allowedDuplicates=withCatalog(seedReferenceCatalog(),()=>{const groups=new Map();for(const row of seedReferenceCatalog().entries.relationships){const key=[manufacturerKey(row.original),manufacturerKey(row.current)].join('|');groups.set(key,[...(groups.get(key)||[]),row.id]);}return groups;});
  withCatalog(catalog,()=>{
    const seen=new Map();for(const row of active('relationships')){const key=[manufacturerKey(row.original),manufacturerKey(row.current)].join('|');if(seen.has(key)&&![...allowedDuplicates.values()].some(ids=>ids.length>1&&ids.includes(row.id)&&ids.includes(seen.get(key))))fail('REFERENCE_DUPLICATE','An active directed manufacturer relationship already uses this pair.',[key]);seen.set(key,row.id);}
    for(const row of active('relationships'))if(!manufacturerKey(row.original)||!manufacturerKey(row.current)||manufacturerKey(row.original)===manufacturerKey(row.current))fail('REFERENCE_RELATIONSHIP','A directed relationship requires two distinct manufacturers.',[`${row.original} → ${row.current}`]);
  });
}

function relationshipIdentities(catalog){
  return withCatalog(catalog,()=>catalog.entries.relationships.filter(row=>row.active).map(row=>({id:row.id,original:canonicalManufacturer(row.original),current:canonicalManufacturer(row.current),key:[manufacturerKey(row.original),manufacturerKey(row.current)].join('|'),source:row})));
}

function validateIdentityRelationships(catalog){
  const sourceGroups=new Map();for(const row of relationshipIdentities(seedReferenceCatalog()))sourceGroups.set(row.key,[...(sourceGroups.get(row.key)||[]),row.id]);
  const groups=new Map();for(const row of relationshipIdentities(catalog)){
    if(!normalize(row.original)||!normalize(row.current)||normalize(row.original)===normalize(row.current))fail('REFERENCE_IDENTITY_RELATIONSHIP','This identity change would create an empty or self-directed manufacturer relationship. Resolve the relationship explicitly before changing the identity.',[`${row.id}: ${row.source.original} → ${row.source.current}`]);
    groups.set(row.key,[...(groups.get(row.key)||[]),row]);
  }
  for(const [key,rows] of groups)if(rows.length>1&&![...sourceGroups.values()].some(ids=>rows.every(row=>ids.includes(row.id))))fail('REFERENCE_IDENTITY_RELATIONSHIP','This identity change would collapse distinct directed relationship rows. Resolve the conflicting relationships before changing the identity.',[key,...rows.map(row=>`${row.id}: ${row.source.original} → ${row.source.current}; ${row.source.relation}; ${row.source.effectiveDate||''}`)]);
}

function identityChanges(before,after){
  const changes=[];
  for(const kind of Object.keys(referenceKinds)){
    const prior=new Map(before.entries[kind].map(row=>[row.id,row]));
    for(const row of after.entries[kind]){
      const previous=prior.get(row.id)||null;
      if(JSON.stringify(previous)!==JSON.stringify(row))changes.push({kind,id:row.id,before:previous?structuredClone(previous):null,after:structuredClone(row)});
    }
  }
  return changes;
}

function planManufacturerIdentity(catalog,body,reason){
  if(!['RENAME','MERGE'].includes(body.action))fail('REFERENCE_ACTION','Choose RENAME or MERGE for an identity change.');
  if(body.kind!=='manufacturers')fail('REFERENCE_IDENTITY_KIND','Advanced identity changes currently apply only to manufacturers. Supplier/product identities require their account/order reconciliation workflow.');
  if(catalogHash(catalog)!==catalog.hash)throw httpError(409,'Reference catalog integrity check failed. Restore a verified catalog before planning an identity change.',{code:'REFERENCE_INTEGRITY'});
  if(Object.keys(body.values).some(key=>body.action==='RENAME'?key!=='name':true))fail('REFERENCE_IDENTITY_FIELDS',body.action==='RENAME'?'A rename changes only the manufacturer name.':'A merge selects an existing target; do not combine it with other field edits.');
  const source=catalog.entries.manufacturers.find(row=>row.id===body.id);
  if(!source)throw httpError(404,'Source manufacturer not found.');
  if(!source.active||!cleanText(source.name))fail('REFERENCE_IDENTITY_SOURCE','Select an active source manufacturer.');
  const placeholder=name=>['NOT SPECIFIED','UNKNOWN','N/A'].includes(normalize(name));
  if(placeholder(source.name))fail('REFERENCE_PLACEHOLDER','Placeholder manufacturer entries cannot be renamed or merged.');
  const next=structuredClone(catalog),entry=next.entries.manufacturers.find(row=>row.id===source.id),before=structuredClone(source);
  let target;
  if(body.action==='RENAME'){
    if(typeof body.values.name!=='string'||!cleanText(body.values.name))fail('REFERENCE_REQUIRED','Enter the new canonical manufacturer name.',['name']);
    const name=cleanText(body.values.name);if(name.length>250)fail('REFERENCE_LENGTH','The manufacturer name is too long.');if(placeholder(name))fail('REFERENCE_PLACEHOLDER','A placeholder cannot become a canonical manufacturer identity.');
    const collision=next.entries.manufacturers.find(row=>row.id!==entry.id&&normalize(row.name)===normalize(name));
    if(collision)fail('REFERENCE_IDENTITY_COLLISION','That name belongs to another active or retired manufacturer identity. Choose an explicit merge into an active identity instead.',[`${collision.id}: ${collision.name}`]);
    const aliasCollision=next.entries.aliases.find(row=>normalize(row.alias)===normalize(name)&&normalize(row.manufacturer)!==normalize(source.name));
    if(aliasCollision)fail('REFERENCE_IDENTITY_COLLISION','That spelling is already owned by another manufacturer alias.',[`${aliasCollision.id}: ${aliasCollision.alias} → ${aliasCollision.manufacturer}`]);
    entry.name=name;target=entry;
  }else{
    target=next.entries.manufacturers.find(row=>row.id===body.targetId);
    if(!target||!target.active||!cleanText(target.name)||target.id===entry.id)fail('REFERENCE_IDENTITY_TARGET','Choose a different active canonical manufacturer as the merge target.');
    if(placeholder(target.name))fail('REFERENCE_PLACEHOLDER','A placeholder cannot be a manufacturer merge target.');
    entry.active=false;
  }
  const impact={sourceId:source.id,sourceName:source.name,targetId:target.id,targetName:target.name,sourceRetired:body.action==='MERGE',aliasesRetargeted:0,legacyAliasAdded:false,legacyAliasId:null,relationshipsReinterpreted:[]};
  if(body.action==='RENAME'&&entry.name===source.name)return {catalog,before,after:structuredClone(source),changed:false,reason,kind:body.kind,action:body.action,changes:[],impact};
  // Retired aliases keep their state, but their target follows the canonical
  // identity so reactivation cannot accidentally resurrect the retired source.
  for(const alias of next.entries.aliases)if(normalize(alias.manufacturer)===normalize(source.name)&&alias.manufacturer!==target.name){alias.manufacturer=target.name;impact.aliasesRetargeted++;}
  let legacy=next.entries.aliases.find(row=>row.active&&normalize(row.alias)===normalize(source.name));
  if(legacy){
    if(normalize(legacy.manufacturer)!==normalize(target.name))fail('REFERENCE_IDENTITY_COLLISION','The original manufacturer spelling is already mapped to a different canonical identity.',[`${legacy.alias} → ${legacy.manufacturer}`]);
  }else{
    const id=`aliases-${digest(['manufacturer-identity-alias',catalog.revision,source.id,source.name,target.id,target.name]).slice(0,24)}`;
    if(next.entries.aliases.some(row=>row.id===id))fail('REFERENCE_IDENTITY_COLLISION','The generated legacy-alias identity already exists. Review the catalog before retrying.');
    legacy={id,active:true,alias:source.name,manufacturer:target.name};next.entries.aliases.push(legacy);impact.legacyAliasAdded=true;
  }
  impact.legacyAliasId=legacy.id;
  validateIdentityRelationships(next);validateCatalog(next);
  const oldRelations=new Map(relationshipIdentities(catalog).map(row=>[row.id,row]));
  for(const row of relationshipIdentities(next)){
    const prior=oldRelations.get(row.id);
    if(prior&&(prior.original!==row.original||prior.current!==row.current))impact.relationshipsReinterpreted.push({id:row.id,before:{original:prior.original,current:prior.current},after:{original:row.original,current:row.current},source:{original:row.source.original,current:row.source.current},relation:row.source.relation,effectiveDate:row.source.effectiveDate||''});
  }
  const changes=identityChanges(catalog,next);next.revision++;next.hash=catalogHash(next);
  return {catalog:next,before,after:structuredClone(entry),changed:true,reason,kind:body.kind,action:body.action,changes,impact};
}

export function planReferenceChange(catalog,body,context){
  if(context.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can moderate reference data.');
  if(!body||typeof body!=='object'||Array.isArray(body))fail('REFERENCE_VALUES','A reference change object is required.');
  if(!Number.isSafeInteger(body.revision)||body.revision<1)throw httpError(428,'Open the current reference catalog before saving.',{code:'REFERENCE_VERSION_REQUIRED'});
  if(body.revision!==catalog.revision)throw httpError(409,'The reference catalog changed. Refresh it and review your changes before saving.',{code:'REFERENCE_CHANGED',current:{revision:catalog.revision,hash:catalog.hash}});
  const fields=referenceKinds[body.kind];if(!fields)fail('REFERENCE_KIND','Choose a supported reference catalog.');
  const reason=cleanText(body.reason);if(!reason||reason.length>2000)fail('REFERENCE_REASON','Enter a reason for this reference change (up to 2,000 characters).');
  if(!body.values||typeof body.values!=='object'||Array.isArray(body.values))fail('REFERENCE_VALUES','Reference fields are required.');
  if(body.action!==undefined)return planManufacturerIdentity(catalog,body,reason);
  for(const key of Object.keys(body.values))if(![...fields,'active'].includes(key))fail('REFERENCE_FIELD',`The field ${key} cannot be edited in ${body.kind}.`);
  const next=structuredClone(catalog),rows=next.entries[body.kind],previous=body.id?rows.find(row=>row.id===body.id):null;
  if(body.id&&!previous)throw httpError(404,'Reference entry not found.');
  const before=previous?structuredClone(previous):null,entry=previous||{id:`${body.kind}-${randomUUID()}`,active:true};
  for(const key of fields)if(Object.hasOwn(body.values,key)){if(typeof body.values[key]!=='string')fail('REFERENCE_VALUE',`${key} must be text.`);entry[key]=cleanText(body.values[key]);if(entry[key].length>(key==='notes'?2000:250))fail('REFERENCE_LENGTH',`${key} is too long.`);}
  if(Object.hasOwn(body.values,'active')){if(typeof body.values.active!=='boolean')fail('REFERENCE_ACTIVE','The active flag must be true or false.');entry.active=body.values.active;}
  const required=fields.filter(key=>!['notes','effectiveDate'].includes(key));for(const key of required)if(!entry[key])fail('REFERENCE_REQUIRED',`Enter ${key} for this reference entry.`,[key]);
  if(before){const identity=['manufacturers','suppliers'].includes(body.kind)?'name':body.kind==='products'?'productDecimalNo':null;if(identity&&entry[identity]!==before[identity])fail('REFERENCE_IDENTITY','This reference identity is retained for historical records and account assignments.',[`Create a new ${body.kind} entry and retire the old one. Manufacturer spelling changes can be represented with an alias after retiring the old canonical entry.`]);}
  if(entry.effectiveDate&&entry.effectiveDate!==before?.effectiveDate&&!validBusinessDate(entry.effectiveDate))fail('REFERENCE_DATE','Enter the effective date as YYYY-MM-DD. Existing source date text may be retained unchanged.');
  if(!previous)rows.push(entry);validateCatalog(next);
  if(before&&JSON.stringify(before)===JSON.stringify(entry))return {catalog,before,after:entry,changed:false,reason,kind:body.kind};
  next.revision++;next.hash=catalogHash(next);return {catalog:next,before,after:entry,changed:true,reason,kind:body.kind};
}
