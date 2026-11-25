// Pure pricing math shared by POST /api/transactions and PUT /api/transactions/:id (server/invoiceEdit.ts).
// No DB access here on purpose — these are simple, directly-testable functions; callers pass in
// whatever product/settings data they already loaded.

export type PriceLevel = 'retail' | 'wholesale' | 'super_wholesale';

// Anything that isn't a recognized tier collapses to 'retail' — this is also the fallback used
// when a stakeholder/settings default is missing or garbled.
export function normalizeLevel(x: any): PriceLevel {
  return x === 'wholesale' || x === 'super_wholesale' ? x : 'retail';
}

export interface TierProduct {
  price: number;
  price_wholesale?: number | null;
  price_super_wholesale?: number | null;
  package_price?: number | null;
  units_per_package?: number | null;
  // LBP (local currency) columns - only read by the *Lbp functions below.
  price_lbp?: number | null;
  package_price_lbp?: number | null;
  price_wholesale_lbp?: number | null;
  price_super_wholesale_lbp?: number | null;
}

// USD unit price for a given price level, USD tier chain (super_wholesale falls back to
// wholesale, then to retail). A tier value only counts when actually set — NULL/0 means "not
// configured for this product", not "free".
// Retail-tier parity: the online store's public price (cloud function store_public_listings in
// supabase/migrations/2026-10-18_commerce_store_foundation.sql) mirrors the RETAIL branch of this and
// uomUnitPrice — product.price / product_units.price. Change one, change the other.
export function tierUnitPrice(product: TierProduct, level: PriceLevel): number {
  if (level === 'super_wholesale') {
    if (product.price_super_wholesale && product.price_super_wholesale > 0) return product.price_super_wholesale;
    if (product.price_wholesale && product.price_wholesale > 0) return product.price_wholesale;
    return product.price;
  }
  if (level === 'wholesale') {
    if (product.price_wholesale && product.price_wholesale > 0) return product.price_wholesale;
    return product.price;
  }
  return product.price;
}

// Whether `level` has a genuinely configured tier price for this product, as opposed to silently
// falling back to retail. Package-price blending (below) is a retail-only concept, so a real tier
// price always wins as a flat per-unit price instead.
function hasRealTier(product: TierProduct, level: PriceLevel): boolean {
  if (level === 'super_wholesale') {
    return !!((product.price_super_wholesale && product.price_super_wholesale > 0) || (product.price_wholesale && product.price_wholesale > 0));
  }
  if (level === 'wholesale') {
    return !!(product.price_wholesale && product.price_wholesale > 0);
  }
  return false;
}

// A unit of measure (pack, carton...) of a product: `factor` base pieces per unit, with its own
// prices. Same shape as the product_units row.
export interface UomPricing {
  factor: number;
  price: number;
  price_lbp?: number | null;
  price_wholesale?: number | null;
  price_wholesale_lbp?: number | null;
  price_super_wholesale?: number | null;
  price_super_wholesale_lbp?: number | null;
}

const pos = (n: any): n is number => typeof n === 'number' && n > 0;

// Price of ONE unit of `uom` at a price level (USD). A value only counts when > 0. Chain:
//   retail:          uom.price
//   wholesale:       uom.price_wholesale -> product.price_wholesale * factor -> uom.price
//   super_wholesale: uom.price_super_wholesale -> product.price_super_wholesale * factor
//                    -> uom.price_wholesale -> product.price_wholesale * factor -> uom.price
export function uomUnitPrice(product: TierProduct, uom: UomPricing, level: PriceLevel): number {
  const f = uom.factor;
  if (level === 'super_wholesale') {
    if (pos(uom.price_super_wholesale)) return uom.price_super_wholesale;
    if (pos(product.price_super_wholesale)) return product.price_super_wholesale * f;
  }
  if (level === 'super_wholesale' || level === 'wholesale') {
    if (pos(uom.price_wholesale)) return uom.price_wholesale;
    if (pos(product.price_wholesale)) return product.price_wholesale * f;
  }
  return uom.price;
}

