import { db } from "../db.js";
import { computeProfit, profitCalendar, type FixedObligation, type ProfitLine, type ProfitOutflow } from "./profit.js";
import { dailySalesDate, dailySalesTypeFilter } from "./sales.js";

function salesBranch(transactions: string, items: string) {
  return `
    SELECT t.id AS transaction_id, t.type, t.day, t.status, t.deleted_at,
           CASE WHEN t.stakeholder_id = @owner THEN 1 ELSE 0 END AS owner,
           i.quantity, i.unit_price, i.unit_cost, p.cost AS product_cost, i.discount_type, i.discount_value,
           t.discount_type AS tx_discount_type, t.discount_value AS tx_discount_value
    FROM (
      SELECT *, ${dailySalesDate} AS day FROM ${transactions}
      WHERE tenant_id = @tenant AND ${dailySalesTypeFilter} AND type IN ('sale', 'refund')
        AND ${dailySalesDate} BETWEEN @from AND @to
    ) t
    JOIN ${items} i ON i.transaction_id = t.id AND i.deleted_at IS NULL
    LEFT JOIN products p ON p.id = i.product_id AND p.tenant_id = @tenant
  `;
}

function outflowBranch(table: string) {
  return `
    SELECT ${dailySalesDate} AS day, category, reason, amount, exchange_rate
    FROM ${table}
    WHERE tenant_id = @tenant AND type = 'out' AND deleted_at IS NULL
      AND ${dailySalesDate} BETWEEN @from AND @to
  `;
}

export function readProfitReport(tenant: number, now = new Date()) {
  const calendar = profitCalendar(now);
  const bounds = { tenant, from: calendar.days[0], to: calendar.days[calendar.days.length - 1] };
  const config = db.prepare(`
    SELECT owner_stakeholder_id FROM or_tenant_config
    WHERE tenant_id = ? AND deleted_at IS NULL
  `).get(tenant) as { owner_stakeholder_id: number | null } | undefined;
  const lines = db.prepare(`
    ${salesBranch("transactions", "transaction_items")}
    UNION ALL
    ${salesBranch("archived_transactions", "archived_transaction_items")}
  `).all({ ...bounds, owner: config?.owner_stakeholder_id ?? null }) as ProfitLine[];
  const outflows = db.prepare(`
    ${outflowBranch("cash_flow")} UNION ALL ${outflowBranch("archived_cash_flow")}
  `).all(bounds) as ProfitOutflow[];
  // OR cash draws already have a Core owner_withdrawal outflow. Add only the goods portion here.
  const goodsDraws = db.prepare(`
    SELECT draw_date AS day, goods_cost_total AS amount FROM or_owner_draws
    WHERE tenant_id = @tenant AND deleted_at IS NULL AND draw_date BETWEEN @from AND @to
  `).all(bounds) as { day: string; amount: number }[];
  const obligations = db.prepare(`
    SELECT amount_usd, frequency FROM or_fixed_obligations
    WHERE tenant_id = ? AND active = 1 AND deleted_at IS NULL
  `).all(tenant) as FixedObligation[];
  const categories = db.prepare("SELECT key, name FROM cash_flow_categories WHERE tenant_id = ?")
    .all(tenant) as { key: string; name: string }[];

  return { ...computeProfit(calendar, lines, outflows, goodsDraws, obligations), categories };
}
