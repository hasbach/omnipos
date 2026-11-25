// Unified Nightly OR Pipeline (`runNightlyOrPipeline`): single idempotent pipeline per (tenant, business_date).
// 1. Sync & classify `or_sku_metrics` (30-day weighted velocity, DOS, ABC class)
// 2. Accrue today's `or_fixed_obligations` into `OPEX_RESERVE` bucket + ledger
// 3. Evaluate 14-day Cash Runway -> auto-set `survival_mode` ('CRISIS' | 'RECOVERY' | 'GROWTH')
// 4. Generate morning 5-minute Cycle Count queue
// 5. Draft PO suggestions & populate Morning Briefing `or_action_queue`
import { db } from "../db.js";
import { ensureOrInitialized, type SurvivalMode } from "./config.js";
import { localDateIso, round2 } from "./coreBridge.js";
import { computeOpexReserve, computeSpendableCash } from "./spendableCash.js";
import { generateCycleCountSession, recordStockAnomaly } from "./cycleCount.js";
import { isOrLicenseValid } from "./license.js";
import { rowGlobalId, stableGlobalId } from "./stableId.js";

export interface PipelineSummary {
  run_date: string;
  skipped?: boolean;
  skus_classified: number;
  opex_accrued_usd: number;
  survival_mode: SurvivalMode;
  runway_days: number | null;
  cycle_count_session_id: number | null;
  actions_created: number;
}

