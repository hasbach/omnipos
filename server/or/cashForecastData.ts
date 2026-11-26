import forecastLocales from "../../src/intl/locales/cashForecast.js";
import { db } from "../db.js";
import { REAL_MONEY_SQL } from "../paymentMethods.js";
import { computeSpendableCash, averageDailyOwnerDraws } from "./spendableCash.js";
import { loadOpenPayablesReceivables } from "./payablesData.js";
import { localDateIso } from "./coreBridge.js";
import { forecastDate, projectCashForecast, type ForecastObligation } from "./cashForecast.js";

export function loadCashForecast(tenantId: number, today = localDateIso()) {
  const cash = computeSpendableCash(tenantId, today);
  const debts = loadOpenPayablesReceivables(tenantId, today);
  const branch = (table: string, payments: string) => `
    SELECT date(t.created_at, 'localtime') AS date, t.total_amount AS revenue_usd,
      (SELECT COALESCE(SUM(p.amount / COALESCE(NULLIF(p.exchange_rate, 0), 1)), 0)
       FROM ${payments} p WHERE p.transaction_id = t.id AND p.deleted_at IS NULL AND p.${REAL_MONEY_SQL}) AS cash_usd
    FROM ${table} t WHERE t.tenant_id = @tenant AND t.deleted_at IS NULL AND t.type = 'sale'
      AND COALESCE(t.status, '') NOT IN ('void', 'voided', 'canceled', 'cancelled')
      AND date(t.created_at, 'localtime') >= @from AND date(t.created_at, 'localtime') < @today
      AND (t.stakeholder_id IS NULL OR t.stakeholder_id != COALESCE(
        (SELECT owner_stakeholder_id FROM or_tenant_config WHERE tenant_id = @tenant AND deleted_at IS NULL), -1))`;
  const sales = db.prepare(`${branch('transactions', 'payments')} UNION ALL ${branch('archived_transactions', 'archived_payments')}`)
    .all({ tenant: tenantId, today, from: forecastDate(today, -56) }) as Array<{ date: string; revenue_usd: number; cash_usd: number }>;
  const revenue = sales.reduce((sum, s) => sum + s.revenue_usd, 0);
  return projectCashForecast({
    today, liquid_cash_usd: cash.total_liquid_cash_usd, min_float_usd: cash.min_drawer_float_usd,
    sales, cash_share: revenue > 0 ? sales.reduce((sum, s) => sum + s.cash_usd, 0) / revenue : 0,
    ...debts,
    obligations: db.prepare(`SELECT name, amount_usd, frequency, due_day FROM or_fixed_obligations
      WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL`).all(tenantId) as ForecastObligation[],
    pos: db.prepare(`SELECT po_number AS name, locked_cash_amount AS amount_usd, expected_delivery_date AS due_date
      FROM or_po_commitments WHERE tenant_id = ? AND deleted_at IS NULL
      AND status IN ('APPROVED_LOCKED', 'PARTIALLY_RECEIVED')`).all(tenantId) as any[],
    daily_owner_draws_usd: averageDailyOwnerDraws(tenantId),
  });
}

/** Feed the pipeline's existing stable-id upsert and retirement mechanism. */
export function cashForecastBriefing(tenantId: number, today: string): Array<[
  number, string, string, string, string, string, string | null, number | null,
]> {
  const forecast = loadCashForecast(tenantId, today);
  const shortfall = forecast.first_shortfall;
  if (!shortfall || shortfall.date > forecastDate(today, 14)) return [];
  // Queue text is stored in the shop's configured language, like other generated briefing data.
  const setting = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'language'").get(tenantId) as { value: string } | undefined;
  const lang = setting?.value === 'ar' || setting?.value === 'fr' ? setting.value : 'en';
  const t = (key: 'cf_brief_title' | 'cf_brief_details') => forecastLocales[lang][key]
    .replace('{date}', shortfall.date)
    .replace('{closing}', '$' + shortfall.closing.toFixed(2))
    .replace('{float}', '$' + forecast.min_float_usd.toFixed(2));
  return [[tenantId, today, 'HIGH', 'CASH_FORECAST', t('cf_brief_title'), t('cf_brief_details'), 'CASH_FORECAST', null]];
}
