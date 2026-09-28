// Frontend mirror of server/pricing.ts. Keep these two files in sync.
// Rules:
//  - A tier value counts only if it is > 0 (0/NULL/undefined = "not set").
//  - super_wholesale resolves to: price_super_wholesale || price_wholesale || price
//  - wholesale resolves to: price_wholesale || price
//  - A resolved non-retail tier price is FLAT per unit (no package break).
//  - retail (or a tier that falls through to price) uses the package-break logic:
//      packages = floor(qty / units_per_package); remainder = qty % units_per_package
//      total = packages * package_price + remainder * price   (only if package_price set and units_per_package > 1)

export type PriceLevel = 'retail' | 'wholesale' | 'super_wholesale';

export function normalizeLevel(level: unknown): PriceLevel {
  return level === 'wholesale' || level === 'super_wholesale' ? level : 'retail';
}

export interface PricingProduct {
  price: number;
  price_lbp?: number | null;
  package_price?: number | null;
  package_price_lbp?: number | null;
  units_per_package?: number | null;
  price_wholesale?: number | null;
  price_wholesale_lbp?: number | null;
  price_super_wholesale?: number | null;
  price_super_wholesale_lbp?: number | null;
  cost?: number | null;
}

const positive = (v: number | null | undefined): number | null =>
  typeof v === 'number' && v > 0 ? v : null;

/** Resolved flat tier price in USD, or null if the level falls through to retail/package pricing. */
export function tierUnitPrice(product: PricingProduct, level: PriceLevel): number | null {
  if (level === 'super_wholesale') {
    return (
      positive(product.price_super_wholesale) ??
      positive(product.price_wholesale) ??
      null
    );
  }
  if (level === 'wholesale') {
    return positive(product.price_wholesale) ?? null;
  }
  return null;
}

/** Same resolution, but against the LBP tier columns, falling back to USD*rate when unset. */
export function tierUnitPriceLbp(product: PricingProduct, level: PriceLevel, rate: number): number | null {
  if (level === 'super_wholesale') {
    const flat =
      positive(product.price_super_wholesale_lbp) ??
      positive(product.price_wholesale_lbp) ??
      null;
    if (flat != null) return flat;
    const usd = tierUnitPrice(product, level);
    return usd != null ? usd * rate : null;
  }
  if (level === 'wholesale') {
    const flat = positive(product.price_wholesale_lbp) ?? null;
    if (flat != null) return flat;
    const usd = tierUnitPrice(product, level);
    return usd != null ? usd * rate : null;
  }
  return null;
}

/** A unit of measure as far as pricing is concerned (mirror of server/pricing.ts UomPricing). */
export interface UomPricing {
  factor: number;
  price: number;
  price_lbp?: number | null;
  price_wholesale?: number | null;
  price_wholesale_lbp?: number | null;
  price_super_wholesale?: number | null;
  price_super_wholesale_lbp?: number | null;
}

/** Price (USD) of ONE unit of measure at a level: unit tier -> product tier x factor -> ... -> unit retail. */
export function uomUnitPrice(product: PricingProduct, uom: UomPricing, level: PriceLevel): number {
  const f = uom.factor || 1;
  const scaled = (v: number | null | undefined) => { const p = positive(v); return p != null ? p * f : null; };
  if (level === 'super_wholesale') {
    return (
      positive(uom.price_super_wholesale) ??
      scaled(product.price_super_wholesale) ??
      positive(uom.price_wholesale) ??
      scaled(product.price_wholesale) ??
      uom.price
    );
  }
  if (level === 'wholesale') {
    return positive(uom.price_wholesale) ?? scaled(product.price_wholesale) ?? uom.price;
  }
  return uom.price;
}

/** Same chain against the LBP columns; each step falls back to its USD value x rate before moving on. */
export function uomUnitPriceLbp(product: PricingProduct, uom: UomPricing, level: PriceLevel, rate: number): number {
  const f = uom.factor || 1;
  const step = (lbp: number | null | undefined, usd: number | null | undefined, mult: number): number | null => {
    const l = positive(lbp);
    if (l != null) return l * mult;
    const u = positive(usd);
    return u != null ? u * mult * rate : null;
  };
  const retail = positive(uom.price_lbp) ?? uom.price * rate;
  if (level === 'super_wholesale') {
    return (
      step(uom.price_super_wholesale_lbp, uom.price_super_wholesale, 1) ??
      step(product.price_super_wholesale_lbp, product.price_super_wholesale, f) ??
      step(uom.price_wholesale_lbp, uom.price_wholesale, 1) ??
      step(product.price_wholesale_lbp, product.price_wholesale, f) ??
      retail
    );
  }
  if (level === 'wholesale') {
    return (
      step(uom.price_wholesale_lbp, uom.price_wholesale, 1) ??
      step(product.price_wholesale_lbp, product.price_wholesale, f) ??
      retail
    );
  }
  return retail;
}

