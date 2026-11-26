import { db } from '../db.js';
import { sessionHasPermission } from '../permissions.js';
import { normalizeWhatsapp } from '../../storefront/src/phone.js';
import { localCurrencyFor } from '../localCurrency.js';
import { listCashAccounts } from '../cashAccounts.js';
import { readProfitReport } from '../reports/profitQuery.js';
import { localDateIso } from './coreBridge.js';
import { isOrLicenseValid } from './license.js';
import { loadOpenPayablesReceivables } from './payablesData.js';
import { computeSpendableCash } from './spendableCash.js';
import { loadCashForecast } from './cashForecastData.js';
import { forecastDate, obligationDue, type ForecastObligation } from './cashForecast.js';
import { marginBriefingItems } from './marginAlerts.js';
import { rateReview } from '../lbpRateAlertData.js';
import { staleLocalPrices } from '../lbpRateAlerts.js';
import { ensureOrInitialized } from './config.js';
import { loadCashierRisk } from './cashierRiskData.js';
import { buildOwnerSummary, ownerSummaryWhatsappUrl, summaryLanguage, type OwnerSummaryInput } from './ownerSummary.js';

// Existing settings already sync with tenant RLS and set_synced_at; these are new keys, not columns.
export function ownerSummarySettings(tenant: number) {
  const rows = db.prepare("SELECT key, value FROM settings WHERE tenant_id = ? AND deleted_at IS NULL AND key IN ('owner_whatsapp', 'owner_summary_language')").all(tenant) as Array<{ key: string; value: string }>;
  const values = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { owner_whatsapp: values.owner_whatsapp || '', owner_summary_language: summaryLanguage(values.owner_summary_language) };
}

