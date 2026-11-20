const lettersToColumn=value=>[...value.toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
export function columnLetters(value){let result='';for(let n=value;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;}
const cellPattern=/^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)/;
const wordCharacter=char=>Boolean(char)&&/[\p{L}\p{N}_.]/u.test(char);
const sheetPattern=/^((?:\[[^\]]+\])?(?:'(?:[^']|'')+'|[\p{L}\p{N}_][\p{L}\p{N}_.]*)(?::(?:'(?:[^']|'')+'|[\p{L}\p{N}_][\p{L}\p{N}_.]*))?)!/u;
const decodeSheet=value=>value.replace(/^'|'$/g,'').replace(/''/g,"'");
function cell(text){const match=text.match(cellPattern);return match&&lettersToColumn(match[2])<=16384&&Number(match[4])<=1048576?{length:match[0].length,column:lettersToColumn(match[2]),row:match[4],columnAbsolute:match[1],rowAbsolute:match[3]}:null;}
function parseReference(text) {
  const first=cell(text);
  if(first){const second=text[first.length]===':'?cell(text.slice(first.length+1)):null;return {kind:'CELL',first,second,length:first.length+(second?second.length+1:0)};}
  let match=text.match(/^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})/);
  if(match&&lettersToColumn(match[2])<=16384&&lettersToColumn(match[4])<=16384)return {kind:'COLUMN',first:{column:lettersToColumn(match[2]),columnAbsolute:match[1]},second:{column:lettersToColumn(match[4]),columnAbsolute:match[3]},length:match[0].length};
  match=text.match(/^(\$?)([1-9][0-9]*):(\$?)([1-9][0-9]*)/);
  return match&&Number(match[2])<=1048576&&Number(match[4])<=1048576?{kind:'ROW',length:match[0].length}:null;
}
function movedRange(reference,column,count,clamp=false) {
  if(reference.kind==='ROW')return null;
  const end=column+count-1,first=reference.first,second=reference.second;
  const address=(point,col)=>`${point.columnAbsolute}${columnLetters(col)}${reference.kind==='CELL'?`${point.rowAbsolute}${point.row}`:''}`;
  if(!second){if(first.column>=column&&first.column<=end)return clamp?address(first,column):'#REF!';return address(first,first.column>end?first.column-count:first.column);}
  const low=Math.min(first.column,second.column),high=Math.max(first.column,second.column);
  if(low>=column&&high<=end)return clamp?`${address(first,column)}:${address(second,column)}`:'#REF!';
  const newLow=low<column?low:low>end?low-count:column;
  const newHigh=high>end?high-count:high<column?high:column-1;
  const ascending=first.column<=second.column;
  return `${address(first,ascending?newLow:newHigh)}:${address(second,ascending?newHigh:newLow)}`;
}

// Structural column deletion moves absolute references too. Deleted single
// cells become #REF!, ranges shrink, and literals/external/3D/table references
// remain opaque here. Table-column references are handled by the XLSX editor.
export function deleteFormulaColumns(formula,currentSheet,targetSheet,column,count=1,{clamp=false}={}) {
  const text=String(formula);let output='',index=0;
  while(index<text.length) {
    if(text[index]==='"'){let end=index+1;while(end<text.length){if(text[end]==='"'){if(text[end+1]==='"'){end+=2;continue;}end++;break;}end++;}output+=text.slice(index,end);index=end;continue;}
    if(!wordCharacter(text[index-1])) {
      const prefix=text.slice(index).match(sheetPattern),offset=prefix?prefix[0].length:0,reference=parseReference(text.slice(index+offset));
      if(reference&&!wordCharacter(text[index+offset+reference.length])&&!['(','['].includes(text[index+offset+reference.length])) {
        const original=text.slice(index,index+offset+reference.length),sheet=prefix?decodeSheet(prefix[1]):currentSheet;
        if(!sheet||sheet.includes('[')||sheet.includes(':')||sheet.toUpperCase()!==targetSheet.toUpperCase())output+=original;
        else output+=(prefix?.[0]||'')+(movedRange(reference,column,count,clamp)??text.slice(index+offset,index+offset+reference.length));
        index+=offset+reference.length;continue;
      }
    }
    if(text[index]==='['){let depth=0,end=index;do{if(text[end]==="'"){end+=2;continue;}if(text[end]==='[')depth++;if(text[end]===']')depth--;end++;}while(end<text.length&&depth>0);output+=text.slice(index,end);index=end;continue;}
    output+=text[index++];
  }
  return output;
}

export function deletedRange(reference,column,count=1,clamp=false){return deleteFormulaColumns(reference,'Sheet','Sheet',column,count,{clamp});}
export function columnIndex(address){return lettersToColumn(String(address).replace(/\$/g,'').match(/^[A-Za-z]+/)?.[0]||'');}

// Excel invalidates the complete structured reference if one of its named
// columns (including a range endpoint) is deleted. String literals and external
// workbook references must not be interpreted as local table expressions.
export function deleteTableColumnReferences(formula,tableName,columnName,{implicit=false}={}) {
  const text=String(formula),same=value=>value.toUpperCase()===columnName.toUpperCase();let result='',index=0;
  while(index<text.length){
    if(text[index]==='"'){let end=index+1;while(end<text.length){if(text[end]==='"'){if(text[end+1]==='"'){end+=2;continue;}end++;break;}end++;}result+=text.slice(index,end);index=end;continue;}
    const match=text.slice(index).match(/^[\p{L}_\\][\p{L}\p{N}_.\\]*/u),named=match&&match[0].toUpperCase()===tableName.toUpperCase()&&!wordCharacter(text[index-1])&&!['!',']'].includes(text[index-1]);
    const start=named?index+match[0].length:index;
    if(text[start]==='['&&(named||implicit&&start===index)){
      let depth=0,end=start,leaf='',escapedFirst=false,deleted=false;
      do{const char=text[end++];if(char==="'"&&depth>0&&end<text.length){if(!leaf)escapedFirst=true;leaf+=text[end++];continue;}if(char==='['){depth++;leaf='';escapedFirst=false;}else if(char===']'){const field=escapedFirst?leaf:leaf.replace(/^@/,'');if((escapedFirst||!leaf.startsWith('#'))&&same(field))deleted=true;depth--;leaf='';escapedFirst=false;}else leaf+=char;}while(end<text.length&&depth>0);
      result+=deleted?'#REF!':text.slice(index,end);index=end;continue;
    }
    if(text[index]==='['){let depth=0,end=index;do{if(text[end]==="'"){end+=2;continue;}if(text[end]==='[')depth++;if(text[end]===']')depth--;end++;}while(end<text.length&&depth>0);result+=text.slice(index,end);index=end;continue;}
    result+=text[index++];
  }
  return result;
}
