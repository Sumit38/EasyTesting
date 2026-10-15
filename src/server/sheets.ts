import { decodeText } from '../cases/decode.js';
import { parseCsvRows } from './csv.js';
import { looksLikeXlsx, readXlsx } from './xlsx.js';

/** Rows from an uploaded spreadsheet: .xlsx (checked by content, not just the name) or CSV/TSV text. */
export function readSheet(data: Uint8Array, filename: string): string[][] {
  if (looksLikeXlsx(data) || /\.xlsx$/i.test(filename)) {
    if (!looksLikeXlsx(data)) throw new Error('That file is named .xlsx but is not an Excel workbook. Save it from Excel as .xlsx or as CSV.');
    return readXlsx(data);
  }
  if (/\.xls$/i.test(filename)) throw new Error('Old .xls files are not supported. In Excel choose Save As and pick .xlsx or CSV.');
  // Excel saves CSV in the Windows code page, and "Unicode text" as UTF-16: read both, not only UTF-8.
  return parseCsvRows(decodeText(data));
}
