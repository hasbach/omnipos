// Offline-first MILP solver using HiGHS compiled to WebAssembly (`highs` npm package).
// Builds a CPLEX LP format MILP model directly from `OrOptimizationProblem`, solves the integer program,
// and runs an LP relaxation pass to extract marginal cash ROI (shadow price on the cash budget).
import highsLoader from "highs";
import { createRequire } from "module";
import { Worker } from "worker_threads";
import { localDateIso, round2 } from "../coreBridge.js";
import type {
  BindingConstraintInsight,
  OrOptimizationProblem,
  OrOptimizationSolution,
  RecommendedOrderLine,
  RecommendedSupplierPlan,
  SolverAdapter,
} from "./types.js";

let highsInstancePromise: Promise<any> | null = null;
async function getHighs(): Promise<any> {
  if (!highsInstancePromise) {
    highsInstancePromise = (highsLoader as any)();
  }
  return highsInstancePromise;
}

/** HiGHS options for every solve: a hard time limit so a hard instance can never stall the register. */
export const HIGHS_TIME_LIMIT_S = 8;
const WORKER_TIMEOUT_MS = 20000;
const HIGHS_OPTIONS = { time_limit: HIGHS_TIME_LIMIT_S, mip_rel_gap: 0.01, output_flag: false };

// The solve runs in a worker thread so the POS server's event loop (sales, payments, sync) keeps
// answering while HiGHS works. A fresh worker per solve also isolates the WASM heap: a crashed or
// stuck solve is simply terminated.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
Promise.resolve()
  .then(() => require(workerData.highsPath)())
  .then((h) => {
    const out = {};
    for (const job of workerData.jobs) {
      try { out[job.key] = { sol: h.solve(job.lp, workerData.options) }; }
      catch (e) { out[job.key] = { error: String((e && e.message) || e) }; }
    }
    parentPort.postMessage(out);
  })
  .catch((e) => parentPort.postMessage({ __fatal: String((e && e.message) || e) }));
