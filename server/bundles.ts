// Product bundles — DB helpers shared by server/routes.ts (product editor + checkout + refunds) and
// server/invoiceEdit.ts. See docs/superpowers/specs/2026-11-26-product-bundles-design.md.
//
// INVARIANT: a bundle never appears in transaction_items. A sold bundle is stored as one row per
// component (product_id = the component, quantity in its base pieces, unit_price = its share of the
// bundle price per piece, unit_cost = the component's cost), each carrying the bundle snapshot
// (bundle_id / bundle_name / bundle_qty / bundle_line). Every stock, COGS, report and OR query keeps
// reading ordinary component lines.
import { db } from "./db.js";
import { ValidationError } from "./errors.js";
import { bundleShares } from "./pricing.js";

export interface BundleItem {
  id: number;
  bundle_id: number;
  component_id: number;
  quantity: number;
  sort_order: number;
  // component snapshot (current values, for the editor / POS availability)
  name: string | null;
  barcode: string | null;
  price: number | null;
  price_lbp: number | null;
  cost: number | null;
  stock: number | null;
  track_inventory: number | null;
  active: number | null;
  unit: string | null;
  category: string | null;
}

const ITEM_SELECT = `
  SELECT bi.id, bi.bundle_id, bi.component_id, bi.quantity, bi.sort_order,
         p.name, p.barcode, p.price, p.price_lbp, p.cost, p.stock, p.track_inventory, p.active, p.unit, p.category
  FROM product_bundle_items bi
  LEFT JOIN products p ON p.id = bi.component_id AND p.tenant_id = bi.tenant_id
  WHERE bi.tenant_id = ? AND bi.deleted_at IS NULL`;

/** All live bundle rows of a tenant in ONE query, grouped by bundle. */
export function loadBundleItemsByBundle(tenantId: number): Map<number, BundleItem[]> {
  const rows = db.prepare(`${ITEM_SELECT} ORDER BY bi.bundle_id, bi.sort_order, bi.id`).all(tenantId) as BundleItem[];
  const map = new Map<number, BundleItem[]>();
  for (const r of rows) {
    const list = map.get(r.bundle_id);
    if (list) list.push(r); else map.set(r.bundle_id, [r]);
  }
  return map;
}

export function loadBundleItems(tenantId: number, bundleId: number): BundleItem[] {
  return db.prepare(`${ITEM_SELECT} AND bi.bundle_id = ? ORDER BY bi.sort_order, bi.id`).all(tenantId, bundleId) as BundleItem[];
}

export interface NormalizedBundleItem { component_id: number; quantity: number }

/**
 * Validates a `bundle_items` payload for bundle `bundleId` (null on create): at least one component,
 * each one a product of this tenant that is not itself a bundle (no nesting) nor the bundle, listed
 * once, with a quantity > 0.
 */
export function normalizeBundlePayload(tenantId: number, bundleId: number | null, payload: any): NormalizedBundleItem[] {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new ValidationError("A bundle needs at least one product.", 400, { code: 'BUNDLE_EMPTY', field: 'bundle_items' });
  }
  const out: NormalizedBundleItem[] = [];
  const product = db.prepare("SELECT id, IFNULL(is_bundle, 0) AS is_bundle FROM products WHERE id = ? AND tenant_id = ?");
  payload.forEach((it: any, i: number) => {
    const componentId = Number(it?.component_id);
    const row = Number.isInteger(componentId) ? product.get(componentId, tenantId) as any : null;
    if (!row) {
      throw new ValidationError("This product no longer exists.", 400, { code: 'BUNDLE_COMPONENT_MISSING', field: `bundle_items.${i}.component_id` });
    }
    if (bundleId != null && componentId === bundleId) {
      throw new ValidationError("A bundle can't contain itself.", 400, { code: 'BUNDLE_SELF', field: `bundle_items.${i}.component_id` });
    }
    if (row.is_bundle) {
      throw new ValidationError("A bundle can't contain another bundle.", 400, { code: 'BUNDLE_NESTED', field: `bundle_items.${i}.component_id` });
    }
    if (out.some((o) => o.component_id === componentId)) {
      throw new ValidationError("This product is already in the bundle.", 400, { code: 'BUNDLE_DUPLICATE_COMPONENT', field: `bundle_items.${i}.component_id` });
    }
    const quantity = Number(it?.quantity);
    if (!(Number.isFinite(quantity) && quantity > 0)) {
      throw new ValidationError("Enter a quantity greater than 0.", 400, { code: 'BUNDLE_QTY_INVALID', field: `bundle_items.${i}.quantity` });
    }
    out.push({ component_id: componentId, quantity });
  });
  return out;
}

/** True when the product is a component of some live bundle (so it can't become a bundle itself). */
export function isBundleComponent(tenantId: number, productId: number): boolean {
  return !!db.prepare("SELECT 1 FROM product_bundle_items WHERE tenant_id = ? AND component_id = ? AND deleted_at IS NULL LIMIT 1").get(tenantId, productId);
}

