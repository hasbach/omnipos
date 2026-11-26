// Pure advisory calculations: no price writes and no database dependencies.
export interface SaleDay { day: string; units: number; price: number }
export interface PriceProduct { id: number; name: string; category: string; price: number; cost: number }
export interface Elasticity { elasticity: number; standard_error: number; r_squared: number; sale_days: number }

export function fitElasticity(history: SaleDay[]): Elasticity | null {
  const days = history.filter(d => d.units > 0 && d.price > 0 && Number.isFinite(d.units + d.price))
    .slice().sort((a, b) => a.day.localeCompare(b.day));
  const runs: SaleDay[][] = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && Math.round(last[0].price * 100) === Math.round(d.price * 100)) last.push(d);
    else runs.push([d]);
  }
  const eligible = runs.filter(r => r.length >= 7 && Date.parse(r[r.length - 1].day) - Date.parse(r[0].day) >= 6 * 86400000).flat();
  if (new Set(eligible.map(d => Math.round(d.price * 100))).size < 2) return null;
  // Within-weekday demeaning is OLS with weekday fixed effects (Frisch-Waugh-Lovell).
  const groups = new Map<number, { x: number; y: number }[]>();
  for (const d of eligible) {
    const weekday = new Date(d.day).getUTCDay();
    const list = groups.get(weekday) ?? [];
    list.push({ x: Math.log(d.price), y: Math.log(d.units) });
    groups.set(weekday, list);
  }
  let xx = 0, xy = 0, yy = 0;
  for (const list of groups.values()) {
    const mx = list.reduce((s, d) => s + d.x, 0) / list.length;
    const my = list.reduce((s, d) => s + d.y, 0) / list.length;
    for (const d of list) { xx += (d.x - mx) ** 2; xy += (d.x - mx) * (d.y - my); yy += (d.y - my) ** 2; }
  }
  const df = eligible.length - groups.size - 1;
  if (xx < 1e-12 || df <= 0) return null;
  const slope = xy / xx;
  const residual = Math.max(0, yy - xy * xy / xx);
  const standardError = Math.sqrt(residual / df / xx);
  // Only a clearly negative slope is evidence of price sensitivity. A flat/positive or noisy slope
  // would clamp to 0 ("demand ignores price") and always suggest the maximum raise: treat it as no fit.
  if (!(slope < 0) || Math.abs(slope) < 2 * standardError) return null;
  return { elasticity: Math.max(-4, Math.min(0, slope)), standard_error: standardError,
    r_squared: yy > 1e-12 ? Math.max(0, 1 - residual / yy) : 0, sale_days: eligible.length };
}

export function categoryElasticities(products: PriceProduct[], fits: Map<number, Elasticity>) {
  const grouped = new Map<string, Elasticity[]>();
  for (const p of products) {
    const fit = fits.get(p.id);
    if (fit && p.category) { const list = grouped.get(p.category) ?? []; list.push(fit); grouped.set(p.category, list); }
  }
  const result = new Map<string, Elasticity>();
  for (const [category, list] of grouped) {
    const n = list.reduce((s, f) => s + f.sale_days, 0);
    result.set(category, { elasticity: list.reduce((s, f) => s + f.elasticity * f.sale_days, 0) / n,
      standard_error: Math.sqrt(list.reduce((s, f) => s + (f.standard_error * f.sale_days) ** 2, 0)) / n,
      r_squared: list.reduce((s, f) => s + f.r_squared * f.sale_days, 0) / n, sale_days: n });
  }
  return result;
}

export function evaluateCandidates(p: PriceProduct, units: number, target: number, targetPrice: number, fit: Elasticity | null) {
  const baseline = units * (p.price - p.cost);
  const prices = new Set<number>([Math.round(targetPrice * 100) / 100]);
  if (fit) for (let step = -20; step <= 30; step++) prices.add(Math.round(p.price * (1 + step * 0.005) * 100) / 100);
  const candidates = [...prices].filter(price => price > 0 && (1 - p.cost / price) * 100 >= target - 1e-9)
    .map(price => {
      const expected_units = units * (price / p.price) ** (fit?.elasticity ?? 0);
      return { suggested_price: price, expected_units, volume_change_pct: ((price / p.price) ** (fit?.elasticity ?? 0) - 1) * 100,
        profit_change: expected_units * (price - p.cost) - baseline, units_change: expected_units - units };
    }).filter(c => c.volume_change_pct >= -10 - 1e-9)
    .sort((a, b) => b.profit_change - a.profit_change || Math.abs(a.suggested_price - p.price) - Math.abs(b.suggested_price - p.price));
  return candidates[0] ?? null;
}
