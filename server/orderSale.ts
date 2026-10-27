import { db } from './db.js';

export function loadCompletableOrder(tenantId: number, orderGlobalId: string): any {
  return db.prepare('SELECT * FROM orders WHERE tenant_id = ? AND global_id = ? AND deleted_at IS NULL')
    .get(tenantId, orderGlobalId) || null;
}

export function orderEffectiveState(order: any): string {
  return order.state === 'submitted' && Date.parse(order.expires_at) < Date.now() ? 'expired' : order.state;
}

export function orderSaleExists(tenantId: number, orderGlobalId: string): boolean {
  return !!db.prepare(`SELECT id FROM transactions WHERE tenant_id = ? AND order_global_id = ?
    UNION ALL SELECT id FROM archived_transactions WHERE tenant_id = ? AND order_global_id = ? LIMIT 1`)
    .get(tenantId, orderGlobalId, tenantId, orderGlobalId);
}

export function orderPricedItems(tenantId: number, orderGlobalId: string, items: any): Map<number, { perUnitUsd: number }> {
  const result = new Map<number, { perUnitUsd: number }>();
  const order = loadCompletableOrder(tenantId, orderGlobalId);
  if (!order || !['confirmed', 'ready'].includes(orderEffectiveState(order)) || !Array.isArray(items)) return result;
  const lines = (db.prepare(`SELECT * FROM order_lines WHERE tenant_id = ? AND order_id = ?
    AND deleted_at IS NULL AND confirmed_qty > 0 AND product_id IS NOT NULL ORDER BY line_no`)
    .all(tenantId, order.id) as any[]).map(line => {
      const unit = line.unit_key === 'base' ? null : db.prepare(`SELECT id FROM product_units
        WHERE tenant_id = ? AND product_id = ? AND global_id = ? AND deleted_at IS NULL`)
        .get(tenantId, line.product_id, line.unit_key) as any;
      const converted = line.unit_key !== 'base' && !unit;
      return {
        productId: line.product_id, uomId: unit?.id ?? null,
        remaining: line.confirmed_qty * (converted ? line.unit_factor : 1),
        price: line.unit_price_usd / (converted ? line.unit_factor : 1),
      };
    });
  items.forEach((item: any, index: number) => {
    if (!item || !Number.isFinite(item.unit_price) || !Number.isFinite(item.quantity) || item.quantity <= 0) return;
    const line = lines.find(line => line.productId === item.id && line.uomId === (item.uom_id ?? null)
      && Math.abs(item.unit_price - line.price) <= 0.005 + 1e-9 && item.quantity <= line.remaining + 1e-9);
    if (!line) return;
    line.remaining -= item.quantity;
    result.set(index, { perUnitUsd: line.price });
  });
  return result;
}
