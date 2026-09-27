// Professional reporting API — 1.2.0 upgrade (see docs/plans/2026-09-28-pro-upgrade.md, "Reports —
// server/reports.ts"). Every endpoint is tenant-scoped (req.session.tenantId), takes `from`/`to`
// query params as local YYYY-MM-DD (inclusive, default = current local month start -> today),
// compares against date(created_at,'localtime'), ALWAYS unions live + archived tables, and reports
// money in USD.
//
// Shared convention: a sale/refund line's "revenue" is its line-discounted total (unit_price*qty
// after the PER-LINE discount) with the transaction's GLOBAL discount then allocated to it
// proportionally to its share of the invoice subtotal (the sum of all its lines' line-discounted
// totals). Tax is never part of revenue — it's reported separately. This is computed once, by
// computeAllocatedLines() below, and every per-line report (by-product, by-category, by-customer,
// by-cashier) is built from that same array so they all reconcile with /api/reports/summary.
import { db } from "./db.js";

// ---------------------------------------------------------------------------
// Small local helpers (deliberately NOT imported from routes.ts — that module imports this one,
// and importing back would create a circular import).
// ---------------------------------------------------------------------------

function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
}

function localMonthStart(): string {
  const today = localToday();
  return today.slice(0, 7) + "-01";
}

function resolveRange(query: any): { from: string; to: string } {
  const from = typeof query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? query.from : localMonthStart();
  const to = typeof query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.to) ? query.to : localToday();
  return { from, to };
}

// Matches the exact per-item discount math used by POST /api/transactions (unit_price*qty, then a
// percentage or fixed discount applied on top; fixed is floored at 0).
function lineNet(unitPrice: number, qty: number, discountType: string | null, discountValue: number | null): number {
  let total = unitPrice * qty;
  if (discountValue) {
    total = discountType === "percentage" ? total * (1 - discountValue / 100) : Math.max(0, total - discountValue);
  }
  return total;
}

// The global (whole-invoice) discount amount, matching POST's clamping: a percentage is applied to
// the subtotal, a fixed amount is clamped to it (never inflates a line's share past 100%).
function globalDiscountAmount(subtotal: number, discountType: string | null, discountValue: number | null): number {
  if (!discountValue) return 0;
  if (discountType === "percentage") return subtotal * (discountValue / 100);
  if (discountType === "fixed") return Math.min(discountValue, subtotal);
  return 0;
}

interface RawLine {
  transaction_id: number;
  type: string;
  product_id: number;
  quantity: number;
  unit_price: number;
  discount_type: string | null;
  discount_value: number | null;
  unit_cost: number | null;
  tx_discount_type: string | null;
  tx_discount_value: number | null;
  stakeholder_id: number | null;
  user_id: number | null;
  created_at: string;
  local_date: string;
  product_name: string;
  barcode: string | null;
  category: string | null;
  product_cost: number | null;
}

export interface AllocatedLine {
  transaction_id: number;
  type: string;
  product_id: number;
  quantity: number;
  unit_price: number;
  unit_cost: number;
  stakeholder_id: number | null;
  user_id: number | null;
  created_at: string;
  local_date: string; // YYYY-MM-DD in the machine's local time (SQLite 'localtime', DST-correct)
  product_name: string;
  barcode: string | null;
  category: string;
  revenue: number; // this line's share of the invoice, net of line + allocated global discount, excl. tax
  cogs: number;
  discountGiven: number; // list price (unit_price*qty) minus revenue — line + allocated global discount
}

const LINE_SELECT_LIVE = `
  SELECT ti.transaction_id as transaction_id, t.type as type, ti.product_id as product_id,
         ti.quantity as quantity, ti.unit_price as unit_price, ti.discount_type as discount_type,
         ti.discount_value as discount_value, ti.unit_cost as unit_cost,
         t.discount_type as tx_discount_type, t.discount_value as tx_discount_value,
         t.stakeholder_id as stakeholder_id, t.user_id as user_id, t.created_at as created_at, date(t.created_at,'localtime') as local_date,
         p.name as product_name, p.barcode as barcode, p.category as category, p.cost as product_cost
  FROM transaction_items ti
  JOIN transactions t ON t.id = ti.transaction_id
  JOIN products p ON p.id = ti.product_id
  WHERE t.tenant_id = ? AND t.type IN ('sale','refund') AND date(t.created_at,'localtime') BETWEEN ? AND ?
`;

const LINE_SELECT_ARCHIVED = `
  SELECT ati.transaction_id as transaction_id, at.type as type, ati.product_id as product_id,
         ati.quantity as quantity, ati.unit_price as unit_price, ati.discount_type as discount_type,
         ati.discount_value as discount_value, ati.unit_cost as unit_cost,
         at.discount_type as tx_discount_type, at.discount_value as tx_discount_value,
         at.stakeholder_id as stakeholder_id, at.user_id as user_id, at.created_at as created_at, date(at.created_at,'localtime') as local_date,
         p.name as product_name, p.barcode as barcode, p.category as category, p.cost as product_cost
  FROM archived_transaction_items ati
  JOIN archived_transactions at ON at.id = ati.transaction_id
  JOIN products p ON p.id = ati.product_id
  WHERE at.tenant_id = ? AND at.type IN ('sale','refund') AND date(at.created_at,'localtime') BETWEEN ? AND ?
`;

