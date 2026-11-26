import type Database from "better-sqlite3";
import { lineNet, globalDiscountAmount } from "./sales.js";

interface HistoryLine {
  source: string;
  id: number;
  type: string;
  created_at: string;
  stakeholder_id: number | null;
  supplier: string | null;
  tx_discount_type: string | null;
  tx_discount_value: number | null;
  product_id: number;
  quantity: number;
  unit_price: number;
  unit_cost: number | null;
  discount_type: string | null;
  discount_value: number | null;
}

// Read-only snapshot: quantities are base pieces and product.cost is the current USD WAC.
export function readInventoryHealth(db: Database.Database, tenant: number, now = new Date()) {
  const asOf = now.toISOString();
  const products = db.prepare(`SELECT id, name, category, stock, cost FROM products
    WHERE tenant_id = ? AND deleted_at IS NULL AND COALESCE(track_inventory, 1) = 1 AND COALESCE(is_bundle, 0) = 0`)
    .all(tenant) as { id: number; name: string; category: string | null; stock: number; cost: number | null }[];
  const branch = (tx: string, items: string, source: string) => `SELECT '${source}' AS source,
    t.id, t.type, t.created_at, t.stakeholder_id, s.name AS supplier,
    t.discount_type AS tx_discount_type, t.discount_value AS tx_discount_value,
    i.product_id, i.quantity, i.unit_price, i.unit_cost, i.discount_type, i.discount_value
    FROM ${tx} t JOIN ${items} i ON i.transaction_id = t.id
    LEFT JOIN stakeholders s ON s.id = t.stakeholder_id AND s.tenant_id = t.tenant_id
    WHERE t.tenant_id = @tenant AND t.deleted_at IS NULL AND i.deleted_at IS NULL
      AND COALESCE(lower(t.status), '') NOT IN ('void', 'voided', 'cancelled', 'canceled')
      AND t.type IN ('purchase', 'sale', 'refund') AND datetime(t.created_at) <= datetime(@asOf)`;
  const lines = db.prepare(`${branch('transactions', 'transaction_items', 'live')}
    UNION ALL ${branch('archived_transactions', 'archived_transaction_items', 'archive')}`)
    .all({ tenant, asOf }) as HistoryLine[];
  const timestamp = (s: string) => new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
  lines.sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at) || a.id - b.id || a.source.localeCompare(b.source));
  const adjustments = new Set((db.prepare(`SELECT DISTINCT product_id FROM stock_adjustments
    WHERE tenant_id = ? AND deleted_at IS NULL AND delta < 0`).all(tenant) as { product_id: number }[]).map(r => r.product_id));
  const subtotals = new Map<string, number>();
  const historyByProduct = new Map<number, HistoryLine[]>();
  for (const l of lines) {
    const key = `${l.source}:${l.id}`;
    subtotals.set(key, (subtotals.get(key) ?? 0) + lineNet(l.unit_price, l.quantity, l.discount_type, l.discount_value));
    const history = historyByProduct.get(l.product_id) ?? [];
    history.push(l);
    historyByProduct.set(l.product_id, history);
  }
  const categories = new Map<string, { category: string; value: number; cogs: number; grossMargin: number }>();
  const suppliers = new Map<string, { supplierId: number | null; supplier: string | null; value: number }>();
  const cutoff = now.getTime() - 365 * 86400000;
  const items = products.map(p => {
    const history = historyByProduct.get(p.id) ?? [];
    const purchases = history.filter(l => l.type === 'purchase');
    const sales = history.filter(l => l.type === 'sale');
    const lastPurchase = purchases[purchases.length - 1];
    const lastSale: string | null = sales[sales.length - 1]?.created_at ?? null;
    const value = Math.max(0, p.stock) * (p.cost ?? 0);
    const category = p.category || '';
    const group = categories.get(category) ?? { category, value: 0, cogs: 0, grossMargin: 0 };
    group.value += value;
    for (const l of history) {
      if (l.type === 'purchase' || timestamp(l.created_at) < cutoff) continue;
      const subtotal = subtotals.get(`${l.source}:${l.id}`) ?? 0;
      const net = lineNet(l.unit_price, l.quantity, l.discount_type, l.discount_value);
      const revenue = net * (subtotal > 0 ? 1 - globalDiscountAmount(subtotal, l.tx_discount_type, l.tx_discount_value) / subtotal : 0);
      const cogs = l.quantity * (l.unit_cost ?? p.cost ?? 0);
      const sign = l.type === 'refund' ? -1 : 1;
      group.cogs += sign * cogs;
      group.grossMargin += sign * (revenue - cogs);
    }
    categories.set(category, group);
    const supplierId: number | null = lastPurchase?.stakeholder_id ?? null;
    const supplierKey = String(supplierId);
    const supplier = suppliers.get(supplierKey) ?? { supplierId, supplier: lastPurchase?.supplier ?? null, value: 0 };
    supplier.value += value;
    suppliers.set(supplierKey, supplier);
    const sold = sales.reduce((n, l) => n + l.quantity, 0) - history.filter(l => l.type === 'refund').reduce((n, l) => n + l.quantity, 0);
    const purchased = purchases.reduce((n, l) => n + l.quantity, 0);
    const cause = adjustments.has(p.id) ? 'manual' : sold > 0 && purchased === 0 ? 'never' : sold > purchased ? 'oversold' : 'manual';
    // Never sold: age from the first purchase, so stock bought last week isn't "dead" yet.
    // No history at all (opening/imported stock) stays null and counts as dead.
    const since = lastSale ?? purchases[0]?.created_at ?? null;
    const daysSinceSale = since === null ? null : Math.floor((now.getTime() - timestamp(since)) / 86400000);
    return { ...p, value, lastSale, daysSinceSale, cause };
  });
  return {
    asOf, totalValue: items.reduce((n, p) => n + p.value, 0),
    categories: [...categories.values()].map(c => ({ ...c, turns: c.value > 0 ? c.cogs / c.value : null, gmroi: c.value > 0 ? c.grossMargin / c.value : null })),
    suppliers: [...suppliers.values()],
    deadStock: [60, 90].map(days => {
      const rows = items.filter(p => p.stock > 0 && (p.daysSinceSale === null || p.daysSinceSale >= days));
      return { days, value: rows.reduce((n, p) => n + p.value, 0), items: rows };
    }),
    negatives: ['never', 'oversold', 'manual'].map(cause => ({ cause, items: items.filter(p => p.stock < 0 && p.cause === cause) })),
  };
}

export type InventoryHealthReport = ReturnType<typeof readInventoryHealth>;

export function inventoryHealthHandler(db: Database.Database) {
  return (req: any, res: any) => {
    try { res.json(readInventoryHealth(db, req.session.tenantId)); }
    catch (error) { console.error('[inventory-health]', error); res.status(500).json({ error: 'Inventory health unavailable' }); }
  };
}
