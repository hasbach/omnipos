import { db } from '../db.js';
import { ValidationError } from '../errors.js';
import { localDateIso } from './coreBridge.js';
import { backtestDemand, defaultForecastConfig, demandDate, forecastDemand, wape, type DailySale, type ForecastConfig } from './demandForecast.js';

export function readForecastConfig(tenantId: number): ForecastConfig {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'or_demand_forecast'").get(tenantId) as any;
  try { return validateForecastConfig(JSON.parse(row?.value || JSON.stringify(defaultForecastConfig))); }
  catch { return defaultForecastConfig; }
}
export function validateForecastConfig(input: any): ForecastConfig {
  const validDate = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!input || !Array.isArray(input.salaryDays) || input.salaryDays.some((d: any) => !Number.isInteger(d) || d < 1 || d > 31) ||
      !Array.isArray(input.periods) || input.periods.length > 100 || input.periods.some((p: any) => !p || !validDate(p.from) || !validDate(p.to) || p.from > p.to || !Number.isFinite(p.multiplier) || p.multiplier <= 0 || p.multiplier > 10)) {
    throw new ValidationError('Invalid demand forecast configuration');
  }
  return { salaryDays: [...new Set<number>(input.salaryDays)], periods: input.periods.map((p: any) => ({ from: p.from, to: p.to, multiplier: p.multiplier })) };
}
export function saveForecastConfig(tenantId: number, input: any) {
  const config = validateForecastConfig(input);
  db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'or_demand_forecast', ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value").run(tenantId, JSON.stringify(config));
  return config;
}
function salesHistory(tenantId: number, today: string, days: number) {
  const rows = db.prepare(`SELECT product_id AS product_id, sale_day AS sale_day, SUM(qty) AS units FROM (
    SELECT ti.product_id AS product_id, date(t.created_at, 'localtime') AS sale_day, ti.quantity AS qty
    FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
    WHERE t.tenant_id = ? AND t.type = 'sale' AND t.deleted_at IS NULL
      AND date(t.created_at, 'localtime') >= ? AND date(t.created_at, 'localtime') < ?
    UNION ALL
    SELECT ti.product_id AS product_id, date(t.created_at, 'localtime') AS sale_day, ti.quantity AS qty
    FROM archived_transaction_items ti JOIN archived_transactions t ON t.id = ti.transaction_id
    WHERE t.tenant_id = ? AND t.type = 'sale'
      AND date(t.created_at, 'localtime') >= ? AND date(t.created_at, 'localtime') < ?
  ) GROUP BY product_id, sale_day`).all(tenantId, demandDate(today, -days), today, tenantId, demandDate(today, -days), today) as any[];
  const grouped = new Map<number, DailySale[]>();
  for (const row of rows) {
    let list = grouped.get(row.product_id);
    if (!list) grouped.set(row.product_id, list = []);
    list.push({ date: row.sale_day, units: Number(row.units) || 0 });
  }
  return grouped;
}
export function loadDemandForecasts(tenantId: number, today = localDateIso()) {
  const config = readForecastConfig(tenantId);
  const purchases = db.prepare(`SELECT product_id AS product_id, stakeholder_id AS supplier_id, created_at AS created_at FROM (
    SELECT ti.product_id AS product_id, t.stakeholder_id AS stakeholder_id, t.created_at AS created_at
    FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
    WHERE t.tenant_id = ? AND t.type = 'purchase' AND t.deleted_at IS NULL AND t.stakeholder_id IS NOT NULL
    UNION ALL
    SELECT ti.product_id AS product_id, t.stakeholder_id AS stakeholder_id, t.created_at AS created_at
    FROM archived_transaction_items ti JOIN archived_transactions t ON t.id = ti.transaction_id
    WHERE t.tenant_id = ? AND t.type = 'purchase' AND t.stakeholder_id IS NOT NULL
  ) ORDER BY created_at DESC`).all(tenantId, tenantId) as any[];
  const supplierByProduct = new Map<number, number>();
  for (const row of purchases) if (!supplierByProduct.has(row.product_id)) supplierByProduct.set(row.product_id, row.supplier_id);
  const primaries = db.prepare('SELECT product_id, primary_supplier_id FROM or_sku_metrics WHERE tenant_id = ? AND primary_supplier_id IS NOT NULL').all(tenantId) as any[];
  for (const row of primaries) supplierByProduct.set(row.product_id, row.primary_supplier_id);
  const profiles = db.prepare('SELECT supplier_id, lead_time_days FROM or_supplier_profiles WHERE tenant_id = ? AND deleted_at IS NULL').all(tenantId) as any[];
  const leads = new Map<number, number>(profiles.map(p => [p.supplier_id, Math.max(1, Number(p.lead_time_days) || 2)]));
  return new Map([...salesHistory(tenantId, today, 56)].map(([id, history]) => {
    const leadDays = leads.get(supplierByProduct.get(id) || 0) || 2;
    return [id, { ...forecastDemand(history, today, leadDays, config), leadDays }];
  }));
}
export function loadForecastAccuracy(tenantId: number, today = localDateIso()) {
  const config = readForecastConfig(tenantId);
  // 56 extra warm-up days allow all eight holdout weeks to use prior history only.
  const history = salesHistory(tenantId, today, 112);
  const products = db.prepare(`SELECT p.id, p.name, COALESCE(m.abc_class, 'C') AS abc_class
    FROM products p LEFT JOIN or_sku_metrics m ON m.product_id = p.id AND m.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND IFNULL(p.active, 1) = 1 AND IFNULL(p.is_bundle, 0) = 0`).all(tenantId) as any[];
  const rows = products.map(p => ({ product_id: p.id, name: p.name, abc_class: p.abc_class, ...backtestDemand(history.get(p.id) || [], today, config) }));
  const classes = ['A', 'B', 'C'].map(abc => {
    const members = rows.filter(p => p.abc_class === abc);
    const absoluteError = members.reduce((s, p) => s + p.absoluteError, 0);
    const actual = members.reduce((s, p) => s + p.actual, 0);
    return { abc_class: abc, absoluteError, actual, wape: wape(absoluteError, actual) };
  });
  return { today, config, products: rows, classes };
}
