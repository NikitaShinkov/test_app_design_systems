import path from 'node:path';
import {isDecisionHeader,decisionAppearance,decisionFormattingRules} from './decision-formatting.js';
import {loadBundledProfiles} from './font-metrics.js';
import {applyPreservedRowGrowth} from './preserved-row-growth.js';
let layoutProfiles;
const measuredLayoutProfiles=()=>layoutProfiles??=loadBundledProfiles(new URL('.',import.meta.url));
import JSZip from 'jszip';
import XLSX from 'xlsx';
import {assertWorkbookArchive,assertWorkbookModel} from './workbook-limits.js';
import {DOMParser,XMLSerializer} from '@xmldom/xmldom';
import {deleteFormulaColumns,deleteTableColumnReferences,deletedRange,columnIndex,columnLetters} from './formula-deletion.js';

const serializer=new XMLSerializer();
const children=(node,name)=>Array.from(node?.childNodes||[]).filter(child=>child.nodeType===1&&(!name||child.localName===name));
const first=(node,name)=>children(node,name)[0];
const descendants=(node,name)=>Array.from(node.getElementsByTagNameNS('*',name));
const xml=node=>serializer.serializeToString(node);
const fail=(code,message,details=[])=>{throw Object.assign(new Error(message),{status:422,code,details});};
function parse(value,part) {
  value=value.replace(/^\uFEFF/,'').replace(/^(<\?xml\b[^?]*\bencoding\s*=\s*["'])[^"']+(["'])/i,'$1UTF-8$2');
  if(/<!DOCTYPE|<!ENTITY/i.test(value))fail('M09_XML_DECLARATION','M09 cannot process XML document-type or entity declarations.',[part]);
  try{return new DOMParser({onError:(level,message)=>{throw new Error(`${level}: ${message}`);}}).parseFromString(value,'application/xml');}
  catch(error){fail('M09_INVALID_XML','M09 cannot read a workbook XML part.',[`${part}: ${error.message}`]);}
}
const attribute=(node,local)=>Array.from(node.attributes||[]).find(item=>item.localName===local)?.value;
const partTarget=(base,target)=>path.posix.normalize(path.posix.join(path.posix.dirname(base),target.replace(/^\//,'')));
function relativePart(base,target){return target.startsWith('/')?target.slice(1):partTarget(base,target);}
const relationshipPart=part=>path.posix.join(path.posix.dirname(part),'_rels',`${path.posix.basename(part)}.rels`);
const list=value=>String(value||'').split(/\s+/).filter(Boolean);
function moveFilterColumns(filter,column) {
  const left=columnIndex(filter.getAttribute('ref').split(':')[0]),offset=column-left;
  if(offset<0)return;
  for(const child of children(filter,'filterColumn')){const index=Number(child.getAttribute('colId'));if(index===offset)filter.removeChild(child);else if(index>offset)child.setAttribute('colId',index-1);}
}

export class PreservedWorkbook {
  static async open(bytes) {
    try{assertWorkbookArchive(bytes);}catch(error){if(error.code==='WORKBOOK_XML_DECLARATION')fail('M09_XML_DECLARATION','M09 cannot process XML document-type or entity declarations.',error.details);throw error;}
    const editor=new PreservedWorkbook();editor.zip=await JSZip.loadAsync(bytes);editor.documents=new Map();editor.changed=new Set();editor.values=new WeakMap();editor.rawValues=new WeakMap();editor.styleCache=new Map();editor.fontCache=new Map();
    if(Object.keys(editor.zip.files).some(part=>part.startsWith('_xmlsignatures/')))fail('M09_SIGNED_WORKBOOK','M09 cannot change a digitally signed source workbook.',['Create an unsigned copy of the original BOM and register that copy before export.']);
    editor.book=XLSX.read(bytes,{type:'buffer',cellStyles:true,cellFormula:true});
    assertWorkbookModel(editor.book);
    editor.workbook=await editor.document('xl/workbook.xml');editor.workbookRelationships=await editor.document('xl/_rels/workbook.xml.rels');
    const relationships=children(editor.workbookRelationships.documentElement,'Relationship');
    editor.sheets=[];
    for(const sheet of children(first(editor.workbook.documentElement,'sheets'),'sheet')) {
      const relation=relationships.find(item=>item.getAttribute('Id')===attribute(sheet,'id'));
      if(!relation||relation.getAttribute('TargetMode')==='External')fail('M09_WORKSHEET_RELATIONSHIP','M09 found an invalid worksheet relationship.');
      const part=relativePart('xl/workbook.xml',relation.getAttribute('Target')),document=await editor.document(part),name=sheet.getAttribute('name');
      const model={name,part,document,rows:new Map(),cells:new Map(),tables:[]};
      for(const row of children(first(document.documentElement,'sheetData'),'row')) {
        model.rows.set(Number(row.getAttribute('r')),row);
        for(const cell of children(row,'c')) {
          const address=cell.getAttribute('r');model.cells.set(address,cell);
          const original=editor.book.Sheets[name]?.[address];editor.values.set(cell,original?.w??(original?.v===undefined?'':String(original.v)));
          // VBA identity reads Cells.Value, independently of its number format.
          // AC8_CleanText treats errors/empty cells as blank; no formula is evaluated.
          editor.rawValues.set(cell,original?.t==='e'?'':original?.v??'');
          const formula=first(cell,'f');
          if(formula?.getAttribute('t')==='shared') {
            if(!original?.f)fail('M09_SHARED_FORMULA','M09 cannot resolve a shared formula.',[`${name}!${address}`]);
            formula.textContent=original.f;for(const key of ['t','si','ref'])formula.removeAttribute(key);editor.changed.add(part);
          }
        }
      }
      const relPart=relationshipPart(part);
      if(editor.zip.file(relPart)) {
        const relations=await editor.document(relPart);
        for(const rel of children(relations.documentElement,'Relationship').filter(item=>item.getAttribute('Type').endsWith('/table'))) {
          const tablePart=relativePart(part,rel.getAttribute('Target')),table=await editor.document(tablePart);model.tables.push({part:tablePart,document:table,relationshipId:rel.getAttribute('Id')});
        }
      }
      editor.sheets.push(model);
    }
    const stylesRel=relationships.find(item=>item.getAttribute('Type').endsWith('/styles'));editor.stylesPart=stylesRel?relativePart('xl/workbook.xml',stylesRel.getAttribute('Target')):'xl/styles.xml';
    if(!stylesRel){
      const part=editor.stylesPart;
      if(!editor.zip.file(part)){editor.documents.set(part,parse('<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',part));editor.changed.add(part);}
      let id=1;while(relationships.some(rel=>rel.getAttribute('Id')===`rId${id}`))id++;
      editor.workbookRelationships.documentElement.appendChild(editor.element(editor.workbookRelationships,'Relationship',{Id:`rId${id}`,Type:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',Target:'styles.xml'}));editor.changed.add('xl/_rels/workbook.xml.rels');
      const types=await editor.document('[Content_Types].xml');if(!children(types.documentElement,'Override').some(item=>item.getAttribute('PartName')===`/${part}`))types.documentElement.appendChild(editor.element(types,'Override',{PartName:`/${part}`,ContentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'}));editor.changed.add('[Content_Types].xml');
    }
    editor.styles=editor.documents.get(editor.stylesPart)||await editor.document(editor.stylesPart);editor.sheet=editor.sheets[0];
    if(['1','true'].includes(first(editor.sheet.document.documentElement,'sheetProtection')?.getAttribute('sheet')))fail('M09_SHEET_PROTECTED','M09 cannot edit the protected original BOM worksheet.',[`${editor.sheet.name}: unprotect this worksheet in a separate source copy, then register that copy before export.`]);
    return editor;
  }
  async document(part) {
    if(!this.documents.has(part)){const entry=this.zip.file(part);if(!entry)fail('M09_PART_MISSING','M09 cannot find a required workbook part.',[part]);const bytes=await entry.async('nodebuffer'),encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';let value;try{value=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch(error){fail('M09_INVALID_ENCODING','M09 cannot decode a workbook XML part.',[`${part}: ${error.message}`]);}this.documents.set(part,parse(value,part));}
    return this.documents.get(part);
  }
  element(document,name,attributes={},text=null) {
    const root=document.documentElement,node=document.createElementNS(root.namespaceURI,root.prefix?`${root.prefix}:${name}`:name);
    for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==null)node.textContent=String(text);return node;
  }
  ensure(parent,name,attributes={}){let node=first(parent,name);if(!node){node=this.element(parent.ownerDocument,name,attributes);parent.appendChild(node);}return node;}
  cell(row,column,create=false) {
    const address=`${columnLetters(column)}${row}`;let node=this.sheet.cells.get(address);
    if(!node&&create){let rowNode=this.sheet.rows.get(row);const data=this.ensure(this.sheet.document.documentElement,'sheetData');
      if(!rowNode){rowNode=this.element(this.sheet.document,'row',{r:row});data.insertBefore(rowNode,children(data,'row').find(item=>Number(item.getAttribute('r'))>row)||null);this.sheet.rows.set(row,rowNode);}
      node=this.element(this.sheet.document,'c',{r:address});rowNode.insertBefore(node,children(rowNode,'c').find(item=>columnIndex(item.getAttribute('r'))>column)||null);this.sheet.cells.set(address,node);
    }return node;
  }
  text(row,column){return this.values.get(this.cell(row,column))||'';}
  value(row,column){return this.rawValues.get(this.cell(row,column))??'';}
  set(row,column,value) {
    const node=this.cell(row,column,true);for(const child of children(node))if(['f','v','is'].includes(child.localName))node.removeChild(child);
    node.setAttribute('t','inlineStr');const inline=this.element(this.sheet.document,'is'),text=this.element(this.sheet.document,'t',{},String(value??''));text.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');inline.appendChild(text);node.appendChild(inline);this.values.set(node,String(value??''));this.rawValues.set(node,String(value??''));this.changed.add(this.sheet.part);return node;
  }
  async removeColumn(column) {
    const target=this.sheet.name,change=formula=>deleteFormulaColumns(formula,target,target,column);
    const removed=this.sheet.tables.flatMap(table=>{const root=table.document.documentElement,left=columnIndex(root.getAttribute('ref').split(':')[0]),field=children(first(root,'tableColumns'),'tableColumn')[column-left];return field?[{table,name:root.getAttribute('name'),column:field.getAttribute('name')}]:[];});
    const rewrite=(formula,sheet,owner=null)=>removed.reduce((text,item)=>deleteTableColumnReferences(text,item.name,item.column,{implicit:item.table===owner}),deleteFormulaColumns(formula,sheet,target,column));
    for(const model of this.sheets) {
      const before=xml(model.document);
      for(const cell of model.cells.values()) {
        const formula=first(cell,'f');if(!formula)continue;
        if(model===this.sheet&&formula.getAttribute('t')==='array'&&formula.hasAttribute('ref')) {
          const [start,end=start]=formula.getAttribute('ref').split(':'),low=Math.min(columnIndex(start),columnIndex(end)),high=Math.max(columnIndex(start),columnIndex(end));
          if(column>=low&&column<=high&&low!==high)fail('M09_ARRAY_FORMULA_OVERLAP','M09 cannot delete part of an array-formula range.',[`${target}!${formula.getAttribute('ref')}: workflow column ${columnLetters(column)} intersects this array. Resolve the source array before export.`]);
        }
        const address=cell.getAttribute('r'),row=Number(address.match(/[0-9]+$/)[0]),col=columnIndex(address),owner=model.tables.find(table=>{const [low,high=low]=table.document.documentElement.getAttribute('ref').split(':');return col>=columnIndex(low)&&col<=columnIndex(high)&&row>=Number(low.match(/[0-9]+$/)[0])&&row<=Number(high.match(/[0-9]+$/)[0]);});
        formula.textContent=rewrite(formula.textContent,model.name,owner);
        if(model===this.sheet&&formula.hasAttribute('ref'))formula.setAttribute('ref',change(formula.getAttribute('ref')));
      }
      for(const tag of ['formula','formula1','formula2','f'])for(const formula of descendants(model.document,tag))if(formula.parentNode?.localName!=='c')formula.textContent=rewrite(formula.textContent,model.name);
      if(model===this.sheet) {
        for(const filter of descendants(model.document,'autoFilter'))moveFilterColumns(filter,column);
        for(const row of model.rows.values())for(const cell of children(row,'c')) {
          const address=cell.getAttribute('r');if(columnIndex(address)===column){row.removeChild(cell);continue;}
          cell.setAttribute('r',deletedRange(address,column));
        }
        model.cells=new Map([...model.rows.values()].flatMap(row=>children(row,'c').map(cell=>[cell.getAttribute('r'),cell])));
        for(const parent of descendants(model.document,'cols'))for(const col of children(parent,'col')) {
          const low=Number(col.getAttribute('min')),high=Number(col.getAttribute('max'));if(low===column&&high===column){parent.removeChild(col);continue;}
          col.setAttribute('min',low>column?low-1:low);col.setAttribute('max',high>=column?high-1:high);
        }
        for(const tag of ['mergeCell','dimension','autoFilter','sortState','sortCondition','hyperlink','conditionalFormatting','dataValidation','ignoredError','selection','pane'])for(const node of descendants(model.document,tag)) {
          for(const attribute of ['ref','sqref','activeCell','topLeftCell'])if(node.hasAttribute(attribute)) {
            const clamp=['selection','pane'].includes(tag),ranges=list(node.getAttribute(attribute)).map(range=>deletedRange(range,column,1,clamp)).filter(range=>range!=='#REF!');
            if(!ranges.length){node.parentNode.removeChild(node);break;}node.setAttribute(attribute,ranges.join(' '));
          }
          if(tag==='pane'&&Number(node.getAttribute('xSplit'))>=column)node.setAttribute('xSplit',String(Number(node.getAttribute('xSplit'))-1));
        }
        for(const tag of ['mergeCells','dataValidations'])for(const container of descendants(model.document,tag))container.setAttribute('count',children(container).length);
        for(const node of descendants(model.document,'sqref')){const ranges=list(node.textContent).map(range=>deletedRange(range,column)).filter(range=>range!=='#REF!');node.textContent=ranges.join(' ');}
        for(const row of model.rows.values())if(row.hasAttribute('spans'))row.removeAttribute('spans');
      }
      for(const link of descendants(model.document,'hyperlink'))if(link.hasAttribute('location')&&!/^[a-z][a-z0-9+.-]*:/i.test(link.getAttribute('location')))link.setAttribute('location',deleteFormulaColumns(link.getAttribute('location'),model.name,target,column,1,{clamp:true}));
      if(xml(model.document)!==before)this.changed.add(model.part);
    }
    for(const name of descendants(this.workbook,'definedName')) {
      const previous=name.textContent,local=name.hasAttribute('localSheetId')?this.sheets[Number(name.getAttribute('localSheetId'))]?.name:null;
      name.textContent=rewrite(previous,local);if(name.textContent!==previous)this.changed.add('xl/workbook.xml');
    }
    for(const model of this.sheets)for(const table of model.tables) {
      const before=xml(table.document),root=table.document.documentElement;
      if(model===this.sheet) {
        const reference=root.getAttribute('ref'),left=columnIndex(reference.split(':')[0]),right=columnIndex(reference.split(':').at(-1));
        root.setAttribute('ref',change(reference));
        if(column>=left&&column<=right){const columns=first(root,'tableColumns'),items=children(columns,'tableColumn');if(items[column-left])columns.removeChild(items[column-left]);columns.setAttribute('count',children(columns,'tableColumn').length);}
        const auto=first(root,'autoFilter');if(auto){moveFilterColumns(auto,column);auto.setAttribute('ref',change(auto.getAttribute('ref')));}
        for(const tag of ['sortState','sortCondition'])for(const node of descendants(root,tag))if(node.hasAttribute('ref')){const ref=change(node.getAttribute('ref'));if(ref==='#REF!')node.parentNode.removeChild(node);else node.setAttribute('ref',ref);}
      }
      for(const tag of ['calculatedColumnFormula','totalsRowFormula'])for(const formula of descendants(root,tag))formula.textContent=rewrite(formula.textContent,model.name,table);
      if(xml(table.document)!==before)this.changed.add(table.part);
    }
    // Related drawings/comments keep their original parts, binary content and
    // relationship IDs. Only actual anchors/references need column movement.
    const relationsPart=relationshipPart(this.sheet.part);
    if(this.zip.file(relationsPart))for(const rel of children((await this.document(relationsPart)).documentElement,'Relationship')) {
      if(rel.getAttribute('TargetMode')==='External')continue;
      const type=rel.getAttribute('Type'),part=relativePart(this.sheet.part,rel.getAttribute('Target'));
      if(!['/drawing','/comments','/vmlDrawing'].some(suffix=>type.endsWith(suffix)))continue;
      const document=await this.document(part),before=xml(document);
      if(type.endsWith('/drawing'))for(const anchor of [...descendants(document,'from'),...descendants(document,'to')]){const node=first(anchor,'col');if(node){const value=Number(node.textContent);node.textContent=String(value>=column?value-1:value);}}
      if(type.endsWith('/comments'))for(const comment of descendants(document,'comment')){const ref=comment.getAttribute('ref');if(columnIndex(ref)===column)comment.parentNode.removeChild(comment);else comment.setAttribute('ref',deletedRange(ref,column));}
      if(type.endsWith('/vmlDrawing'))for(const data of descendants(document,'ClientData')) {
        const node=first(data,'Column');if(node){const value=Number(node.textContent);if(value===column-1&&data.getAttribute('ObjectType')==='Note'){data.parentNode.parentNode.removeChild(data.parentNode);continue;}node.textContent=String(value>=column?value-1:value);}
        const anchor=first(data,'Anchor');if(anchor){const values=anchor.textContent.split(',').map(Number);for(const index of [0,4])if(values[index]>=column)values[index]--;anchor.textContent=values.join(', ');}
      }
      if(xml(document)!==before)this.changed.add(part);
    }
    for(const part of Object.keys(this.zip.files).filter(name=>/^xl\/charts\/[^/]+\.xml$/.test(name))) {
      const document=await this.document(part),before=xml(document);for(const formula of descendants(document,'f'))formula.textContent=rewrite(formula.textContent,null);if(xml(document)!==before)this.changed.add(part);
    }
  }
  baseStyle(cell,column) {
    if(cell?.hasAttribute('s'))return Number(cell.getAttribute('s'));const row=cell?.parentNode;if(row?.getAttribute('customFormat')==='1')return Number(row.getAttribute('s'));
    const col=children(first(this.sheet.document.documentElement,'cols'),'col').find(item=>Number(item.getAttribute('min'))<=column&&Number(item.getAttribute('max'))>=column);return Number(col?.getAttribute('style')||0);
  }
  style(cell,column,{header=false,fill='FFFFFFFF',wrap=false}={}) {
    const base=this.baseStyle(cell,column),key=JSON.stringify([base,header,fill,wrap]);
    if(!this.styleCache.has(key)) {
      const root=this.styles.documentElement,xfs=first(root,'cellXfs'),baseNode=children(xfs,'xf')[base]||children(xfs,'xf')[0],xf=baseNode.cloneNode(true);
      const fills=first(root,'fills');let fillIndex=children(fills,'fill').findIndex(item=>first(item,'patternFill')?.getAttribute('patternType')==='solid'&&first(first(item,'patternFill'),'fgColor')?.getAttribute('rgb')===fill);
      if(fillIndex<0){fillIndex=children(fills,'fill').length;const node=this.element(this.styles,'fill'),pattern=this.element(this.styles,'patternFill',{patternType:'solid'});pattern.appendChild(this.element(this.styles,'fgColor',{rgb:fill}));pattern.appendChild(this.element(this.styles,'bgColor',{indexed:64}));node.appendChild(pattern);fills.appendChild(node);fills.setAttribute('count',fillIndex+1);}
      xf.setAttribute('fillId',fillIndex);xf.setAttribute('applyFill','1');
      if(this.tableBorderId===undefined){
        const borders=first(root,'borders'),border=this.element(this.styles,'border');
        for(const edge of ['left','right','top','bottom']){const side=this.element(this.styles,edge,{style:'thin'});side.appendChild(this.element(this.styles,'color',{rgb:'FFB7C4CE'}));border.appendChild(side);}
        border.appendChild(this.element(this.styles,'diagonal'));this.tableBorderId=children(borders,'border').length;borders.appendChild(border);borders.setAttribute('count',this.tableBorderId+1);
      }
      xf.setAttribute('borderId',this.tableBorderId);xf.setAttribute('applyBorder','1');
      let alignment=first(xf,'alignment');if(!alignment){alignment=this.element(this.styles,'alignment');xf.insertBefore(alignment,first(xf,'protection')||first(xf,'extLst')||null);}alignment.setAttribute('vertical',header?'center':'top');alignment.setAttribute('wrapText',header||wrap?'1':'0');xf.setAttribute('applyAlignment','1');
      if(header){const fontId=Number(xf.getAttribute('fontId')||0);if(!this.fontCache.has(fontId)){const fonts=first(root,'fonts'),font=(children(fonts,'font')[fontId]||children(fonts,'font')[0]).cloneNode(true);this.ensure(font,'b').setAttribute('val','1');for(const color of children(font,'color'))font.removeChild(color);font.appendChild(this.element(this.styles,'color',{rgb:'FF000000'}));this.fontCache.set(fontId,children(fonts,'font').length);fonts.appendChild(font);fonts.setAttribute('count',children(fonts,'font').length);}xf.setAttribute('fontId',this.fontCache.get(fontId));xf.setAttribute('applyFont','1');}
      const index=children(xfs,'xf').length;xfs.appendChild(xf);xfs.setAttribute('count',index+1);this.styleCache.set(key,index);this.changed.add(this.stylesPart);
    }cell.setAttribute('s',this.styleCache.get(key));
  }
  formatDecisions(headerRow,lastRow,headers){
    const columns=headers.flatMap((header,index)=>isDecisionHeader(header)?[index+1]:[]);if(!columns.length||lastRow<=headerRow)return;
    const root=this.styles.documentElement;let dxfs=first(root,'dxfs');if(!dxfs){dxfs=this.element(this.styles,'dxfs',{count:0});root.insertBefore(dxfs,first(root,'tableStyles')||first(root,'colors')||first(root,'extLst')||null);}
    const sheetRoot=this.sheet.document.documentElement;
    for(const group of children(sheetRoot,'conditionalFormatting'))for(const rule of children(group,'cfRule'))rule.setAttribute('priority',String((Number(rule.getAttribute('priority'))||1)+columns.length*5));
    const successor=['dataValidations','hyperlinks','printOptions','pageMargins','pageSetup','headerFooter','rowBreaks','colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture','oleObjects','controls','webPublishItems','tableParts','extLst'].map(name=>first(sheetRoot,name)).find(Boolean)||null;
    for(const [index,column]of columns.entries()){
      const letters=columnLetters(column),group=this.element(this.sheet.document,'conditionalFormatting',{sqref:`${letters}${headerRow+1}:${letters}${lastRow}`});
      for(const rule of decisionFormattingRules(letters,headerRow+1)){
        const dxf=this.element(this.styles,'dxf'),font=this.element(this.styles,'font');font.appendChild(this.element(this.styles,'b'));font.appendChild(this.element(this.styles,'color',{rgb:rule.style.font.color.argb}));dxf.appendChild(font);
        const fill=this.element(this.styles,'fill'),pattern=this.element(this.styles,'patternFill',{patternType:'solid'});pattern.appendChild(this.element(this.styles,'fgColor',{rgb:rule.style.fill.fgColor.argb}));pattern.appendChild(this.element(this.styles,'bgColor',{indexed:64}));fill.appendChild(pattern);dxf.appendChild(fill);
        const dxfId=children(dxfs,'dxf').length;dxfs.appendChild(dxf);dxfs.setAttribute('count',dxfId+1);
        const node=this.element(this.sheet.document,'cfRule',{type:'expression',dxfId,priority:rule.priority+index*5,stopIfTrue:1}),formula=this.element(this.sheet.document,'formula');formula.textContent=rule.formulae[0];node.appendChild(formula);group.appendChild(node);
      }
      sheetRoot.insertBefore(group,successor);
    }
    this.changed.add(this.stylesPart);this.changed.add(this.sheet.part);
  }
  setColumnWidth(index,width) {
    const root=this.sheet.document.documentElement;let cols=first(root,'cols');if(!cols){cols=this.element(this.sheet.document,'cols');root.insertBefore(cols,first(root,'sheetData'));}
    const existing=children(cols,'col').find(col=>Number(col.getAttribute('min'))<=index&&Number(col.getAttribute('max'))>=index),node=existing?existing.cloneNode(false):this.element(this.sheet.document,'col');
    if(existing){const low=Number(existing.getAttribute('min')),high=Number(existing.getAttribute('max'));if(low<index){const left=existing.cloneNode(false);left.setAttribute('max',index-1);cols.insertBefore(left,existing);}if(high>index){const right=existing.cloneNode(false);right.setAttribute('min',index+1);cols.insertBefore(right,existing);}cols.removeChild(existing);}
    node.setAttribute('min',index);node.setAttribute('max',index);node.setAttribute('width',width);node.setAttribute('customWidth','1');cols.insertBefore(node,children(cols,'col').find(col=>Number(col.getAttribute('min'))>index)||null);
  }
  async formatTable(headerRow,lastRow,headers,{original=[],alternative=[],widths=[]}={}) {
    if(headers.length>16384)fail('M09_COLUMN_LIMIT','M09 has no room for its final columns.',['The completed BOM would exceed Excel’s 16,384-column limit.']);
    const root=this.sheet.document.documentElement,defaultHeight=Number(first(root,'sheetFormatPr')?.getAttribute('defaultRowHeight'))||15;
    let format=first(root,'sheetFormatPr');if(!format){format=this.element(this.sheet.document,'sheetFormatPr',{defaultRowHeight:defaultHeight});root.insertBefore(format,first(root,'cols')||first(root,'sheetData'));}else if(!format.hasAttribute('defaultRowHeight'))format.setAttribute('defaultRowHeight',defaultHeight);
    for(let row=headerRow;row<=lastRow;row++) {
      for(let column=1;column<=headers.length;column++){const cell=this.cell(row,column,true),decision=isDecisionHeader(headers[column-1]);this.style(cell,column,{header:row===headerRow,fill:row===headerRow?'FFFFFFFF':decision?decisionAppearance(this.value(row,column)).fill:original.includes(column)?'FFE2EFDA':alternative.includes(column)?'FFDDEBF7':'FFFFFFFF',wrap:['Designation','Nomenclature','Alt_Mfr','Alt_PN'].includes(headers[column-1])});}
      const node=this.sheet.rows.get(row);if(row===headerRow||!node.hasAttribute('ht')&&!['1','true'].includes(node.getAttribute('hidden'))){node.setAttribute('ht',row===headerRow?32:defaultHeight);node.setAttribute('customHeight','1');}
    }
    this.formatDecisions(headerRow,lastRow,headers);
    for(const [column,width] of widths)this.setColumnWidth(column,width);
    const stringsRel=children(this.workbookRelationships.documentElement,'Relationship').find(item=>item.getAttribute('Type').endsWith('/sharedStrings'));
    const sharedStrings=stringsRel?children((await this.document(relativePart('xl/workbook.xml',stringsRel.getAttribute('Target')))).documentElement,'si'):[];
    applyPreservedRowGrowth(this,headerRow,lastRow,headers,{profiles:await measuredLayoutProfiles(),sharedStrings});
    let table=this.sheet.tables[0];
    if(!table) {
      const existing=[];for(const model of this.sheets)for(const item of model.tables)existing.push(item.document.documentElement);
      const id=Math.max(0,...existing.map(item=>Number(item.getAttribute('id'))))+1;let name='tblCompleteSupplierBOM_1',suffix=2;while(existing.some(item=>item.getAttribute('name').toUpperCase()===name.toUpperCase()))name=`tblCompleteSupplierBOM_${suffix++}`;
      let part=`xl/tables/table${id}.xml`,number=id;while(this.zip.file(part))part=`xl/tables/table${++number}.xml`;
      const document=parse(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="${root.namespaceURI}" id="${id}" name="${name}" displayName="${name}"/>`,part);
      const relPart=relationshipPart(this.sheet.part);let relationships;if(this.zip.file(relPart))relationships=await this.document(relPart);else{relationships=parse('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',relPart);this.documents.set(relPart,relationships);}
      let relationId=1;while(children(relationships.documentElement,'Relationship').some(rel=>rel.getAttribute('Id')===`rId${relationId}`))relationId++;
      relationships.documentElement.appendChild(this.element(relationships,'Relationship',{Id:`rId${relationId}`,Type:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table',Target:path.posix.relative(path.posix.dirname(this.sheet.part),part)}));this.changed.add(relPart);
      let parts=first(root,'tableParts');if(!parts){parts=this.element(this.sheet.document,'tableParts');root.insertBefore(parts,first(root,'extLst')||null);}const node=this.element(this.sheet.document,'tablePart');node.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','r:id',`rId${relationId}`);parts.appendChild(node);parts.setAttribute('count',children(parts,'tablePart').length);
      const types=await this.document('[Content_Types].xml');types.documentElement.appendChild(this.element(types,'Override',{PartName:`/${part}`,ContentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml'}));this.changed.add('[Content_Types].xml');table={part,document};this.sheet.tables.push(table);this.documents.set(part,document);
    }
    const tableRoot=table.document.documentElement,reference=`A${headerRow}:${columnLetters(headers.length)}${lastRow}`;tableRoot.setAttribute('ref',reference);
    const auto=this.ensure(tableRoot,'autoFilter');auto.setAttribute('ref',reference);tableRoot.insertBefore(auto,first(tableRoot,'sortState')||first(tableRoot,'tableColumns')||first(tableRoot,'tableStyleInfo')||first(tableRoot,'extLst')||null);
    let columns=first(tableRoot,'tableColumns');const previous=children(columns,'tableColumn');if(columns)tableRoot.removeChild(columns);columns=this.element(table.document,'tableColumns',{count:headers.length});tableRoot.insertBefore(columns,first(tableRoot,'tableStyleInfo')||first(tableRoot,'extLst')||null);
    let nextId=Math.max(0,...previous.map(item=>Number(item.getAttribute('id'))));
    for(const name of headers){const existing=previous.find(item=>item.getAttribute('name')===name),node=existing?existing.cloneNode(true):this.element(table.document,'tableColumn',{id:++nextId,name});columns.appendChild(node);}
    const style=this.ensure(tableRoot,'tableStyleInfo');if(first(tableRoot,'extLst'))tableRoot.insertBefore(style,first(tableRoot,'extLst'));for(const [name,value] of Object.entries({name:'TableStyleMedium1',showFirstColumn:0,showLastColumn:0,showRowStripes:0,showColumnStripes:0}))style.setAttribute(name,value);
    for(const filter of children(root,'autoFilter'))root.removeChild(filter);this.changed.add(table.part);this.changed.add(this.sheet.part);
  }
  async buffer() {
    // A stale calculation chain can refer to removed cells. Native Excel will
    // rebuild it rather than repair the workbook or display old formula values.
    for(const rel of children(this.workbookRelationships.documentElement,'Relationship').filter(item=>item.getAttribute('Type').endsWith('/calcChain'))){this.zip.remove(relativePart('xl/workbook.xml',rel.getAttribute('Target')));rel.parentNode.removeChild(rel);this.changed.add('xl/_rels/workbook.xml.rels');}
    const types=await this.document('[Content_Types].xml');for(const type of children(types.documentElement,'Override'))if(type.getAttribute('ContentType').endsWith('calcChain+xml')){type.parentNode.removeChild(type);this.changed.add('[Content_Types].xml');}
    // SaveAs(xlsx), like the macro, produces a macro-free completed BOM.
    for(const rel of children(this.workbookRelationships.documentElement,'Relationship').filter(item=>/\/(?:vbaProject|vbaData)$/.test(item.getAttribute('Type')))){
      const part=relativePart('xl/workbook.xml',rel.getAttribute('Target')),related=relationshipPart(part);
      if(this.zip.file(related)){for(const item of children((await this.document(related)).documentElement,'Relationship'))if(item.getAttribute('TargetMode')!=='External')this.zip.remove(relativePart(part,item.getAttribute('Target')));this.zip.remove(related);}
      this.zip.remove(part);rel.parentNode.removeChild(rel);this.changed.add('xl/_rels/workbook.xml.rels');
    }
    for(const type of children(types.documentElement,'Override')){
      if(type.getAttribute('ContentType')==='application/vnd.ms-excel.sheet.macroEnabled.main+xml'){type.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');this.changed.add('[Content_Types].xml');}
      else if(/vba(?:Project|Data|ProjectSignature)/i.test(type.getAttribute('ContentType'))){type.parentNode.removeChild(type);this.changed.add('[Content_Types].xml');}
    }
    for(const rel of children(this.workbookRelationships.documentElement,'Relationship').filter(item=>item.getAttribute('Type').endsWith('/sharedStrings'))){const part=relativePart('xl/workbook.xml',rel.getAttribute('Target')),document=await this.document(part);let count=0;for(const sheet of this.sheets)for(const cell of sheet.cells.values())if(cell.getAttribute('t')==='s')count++;document.documentElement.setAttribute('count',count);document.documentElement.setAttribute('uniqueCount',children(document.documentElement,'si').length);this.changed.add(part);}
    const calc=this.ensure(this.workbook.documentElement,'calcPr');calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');this.changed.add('xl/workbook.xml');
    const dimension=first(this.sheet.document.documentElement,'dimension');if(dimension){let lastColumn=1,lastRow=1;for(const address of this.sheet.cells.keys()){lastColumn=Math.max(lastColumn,columnIndex(address));lastRow=Math.max(lastRow,Number(address.match(/[0-9]+$/)[0]));}dimension.setAttribute('ref',`A1:${columnLetters(lastColumn)}${lastRow}`);}
    for(const part of this.changed)this.zip.file(part,xml(this.documents.get(part)));
    return this.zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  }
}
