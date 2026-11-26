import { db, logAction } from './db.js';
import { effectiveLocalRate, localRoundingStep } from './localCurrency.js';
import { localPricePatch, staleLocalPrices, paymentCurrencyShares } from './lbpRateAlerts.js';
import { writeProductFields } from './productEditFields.js';
import locales from '../src/intl/locales/lbpRateAlerts.js';
import { REAL_MONEY_SQL } from './paymentMethods.js';
import { isOrLicenseValid } from './or/license.js';
import { stableGlobalId } from './or/stableId.js';
import { localDateIso } from './or/coreBridge.js';

export function rateReview(tenantId: number, stakeholderId?: number) {
  if (stakeholderId && !db.prepare('SELECT id FROM stakeholders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL').get(tenantId, stakeholderId)) throw new Error('Unknown party');
  const local = effectiveLocalRate(tenantId, stakeholderId);
  const settings = Object.fromEntries((db.prepare("SELECT key, value FROM settings WHERE tenant_id = ? AND key IN ('lbp_rounding_step', 'lbp_stale_tolerance_pct')").all(tenantId) as any[]).map(r => [r.key, r.value]));
  const tolerance = Number.isFinite(Number(settings.lbp_stale_tolerance_pct)) && Number(settings.lbp_stale_tolerance_pct) >= 0 && Number(settings.lbp_stale_tolerance_pct) <= 100 ? Number(settings.lbp_stale_tolerance_pct) : 3;
  const step = localRoundingStep(settings.lbp_rounding_step, local?.rate);
  const products = local ? (db.prepare('SELECT * FROM products WHERE tenant_id = ? AND deleted_at IS NULL AND price_lbp IS NOT NULL').all(tenantId) as any[])
    .filter(p => staleLocalPrices(p, local.rate, tolerance, step))
    .map(p => ({ ...p, proposed: localPricePatch(p, local.rate, step) })) : [];
  return { local, tolerance, step, products };
}

export function ratePaymentShares(tenantId: number, localCode: string) {
  const branches = [['payments', 'transactions'], ['archived_payments', 'archived_transactions']].map(([payments, transactions]) => `
    SELECT t.type AS type, p.currency AS currency, SUM(p.amount / CASE WHEN UPPER(p.currency) = 'USD' THEN 1 ELSE NULLIF(p.exchange_rate, 0) END) AS usd
    FROM ${payments} p JOIN ${transactions} t ON t.id = p.transaction_id
    WHERE t.tenant_id = @tenant AND t.deleted_at IS NULL AND p.deleted_at IS NULL
      AND t.type IN ('sale', 'refund', 'purchase') AND COALESCE(t.status, '') <> 'cancelled' AND p.${REAL_MONEY_SQL}
      AND datetime(p.created_at) >= datetime('now', '-30 days') AND datetime(p.created_at) <= datetime('now')
    GROUP BY t.type, UPPER(p.currency)`);
  // Invoice payments plus later collections/payments and operating costs in the cash register.
  for (const table of ['cash_flow', 'archived_cash_flow']) branches.push(`
    SELECT CASE WHEN type = 'in' THEN 'sale' ELSE 'purchase' END AS type, currency AS currency,
      SUM(amount / CASE WHEN UPPER(currency) = 'USD' THEN 1 ELSE NULLIF(exchange_rate, 0) END) AS usd
    FROM ${table} WHERE tenant_id = @tenant AND deleted_at IS NULL
      AND ((type = 'in' AND category = 'customer_collection') OR (type = 'out' AND category IN ('supplier_payment', 'expense')))
      AND datetime(created_at) >= datetime('now', '-30 days') AND datetime(created_at) <= datetime('now')
    GROUP BY type, UPPER(currency)`);
  return paymentCurrencyShares(db.prepare(branches.join(' UNION ALL ')).all({ tenant: tenantId }) as any[], localCode);
}

export function updateLocalPrices(tenantId: number, ids: number[] | 'all', stakeholderId?: number, userId: number | null = null) {
  return db.transaction(() => {
    const review = rateReview(tenantId, stakeholderId);
    const selected = ids === 'all' ? null : new Set(ids);
    let updated = 0;
    for (const product of review.products) {
      if (selected && !selected.has(product.id)) continue;
      writeProductFields(tenantId, product.id, product.proposed, true);
      logAction(tenantId, userId, 'Product Updated', `ID: ${product.id}, LBP rate: ${review.local!.rate}, LBP prices: ${JSON.stringify(product.proposed)}`);
      updated++;
    }
    return { updated };
  })();
}

