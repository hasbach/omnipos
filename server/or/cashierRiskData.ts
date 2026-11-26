import { db } from '../db.js';
import { localDateIso } from './coreBridge.js';
import { analyzeCashierRisk, cashierBriefingItems, riskMetrics, type CashierDay } from './cashierRisk.js';
import { sessionHasPermission } from '../permissions.js';

export function loadCashierRisk(tenantId: number, today = localDateIso()) {
  const yesterday = db.prepare("SELECT date(?, '-1 day') AS date").get(today) as { date: string };
  const days = new Map<string, CashierDay>();
  const get = (r: any) => {
    const key = `${r.cashier}:${r.date}`;
    if (!days.has(key)) days.set(key, { cashier: r.cashier, name: r.name, date: r.date, sales: 0, voids: 0, refunds: 0, discounts: 0, overrides: 0, cash_difference: 0 });
    return days.get(key)!;
  };
  // Read both live and settled sales; line prices are USD per base piece. Exclude UOM,
  // package and LBP lines where today's product price cannot identify an override reliably.
  const sales = db.prepare(`
    WITH tx AS (
      SELECT t.id AS id, t.user_id AS user_id, t.created_at AS created_at, t.type AS type,
        t.status AS status, t.discount_value AS discount_value, t.price_level AS price_level,
        t.currency AS currency, 0 AS archived FROM transactions t
        WHERE t.tenant_id = ? AND t.deleted_at IS NULL AND date(t.created_at, 'localtime') >= date(?, '-60 days') AND date(t.created_at, 'localtime') < date(?)
      UNION ALL
      SELECT t.id, t.user_id, t.created_at, t.type, t.status, t.discount_value, t.price_level, t.currency, 1
        FROM archived_transactions t WHERE t.tenant_id = ? AND t.deleted_at IS NULL AND date(t.created_at, 'localtime') >= date(?, '-60 days') AND date(t.created_at, 'localtime') < date(?)
    ), lines AS (
      SELECT i.transaction_id AS transaction_id, i.product_id AS product_id, i.unit_price AS unit_price,
        i.discount_value AS discount_value, i.uom_id AS uom_id, 0 AS archived FROM transaction_items i
      UNION ALL SELECT i.transaction_id, i.product_id, i.unit_price, i.discount_value, i.uom_id, 1 FROM archived_transaction_items i
    )
    SELECT u.global_id AS cashier, u.name AS name, date(t.created_at, 'localtime') AS date,
      (SELECT s.global_id FROM cashier_shifts s WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id
        AND s.deleted_at IS NULL AND s.date = date(t.created_at, 'localtime') AND s.created_at >= t.created_at
        ORDER BY s.created_at, s.id LIMIT 1) AS shift,
      SUM(CASE WHEN t.type = 'sale' AND COALESCE(t.status, '') NOT IN ('void', 'voided', 'cancelled') THEN 1 ELSE 0 END) AS sales,
      SUM(CASE WHEN t.type = 'sale' AND t.status IN ('void', 'voided', 'cancelled') THEN 1 ELSE 0 END) AS voids,
      SUM(CASE WHEN t.type = 'refund' THEN 1 ELSE 0 END) AS refunds,
      SUM(CASE WHEN t.type = 'sale' AND COALESCE(t.status, '') NOT IN ('void', 'voided', 'cancelled') AND (t.discount_value > 0 OR EXISTS
        (SELECT 1 FROM lines i WHERE i.transaction_id = t.id AND i.archived = t.archived AND i.discount_value > 0)) THEN 1 ELSE 0 END) AS discounts,
      SUM(CASE WHEN t.type = 'sale' AND COALESCE(t.status, '') NOT IN ('void', 'voided', 'cancelled') AND t.currency = 'USD' AND t.price_level IS NOT NULL AND EXISTS (
        SELECT 1 FROM lines i JOIN products p ON p.id = i.product_id AND p.tenant_id = ?
        WHERE i.transaction_id = t.id AND i.archived = t.archived AND i.uom_id IS NULL AND COALESCE(p.package_price, 0) = 0
          AND i.unit_price + 0.000001 < CASE t.price_level
            WHEN 'super_wholesale' THEN COALESCE(NULLIF(p.price_super_wholesale, 0), NULLIF(p.price_wholesale, 0), p.price)
            WHEN 'wholesale' THEN COALESCE(NULLIF(p.price_wholesale, 0), p.price) ELSE p.price END
      ) THEN 1 ELSE 0 END) AS overrides
    FROM tx t JOIN users u ON u.id = t.user_id AND u.tenant_id = ?
    WHERE u.global_id IS NOT NULL AND t.type IN ('sale', 'refund') GROUP BY u.id, date(t.created_at, 'localtime'), shift
  `).all(tenantId, today, today, tenantId, today, today, tenantId, tenantId) as any[];
  for (const row of sales) {
    const day = get(row);
    day.sales += row.sales;
    for (const metric of riskMetrics) if (metric !== 'cash_difference') day[metric] += row[metric];
  }
  const shifts = db.prepare(`SELECT u.global_id AS cashier, u.name AS name, s.date AS date,
    s.global_id AS shift, s.created_at AS closed_at, s.expected_cash AS expected_cash,
    s.actual_cash AS actual_cash, (s.actual_cash - s.expected_cash) AS difference
    FROM cashier_shifts s JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.date >= date(?, '-60 days') AND s.date < date(?) AND s.deleted_at IS NULL
    ORDER BY s.created_at, s.id`).all(tenantId, today, today) as any[];
  for (const shift of shifts) get(shift).cash_difference += Math.abs(shift.difference);
  // Settlement clears cashier_shifts, but the close audit log survives. Prefer shift rows
  // for a cashier/day so the same close is never counted twice.
  const liveDays = new Set(shifts.map(s => `${s.cashier}:${s.date}`));
  const closes = db.prepare(`SELECT u.global_id AS cashier, u.name AS name, date(l.created_at, 'localtime') AS date, l.details AS details
    FROM user_logs l JOIN users u ON u.id = l.user_id AND u.tenant_id = l.tenant_id
    WHERE l.tenant_id = ? AND l.action = 'Cashier Cash Out'
      AND date(l.created_at, 'localtime') >= date(?, '-60 days') AND date(l.created_at, 'localtime') < date(?)`).all(tenantId, today, today) as any[];
  for (const close of closes) {
    if (liveDays.has(`${close.cashier}:${close.date}`)) continue;
    const match = /Diff: (-?\d+(?:\.\d+)?)/.exec(close.details || '');
    if (match) get(close).cash_difference += Math.abs(Number(match[1]));
  }
  const shiftMetrics = new Map(sales.filter(s => s.shift).map(s => [s.shift, s]));
  return { date: yesterday.date, daily: [...days.values()], shifts: shifts.map(s => ({ ...s,
    sales: shiftMetrics.get(s.shift)?.sales ?? 0,
    refunds: shiftMetrics.get(s.shift)?.refunds ?? 0,
    discounts: shiftMetrics.get(s.shift)?.discounts ?? 0,
    overrides: shiftMetrics.get(s.shift)?.overrides ?? 0,
    voids: shiftMetrics.get(s.shift)?.voids ?? 0,
  })), cashiers: analyzeCashierRisk([...days.values()], yesterday.date) };
}

export function cashierRiskBriefing(tenantId: number, today: string) {
  return cashierBriefingItems(loadCashierRisk(tenantId, today).cashiers);
}

export function cashierRiskRoute(req: any, res: any) {
  if (!sessionHasPermission(req, 'or.manage')) return res.status(403).json({ error: 'Permission denied', code: 'PERMISSION_DENIED' });
  try { return res.json(loadCashierRisk(req.session.tenantId)); }
  catch (error: any) { return res.status(500).json({ error: error.message }); }
}

/** The shared briefing is readable with or.view; redact admin-only activity there too. */
export function protectCashierBriefing(req: any, res: any, next: any) {
  if (!sessionHasPermission(req, 'or.manage')) {
    const json = res.json.bind(res);
    res.json = (body: any) => json(body && Array.isArray(body.actions)
      ? { ...body, actions: body.actions.filter((item: any) => !String(item.category).startsWith('CASHIER_RISK:')) }
      : body);
  }
  next();
}
