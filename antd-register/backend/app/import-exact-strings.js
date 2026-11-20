import path from 'node:path';
import {DOMParser} from '@xmldom/xmldom';
import {WORKBOOK_LIMITS,WorkbookLimitError} from './workbook-limits.js';

const mainNamespaces=new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main','http://purl.oclc.org/ooxml/spreadsheetml/main']);
const packageNamespace='http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipNamespaces=new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships','http://purl.oclc.org/ooxml/officeDocument/relationships']);
const children=(node,name)=>{
 const matches=Array.from(node?.childNodes||[]).filter(child=>child.nodeType===1&&(!name||child.localName===name));
 for(const child of matches)if((name||['t','r'].includes(child.localName))&&child.namespaceURI!==node.namespaceURI)fail('NAMESPACE_INVALID','Import source text has an unexpected namespace for a worksheet value.',[node.localName,child.localName]);
 return matches;
};
const fail=(code,message,details=[])=>{throw new WorkbookLimitError('IMPORT_TEXT_'+code,message,details);};

// XML entities are already decoded by the XML parser. Replace ST_Xstring
// tokens once, so _x005F_x000D_ remains literal _x000D_, rather than CR.
export function decodeImportXstring(value){return String(value).replace(/_x([0-9a-fA-F]{4})_/g,(_match,hex)=>String.fromCharCode(parseInt(hex,16)));}

function textValue(node,owner){
 let value='';
 for(const child of children(node)){
  if(child.localName==='t')value+=decodeImportXstring(child.textContent);
  else if(child.localName==='r')for(const text of children(child,'t'))value+=decodeImportXstring(text.textContent);
  // rPh contains phonetic annotations, not the cell's visible value.
 }
 if(value.length>WORKBOOK_LIMITS.maxPartBytes)fail('STRING_LIMIT','An import source string exceeds the text limit.',[owner]);
 return value;
}

