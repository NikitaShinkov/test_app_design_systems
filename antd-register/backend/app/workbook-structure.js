// ExcelJS moves cells without rewriting A1 formula references when splicing.
// Update structural references throughout the copied workbook, including $ refs
// (insertion moves absolute references too), while leaving literals/external
// workbooks and references to untouched sheets intact.
const columnNumber=value=>[...value.toUpperCase()].reduce((number,char)=>number*26+char.charCodeAt(0)-64,0);
const columnName=value=>{let result='';for(let number=value;number;number=Math.floor((number-1)/26))result=String.fromCharCode(65+(number-1)%26)+result;return result;};
export function shiftFormulaReferences(formula,currentSheet,targetSheet,{rows=0,column=0,columns=0}={}) {
  const reference=/(?:(\[(?:[^\]]+)\])?('(?:[^']|'')+'|[A-Za-z_\u0080-\uffff][A-Za-z0-9_.\u0080-\uffff]*)!)?(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)(?::(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*))?/g;
  // Strings use doubled quotes; sheet-name apostrophes are part of references.
  return String(formula).split(/("(?:[^"]|"")*")/g).map((part,index)=>{
    if(index%2)return part;
    const shifted=part.replace(reference,(match,external,sheet,cabs,firstColumn,rabs,firstRow,ecabs,lastColumn,erabs,lastRow,offset)=>{
      const before=part[offset-1]||'',after=part[offset+match.length]||'';
      if(/[A-Za-z0-9_.\[\]]/.test(before)||/[A-Za-z0-9_.(\[\]]/.test(after)||external)return match;
      const referencedSheet=sheet?sheet.replace(/^'|'$/g,'').replace(/''/g,"'"):currentSheet;
      if(referencedSheet.toUpperCase()!==targetSheet.toUpperCase())return match;
      const transform=(ca,col,ra,row)=>{let number=columnNumber(col);if(number>16384||Number(row)>1048576)return `${ca}${col}${ra}${row}`;if(columns && number>=column)number+=columns;return `${ca}${columnName(number)}${ra}${Number(row)+rows}`;};
      const prefix=sheet?`${sheet}!`:'';
      return prefix+transform(cabs,firstColumn,rabs,firstRow)+(lastColumn?`:${transform(ecabs,lastColumn,erabs,lastRow)}`:'');
    });
    return shifted.replace(/(?:(\[(?:[^\]]+)\])?('(?:[^']|'')+'|[A-Za-z_\u0080-\uffff][A-Za-z0-9_.\u0080-\uffff]*)!)?(\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?[1-9][0-9]*:\$?[1-9][0-9]*)/g,(match,external,sheet,range,offset)=>{
      if(external || /[A-Za-z0-9_.\[\]]/.test(shifted[offset-1]||'') || /[A-Za-z0-9_.\[\]]/.test(shifted[offset+match.length]||''))return match;
      if((sheet?sheet.replace(/^'|'$/g,'').replace(/''/g,"'"):currentSheet).toUpperCase()!==targetSheet.toUpperCase())return match;
      return (sheet?`${sheet}!`:'')+range.split(':').map(value=>{const abs=value.startsWith('$')?'$':'';const text=value.replace('$','');if(/[A-Za-z]/.test(text)){const number=columnNumber(text);return abs+columnName(number+(columns&&number>=column?columns:0));}return abs+(Number(text)+rows);}).join(':');
    });
  }).join('');
}
export function shiftWorkbookReferences(workbook,targetSheet,shift) {
  const formulas=[];
  for(const sheet of workbook.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{
    const value=cell.value;
    if(value?.formula||value?.sharedFormula)formulas.push({cell,sheet:sheet.name,formula:cell.formula,result:value.result,shareType:value.shareType,ref:value.ref});
  }));
  // Read all shared formulas before changing any master formula.
  for(const item of formulas)item.cell.value={formula:shiftFormulaReferences(item.formula,item.sheet,targetSheet,shift),...(item.result===undefined?{}:{result:item.result}),...(item.shareType==='array'?{shareType:'array',ref:shiftFormulaReferences(item.ref,item.sheet,targetSheet,shift)}:{})};
  for(const sheet of workbook.worksheets) {
    const rewrite=value=>typeof value==='string'?shiftFormulaReferences(value,sheet.name,targetSheet,shift):value;
    sheet.dataValidations.model=Object.fromEntries(Object.entries(sheet.dataValidations.model).map(([range,value])=>[sheet.name===targetSheet?rewrite(range):range,{...value,...(value.formulae?{formulae:value.formulae.map(rewrite)}:{})}]));
    for(const format of sheet.conditionalFormattings) {
      if(sheet.name===targetSheet)format.ref=rewrite(format.ref);
      for(const rule of format.rules||[])if(rule.formulae)rule.formulae=rule.formulae.map(rewrite);
    }
    if(sheet.name===targetSheet)for(const key of ['printArea','printTitlesRow','printTitlesColumn'])if(sheet.pageSetup[key])sheet.pageSetup[key]=rewrite(sheet.pageSetup[key]);
  }
  // Worksheet.spliceRows/spliceColumns already move workbook.definedNames.
}
