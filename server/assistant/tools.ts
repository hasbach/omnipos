import { db } from '../db.js';
import { computeProfit, profitCalendar, type ProfitLine, type ProfitOutflow } from '../reports/profit.js';
import { loadOpenPayablesReceivables } from '../or/payablesData.js';
import { getOrLicenseStatus } from '../or/license.js';
import { computeSpendableCash } from '../or/spendableCash.js';
import { loadCashForecast } from '../or/cashForecastData.js';

export class AssistantError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
const string = { type: 'string', minLength: 1, maxLength: 200 };
const schema = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const assistantTools = [
  { name: 'sales_summary', description: 'USD revenue, COGS, gross profit and expenses for inclusive local dates, maximum 366 days.', input_schema: schema({ from: string, to: string }, ['from', 'to']) },
  { name: 'product_lookup', description: 'Find up to 20 products by name or barcode. Prices and costs are USD per base piece.', input_schema: schema({ query: string }, ['query']) },
  { name: 'supplier_prices', description: 'Recent purchase unit prices, oldest first, up to 200 lines. Filter by product and/or supplier name; days 1–366.', input_schema: schema({ product: string, supplier: string, days: { type: 'integer', minimum: 1, maximum: 366 } }, ['days']) },
  { name: 'balances', description: 'Largest derived open customer receivables or supplier payables in USD. Top 1–50.', input_schema: schema({ type: { type: 'string', enum: ['customers', 'suppliers'] }, top: { type: 'integer', minimum: 1, maximum: 50 } }, ['type', 'top']) },
  { name: 'or_metrics', description: 'Licensed OR spendable cash, runway, survival mode and first forecast shortfall.', input_schema: schema({}) },
];
function text(v: unknown): v is string { return typeof v === 'string' && v.trim().length > 0 && v.length <= 200; }
function date(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v; }
export function dispatchTool(tenant: number, name: string, input: unknown): unknown {
  const definition = assistantTools.find(t => t.name === name);
  if (!definition || !input || typeof input !== 'object' || Array.isArray(input)) throw new AssistantError('assistant_invalid_tool');
  const v = input as Record<string, any>;
  if (Object.keys(v).some(k => !Object.hasOwn(definition.input_schema.properties, k))) throw new AssistantError('assistant_invalid_tool');
  const invalid = () => { throw new AssistantError('assistant_invalid_tool'); };
  if (name === 'product_lookup') {
    if (!text(v.query)) return invalid();
    return db.prepare(`SELECT p.name, p.barcode, p.stock, p.price AS price_usd, p.cost AS cost_usd,
      CASE WHEN p.price > 0 AND p.cost IS NOT NULL THEN (p.price-p.cost)*100/p.price END AS margin_percent
      FROM products p WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND
      (instr(lower(p.name), lower(?)) > 0 OR p.barcode = ? OR EXISTS
       (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.deleted_at IS NULL AND b.barcode = ?))
      ORDER BY p.name LIMIT 20`).all(tenant, v.query, v.query, v.query);
  }
  if (name === 'balances') {
    if (!['customers', 'suppliers'].includes(v.type) || !Number.isInteger(v.top) || v.top < 1 || v.top > 50) return invalid();
    const data = loadOpenPayablesReceivables(tenant);
    const grouped = new Map<number, { name: string; amount_usd: number }>();
    for (const row of v.type === 'customers' ? data.receivables : data.payables) {
      const entry = grouped.get(row.party_id) || { name: row.name, amount_usd: 0 };
      entry.amount_usd += row.amount_usd;
      grouped.set(row.party_id, entry);
    }
    return { type: v.type, basis: 'open unpaid invoices and opening debt', rows: [...grouped.values()].sort((a, b) => b.amount_usd - a.amount_usd).slice(0, v.top) };
  }
  if (name === 'supplier_prices') {
    if ((!text(v.product) && !text(v.supplier)) || (v.product !== undefined && !text(v.product)) || (v.supplier !== undefined && !text(v.supplier)) || !Number.isInteger(v.days) || v.days < 1 || v.days > 366) return invalid();
    const branch = (transactions: string, items: string) => `SELECT p.name AS product, s.name AS supplier,
      date(t.created_at, 'localtime') AS date, i.unit_price AS unit_price_usd, i.quantity AS quantity
      FROM ${transactions} t JOIN ${items} i ON i.transaction_id = t.id AND i.deleted_at IS NULL
      JOIN products p ON p.id = i.product_id AND p.tenant_id = @tenant
      JOIN stakeholders s ON s.id = t.stakeholder_id AND s.tenant_id = @tenant
      WHERE t.tenant_id = @tenant AND t.type = 'purchase' AND t.deleted_at IS NULL
      AND COALESCE(t.status, '') NOT IN ('void','voided','canceled','cancelled')
      AND date(t.created_at, 'localtime') >= date('now','localtime', @days)
      AND (@product = '' OR instr(lower(p.name),lower(@product)) > 0 OR p.barcode = @product)
      AND (@supplier = '' OR instr(lower(s.name),lower(@supplier)) > 0)`;
    return { limit: 200, prices: db.prepare(`${branch('transactions', 'transaction_items')} UNION ALL ${branch('archived_transactions', 'archived_transaction_items')} ORDER BY date, product, supplier LIMIT 200`).all({ tenant, product: v.product || '', supplier: v.supplier || '', days: `-${v.days - 1} days` }) };
  }
  if (name === 'or_metrics') {
    if (!getOrLicenseStatus(tenant).licensed) return { available: false, reason: 'OR_LICENSE_REQUIRED' };
    if (!db.prepare('SELECT 1 FROM or_tenant_config WHERE tenant_id = ? AND deleted_at IS NULL').get(tenant)) return { available: false, reason: 'OR_NOT_INITIALIZED' };
    const cash = computeSpendableCash(tenant, undefined, true);
    return { available: true, spendable_cash_usd: cash.free_spendable_cash_usd, runway_days: cash.runway_days, mode: cash.survival_mode, first_shortfall: loadCashForecast(tenant, undefined, true).first_shortfall };
  }
  if (!date(v.from) || !date(v.to) || v.from > v.to || (Date.parse(v.to) - Date.parse(v.from)) / 86400000 > 365) return invalid();
  const bounds = { tenant, from: v.from, to: v.to };
  const branch = (transactions: string, items: string) => `SELECT t.id AS transaction_id, t.type AS type,
    date(t.created_at,'localtime') AS day, t.status AS status, t.deleted_at AS deleted_at,
    CASE WHEN t.stakeholder_id = (SELECT owner_stakeholder_id FROM or_tenant_config WHERE tenant_id = @tenant AND deleted_at IS NULL) THEN 1 ELSE 0 END AS owner,
    i.quantity AS quantity, i.unit_price AS unit_price, i.unit_cost AS unit_cost, p.cost AS product_cost,
    i.discount_type AS discount_type, i.discount_value AS discount_value,
    t.discount_type AS tx_discount_type, t.discount_value AS tx_discount_value
    FROM ${transactions} t JOIN ${items} i ON i.transaction_id = t.id AND i.deleted_at IS NULL
    LEFT JOIN products p ON p.id = i.product_id AND p.tenant_id = @tenant
    WHERE t.tenant_id = @tenant AND t.type IN ('sale','refund') AND date(t.created_at,'localtime') BETWEEN @from AND @to`;
  const lines = db.prepare(`${branch('transactions', 'transaction_items')} UNION ALL ${branch('archived_transactions', 'archived_transaction_items')}`).all(bounds) as ProfitLine[];
  const outflow = (table: string) => `SELECT date(created_at,'localtime') AS day, category AS category, reason AS reason, amount AS amount, exchange_rate AS exchange_rate FROM ${table} WHERE tenant_id = @tenant AND type = 'out' AND deleted_at IS NULL AND date(created_at,'localtime') BETWEEN @from AND @to`;
  const outflows = db.prepare(`${outflow('cash_flow')} UNION ALL ${outflow('archived_cash_flow')}`).all(bounds) as ProfitOutflow[];
  const days = Array.from({ length: 1 + (Date.parse(v.to) - Date.parse(v.from)) / 86400000 }, (_, i) => new Date(Date.parse(v.from) + i * 86400000).toISOString().slice(0, 10));
  const draws = db.prepare('SELECT draw_date AS day, goods_cost_total AS amount FROM or_owner_draws WHERE tenant_id = @tenant AND deleted_at IS NULL AND draw_date BETWEEN @from AND @to').all(bounds) as { day: string; amount: number }[];
  const report = computeProfit({ ...profitCalendar(new Date()), days }, lines, outflows, draws, []);
  return { from: v.from, to: v.to, currency: 'USD', daily: report.daily, missing_cost_lines: lines.filter(l => l.unit_cost === null).length };
}
