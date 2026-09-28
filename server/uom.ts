// Units of measure (packs, cartons...) — DB helpers shared by server/routes.ts, server/invoiceEdit.ts
// and server/importer.ts. See docs/plans/2026-09-28-units-of-measure.md.
//
// INVARIANT: transaction_items.quantity is always in BASE PIECES and unit_price / unit_cost are
// always per base piece. A unit line additionally snapshots uom_id / uom_name / uom_factor / uom_qty
// (uom_qty = quantity in the line's own unit) so every stock / WAC / COGS / report query keeps
// working unchanged.
import { db } from "./db.js";
import { ValidationError } from "./errors.js";

export interface ProductUnit {
  id: number;
  product_id: number;
  name: string;
  factor: number;
  barcode: string | null;
  price: number;
  price_lbp: number | null;
  price_wholesale: number | null;
  price_wholesale_lbp: number | null;
  price_super_wholesale: number | null;
  price_super_wholesale_lbp: number | null;
  sort_order: number;
}

const UNIT_COLS = "id, product_id, name, factor, barcode, price, price_lbp, price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, sort_order";

// All live units of a tenant in ONE query, grouped by product (no N+1 in the product list).
export function loadUnitsByProduct(tenantId: number): Map<number, ProductUnit[]> {
  const rows = db.prepare(
    `SELECT ${UNIT_COLS} FROM product_units WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY product_id, sort_order, factor, id`
  ).all(tenantId) as ProductUnit[];
  const map = new Map<number, ProductUnit[]>();
  for (const r of rows) {
    const list = map.get(r.product_id);
    if (list) list.push(r); else map.set(r.product_id, [r]);
  }
  return map;
}

export function loadUnitsForProduct(tenantId: number, productId: number): ProductUnit[] {
  return db.prepare(
    `SELECT ${UNIT_COLS} FROM product_units WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL ORDER BY sort_order, factor, id`
  ).all(tenantId, productId) as ProductUnit[];
}

// A live unit that belongs to this product AND tenant, or null.
export function loadUnit(tenantId: number, productId: number, unitId: any): ProductUnit | null {
  const id = Number(unitId);
  if (!Number.isInteger(id)) return null;
  return (db.prepare(
    `SELECT ${UNIT_COLS} FROM product_units WHERE id = ? AND product_id = ? AND tenant_id = ? AND deleted_at IS NULL`
  ).get(id, productId, tenantId) as ProductUnit) || null;
}

export interface NormalizedUnit {
  id: number | null;
  name: string;
  factor: number;
  barcode: string | null;
  price: number;
  price_lbp: number | null;
  price_wholesale: number | null;
  price_wholesale_lbp: number | null;
  price_super_wholesale: number | null;
  price_super_wholesale_lbp: number | null;
}

const optPrice = (v: any): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Validates a `units` payload (name, factor > 1, price > 0, unique factors). Barcode uniqueness is
// checked separately (assertBarcodesFree) because it needs the product's own barcodes too.
export function normalizeUnitsPayload(units: any): NormalizedUnit[] {
  if (!Array.isArray(units)) throw new ValidationError("units must be an array.", 400, { code: 'UOM_INVALID', field: 'units' });
  const out: NormalizedUnit[] = [];
  units.forEach((u: any, i: number) => {
    const name = String(u?.name ?? '').trim();
    if (!name) throw new ValidationError("Each unit needs a name.", 400, { code: 'UOM_NAME_REQUIRED', field: `units.${i}.name` });
    const factor = Number(u?.factor);
    if (!(Number.isFinite(factor) && factor > 1)) {
      throw new ValidationError(`Unit "${name}" must contain more than 1 base unit.`, 400, { code: 'UOM_FACTOR_INVALID', field: `units.${i}.factor` });
    }
    if (out.some((o) => Math.abs(o.factor - factor) < 1e-9)) {
      throw new ValidationError(`Two units of the same product can't contain the same quantity (${factor}).`, 400, { code: 'UOM_FACTOR_DUPLICATE', field: `units.${i}.factor` });
    }
    const price = Number(u?.price);
    if (!(Number.isFinite(price) && price > 0)) {
      throw new ValidationError(`Unit "${name}" needs a price greater than 0.`, 400, { code: 'UOM_PRICE_REQUIRED', field: `units.${i}.price` });
    }
    const barcode = String(u?.barcode ?? '').trim() || null;
    out.push({
      id: Number.isInteger(Number(u?.id)) && Number(u?.id) > 0 ? Number(u.id) : null,
      name, factor, barcode, price,
      price_lbp: optPrice(u?.price_lbp),
      price_wholesale: optPrice(u?.price_wholesale),
      price_wholesale_lbp: optPrice(u?.price_wholesale_lbp),
      price_super_wholesale: optPrice(u?.price_super_wholesale),
      price_super_wholesale_lbp: optPrice(u?.price_super_wholesale_lbp),
    });
  });
  return out;
}