// LBP variant of the same chain, on the _lbp columns (product _lbp columns x factor). Each step
// falls back to its own USD value x rate before moving on to the next step.
export function uomUnitPriceLbp(
  product: TierProduct & { price_wholesale_lbp?: number | null; price_super_wholesale_lbp?: number | null },
  uom: UomPricing,
  level: PriceLevel,
  rate: number,
): number {
  const f = uom.factor;
  const step = (lbp: any, usd: number | null | undefined, mult: number) =>
    pos(lbp) ? lbp * mult : (pos(usd) ? usd * mult * rate : null);
  if (level === 'super_wholesale') {
    const a = step(uom.price_super_wholesale_lbp, uom.price_super_wholesale, 1);
    if (a !== null) return a;
    const b = step(product.price_super_wholesale_lbp, product.price_super_wholesale, f);
    if (b !== null) return b;
  }
  if (level === 'super_wholesale' || level === 'wholesale') {
    const a = step(uom.price_wholesale_lbp, uom.price_wholesale, 1);
    if (a !== null) return a;
    const b = step(product.price_wholesale_lbp, product.price_wholesale, f);
    if (b !== null) return b;
  }
  return step(uom.price_lbp, uom.price, 1) ?? uom.price * rate;
}

// Per-piece sale price for one BASE-PIECE line. A real (non-retail) tier price is flat, no pack
// breaking. Otherwise (retail) buying in whole units blends the unit price for full units with the
// per-piece price for the remainder: greedy, largest whole-number factor first, over `units`
// (e.g. pack6 = 1.10, carton24 = 4.00, 31 pcs = 1 carton + 1 pack + 1 piece). A product with no
// units but the legacy package_price / units_per_package uses that as a single unit.
export function saleLineUnitPrice(product: TierProduct, level: PriceLevel, quantity: number, units?: UomPricing[] | null): number {
  if (hasRealTier(product, level)) {
    return tierUnitPrice(product, level);
  }
  let breakUnits = (units || []).filter(u => u && Number.isInteger(u.factor) && u.factor > 1 && u.price > 0);
  if (!breakUnits.length) {
    const unitsPerPackage = product.units_per_package || 1;
    if (product.package_price && unitsPerPackage > 1) breakUnits = [{ factor: unitsPerPackage, price: product.package_price }];
  }
  if (breakUnits.length && quantity > 0) {
    breakUnits = [...breakUnits].sort((a, b) => b.factor - a.factor);
    let remaining = quantity;
    let total = 0;
    for (const u of breakUnits) {
      const n = Math.floor(remaining / u.factor);
      if (n > 0) { total += n * u.price; remaining -= n * u.factor; }
    }
    total += remaining * product.price;
    return total / quantity;
  }
  return product.price;
}

// ---- Local-currency (LBP) pricing: 1:1 mirror of src/lib/pricing.ts ------------------------------
// A cart priced in the local currency is charged from the LBP columns (price_lbp, falling back to
// USD x rate), so the server must price it the same way or total_amount drifts from what was paid.

/** Resolved flat tier price in USD, or null when the level falls through to retail/package pricing. */
function flatTierUnitPrice(product: TierProduct, level: PriceLevel): number | null {
  if (level === 'super_wholesale') {
    return (pos(product.price_super_wholesale) ? product.price_super_wholesale : null) ??
      (pos(product.price_wholesale) ? product.price_wholesale : null);
  }
  if (level === 'wholesale') return pos(product.price_wholesale) ? product.price_wholesale : null;
  return null;
}

/** Same resolution against the LBP tier columns, falling back to USD x rate when unset. */
export function tierUnitPriceLbp(product: TierProduct, level: PriceLevel, rate: number): number | null {
  if (level === 'super_wholesale') {
    const flat = (pos(product.price_super_wholesale_lbp) ? product.price_super_wholesale_lbp : null) ??
      (pos(product.price_wholesale_lbp) ? product.price_wholesale_lbp : null);
    if (flat != null) return flat;
    const usd = flatTierUnitPrice(product, level);
    return usd != null ? usd * rate : null;
  }
  if (level === 'wholesale') {
    const flat = pos(product.price_wholesale_lbp) ? product.price_wholesale_lbp : null;
    if (flat != null) return flat;
    const usd = flatTierUnitPrice(product, level);
    return usd != null ? usd * rate : null;
  }
  return null;
}

