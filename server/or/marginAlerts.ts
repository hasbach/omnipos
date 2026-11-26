import { db } from "../db.js";
import { localCurrencyFor, localRoundingStep } from "../localCurrency.js";
import marginLocales from "../../src/intl/locales/margins.js";

export function suggestedPrice(cost: number, target: number, step = 0.01): number {
  return Math.ceil((cost / (1 - target / 100)) / step - 1e-10) * step;
}

export function evaluateMargin(cost: number, previousCost: number | null, price: number, target = 20) {
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const margin = price > 0 ? 100 * (1 - cost / price) : -100;
  const previousMargin = previousCost != null && previousCost > 0 && price > 0 ? 100 * (1 - previousCost / price) : null;
  return {
    margin, previous_margin: previousMargin, under_target: margin < target - 1e-9,
    erosion: previousCost != null && cost > previousCost &&
      (margin < target - 1e-9 || (previousMargin != null && previousMargin - margin > 5 + 1e-9)),
    suggested_price: suggestedPrice(cost, target),
  };
}

// Invert the latest receipt's WAC using stock at receipt, before subsequent sales/adjustments.
// A depleted prior stock has no recoverable cost basis: report under-target without inventing a drop.
export function previousReceiptCost(cost: number, stockAfter: number, lines: Array<{ quantity: number; unit_cost: number | null; unit_price: number }>): number | null {
  let stock = stockAfter, basis = cost;
  for (const line of [...lines].reverse()) {
    const remaining = stock - line.quantity;
    if (remaining <= 0) return null;
    basis = (stock * basis - line.quantity * (line.unit_cost ?? line.unit_price)) / remaining;
    stock = remaining;
  }
  return Number.isFinite(basis) && basis > 0 ? basis : null;
}

export function loadMarginAlerts(tenantId: number) {
  const settings = Object.fromEntries((db.prepare("SELECT key, value FROM settings WHERE tenant_id = ?").all(tenantId) as any[]).map(r => [r.key, r.value]));
  const validTarget = (v: unknown, fallback: number) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 100 ? Number(v) : fallback;
  const target = validTarget(settings.margin_target_pct, 20);
  // Existing synced settings carry overrides keyed by the product's category name.
  let overrides: Record<string, number> = {};
  try { overrides = JSON.parse(settings.margin_target_pct_by_category || '{}') || {}; } catch { /* use tenant target */ }
  const local = localCurrencyFor(tenantId);
  const step = localRoundingStep(settings.lbp_rounding_step, local?.rate);
  const history = db.prepare(`SELECT t.id AS tx_id, t.created_at AS created_at, t.type AS type, ti.id AS id, ti.product_id AS product_id, ti.quantity AS quantity, ti.unit_cost AS unit_cost, ti.unit_price AS unit_price FROM transactions t
    JOIN transaction_items ti ON ti.transaction_id = t.id WHERE t.tenant_id = ? AND t.deleted_at IS NULL AND ti.deleted_at IS NULL
    UNION ALL SELECT t.id AS tx_id, t.created_at, t.type, ti.id, ti.product_id, ti.quantity, ti.unit_cost, ti.unit_price FROM archived_transactions t
    JOIN archived_transaction_items ti ON ti.transaction_id = t.id WHERE t.tenant_id = ?
    ORDER BY created_at, tx_id, id`).all(tenantId, tenantId) as any[];
  const adjustments = db.prepare("SELECT product_id, delta, created_at FROM stock_adjustments WHERE tenant_id = ?").all(tenantId) as any[];
  const products = db.prepare(`SELECT * FROM products WHERE tenant_id = ? AND deleted_at IS NULL
    AND IFNULL(active, 1) = 1 AND IFNULL(is_bundle, 0) = 0 AND cost > 0`).all(tenantId) as any[];
  // Group once: filtering the whole history per product is O(products x lines).
  const byProduct = new Map<number, any[]>();
  for (const r of history) { const list = byProduct.get(r.product_id); if (list) list.push(r); else byProduct.set(r.product_id, [r]); }
  const adjByProduct = new Map<number, any[]>();
  for (const r of adjustments) { const list = adjByProduct.get(r.product_id); if (list) list.push(r); else adjByProduct.set(r.product_id, [r]); }
  return products.flatMap(p => {
    const rows = byProduct.get(p.id) || [];
    const last = [...rows].reverse().find(r => r.type === 'purchase');
    let previous: number | null = null;
    if (last && p.track_inventory !== 0) {
      const after = rows.filter(r => r.created_at > last.created_at || (r.created_at === last.created_at && r.tx_id > last.tx_id));
      const delta = after.reduce((s, r) => s + (['purchase', 'refund'].includes(r.type) ? 1 : -1) * r.quantity, 0);
      const adjusted = (adjByProduct.get(p.id) || []).filter(r => r.created_at > last.created_at).reduce((s, r) => s + r.delta, 0);
      previous = previousReceiptCost(p.cost, p.stock - delta - adjusted, rows.filter(r => r.tx_id === last.tx_id && r.type === 'purchase'));
    }
    const productTarget = validTarget(overrides[p.category], target);
    const usd = evaluateMargin(p.cost, previous, p.price, productTarget)!;
    const lbp = local && p.price_lbp != null ? evaluateMargin(p.cost, previous, p.price_lbp / local.rate, productTarget) : null;
    if (!usd.under_target && !usd.erosion && !lbp?.under_target && !lbp?.erosion) return [];
    return [{ product_id: p.id, name: p.name, cost: p.cost, previous_cost: previous, price: p.price,
      price_lbp: p.price_lbp, target_pct: productTarget, ...usd,
      lbp_margin: lbp?.margin ?? null, local_code: local?.code ?? null,
      suggested_price_lbp: local ? suggestedPrice(p.cost * local.rate, productTarget, step) : null }];
  });
}

export function marginBriefingItems(tenantId: number, limit = 10) {
  const language = (db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'language'").get(tenantId) as any)?.value;
  const dictionary = marginLocales[language as keyof typeof marginLocales] || marginLocales.en;
  const t = (key: keyof typeof dictionary, values: Record<string, string> = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
  // The briefing carries only what changed or loses money (a supplier price rise, or a local price
  // below cost), worst first and capped; the full under-target list lives in the Margins tab.
  const urgent = loadMarginAlerts(tenantId)
    .filter(p => p.erosion || p.margin < 0 || (p.lbp_margin != null && p.lbp_margin < 0))
    .sort((a, b) => Math.min(a.margin, a.lbp_margin ?? a.margin) - Math.min(b.margin, b.lbp_margin ?? b.margin))
    .slice(0, limit);
  return urgent.map(p => ({
    priority: p.margin < 0 || (p.lbp_margin != null && p.lbp_margin < 0) ? 'CRITICAL' : 'HIGH',
    category: 'MARGIN_EROSION', title: p.name,
    details: t('or_margin_detail', {
      before: p.previous_margin == null ? t('or_margin_unknown') : p.previous_margin.toFixed(1),
      after: p.margin.toFixed(1), old: p.previous_cost == null ? t('or_margin_unknown') : p.previous_cost.toFixed(2),
      cost: p.cost.toFixed(2), price: p.suggested_price.toFixed(2),
    }) + (p.lbp_margin == null ? '' : ` ${t('or_margin_local', {
      code: p.local_code!, margin: p.lbp_margin.toFixed(1), price: p.suggested_price_lbp!.toLocaleString(),
    })}`),
    reference_id: p.product_id,
  }));
}
