// Client-side spreadsheet parsing for the import wizard (UploadStep). Handles .xlsx/.xls/.csv,
// including UTF-8-with-BOM and Arabic CSV content (read as an ArrayBuffer + codepage:65001).
import * as XLSX from 'xlsx';
import { isExampleRowMarker } from './fields';

export interface ParsedRow {
  /** 1-based row number in the ORIGINAL sheet (matches what a spreadsheet app shows), used for
   * display (ReviewStep) and for the error report — never renumbered after skipping rows. */
  sheetRow: number;
  /** header (as read from the sheet) -> raw cell value. */
  cells: Record<string, any>;
}

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: ParsedRow[];
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
}

function isRowEmpty(cells: Record<string, any>): boolean {
  return Object.values(cells).every((v) => v === null || v === undefined || String(v).trim() === '');
}

function sheetToRows(ws: XLSX.WorkSheet, sheetName: string): ParsedSheet {
  // header:1 -> array-of-arrays so we keep raw values and can find the true header row (first
  // non-empty row) ourselves, and track original sheet row numbers precisely.
  const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  let headerIdx = -1;
  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i] || [];
    if (row.some((c) => c !== null && c !== undefined && String(c).trim() !== '')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { name: sheetName, headers: [], rows: [] };

  const rawHeaders = aoa[headerIdx] || [];
  const headers: string[] = rawHeaders.map((h, i) => {
    const s = h === null || h === undefined ? '' : String(h).trim();
    return s || `Column ${i + 1}`;
  });

  const rows: ParsedRow[] = [];
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const raw = aoa[i] || [];
    const cells: Record<string, any> = {};
    headers.forEach((h, ci) => {
      cells[h] = raw[ci] !== undefined ? raw[ci] : '';
    });
    if (isRowEmpty(cells)) continue;
    if (isExampleRowMarker(raw[0])) continue;
    // sheetRow is 1-based and matches the spreadsheet's own row numbering (i is 0-based index
    // into aoa, which itself mirrors sheet rows starting at 0).
    rows.push({ sheetRow: i + 1, cells });
  }

  return { name: sheetName, headers, rows };
}

export async function parseSpreadsheetFile(file: File): Promise<ParsedWorkbook> {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const data = new Uint8Array(buf);

  const readOpts: XLSX.ParsingOptions = { type: 'array' };
  if (ext === 'csv') {
    // Detect UTF-8 BOM; XLSX's array reader + codepage:65001 handles UTF-8 (incl. Arabic) correctly
    // either way, so always set it for CSV.
    (readOpts as any).codepage = 65001;
  }

  const workbook = XLSX.read(data, readOpts);
  const sheets = workbook.SheetNames.map((name) => sheetToRows(workbook.Sheets[name], name)).filter(
    (s) => s.headers.length > 0,
  );

  return { sheets };
}
