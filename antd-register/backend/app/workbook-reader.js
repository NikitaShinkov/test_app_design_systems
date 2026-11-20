import XLSX from 'xlsx';
import {assertWorkbookArchive,assertWorkbookModel,WorkbookLimitError} from './workbook-limits.js';
import {restoreImportStringValues} from './import-exact-strings.js';
import {workflowError} from './workbook-file-errors.js';

export function readLegacyWorkbook(buffer,{exactImportStrings=false,physicalCells=false}={}) {
  try {
    assertWorkbookArchive(buffer);
    const workbook=XLSX.read(buffer, { type: "buffer", cellDates: false,...(physicalCells?{cellFormula:true,sheetStubs:true}:{}),...(exactImportStrings?{bookFiles:true}:{}) });
    assertWorkbookModel(workbook);return exactImportStrings?restoreImportStringValues(workbook):workbook;
  } catch (error) {
    if(error instanceof WorkbookLimitError)throw error;
    workflowError("INVALID_EXCEL_FILE", "Excel could not read this file.", [`The file is not a valid XLS/XLSX/XLSM workbook: ${error.message}`]);
  }
}

export function sheetRows(workbook, sheetName, absolute=false) {
  const sheet=workbook.Sheets[sheetName];
  const range=absolute&&sheet['!ref']?`A1:${XLSX.utils.encode_cell(XLSX.utils.decode_range(sheet['!ref']).e)}`:undefined;
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true, ...(range?{range}:{}) });
}