// Fetches every sale/refund line (live + archived) in range and returns them with the invoice's
// global discount already allocated — the single source of truth every per-line report builds on.
function computeAllocatedLines(tenantId: number, from: string, to: string): AllocatedLine[] {
  const rows = db.prepare(`${LINE_SELECT_LIVE} UNION ALL ${LINE_SELECT_ARCHIVED}`).all(
    tenantId, from, to, tenantId, from, to
  ) as RawLine[];

  // Pass 1: per-transaction subtotal (sum of each line's line-discounted total).
  const subtotalByTx = new Map<number, number>();
  const firstRowByTx = new Map<number, RawLine>(); // O(1) lookup of the tx's global discount (was a linear find per tx)
  const netByLine: number[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const net = lineNet(r.unit_price, r.quantity, r.discount_type, r.discount_value);
    netByLine[i] = net;
    subtotalByTx.set(r.transaction_id, (subtotalByTx.get(r.transaction_id) || 0) + net);
    if (!firstRowByTx.has(r.transaction_id)) firstRowByTx.set(r.transaction_id, r);
  }

  // Pass 2: allocate each transaction's global discount to its lines proportionally.
  const ratioByTx = new Map<number, number>();
  for (const [txId, subtotal] of subtotalByTx) {
    const first = firstRowByTx.get(txId)!;
    const discAmt = globalDiscountAmount(subtotal, first.tx_discount_type, first.tx_discount_value);
    ratioByTx.set(txId, subtotal > 0 ? discAmt / subtotal : 0);
  }

  return rows.map((r, i) => {
    const ratio = ratioByTx.get(r.transaction_id) || 0;
    const revenue = netByLine[i] * (1 - ratio);
    const cogs = r.quantity * (r.unit_cost ?? r.product_cost ?? 0);
    const listPrice = r.unit_price * r.quantity;
    return {
      transaction_id: r.transaction_id,
      type: r.type,
      product_id: r.product_id,
      quantity: r.quantity,
      unit_price: r.unit_price,
      unit_cost: r.unit_cost ?? r.product_cost ?? 0,
      stakeholder_id: r.stakeholder_id,
      user_id: r.user_id,
      created_at: r.created_at,
      local_date: r.local_date,
      product_name: r.product_name,
      barcode: r.barcode,
      category: r.category || "Uncategorized",
      revenue,
      cogs,
      discountGiven: listPrice - revenue,
    };
  });
}

