/** Pure basket analysis: quantities and repeated lines count only once per basket. */
export interface BasketLine {
  product_id: number;
  quantity: number;
  bundle_id?: number | null;
}

export interface Basket {
  id: string;
  soldAt: string;
  lines: BasketLine[];
}

export interface BasketProduct {
  id: number;
  name: string;
  price: number;
  cost: number;
  is_bundle?: number;
}

export function basketProducts(lines: BasketLine[]): number[] {
  return [...new Set(lines.filter((line) => line.quantity > 0)
    .map((line) => line.bundle_id ?? line.product_id))].sort((a, b) => a - b);
}

/** The requested target is markup over cost, rather than gross margin on revenue. */
export function suggestBundlePrice(cost: number, regularPrice: number, targetPercent = 20): number {
  if (![cost, regularPrice, targetPercent].every(Number.isFinite) || cost < 0 || regularPrice < 0 || targetPercent < 0) {
    throw new Error('Invalid bundle price inputs');
  }
  return Math.min(regularPrice, Math.round(cost * (1 + targetPercent / 100) * 100) / 100);
}

export function analyzeBaskets(baskets: Basket[], products: BasketProduct[], options: {
  minSupport?: number;
  targetPercent?: number;
  now?: Date;
} = {}) {
  const minSupport = options.minSupport ?? 3;
  if (!Number.isInteger(minSupport) || minSupport < 1) throw new Error('Invalid minimum support');
  const now = (options.now ?? new Date()).getTime();
  const catalog = new Map(products.map((p) => [p.id, p]));
  const counts = new Map<string, number>();
  const recent = new Map<number, number>();
  const last = new Map<number, number>();
  const normalized = baskets.map((basket) => {
    const ids = basketProducts(basket.lines);
    const time = new Date(basket.soldAt).getTime();
    for (const id of ids) {
      counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
      last.set(id, Math.max(last.get(id) ?? 0, time));
      if (time >= now - 30 * 86400000) recent.set(id, (recent.get(id) ?? 0) + 1);
    }
    return ids;
  });
  // Apriori: prune infrequent singletons, then require every pair before counting triples.
  const candidates = normalized.map((ids) => ids.filter((id) => counts.get(String(id))! >= minSupport));
  for (const ids of candidates) {
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const key = `${ids[a]},${ids[b]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const ids of candidates) {
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      if ((counts.get(`${ids[a]},${ids[b]}`) ?? 0) < minSupport) continue;
      for (let c = b + 1; c < ids.length; c++) {
        if ((counts.get(`${ids[a]},${ids[c]}`) ?? 0) < minSupport ||
            (counts.get(`${ids[b]},${ids[c]}`) ?? 0) < minSupport) continue;
        const key = `${ids[a]},${ids[b]},${ids[c]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const ideas = [...counts].filter(([key, count]) => key.includes(',') && count >= minSupport).map(([key, count]) => {
    const ids = key.split(',').map(Number);
    const members = ids.map((id) => catalog.get(id));
    if (members.some((p) => !p)) return null;
    const selected = members as BasketProduct[];
    // Report every rule with a single-product consequent (including pair -> product for triples).
    const rules = ids.map((consequent) => {
      const antecedent = ids.filter((id) => id !== consequent);
      const confidence = count / counts.get(antecedent.join(','))!;
      return { antecedent, consequent, confidence, lift: confidence / (counts.get(String(consequent))! / baskets.length) };
    });
    const combinedRegularPrice = selected.reduce((sum, p) => sum + p.price, 0);
    const combinedCost = selected.reduce((sum, p) => sum + p.cost, 0);
    const velocities = ids.map((id) => recent.get(id) ?? 0);
    const fastest = Math.max(...velocities);
    const slowFast = fastest >= 3 && ids.some((id) =>
      now - (last.get(id) ?? 0) >= 30 * 86400000 || (recent.get(id) ?? 0) <= fastest / 3);
    const lift = Math.max(...rules.map((rule) => rule.lift));
    return {
      key, products: selected, supportCount: count, support: count / baskets.length, rules,
      confidence: Math.max(...rules.map((rule) => rule.confidence)), lift,
      combinedRegularPrice, combinedCost,
      suggestedPrice: suggestBundlePrice(combinedCost, combinedRegularPrice, options.targetPercent),
      slowFast, canCreate: selected.every((p) => !p.is_bundle),
      score: lift * Math.log1p(count) * (slowFast ? 2 : 1),
    };
  }).filter((idea): idea is NonNullable<typeof idea> => idea !== null);
  return ideas.sort((a, b) => b.score - a.score || b.supportCount - a.supportCount || a.key.localeCompare(b.key));
}
