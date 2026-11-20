import {classifyReply} from './domain.js';

export const decisionPalette=Object.freeze({
  REJECTED:{fill:'FFFFC7CE',font:'FF9C0006'},
  PENDING:{fill:'FFFFF2CC',font:'FF7F6000'},
  APPROVED:{fill:'FFC6EFCE',font:'FF006100'},
  'DO NOT PURCHASE':{fill:'FFE7E6E6',font:'FF595959'},
  UNKNOWN:{fill:'FFFCE4D6',font:'FF9C5700'}
});
export const isDecisionHeader=header=>/^client[_ ]?decision(?:_\d+)?$/i.test(String(header).trim());
export const decisionAppearance=value=>decisionPalette[classifyReply(value)||'PENDING']||decisionPalette.UNKNOWN;
const fill=color=>({type:'pattern',pattern:'solid',fgColor:{argb:color}});
export function colorDecisionCell(cell,value=cell.text){const colors=decisionAppearance(value);cell.style={...cell.style};cell.fill=fill(colors.fill);cell.font={...cell.font,bold:true,color:{argb:colors.font}};}
// Decision colours belong to the response cells. Keep the ordinary table
// header style, including the dark header used by register reports.
export function colorDecisionHeader(cell){return cell;}
export function decisionFormattingRules(column,firstRow){
  const ref=`$${column}${firstRow}`,text=`UPPER(TRIM(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(${ref},CHAR(160)," "),CHAR(13)," "),CHAR(10)," ")))`;
  const contains=token=>`ISNUMBER(SEARCH("${token}",${text}))`;
  const doNotPurchase=`OR(${['DO NOT PURCHASE',"DON'T PURCHASE",'DONT PURCHASE','DO NOT BUY'].map(contains).join(',')})`;
  const rejection=`OR(${['REJECT','NOT OK','NOT APPROVED','НЕ СОГЛАС'].map(contains).join(',')})`;
  let tokens=text;for(const punctuation of ['.',',',';',':','/','\\','(',')','[',']'])tokens=`SUBSTITUTE(${tokens},"${punctuation}"," ")`;tokens=`TRIM(${tokens})`;
  const approval=`OR(${['APPROVED','ACCEPTED','СОГЛАС'].map(contains).join(',')},${tokens}="OK",${tokens}="ОК",LEFT(${tokens},3)="OK ",LEFT(${tokens},3)="ОК ")`;
  const conditions=[['PENDING',`LEN(${text})=0`],['DO NOT PURCHASE',doNotPurchase],['REJECTED',rejection],['APPROVED',approval],['UNKNOWN',`LEN(${text})>0`]];
  return conditions.map(([kind,formula],index)=>({kind,type:'expression',priority:index+1,stopIfTrue:true,formulae:[formula],style:{fill:fill(decisionPalette[kind].fill),font:{bold:true,color:{argb:decisionPalette[kind].font}}}}));
}
export function applyExcelDecisionFormatting(worksheet,headerRow,lastRow,headers,{colorCells=true}={}){
  const columns=headers.flatMap((header,index)=>isDecisionHeader(header)?[index+1]:[]);if(!columns.length)return;
  // Keep the order and relative precedence of every retained source rule.
  for(const group of worksheet.conditionalFormattings||[])for(const rule of group.rules||[])if(rule.priority)rule.priority+=columns.length*5;
  for(const [index,column]of columns.entries()){
    if(colorCells){colorDecisionHeader(worksheet.getCell(headerRow,column));for(let row=headerRow+1;row<=lastRow;row++)colorDecisionCell(worksheet.getCell(row,column));}
    if(lastRow<=headerRow)continue;
    let letters='',n=column;while(n){letters=String.fromCharCode(65+(n-1)%26)+letters;n=Math.floor((n-1)/26);}
    worksheet.addConditionalFormatting({ref:`${letters}${headerRow+1}:${letters}${lastRow}`,rules:decisionFormattingRules(letters,headerRow+1).map(({kind,...rule})=>({...rule,priority:rule.priority+index*5}))});
  }
}