/** Step 1: Compute recency-weighted 7d/14d/30d sales velocity, demand volatility, safety stock, DOS, and ABC class. */
function computeSkuMetrics(tenantId: number): number {
  const products = db
    .prepare(
      "SELECT id, stock, cost, price, reorder_point, track_inventory FROM products WHERE tenant_id = ? AND deleted_at IS NULL AND IFNULL(active, 1) = 1"
    )
    .all(tenantId) as any[];
  if (products.length === 0) return 0;

  // Pull daily sales buckets over the last 30 days across BOTH live `transactions` and `archived_transactions`.
  // Line prices are stored in USD per base piece for every sale (also LBP-priced ones), so no rate division.
  const dailyRows = db
    .prepare(
      `SELECT product_id,
              sale_day,
              SUM(qty) AS day_qty,
              SUM(rev_usd) AS day_rev,
              SUM(margin_usd) AS day_margin,
              CAST(julianday('now', 'localtime') - julianday(sale_day) AS INTEGER) AS age_days
         FROM (
           SELECT ti.product_id,
                  date(t.created_at, 'localtime') AS sale_day,
                  ti.quantity AS qty,
                  (ti.quantity * ti.unit_price) AS rev_usd,
                  (ti.quantity * (ti.unit_price - IFNULL(ti.unit_cost, 0))) AS margin_usd
             FROM transaction_items ti
             JOIN transactions t ON t.id = ti.transaction_id
            WHERE t.tenant_id = ? AND t.type = 'sale' AND t.deleted_at IS NULL
              AND datetime(t.created_at) >= datetime('now', '-30 days')
           UNION ALL
           SELECT ati.product_id,
                  date(at.created_at, 'localtime') AS sale_day,
                  ati.quantity AS qty,
                  (ati.quantity * ati.unit_price) AS rev_usd,
                  (ati.quantity * (ati.unit_price - IFNULL(ati.unit_cost, 0))) AS margin_usd
             FROM archived_transaction_items ati
             JOIN archived_transactions at ON at.id = ati.transaction_id
            WHERE at.tenant_id = ? AND at.type = 'sale'
              AND datetime(at.created_at) >= datetime('now', '-30 days')
         )
        GROUP BY product_id, sale_day`
    )
    .all(tenantId, tenantId) as any[];

  const aggMap = new Map<
    number,
    { qty7: number; qty14: number; qty30: number; rev30: number; margin30: number; dailyQtys: number[] }
  >();
  for (const r of dailyRows) {
    let entry = aggMap.get(r.product_id);
    if (!entry) {
      entry = { qty7: 0, qty14: 0, qty30: 0, rev30: 0, margin30: 0, dailyQtys: [] };
      aggMap.set(r.product_id, entry);
    }
    const q = Number(r.day_qty) || 0;
    const age = Number(r.age_days) || 0;
    if (age <= 7) entry.qty7 += q;
    if (age <= 14) entry.qty14 += q;
    entry.qty30 += q;
    entry.rev30 += Number(r.day_rev) || 0;
    entry.margin30 += Number(r.day_margin) || 0;
    entry.dailyQtys.push(q);
  }

  // Sort by 30d revenue descending for Pareto ABC classification (top 80% = A, next 15% = B, rest = C)
  const ranked = products
    .map((p) => {
      const s = aggMap.get(p.id) || { qty7: 0, qty14: 0, qty30: 0, rev30: 0, margin30: 0, dailyQtys: [] };
      const d7 = s.qty7 / 7;
      const d14 = s.qty14 / 14;
      const d30 = s.qty30 / 30;
      const weightedDaily = 0.5 * d7 + 0.3 * d14 + 0.2 * d30;
      // Empirical 30-day daily std dev (including zero-sale days)
      const mean = d30;
      const sumSqNonZero = s.dailyQtys.reduce((acc, q) => acc + (q - mean) ** 2, 0);
      const zeroDays = Math.max(0, 30 - s.dailyQtys.length);
      const variance = (sumSqNonZero + zeroDays * mean * mean) / 30;
      const std30 = Math.sqrt(Math.max(0, variance));
      const stock = Number(p.stock) || 0;
      const dos = weightedDaily > 0.0001 ? round2(stock / weightedDaily) : null;
      const cashVelocity = round2(s.margin30 > 0 ? s.margin30 : s.rev30 * 0.25);
      return {
        product_id: p.id,
        dailySales: round2(weightedDaily),
        std30: round2(std30),
        rev30d: round2(s.rev30),
        margin30d: round2(s.margin30),
        dos,
        cashVelocity,
      };
    })
    .sort((a, b) => b.rev30d - a.rev30d);

  const totalRev = ranked.reduce((s, r) => s + r.rev30d, 0);
  let cumRev = 0;

  const upsert = db.prepare(
    `INSERT INTO or_sku_metrics (
       tenant_id, product_id, weighted_daily_sales, demand_std_30d, safety_stock,
       revenue_30d, gross_margin_30d, days_of_supply, abc_class, cash_velocity_score, computed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id, product_id) DO UPDATE SET
       weighted_daily_sales = excluded.weighted_daily_sales,
       demand_std_30d = excluded.demand_std_30d,
       safety_stock = excluded.safety_stock,
       revenue_30d = excluded.revenue_30d,
       gross_margin_30d = excluded.gross_margin_30d,
       days_of_supply = excluded.days_of_supply,
       abc_class = excluded.abc_class,
       cash_velocity_score = excluded.cash_velocity_score,
       computed_at = CURRENT_TIMESTAMP`
  );

  for (const r of ranked) {
    cumRev += r.rev30d;
    let abc: "A" | "B" | "C" = "C";
    if (totalRev > 0 && r.rev30d > 0) {
      const share = cumRev / totalRev;
      if (share <= 0.8 || cumRev === r.rev30d) abc = "A";
      else if (share <= 0.95) abc = "B";
    }
    const z = abc === "A" ? 1.65 : abc === "B" ? 1.28 : 0.84;
    const safetyStock = round2(z * r.std30 * Math.sqrt(2)); // 2-day baseline lead time
    upsert.run(tenantId, r.product_id, r.dailySales, r.std30, safetyStock, r.rev30d, r.margin30d, r.dos, abc, r.cashVelocity);
  }
  return ranked.length;
}