// True when `barcode` is already used by ANOTHER product in this tenant: as its primary barcode, as
// one of its extra barcodes (product_barcodes is UNIQUE across the whole database, so that check is
// not tenant-scoped), or as a live unit barcode. `excludeProductId` (-1 on create) skips the
// product being saved so it can keep its own barcodes.
export function barcodeUsedElsewhere(tenantId: number, barcode: string, excludeProductId: number): boolean {
  if (db.prepare("SELECT 1 FROM products WHERE tenant_id = ? AND barcode = ? AND id != ? LIMIT 1").get(tenantId, barcode, excludeProductId)) return true;
  if (db.prepare("SELECT 1 FROM product_barcodes WHERE barcode = ? AND product_id != ? LIMIT 1").get(barcode, excludeProductId)) return true;
  if (db.prepare("SELECT 1 FROM product_units WHERE tenant_id = ? AND barcode = ? AND product_id != ? AND deleted_at IS NULL LIMIT 1").get(tenantId, barcode, excludeProductId)) return true;
  return false;
}

// Throws BARCODE_TAKEN (409) when a barcode repeats inside the payload or is used elsewhere in the
// tenant. `ownBarcodes` are the product's primary + extra barcodes (field `barcodes`), then each
// unit barcode (field `units.<i>.barcode`).
export function assertBarcodesFree(tenantId: number, productId: number | null, ownBarcodes: string[], units: NormalizedUnit[]) {
  const exclude = productId ?? -1;
  const seen = new Set<string>();
  const check = (barcode: string, field: string) => {
    if (seen.has(barcode) || barcodeUsedElsewhere(tenantId, barcode, exclude)) {
      throw new ValidationError(`Barcode "${barcode}" is already used by another product or unit.`, 409, { code: 'BARCODE_TAKEN', field, barcode });
    }
    seen.add(barcode);
  };
  for (const b of ownBarcodes) check(b, 'barcodes');
  units.forEach((u, i) => { if (u.barcode) check(u.barcode, `units.${i}.barcode`); });
}