function retailBlendedUnitPriceLbp(product: TierProduct, qty: number, rate: number, units?: UomPricing[] | null): number {
  const unitLbp = product.price_lbp || product.price * rate;
  let bu: UomPricing[] = (units || []).filter(u => u && Number.isInteger(u.factor) && u.factor > 1 && u.price > 0);
  if (bu.length > 0) bu = [...bu].sort((x, y) => y.factor - x.factor);
  else {
    const upp = product.units_per_package || 1;
    if (product.package_price && product.package_price > 0 && upp > 1 && Number.isInteger(upp)) {
      bu = [{ factor: upp, price: product.package_price, price_lbp: product.package_price_lbp }];
    }
  }
  if (bu.length && qty > 0) {
    let remaining = qty;
    let total = 0;
    for (const u of bu) {
      const n = Math.floor(remaining / u.factor);
      const uLbp = pos(u.price_lbp) ? u.price_lbp : u.price * rate;
      total += n * uLbp;
      remaining -= n * u.factor;
    }
    total += remaining * unitLbp;
    return total / qty;
  }
  return unitLbp;
}

/** Per-piece LBP price for a base-piece sale line at the given qty/level (pack break included for retail). */
export function saleLineUnitPriceLbp(product: TierProduct, level: PriceLevel, qty: number, rate: number, units?: UomPricing[] | null): number {
  const flat = tierUnitPriceLbp(product, level, rate);
  if (flat != null) return flat;
  return retailBlendedUnitPriceLbp(product, qty, rate, units);
}

export interface LineAdjustment {
  type?: 'percentage' | 'fixed' | null;
  value?: number | null;
}

// Total for one line after its own per-line discount (the cart's "DISC" control) — exactly the
// existing POST /api/transactions math: percentage scales the line, fixed subtracts a flat USD
// amount and floors at 0.
export function lineTotal(unitPrice: number, quantity: number, discount?: LineAdjustment | null): number {
  let total = unitPrice * quantity;
  if (discount?.value) {
    total = discount.type === 'percentage'
      ? total * (1 - discount.value / 100)
      : Math.max(0, total - discount.value);
  }
  return total;
}

// Applies the whole-sale global discount (clamped to the subtotal) then tax, exactly the existing
// POST /api/transactions math, and floors the result at 0. `lineTotals` are the already-discounted
// per-line totals (from `lineTotal` above) — this only applies the invoice-level adjustments.
export function computeTotals(lineTotals: number[], discount?: LineAdjustment | null, tax?: LineAdjustment | null): number {
  const calculatedTotal = lineTotals.reduce((sum, t) => sum + t, 0);
  let finalTotal = calculatedTotal;

  if (discount?.type === 'percentage') finalTotal -= (calculatedTotal * ((discount.value || 0) / 100));
  else if (discount?.type === 'fixed') finalTotal -= Math.min(discount.value || 0, calculatedTotal);

  if (tax?.type === 'percentage') finalTotal += (finalTotal * ((tax.value || 0) / 100));
  else if (tax?.type === 'fixed') finalTotal += (tax.value || 0);

  // Rounded to 6 decimals only to strip float noise: unit lines are stored per piece, so e.g. a
  // 32.40 carton comes back as 1.35 x 24 = 32.400000000000006, which would otherwise read as a
  // sub-cent balance still owed against an exact payment.
  return Math.max(0, Math.round(finalTotal * 1e6) / 1e6);
}

// ---- Bundles: BYTE-IDENTICAL in server/pricing.ts and src/lib/pricing.ts ------------------------
// (tests/product-bundles.test.ts compares the text between these markers). A bundle sale is stored
// as one transaction_items row per component; these helpers split the bundle price over the
// components and group the rows back into one display line.
// BEGIN BUNDLE MATH

export interface BundleComponentPrice {
  /** The component's retail list price for ONE base piece. */
  listPrice: number;
  /** Base pieces of the component in ONE bundle. */
  quantity: number;
}

/**
 * Share of the bundle price each component carries, in proportion to its list value
 * (list price x quantity). When every list price is 0 the split is by quantity instead.
 * The shares sum to exactly 1 (the last component takes the rounding remainder).
 */