export function loadOwnerSummary(tenant: number, date = forecastDate(localDateIso(), -1), language?: unknown) {
  const now = new Date(`${date}T12:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(now.getTime()) || localDateIso(now) !== date) {
    throw new Error('Invalid summary date');
  }
  const settings = ownerSummarySettings(tenant);
  const lang = language === undefined ? settings.owner_summary_language : summaryLanguage(language);
  const today = localDateIso();
  const profit = readProfitReport(tenant, now, date).daily.find(d => d.date === date)!;
  const debts = loadOpenPayablesReceivables(tenant, today);
  const countBranch = (table: string) => `SELECT COUNT(*) AS count FROM ${table}
    WHERE tenant_id = @tenant AND date(created_at, 'localtime') = @date AND type = 'sale'
    AND deleted_at IS NULL AND LOWER(COALESCE(status, '')) NOT IN ('void', 'voided', 'canceled', 'cancelled')
    AND (stakeholder_id IS NULL OR stakeholder_id != COALESCE((SELECT owner_stakeholder_id FROM or_tenant_config WHERE tenant_id = @tenant AND deleted_at IS NULL), -1))`;
  const counts = db.prepare(`${countBranch('transactions')} UNION ALL ${countBranch('archived_transactions')}`).all({ tenant, date }) as Array<{ count: number }>;
  const data: OwnerSummaryInput = {
    date, licensed: isOrLicenseValid(tenant), sales: profit.revenue, gross: profit.grossMargin,
    net: profit.netProfit, saleCount: counts.reduce((sum, r) => sum + r.count, 0),
    cash: listCashAccounts(tenant, false, true).reduce((sum, a) => sum + a.balance_usd, 0),
    local: localCurrencyFor(tenant), chase: debts.briefing.chase,
  };
  if (data.licensed) {
    ensureOrInitialized(tenant);
    data.free = computeSpendableCash(tenant, today, true).free_spendable_cash_usd;
    const forecast = loadCashForecast(tenant, today, true);
    data.shortfall = forecast.first_shortfall && forecast.first_shortfall.date <= forecastDate(today, 14) ? forecast.first_shortfall.date : null;
    const obligations = db.prepare('SELECT name, amount_usd, frequency, due_day FROM or_fixed_obligations WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL').all(tenant) as ForecastObligation[];
    data.due = debts.briefing.due_week.reduce((sum, p) => sum + p.amount_usd, 0);
    for (let i = 0; i <= 7; i++) for (const bill of obligations) {
      if (obligationDue(bill, forecastDate(today, i))) data.due += bill.amount_usd;
    }
    data.reorder = db.prepare(`SELECT p.name, m.days_of_supply FROM or_sku_metrics m
      JOIN products p ON p.id = m.product_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = ? AND p.deleted_at IS NULL
      AND IFNULL(p.active, 1) = 1 AND m.abc_class IN ('A', 'B') AND m.days_of_supply IS NOT NULL
      ORDER BY m.days_of_supply, p.name LIMIT 3`).all(tenant) as NonNullable<OwnerSummaryInput['reorder']>;
    const margin = marginBriefingItems(tenant, Infinity);
    const review = rateReview(tenant);
    let stale = review.products;
    // Match the briefing's party-specific rate checks as well as the shop's global rate.
    const partyRates = review.local ? db.prepare("SELECT DISTINCT local_rate FROM stakeholders WHERE tenant_id = ? AND deleted_at IS NULL AND local_rate > 0 AND name <> 'Walk-in Customer'").all(tenant) as Array<{ local_rate: number }> : [];
    if (partyRates.length) {
      const rates = [review.local!.rate, ...partyRates.map(p => p.local_rate)];
      const candidates = db.prepare(`SELECT name, price, price_lbp, price_wholesale, price_wholesale_lbp,
        price_super_wholesale, price_super_wholesale_lbp, package_price, package_price_lbp
        FROM products WHERE tenant_id = ? AND deleted_at IS NULL AND price_lbp IS NOT NULL ORDER BY name`).all(tenant) as any[];
      stale = candidates.filter(p => rates.some(rate => staleLocalPrices(p, rate, review.tolerance, review.step)));
    }
    const risky = loadCashierRisk(tenant, today).cashiers.filter(c => c.flags.length);
    data.alerts = {
      margin: { count: margin.length, top: margin[0]?.title || '' },
      stale: { count: stale.length, top: stale[0]?.name || '' },
      risk: { count: risky.length, top: risky[0]?.name || '' },
    };
  }
  const text = buildOwnerSummary(data, lang);
  return { text, language: lang, whatsapp_url: ownerSummaryWhatsappUrl(text, settings.owner_whatsapp) };
}

const allowed = (req: any, res: any) => {
  if (sessionHasPermission(req, 'or.manage')) return true;
  res.status(403).json({ error: 'Permission denied', code: 'PERMISSION_DENIED' });
  return false;
};

export function ownerSummaryRoute(req: any, res: any) {
  if (!allowed(req, res)) return;
  try {
    if (req.query.date !== undefined && typeof req.query.date !== 'string') throw new Error('Invalid summary date');
    if (req.query.language !== undefined && !['ar', 'en', 'fr'].includes(req.query.language)) throw new Error('Invalid summary language');
    res.json(loadOwnerSummary(req.session.tenantId, req.query.date, req.query.language));
  } catch (error: any) { res.status(400).json({ error: error.message }); }
}

export function ownerSummarySettingsRoute(req: any, res: any) {
  if (!allowed(req, res)) return;
  const tenant = req.session.tenantId;
  if (req.method === 'GET') return res.json(ownerSummarySettings(tenant));
  const { owner_whatsapp: raw, owner_summary_language: language } = req.body || {};
  if (typeof raw !== 'string' || raw.length > 50 || !['ar', 'en', 'fr'].includes(language)) return res.status(400).json({ error: 'Invalid summary settings' });
  const phone = raw.trim() ? normalizeWhatsapp(raw) : '';
  if (phone === null) return res.status(400).json({ error: 'Invalid WhatsApp number' });
  db.transaction(() => {
    const save = db.prepare('INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, deleted_at = NULL, last_synced_at = NULL');
    save.run(tenant, 'owner_whatsapp', phone);
    save.run(tenant, 'owner_summary_language', language);
  })();
  res.json(ownerSummarySettings(tenant));
}
