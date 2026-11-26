// Pure price calculations. USD prices are per base piece; package prices are per package.
export const lbpPricePairs = [
  ['price', 'price_lbp'],
  ['price_wholesale', 'price_wholesale_lbp'],
  ['price_super_wholesale', 'price_super_wholesale_lbp'],
  ['package_price', 'package_price_lbp'],
] as const;

export function roundedLocalPrice(usd: number, rate: number, step = 1): number {
  if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(step) || step <= 0) throw new Error('Invalid price or rate');
  return Math.round(usd * rate / step) * step;
}

export function localPricePatch(product: Record<string, any>, rate: number, step = 1) {
  const patch: Record<string, number> = {};
  if (product.price_lbp == null) return patch;
  for (const [usd, local] of lbpPricePairs) {
    if (product[local] != null && product[usd] != null) patch[local] = roundedLocalPrice(Number(product[usd]), rate, step);
  }
  return patch;
}

export function staleLocalPrices(product: Record<string, any>, rate: number, tolerance = 3, step = 1): boolean {
  const patch = localPricePatch(product, rate, step);
  return Object.entries(patch).some(([key, expected]) => expected === 0
    ? Number(product[key]) !== 0
    : Math.abs(Number(product[key]) - expected) / expected * 100 > tolerance + 1e-9);
}

export function paymentCurrencyShares(rows: { type: string; currency: string; usd: number }[], localCode: string) {
  let sales = 0, localSales = 0, costs = 0, usdCosts = 0;
  for (const row of rows) {
    if (row.type === 'sale' || row.type === 'refund') {
      const amount = Number(row.usd) * (row.type === 'refund' ? -1 : 1);
      sales += amount;
      if (row.currency.toUpperCase() === localCode.toUpperCase()) localSales += amount;
    } else {
      costs += Number(row.usd);
      if (row.currency.toUpperCase() === 'USD') usdCosts += Number(row.usd);
    }
  }
  return { sales_usd: sales, local_sales_usd: localSales, costs_usd: costs, usd_costs_usd: usdCosts,
    lbp_sales_pct: sales > 0 ? localSales / sales * 100 : null,
    usd_costs_pct: costs > 0 ? usdCosts / costs * 100 : null };
}
