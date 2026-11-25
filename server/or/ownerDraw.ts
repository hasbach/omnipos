// Workflow A: Recording & tracking Owner Draws (Cash, Goods, or Mixed) with survival-mode caps.
import { db, logAction } from "../db.js";
import { ValidationError } from "../errors.js";
import { ensureOrInitialized, type OrDrawPolicy } from "./config.js";
import { adjustProductStockCore, localDateIso, recordOwnerDrawCashCore, resolveTenantUserId, round2 } from "./coreBridge.js";
import { computeSpendableCash, recordBucketLedger } from "./spendableCash.js";

export interface OwnerDrawItemInput {
  product_id: number;
  quantity: number;
}

export interface CreateOwnerDrawInput {
  owner_user_id?: number | null;
  recorded_by_user_id?: number | null;
  draw_date?: string;
  cash_amount?: number; // native currency amount
  currency?: string;
  exchange_rate?: number;
  account_id?: number | null;
  items?: OwnerDrawItemInput[];
  override_reason?: string | null;
}

export function getOwnerDrawUsage(tenantId: number, dateStr = localDateIso()) {
  const config = ensureOrInitialized(tenantId);
  const policy = db
    .prepare("SELECT * FROM or_draw_policies WHERE tenant_id = ? AND survival_mode = ? AND deleted_at IS NULL")
    .get(tenantId, config.survival_mode) as OrDrawPolicy;

  const monthPrefix = dateStr.slice(0, 7); // YYYY-MM

  // 1. Goods taken through OR draws. Their CASH part is not summed here: every OR cash draw is also a Core
  //    cash_flow 'owner_withdrawal' row (counted once, below) — that works on every register, because
  //    cash_flow syncs while OR's device-local link ids do not.
  const dayOr = db
    .prepare(
      `SELECT 0 AS cash_today,
              IFNULL(SUM(goods_cost_total), 0) AS goods_today
         FROM or_owner_draws
        WHERE tenant_id = ? AND draw_date = ? AND deleted_at IS NULL`
    )
    .get(tenantId, dateStr) as any;

  const monthOr = db
    .prepare(
      `SELECT 0 AS cash_month,
              IFNULL(SUM(goods_cost_total), 0) AS goods_month
         FROM or_owner_draws
        WHERE tenant_id = ? AND substr(draw_date, 1, 7) = ? AND deleted_at IS NULL`
    )
    .get(tenantId, monthPrefix) as any;

  // 2. ALL Core cash_flow + archived_cash_flow rows with category = 'owner_withdrawal' (OR draws + manual withdrawals)
  const cfCashSum = (dateFilterSql: string, param: string): number => {
    const row = db
      .prepare(
        `SELECT IFNULL(SUM(amount / IFNULL(NULLIF(exchange_rate, 0), 1)), 0) AS total
           FROM (
             SELECT id, amount, exchange_rate, date(created_at, 'localtime') AS d
               FROM cash_flow
              WHERE tenant_id = ? AND type = 'out' AND category = 'owner_withdrawal' AND deleted_at IS NULL
             UNION ALL
             SELECT id, amount, exchange_rate, date(created_at, 'localtime') AS d
               FROM archived_cash_flow
              WHERE tenant_id = ? AND type = 'out' AND category = 'owner_withdrawal'
           ) cf
          WHERE ${dateFilterSql}`
      )
      .get(tenantId, tenantId, param) as any;
    return Number(row?.total) || 0;
  };

  const cfCashToday = cfCashSum("cf.d = ?", dateStr);
  const cfCashMonth = cfCashSum("substr(cf.d, 1, 7) = ?", monthPrefix);

  // 3. Owner Customer sales (if owner_stakeholder_id is configured) — valued at unit_cost (historical + future)
  let ownerCustomer: { id: number; name: string; balance: number; goods_cost_all_time: number } | null = null;
  let custGoodsToday = 0;
  let custGoodsMonth = 0;

  if (config.owner_stakeholder_id) {
    const st = db
      .prepare("SELECT id, name, balance FROM stakeholders WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
      .get(config.owner_stakeholder_id, tenantId) as any;
    if (st) {
      const goodsCostQuery = (whereExtra: string, extraParam?: string): number => {
        const params: any[] = [tenantId, st.id, tenantId, st.id];
        if (extraParam !== undefined) params.push(extraParam);
        const row = db
          .prepare(
            `SELECT IFNULL(SUM(line_cost), 0) AS total
               FROM (
                 SELECT date(t.created_at, 'localtime') AS d,
                        ti.quantity * COALESCE(NULLIF(ti.unit_cost, 0), NULLIF(p.cost, 0), ti.unit_price, 0) AS line_cost
                   FROM transaction_items ti
                   JOIN transactions t ON t.id = ti.transaction_id
                   LEFT JOIN products p ON p.id = ti.product_id
                  WHERE t.tenant_id = ? AND t.stakeholder_id = ? AND t.type = 'sale' AND t.deleted_at IS NULL
                 UNION ALL
                 SELECT date(at.created_at, 'localtime') AS d,
                        ati.quantity * COALESCE(NULLIF(ati.unit_cost, 0), NULLIF(p.cost, 0), ati.unit_price, 0) AS line_cost
                   FROM archived_transaction_items ati
                   JOIN archived_transactions at ON at.id = ati.transaction_id
                   LEFT JOIN products p ON p.id = ati.product_id
                  WHERE at.tenant_id = ? AND at.stakeholder_id = ? AND at.type = 'sale'
               ) g
              ${whereExtra}`
          )
          .get(...params) as any;
        return round2(Number(row?.total) || 0);
      };

      custGoodsToday = goodsCostQuery("WHERE g.d = ?", dateStr);
      custGoodsMonth = goodsCostQuery("WHERE substr(g.d, 1, 7) = ?", monthPrefix);
      const goodsAllTime = goodsCostQuery("");
      ownerCustomer = {
        id: st.id,
        name: st.name,
        balance: round2(Number(st.balance) || 0),
        goods_cost_all_time: goodsAllTime,
      };
    }
  }

  const cashToday = round2((Number(dayOr?.cash_today) || 0) + cfCashToday);
  const goodsToday = round2((Number(dayOr?.goods_today) || 0) + custGoodsToday);
  const totalToday = round2(cashToday + goodsToday);
  const cashMonth = round2((Number(monthOr?.cash_month) || 0) + cfCashMonth);
  const goodsMonth = round2((Number(monthOr?.goods_month) || 0) + custGoodsMonth);
  const totalMonth = round2(cashMonth + goodsMonth);

  return {
    date: dateStr,
    survival_mode: config.survival_mode,
    policy,
    owner_customer: ownerCustomer,
    cash_today: cashToday,
    goods_today: goodsToday,
    total_today: totalToday,
    cash_month: cashMonth,
    goods_month: goodsMonth,
    total_month: totalMonth,
    remaining_daily_cash: round2(Math.max(0, (policy?.max_daily_cash || 0) - cashToday)),
    remaining_daily_goods: round2(Math.max(0, (policy?.max_daily_goods_cost || 0) - goodsToday)),
    remaining_monthly_total: round2(Math.max(0, (policy?.max_monthly_total || 0) - totalMonth)),
  };
}

export function createOwnerDraw(tenantId: number, input: CreateOwnerDrawInput) {
  const config = ensureOrInitialized(tenantId);
  if (!config.enable_owner_draw) {
    throw new ValidationError("Owner Draw tracking is disabled in OmniPulse OR settings.", 400, { code: "OR_OWNER_DRAW_DISABLED" });
  }

  const drawDate = input.draw_date && /^\d{4}-\d{2}-\d{2}$/.test(input.draw_date) ? input.draw_date : localDateIso();
  const currency = (input.currency || "USD").trim().toUpperCase();
  const exchangeRate = Number(input.exchange_rate) > 0 ? Number(input.exchange_rate) : 1;
  const cashNative = Math.max(0, Number(input.cash_amount) || 0);
  const cashUsd = round2(cashNative / exchangeRate);
  const rawItems = Array.isArray(input.items) ? input.items.filter((i) => Number(i.quantity) > 0) : [];

  if (cashUsd <= 0 && rawItems.length === 0) {
    throw new ValidationError("Provide a cash amount or at least one item.", 400, { code: "OR_DRAW_EMPTY" });
  }

  // Pre-compute goods cost snapshot from products
  const resolvedItems: Array<{ product_id: number; name: string; quantity: number; unit_cost: number; line_cost: number }> = [];
  for (const item of rawItems) {
    const prod = db
      .prepare("SELECT id, name, cost FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
      .get(item.product_id, tenantId) as any;
    if (!prod) {
      throw new ValidationError(`Product #${item.product_id} not found.`, 404, { code: "PRODUCT_NOT_FOUND" });
    }
    const qty = Number(item.quantity);
    const unitCost = Number(prod.cost) || 0;
    resolvedItems.push({
      product_id: prod.id,
      name: prod.name,
      quantity: qty,
      unit_cost: unitCost,
      line_cost: round2(qty * unitCost),
    });
  }

  const goodsCostTotal = round2(resolvedItems.reduce((s, it) => s + it.line_cost, 0));
  const totalDrawValue = round2(cashUsd + goodsCostTotal);
  const drawType = cashUsd > 0 && resolvedItems.length > 0 ? "MIXED" : cashUsd > 0 ? "CASH" : "GOODS";

  // Policy & cap check
  const usage = getOwnerDrawUsage(tenantId, drawDate);
  const policy = usage.policy;
  const exceedsDailyCash = cashUsd > 0 && usage.cash_today + cashUsd > (policy?.max_daily_cash || 0) + 0.005;
  const exceedsDailyGoods = goodsCostTotal > 0 && usage.goods_today + goodsCostTotal > (policy?.max_daily_goods_cost || 0) + 0.005;
  const exceedsMonthly = usage.total_month + totalDrawValue > (policy?.max_monthly_total || 0) + 0.005;
  const exceededCap = exceedsDailyCash || exceedsDailyGoods || exceedsMonthly;

  const overrideReason = input.override_reason ? String(input.override_reason).trim() : null;
  if (exceededCap && policy?.require_override_reason && (!overrideReason || overrideReason.length < 3)) {
    const spendable = computeSpendableCash(tenantId);
    const impact = round2(Math.max(0, cashUsd - Math.max(0, spendable.free_spendable_cash_usd)));
    throw new ValidationError(
      impact > 0
        ? `This draw exceeds your ${config.survival_mode} cap and reduces OpEx/PO coverage by $${impact.toFixed(2)}. Provide an override reason to continue.`
        : `This draw exceeds your ${config.survival_mode} cap. Provide an override reason to continue.`,
      400,
      { code: "OR_DRAW_CAP_EXCEEDED", field: "override_reason" }
    );
  }

  const ownerUserId = resolveTenantUserId(tenantId, input.owner_user_id);
  const recordedById = resolveTenantUserId(tenantId, input.recorded_by_user_id);

  // Resolve cash account label for cash_source snapshot
  let cashSource: string | null = null;
  let resolvedAccountId: number | null = null;
  if (cashUsd > 0 && input.account_id) {
    const acc = db
      .prepare("SELECT id, kind FROM cash_accounts WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
      .get(input.account_id, tenantId) as any;
    if (acc) {
      resolvedAccountId = acc.id;
      cashSource = acc.kind === "drawer" ? "DRAWER" : acc.kind === "bank" ? "BANK" : "SAFE";
    }
  } else if (cashUsd > 0) {
    cashSource = "DRAWER";
  }

  const created = db.transaction(() => {
    let coreCashTxId: number | null = null;
    if (cashUsd > 0) {
      const cashRes = recordOwnerDrawCashCore({
        tenantId,
        userId: recordedById,
        amountNative: cashNative,
        currency,
        exchangeRate,
        accountId: resolvedAccountId,
        counterparty: "Owner",
        reason: overrideReason ? `Owner Draw (Override: ${overrideReason})` : `Owner Draw (${config.survival_mode})`,
      });
      coreCashTxId = cashRes.cashFlowId;
      resolvedAccountId = cashRes.accountId;
    }

    const drawInfo = db
      .prepare(
        `INSERT INTO or_owner_draws (
          tenant_id, owner_user_id, recorded_by_user_id, draw_date, draw_type,
          cash_amount, currency, exchange_rate, goods_cost_total, total_draw_value,
          cash_source, account_id, exceeded_cap, override_reason, core_cash_tx_id, core_cash_global_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tenantId,
        ownerUserId,
        recordedById,
        drawDate,
        drawType,
        cashUsd,
        currency,
        exchangeRate,
        goodsCostTotal,
        totalDrawValue,
        cashSource,
        resolvedAccountId,
        exceededCap ? 1 : 0,
        overrideReason,
        coreCashTxId,
        coreCashTxId ? ((db.prepare("SELECT global_id FROM cash_flow WHERE id = ?").get(coreCashTxId) as any)?.global_id ?? null) : null
      );
    const drawId = Number(drawInfo.lastInsertRowid);

    if (cashUsd > 0) {
      recordBucketLedger({
        tenantId,
        bucketCode: "OPEX_RESERVE",
        txType: "OWNER_DRAW",
        amount: -cashUsd,
        bucketDelta: 0, // real cash already decreased in cash_accounts; keep virtual OpEx reserve intact
        referenceType: "OWNER_DRAW",
        referenceId: drawId,
        note: overrideReason || `Owner cash draw (${drawType})`,
      });
    }

    const insertLine = db.prepare(
      `INSERT INTO or_owner_draw_items (tenant_id, owner_draw_id, product_id, quantity, unit_cost_snapshot, line_cost_total, core_stock_tx_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const it of resolvedItems) {
      const adj = adjustProductStockCore({
        tenantId,
        productId: it.product_id,
        userId: recordedById,
        delta: -it.quantity,
        reason: `OWNER_DRAW #${drawId}`,
        unitCostOverride: it.unit_cost,
      });
      insertLine.run(tenantId, drawId, it.product_id, it.quantity, it.unit_cost, it.line_cost, adj.adjustmentId);
    }

    return drawId;
  })();

  logAction(
    tenantId,
    recordedById,
    "OR Owner Draw",
    `#${created} (${drawType}): $${totalDrawValue.toFixed(2)}${exceededCap ? " [CAP OVERRIDE]" : ""}`
  );

  return getOwnerDrawById(tenantId, created);
}

export function getOwnerDrawById(tenantId: number, id: number) {
  const draw = db
    .prepare(
      `SELECT d.*, u.name AS recorded_by_name, ou.name AS owner_name
         FROM or_owner_draws d
         LEFT JOIN users u ON u.id = d.recorded_by_user_id
         LEFT JOIN users ou ON ou.id = d.owner_user_id
        WHERE d.id = ? AND d.tenant_id = ? AND d.deleted_at IS NULL`
    )
    .get(id, tenantId) as any;
  if (!draw) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.barcode
         FROM or_owner_draw_items i
         LEFT JOIN products p ON p.id = i.product_id
        WHERE i.owner_draw_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL`
    )
    .all(id, tenantId);
  return { ...draw, items };
}

export function listOwnerDraws(tenantId: number, opts?: { from?: string; to?: string; limit?: number }) {
  const config = ensureOrInitialized(tenantId);
  const limit = Math.max(1, Math.min(500, opts?.limit || 100));

  // 1. Direct OR draws
  const orRows = db
    .prepare(
      `SELECT d.id, d.draw_date, d.draw_type, d.cash_amount, d.goods_cost_total, d.total_draw_value,
              d.cash_source, d.exceeded_cap, d.override_reason, d.created_at, 'or_draw' AS source
         FROM or_owner_draws d
        WHERE d.tenant_id = ? AND d.deleted_at IS NULL`
    )
    .all(tenantId) as any[];

  // 2. Unlinked Core cash_flow / archived_cash_flow owner_withdrawal rows
  const cfRows = db
    .prepare(
      `SELECT cf.id, cf.draw_date, 'CASH' AS draw_type,
              ROUND(cf.amount / IFNULL(NULLIF(cf.exchange_rate, 0), 1), 2) AS cash_amount,
              0 AS goods_cost_total,
              ROUND(cf.amount / IFNULL(NULLIF(cf.exchange_rate, 0), 1), 2) AS total_draw_value,
              COALESCE(ca.name, 'Cash Register') AS cash_source,
              0 AS exceeded_cap,
              cf.reason AS override_reason,
              cf.created_at,
              'cash_flow' AS source
         FROM (
           SELECT id, global_id, amount, exchange_rate, account_id, reason, created_at, date(created_at, 'localtime') AS draw_date
             FROM cash_flow
            WHERE tenant_id = ? AND type = 'out' AND category = 'owner_withdrawal' AND deleted_at IS NULL
           UNION ALL
           SELECT id, global_id, amount, exchange_rate, account_id, reason, created_at, date(created_at, 'localtime') AS draw_date
             FROM archived_cash_flow
            WHERE tenant_id = ? AND type = 'out' AND category = 'owner_withdrawal'
         ) cf
         LEFT JOIN cash_accounts ca ON ca.id = cf.account_id
        WHERE cf.global_id IS NULL OR cf.global_id NOT IN (
          SELECT core_cash_global_id FROM or_owner_draws
           WHERE tenant_id = ? AND core_cash_global_id IS NOT NULL AND deleted_at IS NULL
        )`
    )
    .all(tenantId, tenantId, tenantId) as any[];

  // 3. Owner Customer POS invoices (live + archived), valued at unit_cost
  let custRows: any[] = [];
  if (config.owner_stakeholder_id) {
    custRows = db
      .prepare(
        `SELECT t.id, t.draw_date, 'GOODS' AS draw_type,
                0 AS cash_amount,
                ROUND(t.cost_total, 2) AS goods_cost_total,
                ROUND(t.cost_total, 2) AS total_draw_value,
                'Owner Customer POS' AS cash_source,
                0 AS exceeded_cap,
                t.notes AS override_reason,
                t.created_at,
                'owner_customer_sale' AS source
           FROM (
             SELECT tx.id, date(tx.created_at, 'localtime') AS draw_date, tx.created_at, tx.notes,
                    IFNULL(SUM(ti.quantity * COALESCE(NULLIF(ti.unit_cost, 0), NULLIF(p.cost, 0), ti.unit_price, 0)), 0) AS cost_total
               FROM transactions tx
               JOIN transaction_items ti ON ti.transaction_id = tx.id
               LEFT JOIN products p ON p.id = ti.product_id
              WHERE tx.tenant_id = ? AND tx.stakeholder_id = ? AND tx.type = 'sale' AND tx.deleted_at IS NULL
              GROUP BY tx.id
             UNION ALL
             SELECT atx.id, date(atx.created_at, 'localtime') AS draw_date, atx.created_at, atx.notes,
                    IFNULL(SUM(ati.quantity * COALESCE(NULLIF(ati.unit_cost, 0), NULLIF(p.cost, 0), ati.unit_price, 0)), 0) AS cost_total
               FROM archived_transactions atx
               JOIN archived_transaction_items ati ON ati.transaction_id = atx.id
               LEFT JOIN products p ON p.id = ati.product_id
              WHERE atx.tenant_id = ? AND atx.stakeholder_id = ? AND atx.type = 'sale'
              GROUP BY atx.id
           ) t`
      )
      .all(tenantId, config.owner_stakeholder_id, tenantId, config.owner_stakeholder_id) as any[];
  }

  let combined = [...orRows, ...cfRows, ...custRows];
  if (opts?.from) combined = combined.filter((r) => r.draw_date >= opts.from!);
  if (opts?.to) combined = combined.filter((r) => r.draw_date <= opts.to!);
  combined.sort((a, b) => String(b.draw_date).localeCompare(String(a.draw_date)) || String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return combined.slice(0, limit);
}