// Signed contribution to net figures: a sale line adds, a refund line subtracts.
function sign(line: AllocatedLine): 1 | -1 {
  return line.type === "refund" ? -1 : 1;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Aggregate helpers not derived from line data.
// ---------------------------------------------------------------------------

function cashFlowTotals(tenantId: number, from: string, to: string, excludeSupplierPayments = false): { cash_in: number; cash_out: number } {
  const supplierFilter = excludeSupplierPayments ? " AND (reason IS NULL OR (reason NOT LIKE 'Payment to supplier%' AND reason NOT LIKE 'Payment on invoice%'))" : "";
  const row = db.prepare(`
    SELECT
      IFNULL(SUM(CASE WHEN type = 'in' THEN amount / exchange_rate ELSE 0 END), 0) as cash_in,
      IFNULL(SUM(CASE WHEN type = 'out' THEN amount / exchange_rate ELSE 0 END), 0) as cash_out
    FROM (
      SELECT type, amount, exchange_rate, reason, created_at FROM cash_flow WHERE tenant_id = ?
      UNION ALL
      SELECT type, amount, exchange_rate, reason, created_at FROM archived_cash_flow WHERE tenant_id = ?
    )
    WHERE date(created_at,'localtime') BETWEEN ? AND ?${supplierFilter}
  `).get(tenantId, tenantId, from, to) as any;
  return { cash_in: row.cash_in || 0, cash_out: row.cash_out || 0 };
}

function purchasesTotal(tenantId: number, from: string, to: string): number {
  const row = db.prepare(`
    SELECT IFNULL(SUM(total_amount), 0) as total FROM (
      SELECT total_amount, created_at FROM transactions WHERE tenant_id = ? AND type = 'purchase'
      UNION ALL
      SELECT total_amount, created_at FROM archived_transactions WHERE tenant_id = ? AND type = 'purchase'
    ) WHERE date(created_at,'localtime') BETWEEN ? AND ?
  `).get(tenantId, tenantId, from, to) as any;
  return row.total || 0;
}

// Non-credit payments collected in USD, for sale tickets created within range.
function collectedOnSales(tenantId: number, from: string, to: string): number {
  const row = db.prepare(`
    SELECT IFNULL(SUM(amount / exchange_rate), 0) as total FROM (
      SELECT pay.amount as amount, pay.exchange_rate as exchange_rate FROM payments pay
      JOIN transactions t ON t.id = pay.transaction_id
      WHERE t.tenant_id = ? AND t.type = 'sale' AND pay.method != 'credit'
        AND date(t.created_at,'localtime') BETWEEN ? AND ?
      UNION ALL
      SELECT apay.amount, apay.exchange_rate FROM archived_payments apay
      JOIN archived_transactions at ON at.id = apay.transaction_id
      WHERE at.tenant_id = ? AND at.type = 'sale' AND apay.method != 'credit'
        AND date(at.created_at,'localtime') BETWEEN ? AND ?
    )
  `).get(tenantId, from, to, tenantId, from, to) as any;
  return row.total || 0;
}

// tax collected on sale invoices in range: total_amount - (subtotal - global discount), per tx.
function taxOnSales(tenantId: number, from: string, to: string): number {
  // Per-invoice subtotal is aggregated in SQL (a LEFT JOIN, not an IN (...id list) — a year of a busy
  // store easily exceeds SQLite's bound-variable limit). The line math mirrors lineNet().
  const lineExpr = (a: string) => `CASE WHEN ${a}.discount_value IS NULL OR ${a}.discount_value = 0 THEN ${a}.unit_price * ${a}.quantity
    WHEN ${a}.discount_type = 'percentage' THEN ${a}.unit_price * ${a}.quantity * (1 - ${a}.discount_value / 100.0)
    ELSE MAX(0, ${a}.unit_price * ${a}.quantity - ${a}.discount_value) END`;
  const txs = db.prepare(`
    SELECT t.total_amount, t.discount_type, t.discount_value, IFNULL(SUM(${lineExpr('ti')}), 0) as subtotal
    FROM transactions t LEFT JOIN transaction_items ti ON ti.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'sale' AND date(t.created_at,'localtime') BETWEEN ? AND ?
    GROUP BY t.id
    UNION ALL
    SELECT t.total_amount, t.discount_type, t.discount_value, IFNULL(SUM(${lineExpr('ti')}), 0) as subtotal
    FROM archived_transactions t LEFT JOIN archived_transaction_items ti ON ti.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'sale' AND date(t.created_at,'localtime') BETWEEN ? AND ?
    GROUP BY t.id
  `).all(tenantId, from, to, tenantId, from, to) as any[];
  let tax = 0;
  for (const t of txs) {
    const afterDiscount = t.subtotal - globalDiscountAmount(t.subtotal, t.discount_type, t.discount_value);
    tax += (t.total_amount || 0) - afterDiscount;
  }
  return tax;
}

function receivablesPayables(tenantId: number): { receivables: number; payables: number } {
  const rows = db.prepare("SELECT type, balance FROM stakeholders WHERE tenant_id = ? AND balance < 0").all(tenantId) as any[];
  let receivables = 0;
  let payables = 0;
  for (const r of rows) {
    if (r.type === "customer") receivables += -r.balance;
    else if (r.type === "supplier") payables += -r.balance;
  }
  return { receivables, payables };
}

function inventoryValue(tenantId: number): { cost: number; retail: number } {
  const rows = db.prepare("SELECT stock, cost, price FROM products WHERE tenant_id = ? AND track_inventory = 1 AND stock > 0").all(tenantId) as any[];
  let cost = 0;
  let retail = 0;
  for (const r of rows) {
    cost += r.stock * (r.cost || 0);
    retail += r.stock * (r.price || 0);
  }
  return { cost, retail };
}

function lowStockCount(tenantId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM products
    WHERE tenant_id = ? AND track_inventory = 1 AND (stock <= 0 OR (reorder_point > 0 AND stock <= reorder_point))
  `).get(tenantId) as any;
  return row.c || 0;
}

// Excludes debt-payment tickets (type='sale', total_amount=0, no items) from sale counting.
function saleTxSummary(tenantId: number, from: string, to: string): { sale_count: number; sales_gross: number } {
  const rows = db.prepare(`
    SELECT id, total_amount FROM transactions
    WHERE tenant_id = ? AND type = 'sale' AND date(created_at,'localtime') BETWEEN ? AND ?
    UNION ALL
    SELECT id, total_amount FROM archived_transactions
    WHERE tenant_id = ? AND type = 'sale' AND date(created_at,'localtime') BETWEEN ? AND ?
  `).all(tenantId, from, to, tenantId, from, to) as any[];
  let sale_count = 0;
  for (const t of rows) {
    if (t.total_amount === 0) {
      const hasLiveItems = db.prepare("SELECT 1 FROM transaction_items WHERE transaction_id = ? LIMIT 1").get(t.id);
      const hasArchItems = db.prepare("SELECT 1 FROM archived_transaction_items WHERE transaction_id = ? LIMIT 1").get(t.id);
      if (!hasLiveItems && !hasArchItems) continue; // debt-payment ticket
    }
    sale_count++;
  }
  return { sale_count, sales_gross: 0 };
}

function txCount(tenantId: number, from: string, to: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM (
      SELECT id FROM transactions WHERE tenant_id = ? AND type IN ('sale','refund','purchase') AND date(created_at,'localtime') BETWEEN ? AND ?
      UNION ALL
      SELECT id FROM archived_transactions WHERE tenant_id = ? AND type IN ('sale','refund','purchase') AND date(created_at,'localtime') BETWEEN ? AND ?
    )
  `).get(tenantId, from, to, tenantId, from, to) as any;
  return row.c || 0;
}

