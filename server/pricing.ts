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
