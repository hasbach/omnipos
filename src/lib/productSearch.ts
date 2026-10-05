import Fuse from 'fuse.js';

/** Max suggestions shown in the POS search dropdowns. */
export const MAX_SUGGESTIONS = 50;

/** A query that looks like a barcode: digits only, at least 4 long. */
export const looksLikeBarcode = (q: string) => /^\d{4,}$/.test(q);

const productCodes = (p: any): string[] =>
  [p.barcode, ...(Array.isArray(p.barcodes) ? p.barcodes : []), ...(p.units || []).map((u: any) => u.barcode)]
    .filter((c: any) => c != null && String(c).trim() !== '')
    .map((c: any) => String(c).trim());

/** Products whose barcode / extra barcodes / unit barcodes EXACTLY equal the (trimmed) code. */
export function findExactBarcodeMatches(products: any[], code: string): any[] {
  const q = code.trim();
  if (!q) return [];
  return (products || []).filter(p => productCodes(p).includes(q));
}

/** Suggestions for the POS search box. Barcode-like queries never fuzzy-match barcodes. */
export function searchProducts(products: any[], rawQuery: string, limit = MAX_SUGGESTIONS): any[] {
  const q = rawQuery.trim();
  if (q.length < 2) return [];
  const list = products || [];

  if (looksLikeBarcode(q)) {
    const exact: any[] = [];
    const prefix: any[] = [];
    for (const p of list) {
      const codes = productCodes(p);
      if (codes.includes(q)) exact.push(p);
      else if (codes.some(c => c.startsWith(q))) prefix.push(p);
    }
    return [...exact, ...prefix].slice(0, limit);
  }

  const lower = q.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const seen = new Set<any>();
  const out: any[] = [];
  const push = (p: any) => {
    if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
  };

  // 1) exact barcode match, 2) every word of the query is a substring of the name (or code)
  findExactBarcodeMatches(list, q).forEach(push);
  for (const p of list) {
    const name = String(p.name || '').toLowerCase();
    if (words.every(w => name.includes(w))) push(p);
  }
  // 3) fuzzy name matches (no fuzzy barcode matching for codes)
  const fuse = new Fuse(list, { keys: ['name'], threshold: 0.3 });
  fuse.search(q).forEach((r: any) => push(r.item));
  // codes that merely contain the text (mixed alphanumeric barcodes)
  for (const p of list) {
    if (productCodes(p).some(c => c.toLowerCase().startsWith(lower))) push(p);
  }
  return out.slice(0, limit);
}
