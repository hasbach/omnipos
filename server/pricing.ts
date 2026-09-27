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
}

// USD unit price for a given price level, USD tier chain (super_wholesale falls back to
// wholesale, then to retail). A tier value only counts when actually set — NULL/0 means "not
// configured for this product", not "free".
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

// Per-unit sale price for one line. A real (non-retail) tier price is flat, no package blending.
// Otherwise this reproduces the existing retail logic: buying in whole packages blends the
// package price for full packages with the per-unit price for the remainder.
export function saleLineUnitPrice(product: TierProduct, level: PriceLevel, quantity: number): number {
  if (hasRealTier(product, level)) {
    return tierUnitPrice(product, level);
  }
  const unitsPerPackage = product.units_per_package || 1;
  if (product.package_price && unitsPerPackage > 1 && quantity > 0) {
    const numPackages = Math.floor(quantity / unitsPerPackage);
    const remainder = quantity % unitsPerPackage;
    const packagedTotal = (numPackages * product.package_price) + (remainder * product.price);
    return packagedTotal / quantity;
  }
  return product.price;
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

  return Math.max(0, finalTotal);
}
