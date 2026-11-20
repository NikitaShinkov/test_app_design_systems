import {cleanText,normalize,originalKey} from './normalization.js';
import {validBusinessDate} from './validation.js';

// Core.bas AC8_SourceRowDatabaseMatchScore. Position/manufacturer alone never
// qualify. Matching is supplier-independent and searches all original cells.
export function sourceRowMatchScore(source,record) {
  const pn=normalize(record.origPn);if(!pn)return 0;
  const text=normalize(source.rowText);const code=normalize(source.code);let score=0;
  if(code && code===normalize(record.origCode))score+=200;
  if(text && text.includes(pn))score+=150;
  const manufacturer=normalize(record.origMfr);
  if(manufacturer && text.includes(manufacturer))score+=20;
  if(normalize(source.position) && normalize(source.position)===normalize(record.position))score+=20;
  return score>=150?score:0;
}
const dateSerial=value=>validBusinessDate(cleanText(value))?Date.parse(`${cleanText(value)}T00:00:00Z`):0;
export function matchSourceRow(source,records) {
  const product=normalize(source.productDecimalNo);let bestScore=0,best=null,bestOriginal='',ambiguous=false,obsolete=false;
  const candidates=[];
  if(!product)return {record:null,score:0,ambiguous:false,obsolete:false,candidates};
  for(const record of records) {
    if(normalize(record.productDecimalNo)!==product)continue;
    const score=sourceRowMatchScore(source,record);if(!score)continue;
    if(normalize(record.decisionStatus)==='OBSOLETE')obsolete=true;
    if(normalize(record.decisionStatus)!=='APPROVED' || !cleanText(record.altPn))continue;
    const key=originalKey(record);
    candidates.push({recordId:record.recordId,origMfr:record.origMfr,origPn:record.origPn,altMfr:record.altMfr,altPn:record.altPn,decisionReference:record.decisionReference,decisionDate:record.decisionDate,score});
    if(score>bestScore){bestScore=score;bestOriginal=key;best=record;ambiguous=false;}
    else if(score===bestScore) {
      if(key!==bestOriginal)ambiguous=true;
      else if(dateSerial(record.decisionDate)>=dateSerial(best.decisionDate))best=record;
    }
  }
  return {record:ambiguous?null:best,score:bestScore,ambiguous,obsolete,candidates};
}