// Upserts a product's units to match the payload: rows with a known id are updated in place (so
// their sync global_id is stable), new ones inserted, and live units missing from the payload are
// SOFT-deleted. Returns the saved units.
export function saveProductUnits(tenantId: number, productId: number, units: NormalizedUnit[]): ProductUnit[] {
  const existing = loadUnitsForProduct(tenantId, productId);
  const existingIds = new Set(existing.map((u) => u.id));
  const keep = new Set<number>();
  const update = db.prepare(`UPDATE product_units SET name = ?, factor = ?, barcode = ?, price = ?, price_lbp = ?, price_wholesale = ?, price_wholesale_lbp = ?, price_super_wholesale = ?, price_super_wholesale_lbp = ?, sort_order = ? WHERE id = ? AND product_id = ? AND tenant_id = ?`);
  const insert = db.prepare(`INSERT INTO product_units (tenant_id, product_id, name, factor, barcode, price, price_lbp, price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  units.forEach((u, i) => {
    const vals = [u.name, u.factor, u.barcode, u.price, u.price_lbp, u.price_wholesale, u.price_wholesale_lbp, u.price_super_wholesale, u.price_super_wholesale_lbp, i];
    if (u.id && existingIds.has(u.id) && !keep.has(u.id)) {
      update.run(...vals, u.id, productId, tenantId);
      keep.add(u.id);
    } else {
      insert.run(tenantId, productId, ...vals);
    }
  });
  const softDelete = db.prepare("UPDATE product_units SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?");
  for (const u of existing) if (!keep.has(u.id)) softDelete.run(u.id, tenantId);
  return loadUnitsForProduct(tenantId, productId);
}

// Older devices and the cloud only know package_price / units_per_package: mirror the smallest unit
// there (or clear them when the product has no units).
export function legacyPackageColumns(units: Array<{ factor: number; price: number; price_lbp?: number | null }>) {
  if (!units.length) return { package_price: null, package_price_lbp: null, units_per_package: 1 };
  const smallest = units.reduce((a, b) => (b.factor < a.factor ? b : a));
  return { package_price: smallest.price, package_price_lbp: smallest.price_lbp ?? null, units_per_package: smallest.factor };
}

// ---------------------------------------------------------------------------
// Refunds — per original sale LINE
// ---------------------------------------------------------------------------

export interface RefundLineState {
  item: any;          // the original sale line (transaction_items / archived_transaction_items row)
  refunded: number;   // base pieces already refunded against this line
  remaining: number;  // base pieces still refundable
}

// Pieces already refunded against each line of an original sale, across live AND archived refunds.
// Refund rows that carry `original_item_id` (pointing at one of these lines) count against exactly
// that line. Legacy refund rows (no original_item_id — old clients — or one pointing at a line an
// invoice edit has since replaced) count against their PRODUCT and are allocated to that product's
// lines in id order.
export function refundLineStates(tenantId: number, originalTransactionId: number, items: any[]): RefundLineState[] {
  const rows = db.prepare(`
    SELECT ti.product_id, ti.original_item_id, SUM(ti.quantity) as qty
    FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'refund' AND t.original_transaction_id = ?
    GROUP BY ti.product_id, ti.original_item_id
    UNION ALL
    SELECT ti.product_id, ti.original_item_id, SUM(ti.quantity) as qty
    FROM archived_transaction_items ti JOIN archived_transactions t ON ti.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'refund' AND t.original_transaction_id = ?
    GROUP BY ti.product_id, ti.original_item_id
  `).all(tenantId, originalTransactionId, tenantId, originalTransactionId) as any[];

  const sorted = [...items].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const states: RefundLineState[] = sorted.map((item) => ({ item, refunded: 0, remaining: item.quantity }));
  const byId = new Map(states.map((s) => [s.item.id, s]));
  const legacyByProduct = new Map<number, number>();
  for (const r of rows) {
    const line = r.original_item_id != null ? byId.get(r.original_item_id) : undefined;
    if (line && line.item.product_id === r.product_id) line.refunded += r.qty || 0;
    else legacyByProduct.set(r.product_id, (legacyByProduct.get(r.product_id) || 0) + (r.qty || 0));
  }
  for (const [productId, legacyQty] of legacyByProduct) {
    let left = legacyQty;
    for (const s of states) {
      if (s.item.product_id !== productId || left <= 1e-9) continue;
      const take = Math.min(left, Math.max(0, s.item.quantity - s.refunded));
      s.refunded += take;
      left -= take;
    }
  }
  for (const s of states) s.remaining = Math.max(0, s.item.quantity - s.refunded);
  return states;
}

// Detail-shape helpers: a line's quantity/price expressed in its own unit.
export function displayFields(item: any) {
  const factor = item.uom_factor || 1;
  return {
    display_qty: item.uom_qty ?? item.quantity,
    // rounded to 6 decimals only to strip float noise (per-piece × factor, e.g. 32.400000000000006)
    display_unit_price: Math.round(item.unit_price * factor * 1e6) / 1e6,
  };
}
