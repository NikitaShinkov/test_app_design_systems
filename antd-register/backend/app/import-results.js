const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const sheetFinding=finding=>finding?.code==='IMPORT_SHEET_SKIPPED';

// Earlier immutable receipts have no ignored counter. Its absence means zero
// for comparison only; callers must not add it to the retained receipt.
export function importIgnoredCount(result) {
  if(!Object.hasOwn(result,'ignored'))return 0;
  if(!Number.isSafeInteger(result.ignored)||result.ignored<0)throw Error('Invalid ignored import row count.');
  return result.ignored;
}

export function skippedSheetCount(findings=[]) {
  return new Set(findings.filter(sheetFinding).filter(finding=>typeof finding.sheet==='string'&&finding.sheet).map(finding=>finding.sheet)).size;
}

export function importResultMessage(result) {
  const message=`${count(result.imported)} rows imported, ${count(result.updated)} rows updated, ${count(result.skipped)} rows quarantined or skipped; ${count(result.obsoleteRecorded)} obsolete lifecycle records added.`+(Object.hasOwn(result,'ignored')?` ${importIgnoredCount(result)} ordinary rows without replacement proposals ignored.`:'');
  return (result.duplicate===true?'Already processed; no register rows changed. Saved row result: ':'')+message+(count(result.skippedSheets)?` ${count(result.skippedSheets)} worksheet(s) skipped.`:'');
}

// Keep row counts independent of skipped worksheets. For a duplicate input,
// project the current selection's sheet findings without editing its receipt.
export function withImportFindings(result,parseFindings=[]) {
  const findings=structuredClone([...parseFindings,...(result.findings||[]).filter(finding=>!sheetFinding(finding))]);
  const value={...result,findings,skippedSheets:skippedSheetCount(parseFindings),status:findings.length?'COMPLETED_WITH_FINDINGS':'COMPLETED'};
  return {...value,message:importResultMessage(value)};
}

export function importReceiptResult(receipt,parseFindings) {
  const result={...structuredClone(receipt),duplicate:true};
  return parseFindings===undefined?{...result,message:importResultMessage(result)}:withImportFindings(result,parseFindings);
}
