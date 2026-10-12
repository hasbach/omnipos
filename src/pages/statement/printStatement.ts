// Print / save a statement page produced by GET /api/reports/statement/:id/html. In Electron this goes
// through the 'print:html' / 'print:pdf' IPC handlers; in a plain browser (preview server) it falls back
// to a print window, whose dialog also offers "Save as PDF".

function browserPrint(html: string): void {
  const w = window.open('', '_blank');
  if (!w) throw new Error('Pop-up blocked');
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

/** System print dialog for the given statement page. Resolves quietly when the user cancels. */
export async function printStatementHtml(html: string): Promise<void> {
  const api = window.electronAPI;
  if (api?.printHtml) {
    const r = await api.printHtml(html);
    if (!r.success && r.error && r.error !== 'cancelled') throw new Error(r.error);
    return;
  }
  browserPrint(html);
}

/** Saves an A4 PDF; returns the saved path, or null when cancelled / handled by the browser dialog. */
export async function saveStatementPdf(html: string, fileName: string): Promise<string | null> {
  const api = window.electronAPI;
  if (api?.savePdf) {
    const r = await api.savePdf(html, fileName);
    if (!r.success) {
      if (r.error && r.error !== 'cancelled') throw new Error(r.error);
      return null;
    }
    return r.path ?? null;
  }
  browserPrint(html);
  return null;
}