export function bundleShares(components: BundleComponentPrice[]): number[] {
  if (!components.length) return [];
  const num = (n: any) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
  let weights = components.map((c) => num(c.listPrice) * num(c.quantity));
  let total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) {
    weights = components.map((c) => num(c.quantity));
    total = weights.reduce((s, w) => s + w, 0);
  }
  if (total <= 0) {
    weights = components.map(() => 1);
    total = components.length;
  }
  const shares = weights.map((w) => w / total);
  const head = shares.slice(0, -1).reduce((s, x) => s + x, 0);
  shares[shares.length - 1] = 1 - head;
  return shares;
}

/** Splits `amount` by the shares above; the parts sum back to `amount` exactly. */
export function allocateBundleAmount(amount: number, components: BundleComponentPrice[]): number[] {
  const shares = bundleShares(components);
  const parts = shares.map((s) => amount * s);
  if (parts.length) {
    const head = parts.slice(0, -1).reduce((s, x) => s + x, 0);
    parts[parts.length - 1] = amount - head;
  }
  return parts;
}

/** Sum of the components' list prices for one bundle, and what the customer saves vs. the bundle price. */
export function bundleSaving(bundlePrice: number, components: BundleComponentPrice[]): { listTotal: number; saving: number } {
  const listTotal = components.reduce((s, c) => s + (Number(c.listPrice) || 0) * (Number(c.quantity) || 0), 0);
  return { listTotal, saving: listTotal - (Number(bundlePrice) || 0) };
}

export interface BundleLineRow {
  quantity: number;
  unit_price: number;
  discount_type?: string | null;
  discount_value?: number | null;
  bundle_id?: number | null;
  bundle_name?: string | null;
  bundle_qty?: number | null;
  bundle_line?: number | null;
}

export type BundleDisplayLine<T extends BundleLineRow> =
  | { kind: 'item'; row: T; line_total: number }
  | {
      kind: 'bundle';
      bundle_id: number | null;
      bundle_name: string;
      bundle_qty: number;
      bundle_line: number;
      /** Bundle line total after the components' own line discounts. */
      line_total: number;
      /** Price of ONE bundle before the line discount. */
      unit_price: number;
      components: Array<{ row: T; line_total: number }>;
    };

function bundleRowTotal(r: BundleLineRow): number {
  let total = (Number(r.unit_price) || 0) * (Number(r.quantity) || 0);
  const v = Number(r.discount_value) || 0;
  if (v) total = r.discount_type === 'percentage' ? total * (1 - v / 100) : Math.max(0, total - v);
  return total;
}

/**
 * Collapses the component rows of each sold bundle (same bundle_line) into one display line, in
 * the position of its first row. Rows without bundle_line stay ordinary items.
 */
export function groupBundleLines<T extends BundleLineRow>(rows: T[]): Array<BundleDisplayLine<T>> {
  const out: Array<BundleDisplayLine<T>> = [];
  const groups = new Map<string, Extract<BundleDisplayLine<T>, { kind: 'bundle' }>>();
  for (const row of rows || []) {
    const lineTotal = bundleRowTotal(row);
    if (row.bundle_line == null) {
      out.push({ kind: 'item', row, line_total: lineTotal });
      continue;
    }
    const key = `${row.bundle_line}:${row.bundle_id ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        kind: 'bundle',
        bundle_id: row.bundle_id ?? null,
        bundle_name: row.bundle_name || '',
        bundle_qty: 0,
        bundle_line: Number(row.bundle_line),
        line_total: 0,
        unit_price: 0,
        components: [],
      };
      groups.set(key, g);
      out.push(g);
    }
    g.components.push({ row, line_total: lineTotal });
    g.line_total += lineTotal;
    g.bundle_qty = Math.max(g.bundle_qty, Number(row.bundle_qty) || 0);
  }
  for (const g of groups.values()) {
    const gross = g.components.reduce((s, c) => s + (Number(c.row.unit_price) || 0) * (Number(c.row.quantity) || 0), 0);
    g.line_total = Math.round(g.line_total * 1e6) / 1e6;
    g.unit_price = g.bundle_qty > 0 ? Math.round((gross / g.bundle_qty) * 1e6) / 1e6 : 0;
  }
  return out;
}
// END BUNDLE MATH
