import {permitsGrowth,planRowGrowth,requireReadablePlan} from './selective-row-growth.js';

const children=(node,name)=>Array.from(node?.childNodes||[]).filter(child=>child.nodeType===1&&(!name||child.localName===name));
const first=(node,name)=>children(node,name)[0];
const flag=node=>Boolean(node)&&node.getAttribute('val')!=='0'&&node.getAttribute('val')!=='false';
const enabled=value=>value==='1'||value==='true';
function fontAt(styles,index){
  const root=styles.documentElement,font=children(first(root,'fonts'),'font')[index]||children(first(root,'fonts'),'font')[0];
  return {name:first(font,'name')?.getAttribute('val')||'Calibri',size:Number(first(font,'sz')?.getAttribute('val'))||11,bold:flag(first(font,'b')),italic:flag(first(font,'i'))};
}
function richRunFonts(cell,sharedStrings){
  const value=cell?.getAttribute('t')==='inlineStr'?first(cell,'is'):cell?.getAttribute('t')==='s'?sharedStrings[Number(first(cell,'v')?.textContent)]:null;
  return children(value,'r').map(run=>{
    const properties=first(run,'rPr'),size=Number(first(properties,'sz')?.getAttribute('val'));
    return {name:first(properties,'rFont')?.getAttribute('val'),...(Number.isFinite(size)&&size>0?{size}:{}),bold:flag(first(properties,'b')),italic:flag(first(properties,'i'))};
  });
}
export function normalFontFromStyles(styles){
  const root=styles.documentElement,normal=children(first(root,'cellStyles'),'cellStyle').find(node=>node.getAttribute('name')==='Normal'),xf=children(first(root,'cellStyleXfs'),'xf')[Number(normal?.getAttribute('xfId')||0)];
  return fontAt(styles,Number(xf?.getAttribute('fontId')||0));
}

/** Height-only adapter for the existing package-preserving editor. Invoke
 * AFTER its existing whitelist styling and final setColumnWidth calls. It
 * never serializes/rewrites the package or changes a cell/style/column/table. */
export function applyPreservedRowGrowth(editor,headerRow,lastRow,headers,{profiles,strict=true,collectPlans=false,sharedStrings=[]}={}){
  const root=editor.sheet.document.documentElement,format=first(root,'sheetFormatPr'),normalFont=normalFontFromStyles(editor.styles),defaultHeight=Number(format?.getAttribute('defaultRowHeight'))||15,cols=children(first(root,'cols'),'col'),xfs=children(first(editor.styles.documentElement,'cellXfs'),'xf'),plans=collectPlans?[]:null,summary={rows:0,grown:0,reviewWarnings:0};
  const address=value=>{const match=String(value).match(/^([A-Z]+)([1-9]\d*)$/);if(!match)throw Error('Invalid merged-cell geometry.');return {column:[...match[1]].reduce((result,letter)=>result*26+letter.charCodeAt(0)-64,0),row:Number(match[2])};};
  const merges=children(first(root,'mergeCells'),'mergeCell').map(node=>{const parts=node.getAttribute('ref').split(':');return {from:address(parts[0]),to:address(parts[1]||parts[0])};});
  for(let row=headerRow+1;row<=lastRow;row++){
    const node=editor.sheet.rows.get(row);if(!node)continue;
    const cells=[];
    for(let column=1;column<=headers.length;column++){
      const header=headers[column-1];if(!permitsGrowth(header))continue;
      const cell=editor.cell(row,column),style=xfs[editor.baseStyle(cell,column)]||xfs[0],alignment=first(style,'alignment'),font=fontAt(editor.styles,Number(style?.getAttribute('fontId')||0)),col=cols.find(item=>Number(item.getAttribute('min'))<=column&&Number(item.getAttribute('max'))>=column);
      const formula=first(cell,'f'),cached=first(cell,'v'),cachePresent=!formula||Boolean(cached)&&(cached.textContent!==''||cell.getAttribute('t')==='str');
      const merge=merges.find(range=>row>=range.from.row&&row<=range.to.row&&column>=range.from.column&&column<=range.to.column),slave=merge&&(row!==merge.from.row||column!==merge.from.column);
      const mergedWidths=merge&&merge.from.row===merge.to.row?Array.from({length:merge.to.column-merge.from.column+1},(_,offset)=>{const item=cols.find(item=>Number(item.getAttribute('min'))<=merge.from.column+offset&&Number(item.getAttribute('max'))>=merge.from.column+offset);return enabled(item?.getAttribute('hidden'))?0:Number(item?.getAttribute('width')||format?.getAttribute('defaultColWidth')||8.43);}):null;
      cells.push({header,font,richFonts:richRunFonts(cell,sharedStrings),widthCharacters:Number(col?.getAttribute('width')||format?.getAttribute('defaultColWidth')||8.43),hiddenColumn:enabled(col?.getAttribute('hidden')),rotation:Number(alignment?.getAttribute('textRotation')||0),indent:Number(alignment?.getAttribute('indent')||0),verticalMerge:Boolean(merge&&merge.from.row!==merge.to.row),...(mergedWidths?{mergedWidthsCharacters:mergedWidths}:{}),...(slave?{displayText:''}:cachePresent?{displayText:editor.text(row,column)}:{value:{formula:formula.textContent}})});
    }
    const plan=planRowGrowth({rowHeight:node.hasAttribute('ht')?Number(node.getAttribute('ht')):undefined,defaultRowHeight:defaultHeight,hidden:enabled(node.getAttribute('hidden'))||node.getAttribute('ht')==='0',cells,normalFont,profiles});
    if(strict)requireReadablePlan(plan,{sheet:editor.sheet.name,row});
    if(plan.grow){node.setAttribute('ht',String(plan.heightPt));node.setAttribute('customHeight','1');editor.changed.add(editor.sheet.part);}
    summary.rows++;if(plan.grow)summary.grown++;summary.reviewWarnings+=plan.diagnostics.filter(item=>!item.blocking).length;if(plans)plans.push({row,...plan});
  }
  return plans||summary;
}
