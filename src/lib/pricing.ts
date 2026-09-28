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

/**
 * Per-unit blended price (USD) for a retail sale line, honoring the package break:
 * packages at package_price + remainder at unit price.
 */
function retailBlendedUnitPrice(product: PricingProduct, qty: number): number {
  const unitsPerPackage = product.units_per_package || 1;
  if (product.package_price && unitsPerPackage > 1 && qty > 0) {
    const numPackages = Math.floor(qty / unitsPerPackage);
    const remainder = qty % unitsPerPackage;
    const packagedTotal = numPackages * product.package_price + remainder * product.price;
    return packagedTotal / qty;
  }
  return product.price;
}

function retailBlendedUnitPriceLbp(product: PricingProduct, qty: number, rate: number): number {
  const unitsPerPackage = product.units_per_package || 1;
  const unitLbp = product.price_lbp || product.price * rate;
  if (unitsPerPackage > 1 && qty > 0) {
    const packageLbp = product.package_price_lbp || (product.package_price ? product.package_price * rate : null);
    if (packageLbp) {
      const numPackages = Math.floor(qty / unitsPerPackage);
      const remainder = qty % unitsPerPackage;
      const packagedTotal = numPackages * packageLbp + remainder * unitLbp;
      return packagedTotal / qty;
    }
  }
  return unitLbp;
}

/** Per-unit USD price to use for a sale line at the given qty/level (package break included for retail). */
export function saleLineUnitPrice(product: PricingProduct, level: PriceLevel, qty: number): number {
  const flat = tierUnitPrice(product, level);
  if (flat != null) return flat;
  return retailBlendedUnitPrice(product, qty);
}

/** Same, in LBP. */
export function saleLineUnitPriceLbp(product: PricingProduct, level: PriceLevel, qty: number, rate: number): number {
  const flat = tierUnitPriceLbp(product, level, rate);
  if (flat != null) return flat;
  return retailBlendedUnitPriceLbp(product, qty, rate);
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
  tax?: number; // percent
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
  const taxAmount = tax ? afterDiscount * (tax / 100) : 0;
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