export function lbpBriefingItems(tenantId: number, date: string): Array<[number, string, string, string, string, string, null, null]> {
  const review = rateReview(tenantId);
  if (!review.local) return [];
  const rates = [review.local.rate, ...(db.prepare("SELECT DISTINCT local_rate FROM stakeholders WHERE tenant_id = ? AND deleted_at IS NULL AND local_rate > 0 AND name <> 'Walk-in Customer'").all(tenantId) as any[]).map(p => Number(p.local_rate))];
  const candidates = db.prepare('SELECT price, price_lbp, price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, package_price, package_price_lbp FROM products WHERE tenant_id = ? AND deleted_at IS NULL AND price_lbp IS NOT NULL').all(tenantId) as any[];
  const count = candidates.filter(p => rates.some(rate => staleLocalPrices(p, rate, review.tolerance, review.step))).length;
  if (!count) return [];
  const language = (db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'language'").get(tenantId) as any)?.value;
  const dictionary = locales[language as keyof typeof locales] || locales.en;
  return [[tenantId, date, 'HIGH', 'LBP_RATE', dictionary.lbp_stale.replace('{count}', String(count)), dictionary.lbp_review, null, null]];
}

// Keep today's briefing current immediately after a rate edit, even if the nightly run already ran.
// Called from currency / settings / party saves after their write: it must never fail that save.
export function refreshLbpRateBriefing(tenantId: number) {
  try { refreshLbpRateBriefingUnsafe(tenantId); } catch (e) { console.error('[lbp-rate] briefing refresh failed', e); }
}

function refreshLbpRateBriefingUnsafe(tenantId: number) {
  if (!isOrLicenseValid(tenantId)) return;
  const date = localDateIso();
  const item = lbpBriefingItems(tenantId, date)[0];
  const gid = stableGlobalId(tenantId, 'or_action_queue', date, 'LBP_RATE', '-', '-');
  if (!item) {
    db.prepare("UPDATE or_action_queue SET deleted_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND action_date = ? AND category = 'LBP_RATE' AND deleted_at IS NULL").run(tenantId, date);
    return;
  }
  const existing = db.prepare('SELECT id FROM or_action_queue WHERE global_id = ? AND tenant_id = ?').get(gid, tenantId) as any;
  if (existing) db.prepare('UPDATE or_action_queue SET title = ?, details = ?, deleted_at = NULL WHERE id = ?').run(item[4], item[5], existing.id);
  else db.prepare("INSERT INTO or_action_queue (global_id, tenant_id, action_date, priority, category, title, details, status) VALUES (?, ?, ?, 'HIGH', 'LBP_RATE', ?, ?, 'OPEN')").run(gid, tenantId, date, item[4], item[5]);
}

export function setupLbpRateAlertRoutes(app: any, authenticate: any, broadcast: any) {
  const party = (value: any) => {
    if (value == null || value === '') return undefined;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid party');
    return n;
  };
  app.get('/api/local-rate/stale-prices', authenticate, (req: any, res: any) => {
    try {
      const tenant = req.session.tenantId;
      const review = rateReview(tenant, party(req.query.stakeholder_id));
      const parties = db.prepare("SELECT id, name, local_rate FROM stakeholders WHERE tenant_id = ? AND deleted_at IS NULL AND local_rate > 0 AND name <> 'Walk-in Customer'").all(tenant);
      res.json({ ...review, parties, shares: ratePaymentShares(tenant, review.local?.code || 'LBP') });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/local-rate/update-prices', authenticate, (req: any, res: any) => {
    try {
      const ids = req.body.product_ids;
      if (ids !== 'all' && (!Array.isArray(ids) || ids.length > 10000 || ids.some((id: any) => !Number.isSafeInteger(id) || id <= 0))) return res.status(400).json({ error: 'Invalid product ids' });
      const result = updateLocalPrices(req.session.tenantId, ids, party(req.body.stakeholder_id), req.session.userId || null);
      refreshLbpRateBriefing(req.session.tenantId);
      broadcast({ type: 'PRODUCTS_UPDATED' }, req.session.tenantId);
      res.json(result);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
}
