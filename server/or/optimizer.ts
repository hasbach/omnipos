// Builds a tenant-specific MILP problem from live OmniPOS SQLite data, invokes the active SolverAdapter
// (HiGHS WASM offline or OR-Tools cloud), and optionally materializes recommended DRAFT PO commitments.
import crypto from "crypto";
import { db } from "../db.js";
import { ValidationError } from "../errors.js";
import { ensureOrInitialized, type BusinessType, type SurvivalMode } from "./config.js";
import { round2 } from "./coreBridge.js";
import { createPoCommitment, type PaymentPlan } from "./poCommitments.js";
import { computeSpendableCash } from "./spendableCash.js";
import { getActiveSolver } from "./solver/orToolsCloudAdapter.js";
import type {
  OptimizerSkuInput,
  OptimizerSupplierInput,
  OptimizerWeights,
  OrOptimizationProblem,
  OrOptimizationSolution,
} from "./solver/types.js";

function weightsForTenant(businessType: BusinessType, survivalMode: SurvivalMode, horizonOverride?: number): OptimizerWeights {
  const baseHorizon = survivalMode === "CRISIS" ? 7 : survivalMode === "RECOVERY" ? 10 : 14;
  const horizon = horizonOverride && horizonOverride >= 1 && horizonOverride <= 60 ? Math.round(horizonOverride) : baseHorizon;
  const isRestaurant = businessType === "RESTAURANT";

  if (survivalMode === "CRISIS") {
    return {
      horizon_days: horizon,
      w_profit: 1.0,
      w_turn: 2.5, // strongly rewards high profit-per-dollar fast movers
      w_stockout_a: 1.4,
      w_stockout_b: 0.4,
      w_stockout_c: 0.05,
      w_holding: isRestaurant ? 0.25 : 0.06,
      w_credit_cost: 0.03,
    };
  }
  if (survivalMode === "GROWTH") {
    return {
      horizon_days: horizon,
      w_profit: 1.5,
      w_turn: 0.5,
      w_stockout_a: 2.2,
      w_stockout_b: 1.1,
      w_stockout_c: 0.35,
      w_holding: isRestaurant ? 0.18 : 0.02,
      w_credit_cost: 0.01,
    };
  }
  // RECOVERY
  return {
    horizon_days: horizon,
    w_profit: 1.2,
    w_turn: 1.2,
    w_stockout_a: 1.8,
    w_stockout_b: 0.7,
    w_stockout_c: 0.15,
    w_holding: isRestaurant ? 0.22 : 0.04,
    w_credit_cost: 0.02,
  };
}

/**
 * Typical purchase pack per product from the last 180 days of purchase lines: the unit factor used on the most
 * recent line bought in a unit bigger than one piece, else the most frequent purchased quantity (>= 2; ties go to
 * the smaller one). Products only ever bought one piece at a time get no entry.
 */