/** Units that take part in the automatic pack break: whole-number factor > 1 and price > 0, largest first. */
function breakUnits(product: PricingProduct, units?: UomPricing[] | null): UomPricing[] {
  const live = (units || []).filter(u => u && Number.isInteger(u.factor) && u.factor > 1 && u.price > 0);
  if (live.length > 0) return [...live].sort((x, y) => y.factor - x.factor);
  const upp = product.units_per_package || 1;
  if (product.package_price && product.package_price > 0 && upp > 1 && Number.isInteger(upp)) {
    return [{ factor: upp, price: product.package_price, price_lbp: product.package_price_lbp }];
  }
  return [];
}

/**
 * Per-piece blended price (USD) for a retail base-piece line: greedy, largest unit first
 * (e.g. carton, then pack, then loose pieces).
 */
function retailBlendedUnitPrice(product: PricingProduct, qty: number, units?: UomPricing[] | null): number {
  const bu = breakUnits(product, units);
  if (bu.length && qty > 0) {
    let remaining = qty;
    let total = 0;
    for (const u of bu) {
      const n = Math.floor(remaining / u.factor);
      total += n * u.price;
      remaining -= n * u.factor;
    }
    total += remaining * product.price;
    return total / qty;
  }
  return product.price;
}

function retailBlendedUnitPriceLbp(product: PricingProduct, qty: number, rate: number, units?: UomPricing[] | null): number {
  const unitLbp = product.price_lbp || product.price * rate;
  const bu = breakUnits(product, units);
  if (bu.length && qty > 0) {
    let remaining = qty;
    let total = 0;
    for (const u of bu) {
      const n = Math.floor(remaining / u.factor);
      const uLbp = positive(u.price_lbp) ?? u.price * rate;
      total += n * uLbp;
      remaining -= n * u.factor;
    }
    total += remaining * unitLbp;
    return total / qty;
  }
  return unitLbp;
}

/** Per-piece USD price to use for a base-piece sale line at the given qty/level (pack break included for retail). */
export function saleLineUnitPrice(product: PricingProduct, level: PriceLevel, qty: number, units?: UomPricing[] | null): number {
  const flat = tierUnitPrice(product, level);
  if (flat != null) return flat;
  return retailBlendedUnitPrice(product, qty, units);
}

/** Same, in LBP. */
export function saleLineUnitPriceLbp(product: PricingProduct, level: PriceLevel, qty: number, rate: number, units?: UomPricing[] | null): number {
  const flat = tierUnitPriceLbp(product, level, rate);
  if (flat != null) return flat;
  return retailBlendedUnitPriceLbp(product, qty, rate, units);
}

export interface LineDiscount {
  type: 'percentage' | 'fixed';
  value: number;
}

export function lineTotal(unitPrice: number, qty: number, discount?: LineDiscount | null): number {
  let total = unitPrice * qty;
  if (discount) {
    if (discount.type === 'percentage') {
      total -= total * (Math.max(0, Math.min(100, discount.value)) / 100);
    } else {
      total -= discount.value;
    }
  }
  return Math.max(0, total);
}

export interface TotalsInput {
  lines: Array<{ unitPrice: number; qty: number; discount?: LineDiscount | null }>;
  discount?: LineDiscount | null;
  /** A bare number is a percentage (legacy form); an object matches the server's {type, value} tax. */
  tax?: number | LineDiscount | null;
}

export interface TotalsResult {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}

export function computeTotals({ lines, discount, tax }: TotalsInput): TotalsResult {
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l.unitPrice, l.qty, l.discount), 0);

  let discountAmount = 0;
  if (discount) {
    discountAmount =
      discount.type === 'percentage'
        ? subtotal * (Math.max(0, Math.min(100, discount.value)) / 100)
        : Math.max(0, Math.min(subtotal, discount.value));
  }

  const afterDiscount = Math.max(0, subtotal - discountAmount);
  // Same as server/pricing.ts computeTotals: percentage of the discounted subtotal, or a flat amount.
  const taxAdj: LineDiscount | null = typeof tax === 'number' ? { type: 'percentage', value: tax } : (tax || null);
  const taxAmount = !taxAdj || !taxAdj.value ? 0
    : taxAdj.type === 'percentage' ? afterDiscount * (taxAdj.value / 100) : taxAdj.value;
  const total = Math.max(0, afterDiscount + taxAmount);

  return { subtotal, discountAmount, taxAmount, total };
}

/** Margin % = (price - cost) / price * 100 */
export function marginPct(price: number, cost: number): number {
  if (!price) return 0;
  return ((price - cost) / price) * 100;
}

/** Markup % = (price - cost) / cost * 100 */
export function markupPct(price: number, cost: number): number {
  if (!cost) return 0;
  return ((price - cost) / cost) * 100;
}

/** Price that yields the given markup % over cost. */
export function priceFromMarkup(cost: number, pct: number): number {
  return cost * (1 + pct / 100);
}

/** Price that yields the given margin % (price-based). */
export function priceFromMargin(cost: number, pct: number): number {
  if (pct >= 100) return Infinity;
  return cost / (1 - pct / 100);
}
