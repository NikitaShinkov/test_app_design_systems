const invalid=()=>Object.assign(new Error('The import worksheet extent is invalid.'),{status:422,code:'IMPORT_SOURCE_EXTENT_INVALID'});

// Range.End(xlUp) observes physical content, not normalized business text.
// An empty cached result is occupied when the worksheet retains its formula.
export function importCellOccupied(cell){
 if(!cell||typeof cell!=='object')return false;
 if(typeof cell.f==='string'||typeof cell.F==='string'&&cell.F!=='')return true;
 return cell.v!==undefined&&cell.v!==null&&cell.v!=='';
}

/** All coordinates are one-based; lastRow is the already bounded matrix end. */
export function lastImportDataRow(worksheet,{column,headerRow,lastRow}={}){
 if(!worksheet||typeof worksheet!=='object'||!Number.isSafeInteger(column)||column<1||column>16384||!Number.isSafeInteger(headerRow)||headerRow<1||headerRow>1048576||!Number.isSafeInteger(lastRow)||lastRow<0||lastRow>1048576)throw invalid();
 let name='',number=column;while(number){number--;name=String.fromCharCode(65+number%26)+name;number=Math.floor(number/26);}
 for(let row=lastRow;row>headerRow;row--)if(importCellOccupied(worksheet[name+row]))return row;
 return headerRow;
}

/** Range.End(xlToLeft) observes occupied cells in this one header row. */
export function lastOccupiedHeaderColumn(worksheet,{row,lastColumn}={}){
 if(!worksheet||typeof worksheet!=='object'||!Number.isSafeInteger(row)||row<1||row>1048576||!Number.isSafeInteger(lastColumn)||lastColumn<0||lastColumn>16384)throw invalid();
 for(let column=lastColumn;column>=1;column--){
  let name='',number=column;while(number){number--;name=String.fromCharCode(65+number%26)+name;number=Math.floor(number/26);}
  if(importCellOccupied(worksheet[name+row]))return column;
 }
 return 0;
}