export function runNightlyOrPipeline(
  tenantId: number,
  runDate = localDateIso(),
  triggerSource = "manual",
  force = false
): PipelineSummary {
  const config = ensureOrInitialized(tenantId);

  if (!force) {
    const already = db
      .prepare("SELECT summary_json FROM or_pipeline_runs WHERE tenant_id = ? AND run_date = ?")
      .get(tenantId, runDate) as any;
    if (already) {
      const prev = already.summary_json ? JSON.parse(already.summary_json) : {};
      return { ...prev, run_date: runDate, skipped: true };
    }
  }

  let skusClassified = 0;
  let opexAccrued = 0;
  let nextMode: SurvivalMode = config.survival_mode;
  let runwayDays: number | null = null;
  let actionsCreated = 0;

  db.transaction(() => {
    // Step 1: SKU Metrics & ABC
    if (config.enable_cycle_count || config.business_type !== "SERVICE") {
      skusClassified = computeSkuMetrics(tenantId);
    }

    // Step 2: OpEx reserve is DERIVED from the obligations' due dates (see computeOpexReserve) — nothing is
    // accumulated, so re-runs, several registers and paid bills can never inflate it.
    opexAccrued = computeOpexReserve(tenantId, runDate);

    // Step 3: Survival Mode Evaluation (14-day Cash Runway vs OpEx + PO locks + overdue supplier debt)
    const spendable = computeSpendableCash(tenantId);
    runwayDays = spendable.runway_days;
    if (spendable.daily_opex_burn_usd > 0) {
      if ((runwayDays ?? 0) < 7 || spendable.free_spendable_cash_usd < 0) nextMode = "CRISIS";
      else if ((runwayDays ?? 0) < 14) nextMode = "RECOVERY";
      else nextMode = "GROWTH";
    } else if (spendable.free_spendable_cash_usd < 0) {
      nextMode = "CRISIS";
    }
    if (nextMode !== config.survival_mode) {
      db.prepare("UPDATE or_tenant_config SET survival_mode = ? WHERE tenant_id = ?").run(nextMode, tenantId);
    }

    // Step 5 (Action Queue): Refresh today's Morning Briefing open items. Each item has a stable global id
    // (tenant + day + category + referenced row), so a re-run updates it in place and every register writes
    // the same row; items that no longer apply are SOFT-deleted so the deletion syncs too.
    const keptGids: string[] = [];
    const findAction = db.prepare("SELECT id FROM or_action_queue WHERE global_id = ?");
    const updAction = db.prepare(
      `UPDATE or_action_queue SET priority = ?, category = ?, title = ?, details = ?, reference_type = ?, reference_id = ?, deleted_at = NULL
        WHERE id = ?`
    );
    const newAction = db.prepare(
      `INSERT INTO or_action_queue (global_id, tenant_id, action_date, priority, category, title, details, reference_type, reference_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`
    );
    const refTable: Record<string, string> = { PO_COMMITMENT: "or_po_commitments", PRODUCT: "products" };
    const insAction = {
      run(_t: number, date: string, priority: string, category: string, title: string, details: string, refType: string | null, refId: number | null) {
        const refKey = refType && refId ? rowGlobalId(refTable[refType] || "", refId) || String(refId) : "-";
        const gid = stableGlobalId(tenantId, "or_action_queue", date, category, refType || "-", refKey);
        const existing = gid ? (findAction.get(gid) as any) : null;
        if (existing) updAction.run(priority, category, title, details, refType, refId, existing.id);
        else newAction.run(gid, tenantId, date, priority, category, title, details, refType, refId);
        if (gid) keptGids.push(gid);
      },
    };

    if (spendable.free_spendable_cash_usd < 0) {
      insAction.run(
        tenantId,
        runDate,
        "CRITICAL",
        "CASH_RUNWAY",
        `Negative Free Spendable Cash ($${spendable.free_spendable_cash_usd.toFixed(2)})`,
        `Survival mode is ${nextMode}. Defer non-essential POs and enforce daily owner draw caps.`,
        "SPENDABLE_CASH",
        null
      );
      actionsCreated++;
    }

    // Upcoming PO deliveries within 3 days
    const upcomingPos = db
      .prepare(
        `SELECT c.id, c.po_number, c.expected_delivery_date, c.locked_cash_amount, s.name AS supplier_name
           FROM or_po_commitments c
           LEFT JOIN stakeholders s ON s.id = c.supplier_id
          WHERE c.tenant_id = ? AND c.status IN ('DRAFT', 'APPROVED_LOCKED') AND c.deleted_at IS NULL
            AND date(c.expected_delivery_date) <= date(?, '+3 days')
          ORDER BY c.expected_delivery_date ASC LIMIT 5`
      )
      .all(tenantId, runDate) as any[];
    for (const po of upcomingPos) {
      insAction.run(
        tenantId,
        runDate,
        "HIGH",
        "PO_DELIVERY",
        `Delivery due ${po.expected_delivery_date}: ${po.supplier_name || "Supplier"} (${po.po_number || `#${po.id}`})`,
        `Locked cash: $${Number(po.locked_cash_amount || 0).toFixed(2)}.`,
        "PO_COMMITMENT",
        po.id
      );
      actionsCreated++;
    }

    // Low-stock Class A items (DOS < 4 days)
    const lowStockA = db
      .prepare(
        `SELECT m.product_id, m.days_of_supply, p.name, p.stock
           FROM or_sku_metrics m
           JOIN products p ON p.id = m.product_id AND p.tenant_id = m.tenant_id AND p.deleted_at IS NULL
          WHERE m.tenant_id = ? AND m.abc_class = 'A' AND m.days_of_supply IS NOT NULL AND m.days_of_supply < 4
          ORDER BY m.days_of_supply ASC LIMIT 5`
      )
      .all(tenantId) as any[];
    for (const sku of lowStockA) {
      const stk = Number(sku.stock || 0);
      if (stk < 0) {
        recordStockAnomaly(tenantId, sku.product_id, "NEGATIVE_STOCK_SALE", null);
        insAction.run(
          tenantId,
          runDate,
          "HIGH",
          "NEGATIVE_STOCK_A",
          `Class A negative stock: ${sku.name}`,
          `System shows ${stk} units — physical count & stock adjustment required (queued for 5-Min Cycle Count).`,
          "PRODUCT",
          sku.product_id
        );
      } else {
        insAction.run(
          tenantId,
          runDate,
          "HIGH",
          "LOW_STOCK_A",
          `Class A stockout risk: ${sku.name}`,
          `Only ${stk} units left (~${Math.max(0, Number(sku.days_of_supply)).toFixed(1)} days of supply).`,
          "PRODUCT",
          sku.product_id
        );
      }
      actionsCreated++;
    }

    // Retire today's open items that this run no longer produced.
    const stale = db
      .prepare("SELECT id, global_id FROM or_action_queue WHERE tenant_id = ? AND action_date = ? AND status = 'OPEN' AND deleted_at IS NULL")
      .all(tenantId, runDate) as any[];
    const keep = new Set(keptGids);
    const retire = db.prepare("UPDATE or_action_queue SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?");
    for (const row of stale) if (!keep.has(row.global_id)) retire.run(row.id);
  })();

  // Step 4: Generate today's 5-minute Cycle Count session
  const session = generateCycleCountSession(tenantId, { sessionDate: runDate });

  const summary: PipelineSummary = {
    run_date: runDate,
    skus_classified: skusClassified,
    opex_accrued_usd: opexAccrued,
    survival_mode: nextMode,
    runway_days: runwayDays,
    cycle_count_session_id: session?.id ?? null,
    actions_created: actionsCreated,
  };

  db.prepare(
    `INSERT INTO or_pipeline_runs (tenant_id, run_date, trigger_source, summary_json, ran_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id, run_date) DO UPDATE SET
       trigger_source = excluded.trigger_source,
       summary_json = excluded.summary_json,
       ran_at = CURRENT_TIMESTAMP`
  ).run(tenantId, runDate, triggerSource, JSON.stringify(summary));

  return summary;
}

/** Runs catch-up nightly pipeline for all OR-licensed local tenants that haven't run today yet. */
export function runOrPipelineCatchup(triggerSource = "startup") {
  const tenants = db.prepare("SELECT id FROM tenants").all() as Array<{ id: number }>;
  const today = localDateIso();
  for (const t of tenants) {
    try {
      if (!isOrLicenseValid(t.id)) continue;
      runNightlyOrPipeline(t.id, today, triggerSource, false);
    } catch (e) {
      console.error(`[OR] Pipeline catch-up failed for tenant ${t.id}:`, e);
    }
  }
}