`;

let highsPath: string | null = null;
function resolveHighsPath(): string | null {
  if (highsPath === null) {
    try {
      highsPath = createRequire(import.meta.url).resolve("highs");
    } catch {
      highsPath = "";
    }
  }
  return highsPath || null;
}

let solveInFlight = false;

/** Solves several LP-format models; worker thread first, in-process fallback (still time-limited). */
export async function solveLpModels(jobs: Array<{ key: string; lp: string }>): Promise<Record<string, { sol?: any; error?: string }>> {
  if (solveInFlight) {
    throw Object.assign(new Error("The optimizer is already running. Try again in a moment."), { status: 409, code: "OR_OPTIMIZER_BUSY" });
  }
  solveInFlight = true;
  try {
    const path = resolveHighsPath();
    if (path) {
      try {
        return await new Promise((resolve, reject) => {
          const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { highsPath: path, jobs, options: HIGHS_OPTIONS } });
          const timer = setTimeout(() => {
            worker.terminate();
            reject(Object.assign(new Error("The optimizer took too long and was stopped."), { code: "OR_OPTIMIZER_TIMEOUT" }));
          }, WORKER_TIMEOUT_MS);
          worker.once("message", (msg: any) => {
            clearTimeout(timer);
            worker.terminate();
            if (msg && msg.__fatal) reject(new Error(msg.__fatal));
            else resolve(msg);
          });
          worker.once("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
        });
      } catch (e: any) {
        if (e?.code === "OR_OPTIMIZER_TIMEOUT") throw e;
        console.warn("[OR] HiGHS worker unavailable, solving in-process:", e?.message || e);
      }
    }
    const highs = await getHighs();
    const out: Record<string, { sol?: any; error?: string }> = {};
    for (const job of jobs) {
      try {
        out[job.key] = { sol: highs.solve(job.lp, HIGHS_OPTIONS) };
      } catch (e: any) {
        out[job.key] = { error: String(e?.message || e) };
        highsInstancePromise = null; // a failed WASM instance is not reused
      }
    }
    return out;
  } finally {
    solveInFlight = false;
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 1e-9) return "0";
  return Number(n.toFixed(6)).toString();
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + Math.max(1, Math.round(days)));
  return localDateIso(d);
}

interface LpBuildResult {
  milp: string;
  lpRelaxed: string;
  activeSkus: OrOptimizationProblem["skus"];
  activeSuppliers: OrOptimizationProblem["suppliers"];
  maxPacksBySku: Map<number, number>;
}

/**
 * Translates `OrOptimizationProblem` into CPLEX LP format:
 *   n_i  >= 0 integer : packs of SKU i to order (units q_i = pack_factor * n_i)
 *   u_i  >= 0         : expected units sold during horizon H
 *   v_i  >= 0         : stockout shortfall below target stock
 *   y_s  in {0,1}     : binary indicator for placing an order with supplier s
 *   pc_s >= 0         : cash payment for supplier s's new PO
 *   pr_s >= 0         : credit payment for supplier s's new PO
 *   dp_s >= 0         : repayment toward supplier s's existing debt
 */
function buildLpStrings(problem: OrOptimizationProblem): LpBuildResult {
  const w = problem.weights;
  const H = w.horizon_days;
  const supMap = new Map(problem.suppliers.map((s) => [s.supplier_id, s]));

  // Filter to SKUs with positive cost/demand and compute upper pack bound from shelf life & horizon
  const activeSkus: OrOptimizationProblem["skus"] = [];
  const maxPacksBySku = new Map<number, number>();
  const usedSupIds = new Set<number>();

  for (const sku of problem.skus) {
    const sup = supMap.get(sku.supplier_id);
    if (!sup) continue;
    if (sku.unit_cost_usd <= 0 || sku.weighted_daily_sales <= 0) continue;
    const fill = Math.max(0.1, Math.min(1, sup.fill_rate_score || 1));
    const effHorizon = Math.min(H + sup.lead_time_days, Math.max(1, sku.shelf_life_days));
    const maxTargetUnits = sku.weighted_daily_sales * effHorizon + sku.safety_stock;
    const neededUnits = Math.max(0, maxTargetUnits - Math.max(0, sku.current_stock));
    const maxPacks = Math.ceil(neededUnits / (fill * Math.max(1, sku.pack_factor)));
    if (maxPacks <= 0 && sku.current_stock >= sku.weighted_daily_sales * H) continue;
    activeSkus.push(sku);
    maxPacksBySku.set(sku.product_id, Math.max(0, maxPacks));
    usedSupIds.add(sup.supplier_id);
  }

  const activeSuppliers = problem.suppliers.filter((s) => usedSupIds.has(s.supplier_id));

  // Objective function
  const objTerms: string[] = [];
  const addTerm = (coef: number, varName: string) => {
    if (Math.abs(coef) < 1e-9) return;
    objTerms.push(`${coef >= 0 ? "+" : "-"} ${fmt(Math.abs(coef))} ${varName}`);
  };

  for (let idx = 0; idx < activeSkus.length; idx++) {
    const sku = activeSkus[idx];
    const packCost = sku.unit_cost_usd * sku.pack_factor;
    const margin = Math.max(0.01, sku.unit_margin_usd);
    const turnBonus = margin / (sku.unit_cost_usd + 0.01);
    const uCoef = w.w_profit * margin + w.w_turn * turnBonus;
    const stockoutPen =
      sku.abc_class === "A" ? w.w_stockout_a : sku.abc_class === "B" ? w.w_stockout_b : w.w_stockout_c;
    const holdPen = w.w_holding * packCost;

    addTerm(uCoef, `u_${idx}`);
    addTerm(-stockoutPen * margin, `v_${idx}`);
    addTerm(-holdPen, `n_${idx}`);
  }

  for (let sIdx = 0; sIdx < activeSuppliers.length; sIdx++) {
    const sup = activeSuppliers[sIdx];
    const orderPen = Math.max(0.5, sup.delivery_fee_usd);
    addTerm(-orderPen, `y_${sIdx}`);
    addTerm(-w.w_credit_cost, `pr_${sIdx}`);
    // Tiny tie-breaker cost on unnecessary debt paydown so solver only pays debt when it unlocks profitable credit
    addTerm(-0.005, `dp_${sIdx}`);
  }

  const constraints: string[] = [];

  // 1. Global Cash Budget: sum(pc_s + dp_s) <= max(0, free_spendable_cash_usd)
  if (activeSuppliers.length > 0) {
    const cashTerms = activeSuppliers.map((_, sIdx) => `pc_${sIdx} + dp_${sIdx}`).join(" + ");
    constraints.push(`  c_cash_budget: ${cashTerms} <= ${fmt(Math.max(0, problem.free_spendable_cash_usd))}`);
  }

  // 2. Per-supplier constraints
  for (let sIdx = 0; sIdx < activeSuppliers.length; sIdx++) {
    const sup = activeSuppliers[sIdx];
    const skuIndices = activeSkus
      .map((sk, idx) => ({ sk, idx }))
      .filter(({ sk }) => sk.supplier_id === sup.supplier_id);

    if (skuIndices.length === 0) continue;

    const costExpr = skuIndices
      .map(({ sk, idx }) => `${fmt(sk.unit_cost_usd * sk.pack_factor)} n_${idx}`)
      .join(" + ");
    const bigM = Math.max(
      1,
      skuIndices.reduce((sum, { sk }) => sum + (maxPacksBySku.get(sk.product_id) || 0) * sk.unit_cost_usd * sk.pack_factor, 0)
    );

    // Order cost accounting: sum(cost * n_i) - pc_s - pr_s = 0
    constraints.push(`  c_sup_cost_${sIdx}: ${costExpr} - pc_${sIdx} - pr_${sIdx} = 0`);

    // Big-M activation: sum(cost * n_i) - M * y_s <= 0
    constraints.push(`  c_sup_act_${sIdx}: ${costExpr} - ${fmt(bigM)} y_${sIdx} <= 0`);

    // MOQ if configured
    if (sup.min_order_usd > 0) {
      constraints.push(`  c_sup_moq_${sIdx}: ${costExpr} - ${fmt(sup.min_order_usd)} y_${sIdx} >= 0`);
    }

    // Credit limit: pr_s - dp_s <= max(0, credit_limit - current_debt) [or credit_limit - current_debt allowing dp_s to unlock]
    if (sup.payment_plan === "CASH_ON_DELIVERY") {
      constraints.push(`  c_sup_cod_${sIdx}: pr_${sIdx} <= 0`);
    } else if (sup.credit_limit_usd > 0) {
      // current_debt + pr_s - dp_s <= credit_limit  ==>  pr_s - dp_s <= credit_limit - current_debt
      constraints.push(`  c_sup_cred_${sIdx}: pr_${sIdx} - dp_${sIdx} <= ${fmt(sup.credit_limit_usd - sup.current_debt_usd)}`);
    }
  }

  // 3. Per-SKU supply, demand, and stockout constraints
  for (let idx = 0; idx < activeSkus.length; idx++) {
    const sku = activeSkus[idx];
    const sup = supMap.get(sku.supplier_id)!;
    const fill = Math.max(0.1, Math.min(1, sup.fill_rate_score || 1));
    const effUnitsPerPack = fill * sku.pack_factor;
    const stock = Math.max(0, sku.current_stock);
    const horizonDemand = sku.weighted_daily_sales * H;
    const targetStock = sku.weighted_daily_sales * (H + sup.lead_time_days) + sku.safety_stock;

    // u_i - effUnitsPerPack * n_i <= stock
    constraints.push(`  c_sku_sup_${idx}: u_${idx} - ${fmt(effUnitsPerPack)} n_${idx} <= ${fmt(stock)}`);
    // u_i <= horizonDemand
    constraints.push(`  c_sku_dem_${idx}: u_${idx} <= ${fmt(horizonDemand)}`);
    // v_i + effUnitsPerPack * n_i >= targetStock - stock
    const shortfallRhs = Math.max(0, targetStock - stock);
    if (shortfallRhs > 0) {
      constraints.push(`  c_sku_so_${idx}: v_${idx} + ${fmt(effUnitsPerPack)} n_${idx} >= ${fmt(shortfallRhs)}`);
    }
  }

  // Bounds
  const bounds: string[] = [];
  const generals: string[] = [];
  const binaries: string[] = [];

  for (let idx = 0; idx < activeSkus.length; idx++) {
    const sku = activeSkus[idx];
    const maxP = maxPacksBySku.get(sku.product_id) ?? 0;
    bounds.push(`  0 <= n_${idx} <= ${maxP}`);
    bounds.push(`  u_${idx} >= 0`);
    bounds.push(`  v_${idx} >= 0`);
    generals.push(`n_${idx}`);
  }
  for (let sIdx = 0; sIdx < activeSuppliers.length; sIdx++) {
    const sup = activeSuppliers[sIdx];
    bounds.push(`  0 <= y_${sIdx} <= 1`);
    bounds.push(`  pc_${sIdx} >= 0`);
    bounds.push(`  pr_${sIdx} >= 0`);
    bounds.push(`  0 <= dp_${sIdx} <= ${fmt(Math.max(0, sup.current_debt_usd))}`);
    binaries.push(`y_${sIdx}`);
  }

  const baseBody = [
    "Maximize",
    `  obj: ${objTerms.length > 0 ? objTerms.join(" ") : "0 n_0"}`,
    "Subject To",
    ...constraints,
    "Bounds",
    ...bounds,
  ];

  const milp = [
    ...baseBody,
    ...(generals.length > 0 ? ["General", `  ${generals.join(" ")}`] : []),
    ...(binaries.length > 0 ? ["Binary", `  ${binaries.join(" ")}`] : []),
    "End",
  ].join("\n");

  const lpRelaxed = [...baseBody, "End"].join("\n");

  return { milp, lpRelaxed, activeSkus, activeSuppliers, maxPacksBySku };
}

export class HighsWasmAdapter implements SolverAdapter {
  readonly name = "highs-wasm" as const;

  async solve(problem: OrOptimizationProblem): Promise<OrOptimizationSolution> {
    const start = Date.now();
    const built = buildLpStrings(problem);

    if (built.activeSkus.length === 0 || built.activeSuppliers.length === 0) {
      return {
        solver: this.name,
        status: "Empty",
        solve_time_ms: Date.now() - start,
        horizon_days: problem.weights.horizon_days,
        business_type: problem.business_type,
        survival_mode: problem.survival_mode,
        cash_budget_usd: round2(problem.free_spendable_cash_usd),
        total_cash_used_usd: 0,
        total_credit_used_usd: 0,
        total_debt_paydown_usd: 0,
        total_order_value_usd: 0,
        expected_gross_profit_usd: 0,
        marginal_cash_roi: null,
        binding_constraints: [
          {
            code: "NO_REORDER_NEEDED",
            message: "No active SKUs with sales velocity and supplier linkage currently need restocking.",
          },
        ],
        supplier_plans: [],
      };
    }

    const solved = await solveLpModels([
      { key: "milp", lp: built.milp },
      { key: "lp", lp: built.lpRelaxed },
    ]);
    const sol = solved.milp?.sol;
    // A time-limited solve that found a feasible plan is still usable (HiGHS keeps the incumbent).
    const hasIncumbent = sol?.Status === "Time limit reached" && sol?.Columns && Object.keys(sol.Columns).length > 0;
    const status = sol?.Status === "Optimal" || hasIncumbent ? "Optimal" : sol?.Status === "Infeasible" ? "Infeasible" : "Error";

    if (status !== "Optimal") {
      return {
        solver: this.name,
        status,
        solve_time_ms: Date.now() - start,
        horizon_days: problem.weights.horizon_days,
        business_type: problem.business_type,
        survival_mode: problem.survival_mode,
        cash_budget_usd: round2(problem.free_spendable_cash_usd),
        total_cash_used_usd: 0,
        total_credit_used_usd: 0,
        total_debt_paydown_usd: 0,
        total_order_value_usd: 0,
        expected_gross_profit_usd: 0,
        marginal_cash_roi: null,
        binding_constraints: [],
        supplier_plans: [],
      };
    }

    // LP relaxation pass to extract dual / shadow price on c_cash_budget
    let marginalCashRoi: number | null = null;
    try {
      const lpSol = solved.lp?.sol;
      const cashRow = lpSol?.Rows?.find((r: any) => r.Name === "c_cash_budget");
      if (cashRow && typeof cashRow.Dual === "number" && Math.abs(cashRow.Dual) > 0.001) {
        marginalCashRoi = round2(Math.abs(cashRow.Dual));
      }
    } catch {
      /* shadow price is best-effort */
    }

    const cols = sol.Columns || {};
    const val = (name: string): number => Number(cols[name]?.Primal ?? 0);

    const plansBySupplier = new Map<number, RecommendedSupplierPlan>();
    let totalOrderVal = 0;
    let totalCashUsed = 0;
    let totalCreditUsed = 0;
    let totalDebtPaydown = 0;
    let expectedProfit = 0;
    const binding: BindingConstraintInsight[] = [];

    for (let sIdx = 0; sIdx < built.activeSuppliers.length; sIdx++) {
      const sup = built.activeSuppliers[sIdx];
      const cashPay = round2(Math.max(0, val(`pc_${sIdx}`)));
      const creditPay = round2(Math.max(0, val(`pr_${sIdx}`)));
      const debtPay = round2(Math.max(0, val(`dp_${sIdx}`)));

      const items: RecommendedOrderLine[] = [];
      for (let idx = 0; idx < built.activeSkus.length; idx++) {
        const sku = built.activeSkus[idx];
        if (sku.supplier_id !== sup.supplier_id) continue;
        const packs = Math.round(Math.max(0, val(`n_${idx}`)));
        if (packs <= 0) continue;
        const orderedQty = round2(packs * sku.pack_factor);
        const lineCost = round2(orderedQty * sku.unit_cost_usd);
        const expSold = round2(Math.max(0, val(`u_${idx}`)));
        const expLineProfit = round2(expSold * Math.max(0, sku.unit_margin_usd));
        const shortfall = round2(Math.max(0, val(`v_${idx}`)));
        items.push({
          product_id: sku.product_id,
          name: sku.name,
          abc_class: sku.abc_class,
          packs_to_order: packs,
          pack_factor: sku.pack_factor,
          ordered_qty: orderedQty,
          unit_cost_usd: sku.unit_cost_usd,
          line_cost_usd: lineCost,
          expected_units_sold: expSold,
          expected_profit_usd: expLineProfit,
          stockout_shortfall: shortfall,
        });
        expectedProfit = round2(expectedProfit + expLineProfit);
      }

      const orderTotal = round2(items.reduce((s, it) => s + it.line_cost_usd, 0));
      if (orderTotal <= 0 && debtPay <= 0) continue;

      totalOrderVal = round2(totalOrderVal + orderTotal);
      totalCashUsed = round2(totalCashUsed + cashPay + debtPay);
      totalCreditUsed = round2(totalCreditUsed + creditPay);
      totalDebtPaydown = round2(totalDebtPaydown + debtPay);

      plansBySupplier.set(sup.supplier_id, {
        supplier_id: sup.supplier_id,
        supplier_name: sup.name,
        payment_plan: creditPay > 0 && cashPay > 0 ? "SPLIT" : creditPay > 0 ? "CREDIT" : "CASH_ON_DELIVERY",
        expected_delivery_date: addDaysIso(sup.lead_time_days),
        order_total_usd: orderTotal,
        cash_payment_usd: cashPay,
        credit_payment_usd: creditPay,
        debt_paydown_usd: debtPay,
        items,
      });

      if (sup.credit_limit_usd > 0 && sup.current_debt_usd + creditPay - debtPay >= sup.credit_limit_usd - 0.5) {
        binding.push({
          code: "SUPPLIER_CREDIT_LIMIT",
          supplier_id: sup.supplier_id,
          message:
            debtPay > 0
              ? `Supplier ${sup.name} hit its $${sup.credit_limit_usd.toFixed(0)} credit ceiling; solver allocated $${debtPay.toFixed(2)} debt paydown to unlock $${creditPay.toFixed(2)} credit.`
              : `Supplier ${sup.name} credit limit ($${sup.credit_limit_usd.toFixed(0)}) is binding.`,
        });
      }
    }

    if (problem.free_spendable_cash_usd > 0 && totalCashUsed >= problem.free_spendable_cash_usd - 1.0) {
      binding.push({
        code: "CASH_BUDGET",
        shadow_price_usd: marginalCashRoi,
        message:
          marginalCashRoi != null
            ? `Free Spendable Cash ($${problem.free_spendable_cash_usd.toFixed(2)}) is the binding constraint (marginal value: +${marginalCashRoi.toFixed(2)} objective/profit per $1).`
            : `Free Spendable Cash ($${problem.free_spendable_cash_usd.toFixed(2)}) is fully utilized.`,
      });
    }

    return {
      solver: this.name,
      status: "Optimal",
      solve_time_ms: Date.now() - start,
      horizon_days: problem.weights.horizon_days,
      business_type: problem.business_type,
      survival_mode: problem.survival_mode,
      cash_budget_usd: round2(problem.free_spendable_cash_usd),
      total_cash_used_usd: totalCashUsed,
      total_credit_used_usd: totalCreditUsed,
      total_debt_paydown_usd: totalDebtPaydown,
      total_order_value_usd: totalOrderVal,
      expected_gross_profit_usd: expectedProfit,
      marginal_cash_roi: marginalCashRoi,
      binding_constraints: binding,
      supplier_plans: Array.from(plansBySupplier.values()),
    };
  }
}