// ---------------------------------------------------------------------------
// Route setup
// ---------------------------------------------------------------------------

export function setupReportRoutes(app: any, authenticate: any) {
  app.get("/api/reports/summary", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);
      const lines = computeAllocatedLines(tenantId, from, to);

      let sales = 0;
      let refunds = 0;
      let cogsSale = 0;
      let cogsRefund = 0;
      let discounts = 0;
      for (const l of lines) {
        if (l.type === "sale") {
          sales += l.revenue;
          cogsSale += l.cogs;
          discounts += l.discountGiven;
        } else if (l.type === "refund") {
          refunds += l.revenue;
          cogsRefund += l.cogs;
        }
      }
      const net_sales = sales - refunds;
      const cogs = cogsSale - cogsRefund;
      const gross_profit = net_sales - cogs;
      const margin_pct = net_sales !== 0 ? (gross_profit / net_sales) * 100 : 0;

      const purchases = purchasesTotal(tenantId, from, to);
      const { cash_in, cash_out } = cashFlowTotals(tenantId, from, to);
      const { sale_count } = saleTxSummary(tenantId, from, to);
      const tx_count = txCount(tenantId, from, to);
      const avg_ticket = sale_count > 0 ? sales / sale_count : 0;
      const collected = collectedOnSales(tenantId, from, to);
      const tax = taxOnSales(tenantId, from, to);
      const { receivables, payables } = receivablesPayables(tenantId);
      const inv = inventoryValue(tenantId);
      const low_stock_count = lowStockCount(tenantId);

      res.json({
        from, to,
        sales: round2(sales),
        refunds: round2(refunds),
        net_sales: round2(net_sales),
        discounts: round2(discounts),
        cogs: round2(cogs),
        gross_profit: round2(gross_profit),
        margin_pct: round2(margin_pct),
        purchases: round2(purchases),
        tax: round2(tax),
        cash_in: round2(cash_in),
        cash_out: round2(cash_out),
        tx_count,
        sale_count,
        avg_ticket: round2(avg_ticket),
        collected: round2(collected),
        receivables: round2(receivables),
        payables: round2(payables),
        inventory_value_cost: round2(inv.cost),
        inventory_value_retail: round2(inv.retail),
        low_stock_count,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/sales-trend", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);
      const group = (req.query.group === "week" || req.query.group === "month") ? req.query.group : "day";
      const lines = computeAllocatedLines(tenantId, from, to);

      // local_date is already the local calendar day (SQLite 'localtime', DST-aware).
      const periodOf = (localDate: string): string => {
        const [y, mm, day] = localDate.split("-").map(Number);
        const m = mm - 1;
        if (group === "day") return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (group === "month") return `${y}-${String(m + 1).padStart(2, "0")}`;
        // week: ISO-ish week starting Monday, labeled by that Monday's date
        const dt = new Date(Date.UTC(y, m, day));
        const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
        dt.setUTCDate(dt.getUTCDate() - dow);
        return dt.toISOString().split("T")[0];
      };

      const buckets = new Map<string, { sales: number; refunds: number; cogs: number; count: number }>();
      for (const l of lines) {
        const period = periodOf(l.local_date);
        if (!buckets.has(period)) buckets.set(period, { sales: 0, refunds: 0, cogs: 0, count: 0 });
        const b = buckets.get(period)!;
        if (l.type === "sale") { b.sales += l.revenue; b.cogs += l.cogs; }
        else { b.refunds += l.revenue; b.cogs -= l.cogs; }
      }
      // Count distinct sale transactions per period.
      const seenTx = new Set<string>();
      for (const l of lines) {
        if (l.type !== "sale") continue;
        const period = periodOf(l.local_date);
        const key = `${period}:${l.transaction_id}`;
        if (seenTx.has(key)) continue;
        seenTx.add(key);
        buckets.get(period)!.count++;
      }

      // Fill continuous periods between from/to (ascending), including empty ones.
      const result: any[] = [];
      if (group === "day") {
        let cur = new Date(from + "T00:00:00Z");
        const end = new Date(to + "T00:00:00Z");
        while (cur <= end) {
          const period = cur.toISOString().split("T")[0];
          const b = buckets.get(period) || { sales: 0, refunds: 0, cogs: 0, count: 0 };
          result.push({ period, sales: round2(b.sales), refunds: round2(b.refunds), net: round2(b.sales - b.refunds), cogs: round2(b.cogs), profit: round2(b.sales - b.refunds - b.cogs), count: b.count });
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      } else if (group === "week") {
        const dowOf = (d: Date) => (d.getUTCDay() + 6) % 7;
        let cur = new Date(from + "T00:00:00Z");
        cur.setUTCDate(cur.getUTCDate() - dowOf(cur));
        const end = new Date(to + "T00:00:00Z");
        while (cur <= end) {
          const period = cur.toISOString().split("T")[0];
          const b = buckets.get(period) || { sales: 0, refunds: 0, cogs: 0, count: 0 };
          result.push({ period, sales: round2(b.sales), refunds: round2(b.refunds), net: round2(b.sales - b.refunds), cogs: round2(b.cogs), profit: round2(b.sales - b.refunds - b.cogs), count: b.count });
          cur.setUTCDate(cur.getUTCDate() + 7);
        }
      } else {
        let cur = new Date(from.slice(0, 7) + "-01T00:00:00Z");
        const end = new Date(to.slice(0, 7) + "-01T00:00:00Z");
        while (cur <= end) {
          const period = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`;
          const b = buckets.get(period) || { sales: 0, refunds: 0, cogs: 0, count: 0 };
          result.push({ period, sales: round2(b.sales), refunds: round2(b.refunds), net: round2(b.sales - b.refunds), cogs: round2(b.cogs), profit: round2(b.sales - b.refunds - b.cogs), count: b.count });
          cur.setUTCMonth(cur.getUTCMonth() + 1);
        }
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/by-product", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);
      const lines = computeAllocatedLines(tenantId, from, to);

      const byProduct = new Map<number, any>();
      for (const l of lines) {
        if (!byProduct.has(l.product_id)) {
          byProduct.set(l.product_id, { product_id: l.product_id, name: l.product_name, barcode: l.barcode, category: l.category, qty: 0, revenue: 0, cogs: 0 });
        }
        const p = byProduct.get(l.product_id);
        const s = sign(l);
        p.qty += s * l.quantity;
        p.revenue += s * l.revenue;
        p.cogs += s * l.cogs;
      }

      let rows = Array.from(byProduct.values()).map((p) => {
        const profit = p.revenue - p.cogs;
        const margin_pct = p.revenue !== 0 ? (profit / p.revenue) * 100 : 0;
        return { ...p, qty: round2(p.qty), revenue: round2(p.revenue), cogs: round2(p.cogs), profit: round2(profit), margin_pct: round2(margin_pct) };
      });

      const sort = req.query.sort === "qty" || req.query.sort === "profit" || req.query.sort === "margin" ? req.query.sort : "revenue";
      const sortKey = sort === "margin" ? "margin_pct" : sort;
      rows.sort((a, b) => b[sortKey] - a[sortKey]);

      const limit = Number(req.query.limit);
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/by-category", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);
      const lines = computeAllocatedLines(tenantId, from, to);

      const byCategory = new Map<string, any>();
      for (const l of lines) {
        const key = l.category;
        if (!byCategory.has(key)) byCategory.set(key, { category: key, qty: 0, revenue: 0, cogs: 0 });
        const c = byCategory.get(key);
        const s = sign(l);
        c.qty += s * l.quantity;
        c.revenue += s * l.revenue;
        c.cogs += s * l.cogs;
      }
      const totalRevenue = Array.from(byCategory.values()).reduce((sum, c) => sum + c.revenue, 0);
      const rows = Array.from(byCategory.values()).map((c) => {
        const profit = c.revenue - c.cogs;
        const margin_pct = c.revenue !== 0 ? (profit / c.revenue) * 100 : 0;
        const share_pct = totalRevenue !== 0 ? (c.revenue / totalRevenue) * 100 : 0;
        return { category: c.category, qty: round2(c.qty), revenue: round2(c.revenue), cogs: round2(c.cogs), profit: round2(profit), margin_pct: round2(margin_pct), share_pct: round2(share_pct) };
      }).sort((a, b) => b.revenue - a.revenue);

      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/by-customer", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);
      const lines = computeAllocatedLines(tenantId, from, to);

      const byCustomer = new Map<number, any>();
      const invoiceSeen = new Map<number, Set<number>>();
      for (const l of lines) {
        if (!l.stakeholder_id) continue;
        if (!byCustomer.has(l.stakeholder_id)) {
          byCustomer.set(l.stakeholder_id, { stakeholder_id: l.stakeholder_id, revenue: 0, cogs: 0 });
          invoiceSeen.set(l.stakeholder_id, new Set());
        }
        const c = byCustomer.get(l.stakeholder_id);
        const s = sign(l);
        c.revenue += s * l.revenue;
        c.cogs += s * l.cogs;
        if (l.type === "sale") invoiceSeen.get(l.stakeholder_id)!.add(l.transaction_id);
      }

      const ids = Array.from(byCustomer.keys());
      const names = new Map<number, string>();
      const balances = new Map<number, number>();
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`SELECT id, name, balance FROM stakeholders WHERE tenant_id = ? AND id IN (${placeholders})`).all(tenantId, ...ids) as any[];
        for (const r of rows) { names.set(r.id, r.name); balances.set(r.id, r.balance || 0); }
      }

      // "paid" = non-credit USD payments collected from this customer's sale tickets in range.
      const paidByCustomer = new Map<number, number>();
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`
          SELECT stakeholder_id, IFNULL(SUM(amount / exchange_rate), 0) as paid FROM (
            SELECT t.stakeholder_id as stakeholder_id, pay.amount as amount, pay.exchange_rate as exchange_rate
            FROM payments pay JOIN transactions t ON t.id = pay.transaction_id
            WHERE t.tenant_id = ? AND t.type = 'sale' AND pay.method != 'credit' AND t.stakeholder_id IN (${placeholders})
              AND date(t.created_at,'localtime') BETWEEN ? AND ?
            UNION ALL
            SELECT at.stakeholder_id, apay.amount, apay.exchange_rate
            FROM archived_payments apay JOIN archived_transactions at ON at.id = apay.transaction_id
            WHERE at.tenant_id = ? AND at.type = 'sale' AND apay.method != 'credit' AND at.stakeholder_id IN (${placeholders})
              AND date(at.created_at,'localtime') BETWEEN ? AND ?
          ) GROUP BY stakeholder_id
        `).all(tenantId, ...ids, from, to, tenantId, ...ids, from, to) as any[];
        for (const r of rows) paidByCustomer.set(r.stakeholder_id, r.paid || 0);
      }

      const result = Array.from(byCustomer.values()).map((c) => ({
        stakeholder_id: c.stakeholder_id,
        name: names.get(c.stakeholder_id) || `#${c.stakeholder_id}`,
        invoices: invoiceSeen.get(c.stakeholder_id)?.size || 0,
        revenue: round2(c.revenue),
        profit: round2(c.revenue - c.cogs),
        paid: round2(paidByCustomer.get(c.stakeholder_id) || 0),
        balance: round2(balances.get(c.stakeholder_id) || 0),
      })).sort((a, b) => b.revenue - a.revenue);

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/by-cashier", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);
      const lines = computeAllocatedLines(tenantId, from, to);

      const byCashier = new Map<number, any>();
      const invoiceSeen = new Map<number, Set<number>>();
      for (const l of lines) {
        if (!l.user_id) continue;
        if (!byCashier.has(l.user_id)) {
          byCashier.set(l.user_id, { user_id: l.user_id, revenue: 0, refunds: 0 });
          invoiceSeen.set(l.user_id, new Set());
        }
        const c = byCashier.get(l.user_id);
        if (l.type === "sale") {
          c.revenue += l.revenue;
          invoiceSeen.get(l.user_id)!.add(l.transaction_id);
        } else {
          c.refunds += l.revenue;
        }
      }

      const ids = Array.from(byCashier.keys());
      const names = new Map<number, string>();
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`SELECT id, name FROM users WHERE tenant_id = ? AND id IN (${placeholders})`).all(tenantId, ...ids) as any[];
        for (const r of rows) names.set(r.id, r.name);
      }

      const result = Array.from(byCashier.values()).map((c) => {
        const invoices = invoiceSeen.get(c.user_id)?.size || 0;
        return {
          user_id: c.user_id,
          name: names.get(c.user_id) || `#${c.user_id}`,
          invoices,
          revenue: round2(c.revenue),
          refunds: round2(c.refunds),
          avg_ticket: round2(invoices > 0 ? c.revenue / invoices : 0),
        };
      }).sort((a, b) => b.revenue - a.revenue);

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/by-payment-method", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);

      const rows = db.prepare(`
        SELECT
          CASE WHEN type = 'refund' THEN 'refund' ELSE type END as kind,
          method, currency,
          SUM(amount) as amount, SUM(amount / exchange_rate) as amount_usd, COUNT(*) as count
        FROM (
          SELECT t.type as type, pay.method as method, pay.currency as currency, pay.amount as amount, pay.exchange_rate as exchange_rate
          FROM payments pay JOIN transactions t ON t.id = pay.transaction_id
          WHERE t.tenant_id = ? AND t.type IN ('sale','purchase','refund') AND date(t.created_at,'localtime') BETWEEN ? AND ?
          UNION ALL
          SELECT at.type, apay.method, apay.currency, apay.amount, apay.exchange_rate
          FROM archived_payments apay JOIN archived_transactions at ON at.id = apay.transaction_id
          WHERE at.tenant_id = ? AND at.type IN ('sale','purchase','refund') AND date(at.created_at,'localtime') BETWEEN ? AND ?
        )
        GROUP BY kind, method, currency
        ORDER BY kind, method, currency
      `).all(tenantId, from, to, tenantId, from, to) as any[];

      res.json(rows.map((r) => ({ kind: r.kind, method: r.method, currency: r.currency, amount: round2(r.amount), amount_usd: round2(r.amount_usd), count: r.count })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/by-supplier", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);

      const txRows = db.prepare(`
        SELECT id, stakeholder_id, total_amount FROM transactions
        WHERE tenant_id = ? AND type = 'purchase' AND stakeholder_id IS NOT NULL AND date(created_at,'localtime') BETWEEN ? AND ?
        UNION ALL
        SELECT id, stakeholder_id, total_amount FROM archived_transactions
        WHERE tenant_id = ? AND type = 'purchase' AND stakeholder_id IS NOT NULL AND date(created_at,'localtime') BETWEEN ? AND ?
      `).all(tenantId, from, to, tenantId, from, to) as any[];

      const bySupplier = new Map<number, { purchases: number; amount: number; ids: number[] }>();
      for (const t of txRows) {
        if (!bySupplier.has(t.stakeholder_id)) bySupplier.set(t.stakeholder_id, { purchases: 0, amount: 0, ids: [] });
        const s = bySupplier.get(t.stakeholder_id)!;
        s.purchases++;
        s.amount += t.total_amount || 0;
        s.ids.push(t.id);
      }

      const ids = Array.from(bySupplier.keys());
      const names = new Map<number, string>();
      const balances = new Map<number, number>();
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`SELECT id, name, balance FROM stakeholders WHERE tenant_id = ? AND id IN (${placeholders})`).all(tenantId, ...ids) as any[];
        for (const r of rows) { names.set(r.id, r.name); balances.set(r.id, r.balance || 0); }
      }

      const paidBySupplier = new Map<number, number>();
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`
          SELECT stakeholder_id, IFNULL(SUM(amount / exchange_rate), 0) as paid FROM (
            SELECT t.stakeholder_id as stakeholder_id, pay.amount as amount, pay.exchange_rate as exchange_rate
            FROM payments pay JOIN transactions t ON t.id = pay.transaction_id
            WHERE t.tenant_id = ? AND t.type = 'purchase' AND pay.method != 'credit' AND t.stakeholder_id IN (${placeholders})
              AND date(t.created_at,'localtime') BETWEEN ? AND ?
            UNION ALL
            SELECT at.stakeholder_id, apay.amount, apay.exchange_rate
            FROM archived_payments apay JOIN archived_transactions at ON at.id = apay.transaction_id
            WHERE at.tenant_id = ? AND at.type = 'purchase' AND apay.method != 'credit' AND at.stakeholder_id IN (${placeholders})
              AND date(at.created_at,'localtime') BETWEEN ? AND ?
          ) GROUP BY stakeholder_id
        `).all(tenantId, ...ids, from, to, tenantId, ...ids, from, to) as any[];
        for (const r of rows) paidBySupplier.set(r.stakeholder_id, r.paid || 0);
      }

      const result = Array.from(bySupplier.entries()).map(([id, s]) => ({
        stakeholder_id: id,
        name: names.get(id) || `#${id}`,
        purchases: s.purchases,
        amount: round2(s.amount),
        paid: round2(paidBySupplier.get(id) || 0),
        balance: round2(balances.get(id) || 0),
      })).sort((a, b) => b.amount - a.amount);

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/inventory-valuation", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const category = typeof req.query.category === "string" && req.query.category ? req.query.category : null;
      const rows = db.prepare(`
        SELECT id as product_id, name, barcode, category, stock, cost, price
        FROM products WHERE tenant_id = ? AND track_inventory = 1 ${category ? "AND category = ?" : ""}
      `).all(...(category ? [tenantId, category] : [tenantId])) as any[];

      let totalValueCost = 0, totalValueRetail = 0, totalPotentialProfit = 0;
      const result = rows.map((r) => {
        const cost = r.cost || 0;
        const price = r.price || 0;
        const value_cost = r.stock > 0 ? r.stock * cost : 0;
        const value_retail = r.stock > 0 ? r.stock * price : 0;
        const potential_profit = value_retail - value_cost;
        totalValueCost += value_cost;
        totalValueRetail += value_retail;
        totalPotentialProfit += potential_profit;
        return {
          product_id: r.product_id, name: r.name, barcode: r.barcode, category: r.category || "Uncategorized",
          stock: r.stock, cost: round2(cost), value_cost: round2(value_cost),
          price: round2(price), value_retail: round2(value_retail), potential_profit: round2(potential_profit),
        };
      });

      res.json({
        rows: result,
        totals: {
          value_cost: round2(totalValueCost),
          value_retail: round2(totalValueRetail),
          potential_profit: round2(totalPotentialProfit),
          product_count: result.length,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/low-stock", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const rows = db.prepare(`
        SELECT id as product_id, name, barcode, category, stock, reorder_point, cost, price
        FROM products
        WHERE tenant_id = ? AND track_inventory = 1 AND (stock <= 0 OR (reorder_point > 0 AND stock <= reorder_point))
        ORDER BY stock ASC
      `).all(tenantId) as any[];
      res.json(rows.map((r) => ({
        ...r,
        suggested_order: Math.max((r.reorder_point || 0) * 2 - r.stock, 0),
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/slow-movers", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const days = Number(req.query.days) > 0 ? Number(req.query.days) : 30;
      const since = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

      const products = db.prepare(`
        SELECT id as product_id, name, barcode, category, stock FROM products
        WHERE tenant_id = ? AND track_inventory = 1 AND stock > 0
      `).all(tenantId) as any[];

      const soldRows = db.prepare(`
        SELECT product_id, SUM(quantity) as qty FROM (
          SELECT ti.product_id as product_id, ti.quantity as quantity FROM transaction_items ti
          JOIN transactions t ON t.id = ti.transaction_id
          WHERE t.tenant_id = ? AND t.type = 'sale' AND date(t.created_at,'localtime') >= ?
          UNION ALL
          SELECT ati.product_id, ati.quantity FROM archived_transaction_items ati
          JOIN archived_transactions at ON at.id = ati.transaction_id
          WHERE at.tenant_id = ? AND at.type = 'sale' AND date(at.created_at,'localtime') >= ?
        ) GROUP BY product_id
      `).all(tenantId, since, tenantId, since) as any[];
      const soldMap = new Map<number, number>();
      for (const r of soldRows) soldMap.set(r.product_id, r.qty || 0);

      const lastSoldRows = db.prepare(`
        SELECT product_id, MAX(created_at) as last_sold_at FROM (
          SELECT ti.product_id as product_id, t.created_at as created_at FROM transaction_items ti
          JOIN transactions t ON t.id = ti.transaction_id
          WHERE t.tenant_id = ? AND t.type = 'sale'
          UNION ALL
          SELECT ati.product_id, at.created_at FROM archived_transaction_items ati
          JOIN archived_transactions at ON at.id = ati.transaction_id
          WHERE at.tenant_id = ? AND at.type = 'sale'
        ) GROUP BY product_id
      `).all(tenantId, tenantId) as any[];
      const lastSoldMap = new Map<number, string>();
      for (const r of lastSoldRows) lastSoldMap.set(r.product_id, r.last_sold_at);

      const result = products.map((p) => ({
        product_id: p.product_id, name: p.name, barcode: p.barcode, category: p.category,
        stock: p.stock, qty_sold: soldMap.get(p.product_id) || 0,
        last_sold_at: lastSoldMap.get(p.product_id) || null,
      })).sort((a, b) => a.qty_sold - b.qty_sold).slice(0, 100);

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/aging", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const type = req.query.type === "supplier" ? "supplier" : "customer";
      const today = localToday();

      const stakeholders = db.prepare("SELECT id, name, balance FROM stakeholders WHERE tenant_id = ? AND type = ? AND balance < 0").all(tenantId, type) as any[];

      const result = stakeholders.map((s) => {
        let outstanding = -s.balance;
        // Most-recent-first: live + archived sale/purchase invoices for this stakeholder.
        const invoices = db.prepare(`
          SELECT id, total_amount, created_at, date(created_at,'localtime') as local_date FROM transactions
          WHERE tenant_id = ? AND stakeholder_id = ? AND type = ?
          UNION ALL
          SELECT id, total_amount, created_at, date(created_at,'localtime') as local_date FROM archived_transactions
          WHERE tenant_id = ? AND stakeholder_id = ? AND type = ?
          ORDER BY created_at DESC
        `).all(tenantId, s.id, type === "customer" ? "sale" : "purchase", tenantId, s.id, type === "customer" ? "sale" : "purchase") as any[];

        let current = 0, d31_60 = 0, d61_90 = 0, d90_plus = 0;
        let oldest_invoice_at: string | null = null;

        const paidStmtLive = db.prepare("SELECT IFNULL(SUM(amount / exchange_rate), 0) as p FROM payments WHERE transaction_id = ? AND method != 'credit'");
        const paidStmtArch = db.prepare("SELECT IFNULL(SUM(amount / exchange_rate), 0) as p FROM archived_payments WHERE transaction_id = ? AND method != 'credit'");

        for (const inv of invoices) {
          if (outstanding <= 0.0000001) break;
          const liveP = (paidStmtLive.get(inv.id) as any)?.p || 0;
          const archP = (paidStmtArch.get(inv.id) as any)?.p || 0;
          const unpaid = (inv.total_amount || 0) - liveP - archP;
          if (unpaid <= 0.0000001) continue;
          const allocated = Math.min(unpaid, outstanding);
          outstanding -= allocated;
          const invDate = inv.local_date;
          const ageDays = Math.floor((new Date(today + "T00:00:00Z").getTime() - new Date(invDate + "T00:00:00Z").getTime()) / 86400000);
          if (ageDays <= 30) current += allocated;
          else if (ageDays <= 60) d31_60 += allocated;
          else if (ageDays <= 90) d61_90 += allocated;
          else d90_plus += allocated;
          if (!oldest_invoice_at || invDate < oldest_invoice_at) oldest_invoice_at = invDate;
        }
        if (outstanding > 0.0000001) d90_plus += outstanding; // unexplained remainder (baseline-only debt)

        return {
          stakeholder_id: s.id, name: s.name, balance: round2(s.balance),
          current: round2(current), d31_60: round2(d31_60), d61_90: round2(d61_90), d90_plus: round2(d90_plus),
          oldest_invoice_at,
        };
      }).sort((a, b) => a.balance - b.balance);

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/reports/profit-and-loss", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const { from, to } = resolveRange(req.query);
      const lines = computeAllocatedLines(tenantId, from, to);

      let sales = 0, refunds = 0, cogsSale = 0, cogsRefund = 0;
      for (const l of lines) {
        if (l.type === "sale") { sales += l.revenue; cogsSale += l.cogs; }
        else { refunds += l.revenue; cogsRefund += l.cogs; }
      }
      const revenue = sales - refunds;
      const cogs = cogsSale - cogsRefund;
      const gross_profit = revenue - cogs;
      const { cash_out: expenses } = cashFlowTotals(tenantId, from, to, true);
      const net_profit = gross_profit - expenses;

      res.json({
        from, to,
        revenue: round2(revenue),
        cogs: round2(cogs),
        gross_profit: round2(gross_profit),
        expenses: round2(expenses),
        net_profit: round2(net_profit),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
