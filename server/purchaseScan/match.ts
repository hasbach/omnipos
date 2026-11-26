export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
export interface MatchProduct { id: number; name: string; barcode?: string; barcodes?: string[] }
export function matchLine(line: { name: string; barcode?: string }, products: MatchProduct[], memory: Record<string, number> = {}, threshold = 0.6) {
  const exact = line.barcode && products.find(p => p.barcode === line.barcode || p.barcodes?.includes(line.barcode!));
  if (exact) return [{ product_id: exact.id, score: 1, reason: 'barcode' }];
  const name = normalizeName(line.name);
  const remembered = products.find(p => p.id === memory[name]);
  if (remembered) return [{ product_id: remembered.id, score: 1, reason: 'memory' }];
  if (!name) return [];
  const tokens = new Set(name.split(' '));
  return products.map(p => {
    const other = new Set(normalizeName(p.name).split(' '));
    const overlap = [...tokens].filter(t => other.has(t)).length;
    return { product_id: p.id, score: 2 * overlap / (tokens.size + other.size), reason: 'name' };
  }).filter(p => p.score >= threshold).sort((a, b) => b.score - a.score || a.product_id - b.product_id).slice(0, 5);
}
