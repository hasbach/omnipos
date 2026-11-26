export interface SupplierProfile {
  id: number; name: string; fill_rate_score: number | null; payment_terms_days: number | null;
}
export interface PurchasePrice {
  supplier_id: number; product_id: number; product_name: string; date: string; quantity: number; price: number;
}
export interface Delivery { supplier_id: number; expected: string; received: string }
export interface PurchaseTotal { supplier_id: number; date: string; amount: number }
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const timestamp = (s: string) => Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + (s.length > 10 ? 'Z' : 'T00:00:00Z'));

/** Pure projection; prices and quantities are already USD per base piece and base pieces. */
export function buildSupplierScorecards(profiles: SupplierProfile[], prices: PurchasePrice[], totals: PurchaseTotal[], deliveries: Delivery[], owed: Array<{ party_id: number; amount_usd: number }>, now = new Date()) {
  const cutoff = now.getTime() - 90 * 86400000;
  const cards = new Map(profiles.map(p => [p.id, {
    ...p, on_time_rate: null as number | null, delivery_count: 0, bought_90d_usd: 0, bought_all_usd: 0, owed_usd: 0,
    products: [] as Array<{ product_id: number; product_name: string; last_price: number; average_90d: number | null; change: number | null; history: Array<{ date: string; price: number }> }>,
  }]));
  for (const row of totals) {
    const c = cards.get(row.supplier_id); if (!c) continue;
    c.bought_all_usd += row.amount;
    if (timestamp(row.date) >= cutoff && timestamp(row.date) <= now.getTime()) c.bought_90d_usd += row.amount;
  }
  for (const row of owed) { const c = cards.get(row.party_id); if (c) c.owed_usd += row.amount_usd; }
  const onTime = new Map<number, number>();
  for (const row of deliveries) {
    const c = cards.get(row.supplier_id);
    if (!c || !Number.isFinite(timestamp(row.expected)) || !Number.isFinite(timestamp(row.received))) continue;
    c.delivery_count++;
    if (row.received.slice(0, 10) <= row.expected.slice(0, 10)) onTime.set(c.id, (onTime.get(c.id) || 0) + 1);
  }
  const groups = new Map<string, PurchasePrice[]>();
  for (const row of prices) {
    if (!cards.has(row.supplier_id) || row.quantity <= 0 || !Number.isFinite(row.price) || row.price < 0) continue;
    const key = `${row.supplier_id}:${row.product_id}`;
    const group = groups.get(key); if (group) group.push(row); else groups.set(key, [row]);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) => timestamp(a.date) - timestamp(b.date));
    const last = rows[rows.length - 1];
    let amount = 0, quantity = 0;
    for (const r of rows) if (timestamp(r.date) >= cutoff && timestamp(r.date) <= now.getTime()) { amount += r.quantity * r.price; quantity += r.quantity; }
    cards.get(last.supplier_id)!.products.push({ product_id: last.product_id, product_name: last.product_name,
      last_price: last.price, average_90d: quantity ? amount / quantity : null,
      change: rows.length > 1 ? last.price - rows[rows.length - 2].price : null,
      history: rows.map(r => ({ date: r.date, price: r.price })),
    });
  }
  return [...cards.values()].map(c => ({ ...c, on_time_rate: c.delivery_count ? (onTime.get(c.id) || 0) / c.delivery_count : null,
    bought_all_usd: cents(c.bought_all_usd), bought_90d_usd: cents(c.bought_90d_usd), owed_usd: cents(c.owed_usd) }));
}
export type SupplierScorecard = ReturnType<typeof buildSupplierScorecards>[number];

/** Only multi-supplier history changes the optimizer. Missing delivery observations do not penalize a supplier. */
export function preferredSupplierPrices(cards: SupplierScorecard[]) {
  const products = new Map<number, Array<{ supplier: SupplierScorecard; price: number; average: number | null }>>();
  for (const supplier of cards) for (const p of supplier.products) {
    const rows = products.get(p.product_id) || [];
    rows.push({ supplier, price: p.last_price, average: p.average_90d }); products.set(p.product_id, rows);
  }
  const result = new Map<number, { supplier_id: number; unit_cost_usd: number }>();
  for (const [id, rows] of products) {
    if (rows.length < 2) continue;
    const best = rows.filter(r => r.supplier.fill_rate_score !== null && r.supplier.fill_rate_score >= 0.8 &&
      (r.supplier.on_time_rate === null || r.supplier.on_time_rate >= 0.7))
      .sort((a, b) => a.price - b.price || (a.average ?? Infinity) - (b.average ?? Infinity) || a.supplier.id - b.supplier.id)[0];
    if (best) result.set(id, { supplier_id: best.supplier.id, unit_cost_usd: best.price });
  }
  return result;
}

export function supplierComparisons(cards: SupplierScorecard[]) {
  const groups = new Map<number, Array<{ supplier_id: number; name: string; last_price: number; average_90d: number | null }>>();
  for (const c of cards) for (const p of c.products) {
    const rows = groups.get(p.product_id) || [];
    rows.push({ supplier_id: c.id, name: c.name, last_price: p.last_price, average_90d: p.average_90d }); groups.set(p.product_id, rows);
  }
  return [...groups].filter(([, rows]) => rows.length > 1).map(([product_id, rows]) => ({ product_id,
    cheapest_last: [...rows].sort((a, b) => a.last_price - b.last_price || a.supplier_id - b.supplier_id)[0],
    cheapest_average_90d: rows.filter(r => r.average_90d !== null).sort((a, b) => a.average_90d! - b.average_90d! || a.supplier_id - b.supplier_id)[0] ?? null,
  }));
}
