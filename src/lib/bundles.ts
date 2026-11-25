// Client helpers for product bundles (the shared price math lives in src/lib/pricing.ts).
import type { Product } from '../types';
import { groupBundleLines } from './pricing';

/**
 * How many bundles the components' stock covers: the lowest stock / quantity over the components
 * that track inventory (live stock from `productsById` when given, else the bundle's snapshot).
 * `usedPieces(componentId)` subtracts pieces already in the cart. Infinity when no component
 * tracks stock.
 */
export function bundleAvailability(
  bundle: Pick<Product, 'bundle_items'>,
  productsById?: Map<number, Product>,
  usedPieces?: (componentId: number) => number,
): number {
  let available = Infinity;
  for (const it of bundle.bundle_items || []) {
    const live = productsById?.get(it.component_id);
    const track = live ? live.track_inventory : it.track_inventory;
    if (track === 0) continue;
    const stock = Number(live ? live.stock : it.stock) || 0;
    const free = stock - (usedPieces ? usedPieces(it.component_id) : 0);
    const n = it.quantity > 0 ? Math.floor((free / it.quantity) * 1000 + 1e-6) / 1000 : Infinity;
    available = Math.min(available, Math.floor(n + 1e-9));
  }
  return Math.max(0, available);
}

/** "2 Coffee + 1 Croissant" for a bundle's contents. */
export function bundleContentsLabel(bundle: Pick<Product, 'bundle_items'>, productsById?: Map<number, Product>): string {
  return (bundle.bundle_items || [])
    .map((it) => `${Math.round(it.quantity * 1000) / 1000} ${productsById?.get(it.component_id)?.name ?? it.name ?? ''}`.trim())
    .join(' + ');
}

/**
 * Display rows for a stored invoice: the component rows of each sold bundle collapse into ONE row
 * shaped like an ordinary line (product_name, quantity, unit_price per bundle, discount), with
 * `bundle_contents` ("2 x Coffee") for a sub-line. Ordinary rows pass through unchanged.
 */
export function collapseBundleRows<T extends Record<string, any>>(items: T[]): Array<T & { is_bundle_group?: boolean; bundle_contents?: string[] }> {
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  return groupBundleLines((items || []) as any[]).map((entry: any) => {
    if (entry.kind === 'item') return entry.row;
    const first = entry.components[0]?.row || {};
    const gross = entry.unit_price * entry.bundle_qty;
    const discount = first.discount_value
      ? (first.discount_type === 'percentage'
        ? { type: 'percentage', value: Number(first.discount_value) }
        : { type: 'fixed', value: Math.round((gross - entry.line_total) * 1e6) / 1e6 })
      : undefined;
    return {
      ...first,
      id: `bundle-${entry.bundle_line}-${first.id ?? ''}`,
      product_id: entry.bundle_id,
      product_name: entry.bundle_name,
      name: entry.bundle_name,
      barcode: null,
      quantity: entry.bundle_qty,
      display_qty: entry.bundle_qty,
      unit_price: entry.unit_price,
      price: entry.unit_price,
      display_unit_price: entry.unit_price,
      uom_id: null, uom_name: null, uom_factor: null, uom_qty: null,
      discount,
      discount_type: discount?.type ?? null,
      discount_value: discount?.value ?? null,
      line_total: entry.line_total,
      // cost of ONE bundle from its components' cost snapshots (quantity x unit_cost = the group's COGS)
      unit_cost: entry.bundle_qty > 0
        ? entry.components.reduce((s: number, c: any) => s + (Number(c.row.unit_cost) || 0) * (Number(c.row.quantity) || 0), 0) / entry.bundle_qty
        : 0,
      is_bundle_group: true,
      bundle_contents: entry.components.map((c: any) => `${fmt(c.row.quantity)} x ${c.row.product_name || c.row.name || ''}`),
    };
  });
}

export interface RefundBundleLine {
  item_id: number;
  remaining_qty: number;
  bundle_line?: number | null;
  bundle_name?: string | null;
  bundle_comp_qty?: number | null;
}

/** Refund dialogs: the lines of one sold bundle, how many whole bundles are still refundable, and
 *  how many whole bundles the current per-line quantities amount to. */
export function refundBundleGroup<L extends RefundBundleLine>(lines: L[], line: L, qty: Record<number, number>) {
  const members = lines.filter((l) => l.bundle_line != null && l.bundle_line === line.bundle_line);
  const per = (l: L) => Number(l.bundle_comp_qty) || 0;
  const maxBundles = members.length
    ? Math.min(...members.map((l) => (per(l) > 0 ? Math.floor(l.remaining_qty / per(l) + 1e-9) : 0)))
    : 0;
  const selected = members.length
    ? Math.min(...members.map((l) => (per(l) > 0 ? Math.floor((qty[l.item_id] || 0) / per(l) + 1e-9) : 0)))
    : 0;
  return { members, maxBundles, selected, isFirst: members[0]?.item_id === line.item_id };
}

/** Per-line quantities for refunding `n` whole bundles of the group (each line: n x its pieces per bundle). */
export function refundBundleQuantities<L extends RefundBundleLine>(members: L[], n: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (const l of members) out[l.item_id] = Math.min(l.remaining_qty, Math.round(n * (Number(l.bundle_comp_qty) || 0) * 1e6) / 1e6);
  return out;
}