function targetPart(owner,target){
 if(typeof target!=='string'||!target||/[\\\x00-\x1f\x7f?#]/.test(target)||/^[a-z][a-z0-9+.-]*:/i.test(target))fail('RELATIONSHIP_INVALID','Import source text has an invalid package relationship.',[owner,String(target)]);
 let decoded;try{decoded=decodeURIComponent(target);}catch{fail('RELATIONSHIP_INVALID','Import source text has an invalid encoded package relationship.',[owner,target]);}
 if(/[\\\x00-\x1f\x7f?#]/.test(decoded)||/^[a-z][a-z0-9+.-]*:/i.test(decoded))fail('RELATIONSHIP_INVALID','Import source text has an unsafe package relationship.',[owner,target]);
 const part=path.posix.normalize(decoded.startsWith('/')?decoded.slice(1):path.posix.join(path.posix.dirname(owner),decoded));
 if(!part||part==='.'||part==='..'||part.startsWith('../')||part.startsWith('/'))fail('RELATIONSHIP_INVALID','Import source text relationship escapes the workbook package.',[owner,target]);
 return part;
}
const relPart=owner=>path.posix.join(path.posix.dirname(owner),'_rels',path.posix.basename(owner)+'.rels');
function coordinate(value,owner){
 const match=/^([A-Z]{1,3})([1-9][0-9]*)$/.exec(value);if(!match)fail('COORDINATE_INVALID','Import source text has an invalid cell coordinate.',[owner,value]);
 let column=0;for(const char of match[1])column=column*26+char.charCodeAt(0)-64;const row=Number(match[2]);
 if(!Number.isSafeInteger(row)||row>WORKBOOK_LIMITS.maxRows||column>WORKBOOK_LIMITS.maxColumns)fail('COORDINATE_LIMIT','Import source text exceeds the bounded cell coordinates.',[owner,value]);
 return {row,column};
}
function address(row,column){let letters='';for(;column;column=Math.floor((column-1)/26))letters=String.fromCharCode(65+(column-1)%26)+letters;return letters+row;}

/** Import-only overlay of decoded string values on a validated SheetJS model.
 * The caller first runs archive and model validation. bookFiles reuses the
 * package already inflated by SheetJS; no second ZIP inflate or file I/O.
 * Only string .v/display cache are touched. Numeric/error/boolean values,
 * formula/cache presence, formatting and coordinates retain their model.
 */
export function restoreImportStringValues(book){
 const files=book.files;
 try{
  if(book.bookType!=='xlsx')return book; // Legacy/binary readers retain their existing behavior.
  if(!files||typeof files!=='object')fail('PARTS_UNAVAILABLE','Exact import source text requires the retained workbook package.');
  let readBytes=0,cellCount=0;const usedParts=new Set();
  function document(part,expected,namespace){
   if(usedParts.has(part))fail('PART_REUSED','Import source text found a reused package part.',[part]);usedParts.add(part);
   const entry=files[part],content=entry?.content;
   if(!content||!(content instanceof Uint8Array))fail('PART_MISSING','Import source text cannot read a required package part.',[part]);
   if(content.length>WORKBOOK_LIMITS.maxPartBytes)fail('PART_LIMIT','An import source XML part exceeds the byte limit.',[part]);
   readBytes+=content.length;if(readBytes>WORKBOOK_LIMITS.maxExpandedBytes)fail('TOTAL_LIMIT','Import source text exceeds the total expanded byte limit.');
   const encoding=content[0]===0xfe&&content[1]===0xff||content[0]===0&&content[1]===0x3c?'utf-16be':content[0]===0xff&&content[1]===0xfe||content[0]===0x3c&&content[1]===0?'utf-16le':'utf-8';
   let xml;try{xml=new TextDecoder(encoding,{fatal:true}).decode(content);}catch(error){fail('ENCODING_INVALID','Import source text contains invalid XML character encoding.',[part,error.message]);}
   if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new WorkbookLimitError('WORKBOOK_XML_DECLARATION','The workbook contains a prohibited XML document-type or entity declaration.',[part]);
   let doc;try{doc=new DOMParser({onError:(level,message)=>{throw Error(level+': '+message);}}).parseFromString(xml,'application/xml');}catch(error){fail('XML_INVALID','Import source text contains invalid XML.',[part,error.message]);}
   const element=doc.documentElement;if(!element||element.localName!==expected||!(namespace instanceof Set?namespace.has(element.namespaceURI):element.namespaceURI===namespace))fail('XML_ROOT_INVALID','Import source text has an unexpected package XML root.',[part,expected]);
   return element;
  }
  function relationships(owner){
   const part=owner?relPart(owner):'_rels/.rels',root=document(part,'Relationships',packageNamespace),result=new Map();
   for(const item of children(root,'Relationship')){const id=item.getAttribute('Id');if(!id||result.has(id))fail('RELATIONSHIP_INVALID','Import source text found an invalid or duplicate relationship identifier.',[part,id]);result.set(id,{type:item.getAttribute('Type'),target:item.getAttribute('Target'),external:item.getAttribute('TargetMode')==='External'});}
   return result;
  }
  const roots=relationships(''),office=[...roots.values()].filter(item=>item.type.endsWith('/officeDocument'));
  if(office.length!==1||office[0].external)fail('WORKBOOK_RELATIONSHIP','Import source text cannot identify one internal workbook.',['_rels/.rels']);
  const workbookPart=targetPart('',office[0].target),workbook=document(workbookPart,'workbook',mainNamespaces),relations=relationships(workbookPart);
  const sharedRelations=[...relations.values()].filter(item=>item.type.endsWith('/sharedStrings'));
  if(sharedRelations.length>1||sharedRelations[0]?.external)fail('SHARED_STRINGS_INVALID','Import source text found invalid shared-string relationships.',[workbookPart]);
  let strings=[];
  if(sharedRelations.length){const part=targetPart(workbookPart,sharedRelations[0].target),root=document(part,'sst',mainNamespaces),nodes=children(root,'si');if(nodes.length>WORKBOOK_LIMITS.maxCells)fail('STRING_COUNT_LIMIT','The import shared-string table exceeds the bounded cell limit.',[part]);strings=nodes.map((node,index)=>textValue(node,`${part} shared string ${index}`));}
  const sheetContainers=children(workbook,'sheets');if(sheetContainers.length!==1)fail('SHEETS_INVALID','Import source text cannot identify the workbook sheet list.',[workbookPart]);
  const sheets=children(sheetContainers[0],'sheet');if(sheets.length!==book.SheetNames.length||sheets.length>WORKBOOK_LIMITS.maxSheets)fail('SHEETS_INVALID','Import source text sheet order differs from the validated workbook model.',[workbookPart]);
  for(let index=0;index<sheets.length;index++){
   const sheetNode=sheets[index],identifiers=Array.from(sheetNode.attributes).filter(attr=>{
    if(attr.namespaceURI==='http://www.w3.org/2000/xmlns/')return false;
    // Refuse aliases the model reader folds into id, including unqualified
    // id_suffix and case variants, before strings and typed cells can mix.
    const key=attr.prefix?attr.localName:attr.localName.split('_',1)[0];
    return key.toLowerCase()==='id';
   }),name=book.SheetNames[index];
   if(identifiers.length!==1||identifiers[0].localName!=='id'||!officeRelationshipNamespaces.has(identifiers[0].namespaceURI))fail('RELATIONSHIP_ATTRIBUTE_INVALID','Import source text has an invalid sheet relationship identifier.',[name]);
   const relationshipId=identifiers[0].value,relation=relations.get(relationshipId);
   if(!sheetNode.hasAttribute('name')||decodeImportXstring(sheetNode.getAttribute('name'))!==name)fail('MODEL_SHEET_MISMATCH','Import source text sheet names differ from the validated workbook model.',[sheetNode.getAttribute('name'),name]);
   if(!relation||relation.external)fail('SHEET_RELATIONSHIP','Import source text cannot identify an internal sheet.',[name,relationshipId||'']);
   if(!relation.type.endsWith('/worksheet'))continue; // Charts/dialog/macro sheets have no imported cells.
   const part=targetPart(workbookPart,relation.target),worksheet=document(part,'worksheet',mainNamespaces),data=children(worksheet,'sheetData');
   if(data.length>1)fail('SHEET_DATA_INVALID','Import source text found multiple worksheet data regions.',[name,part]);
   if(!data.length)continue;const model=book.Sheets[name];let previousRow=0;const seenRows=new Set();
   for(const rowNode of children(data[0],'row')){
    const explicit=rowNode.getAttribute('r'),row=explicit?Number(explicit):previousRow+1;if(!Number.isSafeInteger(row)||row<1||row>WORKBOOK_LIMITS.maxRows)fail('COORDINATE_LIMIT','Import source text has an invalid worksheet row.',[name,explicit]);if(seenRows.has(row))fail('COORDINATE_INVALID','Import source text found a duplicate worksheet row.',[name,String(row)]);seenRows.add(row);previousRow=row;let column=0;const seenColumns=new Set();
    for(const cell of children(rowNode,'c')){
     if(++cellCount>WORKBOOK_LIMITS.maxCells)fail('CELL_LIMIT','Import source text exceeds the bounded cell count.');
     const reference=cell.getAttribute('r')||address(row,column+1),position=coordinate(reference,name);column=position.column;
     if(position.row!==row||seenColumns.has(position.column))fail('COORDINATE_INVALID','Import source text has a mismatched or duplicate cell coordinate.',[name,reference]);seenColumns.add(position.column);
     const kind=cell.getAttribute('t');if(!['str','inlineStr','s'].includes(kind))continue;
     let value;
     if(kind==='str'){
      const nodes=children(cell,'v');if(!nodes.length)continue;if(nodes.length!==1)fail('CELL_VALUE_INVALID','Import source text found multiple string cache values.',[name,reference]);value=decodeImportXstring(nodes[0].textContent);
     }else if(kind==='inlineStr'){
      const nodes=children(cell,'is');if(!nodes.length)continue;if(nodes.length!==1)fail('CELL_VALUE_INVALID','Import source text found multiple inline string values.',[name,reference]);value=textValue(nodes[0],`${name}!${reference}`);
     }else{
      const nodes=children(cell,'v'),number=nodes[0]?.textContent;if(nodes.length!==1||!/^\d+$/.test(number??''))fail('SHARED_STRING_REFERENCE','Import source text has an invalid shared-string index.',[name,reference]);const offset=Number(number);if(!Number.isSafeInteger(offset)||offset>=strings.length)fail('SHARED_STRING_REFERENCE','Import source text references a missing shared string.',[name,reference]);value=strings[offset];
     }
     const target=model[reference];if(!target){if(value==='')continue;fail('MODEL_CELL_MISSING','Import source text cannot correlate a string cell with the validated model.',[name,reference]);}
     if(target.t!=='s')fail('MODEL_CELL_TYPE','Import source text found an incompatible model cell type.',[name,reference,target.t]);
     if(target.v!==value){target.v=value;delete target.w;}
    }
   }
  }
  return book;
 }finally{delete book.files;delete book.keys;delete book.cfb;}
}
