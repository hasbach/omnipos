import { db } from '../db.js';
import { analyzeBaskets, type Basket, type BasketProduct } from './basketAnalysis.js';
import { ValidationError } from '../errors.js';

export function readBundleIdeas(tenantId: number, query: Record<string, unknown>, now = new Date()) {
  const minSupport = Number(query.min_support ?? 3);
  const targetPercent = Number(query.target_percent ?? 20);
  if (!Number.isInteger(minSupport) || minSupport < 1 || !Number.isFinite(targetPercent) || targetPercent < 0 || targetPercent > 1000) {
    throw new ValidationError('Invalid bundle analysis parameters.', 400);
  }
  const baskets = new Map<string, Basket>();
  for (const [transactions, items, source] of [
    ['transactions', 'transaction_items', 'live'],
    ['archived_transactions', 'archived_transaction_items', 'archive'],
  ]) {
    const rows = db.prepare(`
      SELECT t.id, t.created_at, i.product_id, i.quantity, i.bundle_id
      FROM ${transactions} t JOIN ${items} i ON i.transaction_id = t.id AND i.deleted_at IS NULL
      WHERE t.tenant_id = ? AND t.type = 'sale' AND t.status = 'completed' AND t.deleted_at IS NULL
        AND julianday(t.created_at) >= julianday(?) AND julianday(t.created_at) <= julianday(?)
    `).all(tenantId, new Date(now.getTime() - 90 * 86400000).toISOString(), now.toISOString()) as Array<{
      id: number; created_at: string; product_id: number; quantity: number; bundle_id: number | null;
    }>;
    for (const row of rows) {
      const id = `${source}:${row.id}`;
      const soldAt = row.created_at.replace(' ', 'T');
      if (!baskets.has(id)) baskets.set(id, { id, soldAt: /(?:Z|[+-]\d{2}:\d{2})$/.test(soldAt) ? soldAt : `${soldAt}Z`, lines: [] });
      baskets.get(id)!.lines.push(row);
    }
  }
  const products = db.prepare(`SELECT id, name, price, cost, is_bundle FROM products
    WHERE tenant_id = ? AND deleted_at IS NULL AND active = 1`).all(tenantId) as BasketProduct[];
  return { basketCount: baskets.size, ideas: analyzeBaskets([...baskets.values()], products, { minSupport, targetPercent, now }) };
}