export function purchaseHistoryPackSizes(tenantId: number): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT product_id, quantity, uom_factor, created_at FROM (
         SELECT ti.product_id, ti.quantity, ti.uom_factor, t.created_at
           FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
          WHERE t.tenant_id = ? AND t.type = 'purchase' AND t.deleted_at IS NULL
            AND datetime(t.created_at) >= datetime('now', '-180 days')
         UNION ALL
         SELECT ti.product_id, ti.quantity, ti.uom_factor, t.created_at
           FROM archived_transaction_items ti JOIN archived_transactions t ON t.id = ti.transaction_id
          WHERE t.tenant_id = ? AND t.type = 'purchase'
            AND datetime(t.created_at) >= datetime('now', '-180 days')
       ) ORDER BY created_at DESC`
    )
    .all(tenantId, tenantId) as any[];
  const unitFactor = new Map<number, number>();
  const counts = new Map<number, Map<number, number>>();
  for (const r of rows) {
    const pid = Number(r.product_id);
    const factor = Number(r.uom_factor) || 0;
    if (factor > 1 && !unitFactor.has(pid)) unitFactor.set(pid, factor);
    const q = Math.round(Number(r.quantity) || 0);
    if (q < 2 || Math.abs((Number(r.quantity) || 0) - q) > 1e-6) continue;
    let m = counts.get(pid);
    if (!m) counts.set(pid, (m = new Map()));
    m.set(q, (m.get(q) || 0) + 1);
  }
  const out = new Map<number, number>(unitFactor);
  for (const [pid, m] of counts) {
    if (out.has(pid)) continue;
    let best = 0;
    let bestN = 0;
    for (const [q, n] of m) if (n > bestN || (n === bestN && q < best)) { best = q; bestN = n; }
    if (best >= 2) out.set(pid, best);
  }
  return out;
}

/** Builds `OrOptimizationProblem` from live OmniPOS products, suppliers, pack units, metrics, and Free Spendable Cash. */
export function buildOptimizationProblem(
  tenantId: number,
  opts?: { horizonDays?: number; cashBudgetOverride?: number }
): OrOptimizationProblem {
  const config = ensureOrInitialized(tenantId);
  const spendable = computeSpendableCash(tenantId);
  const cashBudget = opts?.cashBudgetOverride !== undefined ? Math.max(0, Number(opts.cashBudgetOverride) || 0) : Math.max(0, spendable.free_spendable_cash_usd);
  const weights = weightsForTenant(config.business_type, config.survival_mode, opts?.horizonDays);

  // Load suppliers + OR profiles
  const supRows = db
    .prepare(
      `SELECT s.id, s.name, s.balance, s.credit_limit,
              p.lead_time_days, p.fill_rate_score, p.default_payment_plan, p.min_order_usd, p.delivery_fee_usd
         FROM stakeholders s
         LEFT JOIN or_supplier_profiles p ON p.tenant_id = s.tenant_id AND p.supplier_id = s.id AND p.deleted_at IS NULL
        WHERE s.tenant_id = ? AND s.type = 'supplier' AND s.deleted_at IS NULL
        ORDER BY s.id ASC`
    )
    .all(tenantId) as any[];

  const suppliers: OptimizerSupplierInput[] = supRows.map((s) => ({
    supplier_id: s.id,
    name: s.name,
    payment_plan: (["CASH_ON_DELIVERY", "CREDIT", "SPLIT"].includes(s.default_payment_plan)
      ? s.default_payment_plan
      : Number(s.credit_limit) > 0
        ? "SPLIT"
        : "CASH_ON_DELIVERY") as PaymentPlan,
    lead_time_days: Math.max(1, Number(s.lead_time_days) || 2),
    fill_rate_score: Math.max(0.1, Math.min(1, Number(s.fill_rate_score) || 1)),
    // OmniPOS convention: negative stakeholder.balance means debt owed
    current_debt_usd: round2(Math.max(0, -(Number(s.balance) || 0))),
    credit_limit_usd: round2(Math.max(0, Number(s.credit_limit) || 0)),
    min_order_usd: round2(Math.max(0, Number(s.min_order_usd) || 0)),
    delivery_fee_usd: round2(Math.max(0, Number(s.delivery_fee_usd) || 0)),
  }));


  // Infer each SKU's most recent purchase supplier if primary_supplier_id isn't set in or_sku_metrics
  const lastPurchaseSupplier = new Map<number, number>();
  const recentPurchases = db
    .prepare(
      `SELECT product_id, stakeholder_id FROM (
         SELECT ti.product_id, t.stakeholder_id, t.created_at
           FROM transaction_items ti
           JOIN transactions t ON t.id = ti.transaction_id
          WHERE t.tenant_id = ? AND t.type = 'purchase' AND t.stakeholder_id IS NOT NULL AND t.deleted_at IS NULL
         UNION ALL
         SELECT ati.product_id, at.stakeholder_id, at.created_at
           FROM archived_transaction_items ati
           JOIN archived_transactions at ON at.id = ati.transaction_id
          WHERE at.tenant_id = ? AND at.type = 'purchase' AND at.stakeholder_id IS NOT NULL
       ) ORDER BY created_at DESC`
    )
    .all(tenantId, tenantId) as any[];
  for (const r of recentPurchases) {
    if (!lastPurchaseSupplier.has(r.product_id)) lastPurchaseSupplier.set(r.product_id, r.stakeholder_id);
  }

  // Order multiple per product (suppliers sell boxes, not single pieces), first match wins:
  //  1. the smallest unit of measure bigger than one piece (product_units, e.g. "Box" = 65)
  //  2. how this shop actually buys it: the unit used on recent purchase lines, else the most common
  //     purchased quantity (ties -> the smaller), over the last 180 days
  //  3. products.units_per_package, else 1
  const packFactorMap = new Map<number, number>();
  const unitRows = db
    .prepare("SELECT product_id, MIN(factor) AS min_factor FROM product_units WHERE tenant_id = ? AND deleted_at IS NULL AND factor > 1 GROUP BY product_id")
    .all(tenantId) as any[];
  for (const u of unitRows) packFactorMap.set(u.product_id, Number(u.min_factor) || 1);
  const historyPack = purchaseHistoryPackSizes(tenantId);
  for (const [pid, pack] of historyPack) if (!packFactorMap.has(pid)) packFactorMap.set(pid, pack);

  const skuRows = db
    .prepare(
      `SELECT p.id, p.name, p.barcode, p.cost, p.price, p.stock, p.units_per_package,
              m.weighted_daily_sales, m.demand_std_30d, m.safety_stock, m.abc_class, m.primary_supplier_id
         FROM products p
         JOIN or_sku_metrics m ON m.tenant_id = p.tenant_id AND m.product_id = p.id
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND IFNULL(p.active, 1) = 1 AND IFNULL(p.track_inventory, 1) = 1
          AND m.weighted_daily_sales > 0 AND IFNULL(p.cost, 0) > 0
        ORDER BY CASE m.abc_class WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, m.revenue_30d DESC
        LIMIT 300`
    )
    .all(tenantId) as any[];

  const defaultShelfLife = config.business_type === "RESTAURANT" ? 4 : 30;
  const skus: OptimizerSkuInput[] = [];
  for (const r of skuRows) {
    // Only a supplier this product is known to come from: never the "first supplier" as a guess.
    const supId = r.primary_supplier_id || lastPurchaseSupplier.get(r.id) || null;
    if (!supId) continue;
    const cost = Number(r.cost) || 0;
    const price = Number(r.price) || cost * 1.25;
    const packFactor = packFactorMap.get(r.id) || Math.max(1, Number(r.units_per_package) || 1);
    skus.push({
      product_id: r.id,
      name: r.name,
      barcode: r.barcode,
      supplier_id: supId,
      abc_class: (["A", "B", "C"].includes(r.abc_class) ? r.abc_class : "C") as "A" | "B" | "C",
      unit_cost_usd: cost,
      unit_price_usd: price,
      unit_margin_usd: round2(Math.max(0, price - cost)),
      current_stock: Number(r.stock) || 0,
      pack_factor: packFactor,
      weighted_daily_sales: Number(r.weighted_daily_sales) || 0,
      demand_std_30d: Number(r.demand_std_30d) || 0,
      safety_stock: Number(r.safety_stock) || 0,
      shelf_life_days: defaultShelfLife,
    });
  }

  return {
    tenant_id: tenantId,
    business_type: config.business_type,
    survival_mode: config.survival_mode,
    free_spendable_cash_usd: cashBudget,
    weights,
    suppliers,
    skus,
  };
}

// Solved plans are kept (per tenant, 30 minutes) so "Apply" creates exactly the plan the owner reviewed,
// once: applying the same plan_id again returns the POs it already created.
const PLAN_TTL_MS = 30 * 60 * 1000;
const savedPlans = new Map<string, { tenantId: number; solution: OrOptimizationSolution; at: number; applied?: any[] }>();
function prunePlans() {
  const now = Date.now();
  for (const [id, p] of savedPlans) if (now - p.at > PLAN_TTL_MS) savedPlans.delete(id);
}

export async function runOrOptimizer(
  tenantId: number,
  opts?: { horizonDays?: number; cashBudgetOverride?: number }
): Promise<OrOptimizationSolution & { plan_id?: string }> {
  const problem = buildOptimizationProblem(tenantId, opts);
  const solver = getActiveSolver();
  const solution = await solver.solve(problem);
  prunePlans();
  const planId = crypto.randomUUID();
  savedPlans.set(planId, { tenantId, solution, at: Date.now() });
  return { ...solution, plan_id: planId };
}

/**
 * Materializes the REVIEWED plan (`planId` from runOrOptimizer) into `DRAFT` PO commitments (never auto-locks cash),
 * all-or-nothing in one transaction, and only once per plan.
 */
export async function applyOptimizationPlan(
  tenantId: number,
  userId?: number | null,
  opts?: { planId?: string; supplierIds?: number[]; horizonDays?: number; cashBudgetOverride?: number }
) {
  prunePlans();
  let saved = opts?.planId ? savedPlans.get(opts.planId) : undefined;
  if (opts?.planId && (!saved || saved.tenantId !== tenantId)) {
    throw new ValidationError("This optimizer plan expired. Run the optimizer again, then apply.", 409, { code: "OR_PLAN_EXPIRED" });
  }
  if (saved?.applied) return { solution: saved.solution, created_pos: saved.applied, already_applied: true };
  const solution: OrOptimizationSolution = saved ? saved.solution : await runOrOptimizer(tenantId, opts);
  const filterSet = Array.isArray(opts?.supplierIds) && opts!.supplierIds!.length > 0 ? new Set(opts!.supplierIds!) : null;

  const createdPos = db.transaction(() => {
    const out: any[] = [];
    for (const plan of solution.supplier_plans) {
      if (filterSet && !filterSet.has(plan.supplier_id)) continue;
      if (plan.items.length === 0 || plan.order_total_usd <= 0) continue;

      const noteParts = [
        `Generated by ${solution.solver} (${solution.survival_mode}, ${solution.horizon_days}d horizon)`,
        plan.debt_paydown_usd > 0 ? `Suggested debt paydown: $${plan.debt_paydown_usd.toFixed(2)}` : null,
      ].filter(Boolean);

      out.push(
        createPoCommitment(
          tenantId,
          {
            supplier_id: plan.supplier_id,
            expected_delivery_date: plan.expected_delivery_date,
            payment_plan: plan.payment_plan,
            estimated_order_total: plan.order_total_usd,
            notes: noteParts.join(" · "),
            items: plan.items.map((it) => ({
              product_id: it.product_id,
              ordered_qty: it.ordered_qty,
              unit_cost: it.unit_cost_usd,
            })),
          },
          userId
        )
      );
    }
    return out;
  })();
  if (saved) saved.applied = createdPos;

  return { solution, created_pos: createdPos };
}
