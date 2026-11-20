export const wrappingHeaders=Object.freeze(['Designation','Nomenclature','Alt_Mfr','Alt_PN']);
// Native Excel cropped the last two lines of the original Normal11 M03 QA
// manufacturer cell with 1.0 line spacing. Additional wrapped lines use a
// conservative calibrated allowance (~15.2pt); the first line still fits the
// existing 15pt baseline. This is not a general Excel AutoFit equivalence.
export const selectiveLayoutPolicy=Object.freeze({maximumHeightPt:409,horizontalSafety:1.08,lineSafety:1.2,paddingPt:2,maximumCellCharacters:32767});
export const permitsGrowth=header=>wrappingHeaders.includes(String(header??'').trim());
const positive=value=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
const ceilQuarter=value=>Math.ceil(value*4)/4;
const diagnostic=(code,cell,blocking=false,extra={})=>({code,header:cell.header,blocking,...extra});

// Measuring a cached display value must never replace the actual cell value,
// source formula, number format, hyperlink or rich-text runs.
export function displayText(cell){
  if(Object.hasOwn(cell,'displayText'))return typeof cell.displayText==='string'?{text:cell.displayText,...(Array.isArray(cell.richFonts)?{richFonts:cell.richFonts}:{})}: {error:'LAYOUT_DISPLAY_TEXT_UNAVAILABLE'};
  const value=cell.value;
  if(value===null||value===undefined)return {text:''};
  if(typeof value==='string'||typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean')return {text:String(value)};
  if(value&&typeof value==='object'){
    if(Object.hasOwn(value,'formula')||Object.hasOwn(value,'sharedFormula')){
      if(!Object.hasOwn(value,'result')||value.result===undefined)return {error:'LAYOUT_FORMULA_CACHE_MISSING'};
      return displayText({...cell,value:value.result});
    }
    if(Array.isArray(value.richText)&&value.richText.every(run=>typeof run.text==='string'))return {text:value.richText.map(run=>run.text).join(''),richFonts:value.richText.map(run=>run.font||{})};
    if(typeof value.text==='string')return {text:value.text};
    if(typeof value.error==='string')return {text:value.error};
  }
  return {error:'LAYOUT_DISPLAY_TEXT_UNAVAILABLE'};
}

/** OOXML column width -> pixels, using the NORMAL style's maximum digit
 * width, not the driver cell's font. No column width is written here. */
export function columnPixels(widthCharacters,normalDigitPixels){
  if(!positive(widthCharacters)||!positive(normalDigitPixels))return null;
  return Math.floor(((256*Number(widthCharacters)+Math.floor(128/normalDigitPixels))/256)*normalDigitPixels);
}

function textGeometry(text,font,profile,widthPt,policy){
  const {metrics}=profile,size=positive(font.size)||11,missing=new Set(),advances=new Map();
  const advance=character=>{
    if(advances.has(character))return advances.get(character);
    if(/[\p{Mark}\u200d\ufe00-\ufe0f]/u.test(character))return 0;
    if(character==='\t')return (metrics.advanceEm(32)??0.5)*size*4*policy.horizontalSafety;
    const value=metrics.advanceEm(character.codePointAt(0));if(value===null&&missing.size<16)missing.add('U+'+character.codePointAt(0).toString(16).toUpperCase());
    const width=(value===null?2:value)*size*policy.horizontalSafety;advances.set(character,width);return width;
  };
  // Coverage must include the entire bounded source value, including a glyph
  // beyond the first height-overflow checkpoint. A fallback width cannot prove
  // that a source's native font needs more than the Excel height limit.
  for(const character of text)if(character!=='\r'&&character!=='\n')advance(character);
  const firstLineHeight=Math.max(size,metrics.lineEm*size)+policy.paddingPt,lineHeight=Math.max(size,metrics.lineEm*size)*policy.lineSafety,maximumLines=Math.max(1,Math.floor((policy.maximumHeightPt-firstLineHeight)/lineHeight)+1);
  let lines=1,used=0,maximumUsed=0,overflow=false,pendingSpace=0;
  const nextLine=()=>{maximumUsed=Math.max(maximumUsed,used);lines++;used=0;if(lines>Math.max(1,maximumLines))overflow=true;};
  // Preserve explicit breaks for measurement only. Word boundaries are honored;
  // an overlong uninterrupted PN is split at Unicode code-point boundaries.
  // This bounded estimate is NOT Excel's shaping/AutoFit engine.
  const tokens=text.replace(/\r\n?/g,'\n').matchAll(/\n|[ \t]+|[^ \t\n]+/gu);
  for(const token of tokens){
    if(overflow)break;const value=token[0];if(value==='\n'){pendingSpace=0;nextLine();continue;}
    let tokenWidth=0;for(const character of value)tokenWidth+=advance(character);
    // A break consumes its separating spaces; they must not create an extra
    // blank visual line between words. Raw spaces remain untouched in cells.
    if(/^[ \t]+$/.test(value)){pendingSpace+=tokenWidth;continue;}
    if(used>0&&used+pendingSpace+tokenWidth>widthPt){nextLine();pendingSpace=0;}
    if(pendingSpace&&used+pendingSpace<widthPt)used+=pendingSpace;pendingSpace=0;
    for(const character of value){const width=advance(character);if(used>0&&used+width>widthPt)nextLine();used+=width;if(overflow)break;}
  }
  maximumUsed=Math.max(maximumUsed,used);
  return {lines,lineHeightPt:lineHeight,requiredHeightPt:firstLineHeight+(lines-1)*lineHeight,maximumLineWidthPt:maximumUsed,overflow,missingGlyphs:[...missing]};
}

export function planRowGrowth({rowHeight,defaultRowHeight=15,hidden=false,cells=[],normalFont={name:'Calibri',size:11},profiles,policy=selectiveLayoutPolicy}={}){
  if(!profiles||typeof profiles.resolve!=='function')throw TypeError('An explicit measured font profile is required.');
  const baseline=positive(rowHeight)??positive(defaultRowHeight)??15,diagnostics=[],drivers=[];
  if(hidden)return Object.freeze({heightPt:rowHeight??baseline,baselinePt:baseline,grow:false,blocked:false,drivers,diagnostics,estimateOnly:true,hidden:true});
  if(baseline>policy.maximumHeightPt)diagnostics.push({code:'LAYOUT_SOURCE_HEIGHT_LIMIT',blocking:false,baselinePt:baseline,limitPt:policy.maximumHeightPt});
  const normal=profiles.resolve(normalFont),normalSize=positive(normalFont.size)||11;
  const digitWidths=Array.from({length:10},(_,number)=>normal.metrics.advanceEm(48+number));
  if(digitWidths.some(value=>value===null))throw Error('The normal-font profile lacks decimal digit metrics.');
  const normalDigitPixels=positive(normal.maximumDigitPixelsAt96Dpi)??Math.max(...digitWidths)*normalSize*96/72;
  let needed=baseline;
  for(const cell of cells){
    if(!permitsGrowth(cell.header))continue;
    // Missing cached text or unsupported inherited geometry cannot justify a
    // new business-data rejection. Keep that source geometry and raw value;
    // other measurable permitted cells can still grow this row.
    const extracted=displayText(cell);if(extracted.error){diagnostics.push(diagnostic(extracted.error,cell));continue;}
    if(!extracted.text)continue;
    if(extracted.text.length>policy.maximumCellCharacters){diagnostics.push(diagnostic('LAYOUT_CELL_CHARACTER_LIMIT',cell,true,{length:extracted.text.length,maximumCharacters:policy.maximumCellCharacters}));continue;}
    if(cell.hiddenColumn){diagnostics.push(diagnostic('LAYOUT_ALLOWED_COLUMN_HIDDEN',cell));continue;}
    if(cell.verticalMerge||cell.rotation){diagnostics.push(diagnostic('LAYOUT_GEOMETRY_REQUIRES_REVIEW',cell));continue;}
    const font={...normalFont,...cell.font};
    if(extracted.richFonts?.length){font.size=Math.max(positive(font.size)||11,...extracted.richFonts.map(value=>positive(value.size)||0));font.bold=font.bold||extracted.richFonts.some(value=>value.bold);font.italic=font.italic||extracted.richFonts.some(value=>value.italic);diagnostics.push(diagnostic('LAYOUT_RICH_TEXT_CONSERVATIVE_PROFILE',cell));}
    const profile=profiles.resolve(font),pixels=cell.widthPixels??(cell.mergedWidthsCharacters?.length?cell.mergedWidthsCharacters.reduce((sum,width)=>sum+(columnPixels(width,normalDigitPixels)??0),0):columnPixels(cell.widthCharacters,normalDigitPixels)),space=profile.metrics.advanceEm(32)??0.5;
    if(cell.indent!==undefined&&(!Number.isFinite(Number(cell.indent))||Number(cell.indent)<0||Number(cell.indent)>250)){diagnostics.push(diagnostic('LAYOUT_INDENT_REQUIRES_REVIEW',cell));continue;}
    const available=pixels===null?null:(pixels-5)*72/96-Math.max(0,Number(cell.indent)||0)*3*space*(positive(font.size)||11);
    if(!positive(available)){diagnostics.push(diagnostic('LAYOUT_COLUMN_WIDTH_UNAVAILABLE',cell));continue;}
    if(profile.substituted||normal.substituted)diagnostics.push(diagnostic('LAYOUT_FONT_SUBSTITUTION_ESTIMATE',cell,false,{sourceFont:font.name,metricFont:profile.metrics.family,nativeCalibrationRequired:true}));
    const complexScript=/[\u0590-\u08ff]/u.test(extracted.text);
    if(complexScript)diagnostics.push(diagnostic('LAYOUT_COMPLEX_SCRIPT_REQUIRES_SHAPING',cell));
    const geometry=textGeometry(extracted.text,font,profile,available,policy);needed=Math.max(needed,ceilQuarter(geometry.requiredHeightPt));
    if(geometry.maximumLineWidthPt>available+0.001)diagnostics.push(diagnostic('LAYOUT_GLYPH_WIDER_THAN_COLUMN',cell));
    if(geometry.missingGlyphs.length)diagnostics.push(diagnostic('LAYOUT_GLYPH_COVERAGE',cell,false,{codePoints:geometry.missingGlyphs}));
    const uncertainGeometry=geometry.missingGlyphs.length>0||complexScript||geometry.maximumLineWidthPt>available+0.001;
    if((geometry.overflow||geometry.requiredHeightPt>policy.maximumHeightPt)&&baseline<=policy.maximumHeightPt)diagnostics.push(diagnostic(uncertainGeometry?'LAYOUT_UNCERTAIN_HEIGHT_ESTIMATE':'LAYOUT_ROW_HEIGHT_LIMIT',cell,!uncertainGeometry,{limitPt:policy.maximumHeightPt,estimated:true}));
    drivers.push({header:cell.header,...geometry,uncertainGeometry,availableWidthPt:available,fontSizePt:positive(font.size)||11,metricFont:profile.metrics.family});
  }
  const height=baseline>policy.maximumHeightPt?baseline:Math.max(baseline,Math.min(policy.maximumHeightPt,needed));
  return Object.freeze({heightPt:height,baselinePt:baseline,grow:height>baseline,blocked:diagnostics.some(value=>value.blocking),drivers,diagnostics,estimateOnly:true});
}

export function requireReadablePlan(plan,{sheet,row}={}){
  if(!plan.blocked)return plan;
  const findings=plan.diagnostics.filter(value=>value.blocking).map(value=>`Worksheet '${sheet??'?'}', row ${row??'?'}, field '${value.header??'row'}': ${value.code}${value.limitPt?`; maximum row height ${value.limitPt} points`:''}${value.maximumCharacters?`; ${value.length} characters; Excel maximum ${value.maximumCharacters}`:''}. Raw cell values were retained.`);
  throw Object.assign(new Error(plan.diagnostics.some(value=>value.code==='LAYOUT_CELL_CHARACTER_LIMIT')?'A permitted wrapping field exceeds the Excel cell text limit. Review the listed source cells before exporting.':'The estimated height of a permitted wrapping field exceeds the Excel row height limit at the established column width. Review the listed source cells before exporting.'),{code:'XLSX_SELECTIVE_LAYOUT_REVIEW',status:422,details:findings});
}

/** Shared by in-memory macro sheets AND streaming report rows, before commit.
 * Call only after the final stage-specific column widths are established. */
export function applyExcelJsRowGrowth(row,headers,{profiles,normalFont={name:'Calibri',size:11},defaultRowHeight=row.worksheet.properties.defaultRowHeight||15,formatDisplay,strict=true,mergeRanges}={}){
  // Streaming rows have no merges. Never materialize a worksheet model for
  // every data row; the sheet adapter captures ranges once when necessary.
  const ranges=mergeRanges??(headers.some((header,index)=>permitsGrowth(header)&&row.getCell(index+1).isMerged)?row.worksheet.model?.merges||[]:[]);
  const merges=ranges.map(range=>{
    const match=range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);if(!match)return null;
    const column=letters=>[...letters].reduce((sum,letter)=>sum*26+letter.charCodeAt(0)-64,0);
    return {left:column(match[1]),top:Number(match[2]),right:column(match[3]),bottom:Number(match[4])};
  }).filter(Boolean);
  const cells=headers.map((header,index)=>{
    const cell=row.getCell(index+1),column=row.worksheet.getColumn(index+1),font={...normalFont,...cell.font};
    cell.style={...cell.style};
    cell.alignment={...cell.alignment,wrapText:permitsGrowth(header)};
    const formatted=formatDisplay&&permitsGrowth(header)?formatDisplay(cell):undefined;
    const merge=merges.find(range=>row.number>=range.top&&row.number<=range.bottom&&index+1>=range.left&&index+1<=range.right);
    const slave=Boolean(cell.isMerged&&cell.master?.address!==cell.address),defaultWidth=row.worksheet.properties.defaultColWidth??8.43;
    return {header,value:slave?null:cell.value,font,widthCharacters:column.width??defaultWidth,hiddenColumn:column.hidden,rotation:cell.alignment.textRotation,indent:cell.alignment.indent,verticalMerge:merge?merge.top!==merge.bottom:Boolean(cell.isMerged),...(merge&&!slave&&merge.top===merge.bottom?{mergedWidthsCharacters:Array.from({length:merge.right-merge.left+1},(_,offset)=>{const item=row.worksheet.getColumn(merge.left+offset);return item.hidden?0:item.width??defaultWidth;})}:{}),...(typeof formatted==='string'&&!slave?{displayText:formatted}:{})};
  });
  const plan=planRowGrowth({rowHeight:row.height,defaultRowHeight,hidden:row.hidden||row.height===0,cells,normalFont,profiles});if(strict)requireReadablePlan(plan,{sheet:row.worksheet.name,row:row.number});if(plan.grow)row.height=plan.heightPt;return plan;
}

export function applyExcelJsSheetGrowth(worksheet,headerRow,lastRow,headers,options){
  const mergeRanges=worksheet.model?.merges||[];
  const summary={rows:0,grown:0,reviewWarnings:0};
  for(let number=headerRow+1;number<=lastRow;number++){
    const plan=applyExcelJsRowGrowth(worksheet.getRow(number),headers,{...options,mergeRanges});summary.rows++;if(plan.grow)summary.grown++;summary.reviewWarnings+=plan.diagnostics.filter(item=>!item.blocking).length;
  }
  return summary;
}