/**
 * Makes the bundle's live rows match `items`: a row for a component already in the bundle is
 * updated in place (stable sync global_id), new components are inserted, removed ones SOFT-deleted.
 */
export function saveBundleItems(tenantId: number, bundleId: number, items: NormalizedBundleItem[]) {
  const existing = db.prepare("SELECT id, component_id FROM product_bundle_items WHERE tenant_id = ? AND bundle_id = ? AND deleted_at IS NULL")
    .all(tenantId, bundleId) as Array<{ id: number; component_id: number }>;
  const byComponent = new Map(existing.map((r) => [r.component_id, r.id]));
  const keep = new Set<number>();
  const update = db.prepare("UPDATE product_bundle_items SET quantity = ?, sort_order = ? WHERE id = ? AND tenant_id = ?");
  const insert = db.prepare("INSERT INTO product_bundle_items (tenant_id, bundle_id, component_id, quantity, sort_order) VALUES (?, ?, ?, ?, ?)");
  items.forEach((it, i) => {
    const id = byComponent.get(it.component_id);
    if (id != null && !keep.has(id)) {
      update.run(it.quantity, i, id, tenantId);
      keep.add(id);
    } else {
      insert.run(tenantId, bundleId, it.component_id, it.quantity, i);
    }
  });
  const softDelete = db.prepare("UPDATE product_bundle_items SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?");
  for (const r of existing) if (!keep.has(r.id)) softDelete.run(r.id, tenantId);
}

export function clearBundleItems(tenantId: number, bundleId: number) {
  db.prepare("UPDATE product_bundle_items SET deleted_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND bundle_id = ? AND deleted_at IS NULL").run(tenantId, bundleId);
}

export interface ExpandedBundleRow {
  productId: number;
  pieces: number;
  unitPrice: number;
  discountType: string | null;
  discountValue: number | null;
  unitCost: number | null;
  trackInventory: number;
  /** current component row (price / cost / stock / track_inventory) */
  product: any;
  bundleId: number;
  bundleName: string;
  bundleQty: number;
  bundleLine: number;
}

export interface BundleSaleInput {
  bundleId: number;
  bundleName: string;
  /** bundles sold on this line */
  bundleQty: number;
  /** price of ONE bundle, USD, before the line discount */
  perBundle: number;
  discountType?: string | null;
  discountValue?: number | null;
  /** group key: the bundle's 1-based position in the sale */
  line: number;
  /** request position, for error fields */
  idx: number;
  /** unit_cost override per component (invoice edit keeps the cost the line was sold at) */
  costFor?: (componentId: number) => number | null | undefined;
}

/**
 * Expands one sold bundle line into its component rows. The bundle price is split over the
 * components by list price (bundleShares); a percentage line discount is copied to every row, a
 * fixed one is split by the same shares, so the rows' line totals add up to the bundle line total.
 */
export function expandBundleSale(tenantId: number, input: BundleSaleInput): ExpandedBundleRow[] {
  const items = loadBundleItems(tenantId, input.bundleId);
  if (!items.length) {
    throw new ValidationError(`Bundle ${input.bundleId} has no products.`, 400, { code: 'BUNDLE_EMPTY', field: `items.${input.idx}.id`, product_id: input.bundleId });
  }
  const missing = items.find((it) => it.name == null);
  if (missing) {
    throw new ValidationError(`A product of bundle ${input.bundleId} no longer exists.`, 400, { code: 'BUNDLE_COMPONENT_MISSING', field: `items.${input.idx}.id`, product_id: input.bundleId });
  }
  const shares = bundleShares(items.map((it) => ({ listPrice: Number(it.price) || 0, quantity: it.quantity })));
  const fixed = input.discountType === 'fixed' && input.discountValue ? Number(input.discountValue) : 0;
  return items.map((it, i) => {
    const pieces = it.quantity * input.bundleQty;
    const unitPrice = (input.perBundle * shares[i]) / it.quantity;
    let discountType: string | null = null;
    let discountValue: number | null = null;
    if (input.discountValue) {
      if (input.discountType === 'percentage') { discountType = 'percentage'; discountValue = Number(input.discountValue); }
      else { discountType = 'fixed'; discountValue = fixed * shares[i]; }
    }
    const override = input.costFor ? input.costFor(it.component_id) : undefined;
    return {
      productId: it.component_id,
      pieces,
      unitPrice,
      discountType,
      discountValue,
      unitCost: override !== undefined ? override ?? null : (it.cost ?? null),
      trackInventory: it.track_inventory === 0 ? 0 : 1,
      product: it,
      bundleId: input.bundleId,
      bundleName: input.bundleName,
      bundleQty: input.bundleQty,
      bundleLine: input.line,
    };
  });
}

/** USD cost of the components of ONE bundle (for the below-cost guard). */
export function bundleUnitCost(rows: ExpandedBundleRow[]): number {
  return rows.reduce((s, r) => s + (Number(r.unitCost) || 0) * (r.pieces / (r.bundleQty || 1)), 0);
}
