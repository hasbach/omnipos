import { db } from '../db.js';
import { localCurrencyFor, localRoundingStep } from '../localCurrency.js';
import { roundedLocalPrice } from '../lbpRateAlerts.js';
import { suggestedPrice } from './marginAlerts.js';
import { fitElasticity, categoryElasticities, evaluateCandidates, type SaleDay, type PriceProduct, type Elasticity } from './priceSuggestions.js';

export function loadPriceSuggestions(tenant: number) {
  const settings = Object.fromEntries((db.prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(tenant) as any[]).map(r => [r.key, r.value]));
  const validTarget = (v: unknown, fallback: number) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 100 ? Number(v) : fallback;
  const target = validTarget(settings.margin_target_pct, 20);
  let overrides: Record<string, unknown> = {};
  try { const parsed = JSON.parse(settings.margin_target_pct_by_category || '{}'); if (parsed && typeof parsed === 'object') overrides = parsed; } catch { /* default target */ }
  const localCurrency = localCurrencyFor(tenant);
  const rounding = localRoundingStep(settings.lbp_rounding_step, localCurrency?.rate);
  const products = db.prepare(`SELECT id, name, category, price, cost FROM products WHERE tenant_id = ?
    AND deleted_at IS NULL AND IFNULL(active, 1) = 1 AND IFNULL(is_bundle, 0) = 0 AND price > 0 AND cost > 0`).all(tenant) as PriceProduct[];
  const branch = (tx: string, items: string) => `SELECT i.product_id AS product_id, date(t.created_at, 'localtime') AS day,
    i.quantity AS units, CASE WHEN i.discount_type = 'percentage' THEN i.unit_price * i.quantity * (1 - COALESCE(i.discount_value, 0) / 100.0)
    ELSE MAX(0, i.unit_price * i.quantity - COALESCE(i.discount_value, 0)) END AS net
    FROM ${tx} t JOIN ${items} i ON i.transaction_id = t.id
    WHERE t.tenant_id = @tenant AND t.type = 'sale' AND t.status = 'completed' AND t.deleted_at IS NULL
      AND i.deleted_at IS NULL AND i.quantity > 0 AND i.bundle_id IS NULL
      AND date(t.created_at, 'localtime') >= date('now', 'localtime', '-365 days')
      AND date(t.created_at, 'localtime') < date('now', 'localtime')`;
  const rows = db.prepare(`SELECT product_id, day, SUM(units) AS units, SUM(net) / SUM(units) AS price FROM (
    ${branch('transactions', 'transaction_items')} UNION ALL ${branch('archived_transactions', 'archived_transaction_items')}
    ) GROUP BY product_id, day ORDER BY product_id, day`).all({ tenant }) as (SaleDay & { product_id: number })[];
  const histories = new Map<number, SaleDay[]>();
  for (const row of rows) { const list = histories.get(row.product_id) ?? []; list.push(row); histories.set(row.product_id, list); }
  const fits = new Map<number, Elasticity>();
  for (const [id, history] of histories) { const fit = fitElasticity(history); if (fit) fits.set(id, fit); }
  const categories = categoryElasticities(products, fits);
  const today = (db.prepare("SELECT date('now', 'localtime') AS day").get() as { day: string }).day;
  const results = products.map(p => {
    const own = fits.get(p.id);
    const fit = own ?? categories.get(p.category) ?? null;
    const history = histories.get(p.id) ?? [];
    // Recent calendar-day baseline includes zero-sale days. Inactive/no-history products stay at zero.
    const units = history.reduce((sum, d) => sum + (Date.parse(today) - Date.parse(d.day) <= 28 * 86400000 ? d.units : 0), 0) / 28;
    const productTarget = validTarget(overrides[p.category], target);
    const candidate = evaluateCandidates(p, units, productTarget, suggestedPrice(p.cost, productTarget), fit);
    return { ...p, product_id: p.id, margin: (1 - p.cost / p.price) * 100, target_pct: productTarget, current_units: units,
      source: own ? 'own' : fit ? 'category' : 'insufficient',
      confidence: own && own.r_squared >= 0.5 && own.standard_error <= 0.5 ? 'high' : fit && !own ? 'medium' : 'low',
      fit, candidate, suggested_price_lbp: candidate && localCurrency ? roundedLocalPrice(candidate.suggested_price, localCurrency.rate, rounding) : null };
  // Only actionable rows: a suggestion equal to today's price is "keep", not advice.
  }).filter(r => r.candidate && Math.abs(r.candidate.suggested_price - r.price) >= 0.005)
    .sort((a, b) => (b.candidate?.profit_change ?? -Infinity) - (a.candidate?.profit_change ?? -Infinity) || a.name.localeCompare(b.name));
  return { products: results, localCurrency };
}
