import { db } from './db.js';
import { lbpPricePairs } from './lbpRateAlerts.js';

// Shared scalar write used by the product editor and rate repricing. Optional stock stays untouched.
export function writeProductFields(tenantId: number, id: number | string, body: Record<string, any>, localOnly = false) {
  if (localOnly) {
    const keys = lbpPricePairs.map(([, local]) => local).filter(key => body[key] !== undefined);
    if (!keys.length) throw new Error('No local prices');
    if (keys.some(key => !Number.isFinite(body[key]) || body[key] < 0)) throw new Error('Invalid local price');
    return db.prepare(`UPDATE products SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`)
      .run(...keys.map(key => body[key]), id, tenantId);
  }
  const { name, price, price_lbp, package_price, package_price_lbp, cost, cost_lbp, units_per_package, stock, reorder_point, track_inventory, category, currency, unit, price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, min_price } = body;
  return db.prepare("UPDATE products SET name = ?, price = ?, price_lbp = ?, package_price = ?, package_price_lbp = ?, cost = ?, cost_lbp = ?, units_per_package = ?, stock = COALESCE(?, stock), reorder_point = ?, track_inventory = ?, category = ?, currency = ?, unit = ?, price_wholesale = ?, price_wholesale_lbp = ?, price_super_wholesale = ?, price_super_wholesale_lbp = ?, min_price = ? WHERE id = ? AND tenant_id = ?")
    .run(name, price, price_lbp || null, package_price || null, package_price_lbp || null, cost || null, cost_lbp || null, units_per_package || 1, (stock === undefined || stock === null || stock === '') ? null : Number(stock), reorder_point || 0, track_inventory === 0 ? 0 : 1, category, currency, unit, price_wholesale || null, price_wholesale_lbp || null, price_super_wholesale || null, price_super_wholesale_lbp || null, min_price || null, id, tenantId);
}
