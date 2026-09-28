// Excel (SheetJS) + PDF (jspdf + jspdf-autotable) export helpers shared by every report tab.
// Kept local to src/pages/reports/ per the page-agent brief (no shared src/lib addition).
import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';

export interface ExportColumn<T> {
  key: string;
  header: string;
  /** Raw value for Excel + PDF cells. Numbers are written as numbers in Excel. */
  value: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
}

export interface ExportMeta {
  fileName: string; // without extension
  title: string; // report name, e.g. "Products report"
  subtitle?: string; // e.g. "2026-09-01 – 2026-09-28"
  businessName?: string;
}

export function exportRowsToExcel<T>(rows: T[], columns: ExportColumn<T>[], meta: ExportMeta, totals?: Record<string, string | number>) {
  const header = columns.map((c) => c.header);
  const body = rows.map((row) => columns.map((c) => c.value(row)));
  const aoa: (string | number)[][] = [];
  if (meta.businessName) aoa.push([meta.businessName]);
  aoa.push([meta.title]);
  if (meta.subtitle) aoa.push([meta.subtitle]);
  aoa.push([]);
  aoa.push(header);
  aoa.push(...body);
  if (totals) aoa.push(columns.map((c) => totals[c.key] ?? ''));

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map(() => ({ wch: 18 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, `${meta.fileName}.xlsx`);
}

export function exportRowsToPdf<T>(rows: T[], columns: ExportColumn<T>[], meta: ExportMeta, totals?: Record<string, string | number>) {
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait', unit: 'pt' });
  let y = 40;
  if (meta.businessName) {
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text(meta.businessName, 32, y);
    y += 18;
  }
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(meta.title, 32, y);
  y += 16;
  if (meta.subtitle) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.text(meta.subtitle, 32, y);
    y += 10;
  }

  const head = [columns.map((c) => c.header)];
  const body = rows.map((row) => columns.map((c) => String(c.value(row))));
  const foot = totals ? [columns.map((c) => String(totals[c.key] ?? ''))] : undefined;

  autoTable(doc, {
    startY: y + 6,
    head,
    body,
    foot,
    styles: { fontSize: 8, cellPadding: 4 },
    headStyles: { fillColor: [30, 64, 175], textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [226, 232, 240], textColor: 20, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(
      columns.map((c, i) => [i, { halign: c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left' }]),
    ),
  });

  doc.save(`${meta.fileName}.pdf`);
}

/** Triggers the browser print dialog for the #printable-report container (see src/index.css). */
export function printReport() {
  window.print();
}
