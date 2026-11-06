export type PrintResult = { success: boolean; error: string | null };

/**
 * Prints a full HTML document the way POS receipts are printed: silently to the OS default printer
 * (electron-main.js 'print:silent-html'), with no print dialog. The print callback can hang on a
 * machine with no printer, so it is raced against a timeout. Outside the Electron shell (a plain
 * browser tab) it falls back to the browser's print dialog.
 */
export async function printReportHtml(html: string): Promise<PrintResult> {
  if (window.electronAPI?.printSilent) {
    try {
      const timeout = new Promise<PrintResult>((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'Printing timed out' }), 12000),
      );
      const result = await Promise.race([window.electronAPI.printSilent(html), timeout]);
      return result?.success ? { success: true, error: null } : { success: false, error: result?.error || 'no printer available' };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  const w = window.open('', '_blank');
  if (!w) return { success: false, error: 'The print window was blocked' };
  w.document.write(html.replace('</body>', '<script>window.onload = function () { window.print(); window.close(); };<\/script></body>'));
  w.document.close();
  return { success: true, error: null };
}
