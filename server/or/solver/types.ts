// Shared mathematical optimization contract for OmniPulse OR.
// Both the local offline HiGHS WASM adapter and any future Python Google OR-Tools cloud service
// implement `SolverAdapter` using these exact JSON-serializable input/output types.
import type { BusinessType, SurvivalMode } from "../config.js";
import type { PaymentPlan } from "../poCommitments.js";

export interface OptimizerSupplierInput {
  supplier_id: number;
  name: string;
  payment_plan: PaymentPlan;
  lead_time_days: number;
  fill_rate_score: number; // (0, 1]
  current_debt_usd: number; // max(0, -stakeholders.balance)
  credit_limit_usd: number; // 0 if no credit limit set
  min_order_usd: number;
  delivery_fee_usd: number;
}

export interface OptimizerSkuInput {
  product_id: number;
  name: string;
  barcode?: string | null;
  supplier_id: number;
  abc_class: "A" | "B" | "C";
  unit_cost_usd: number;
  unit_price_usd: number;
  unit_margin_usd: number;
  current_stock: number;
  pack_factor: number; // integer/real pieces per orderable pack (>= 1)
  weighted_daily_sales: number;
  demand_std_30d: number;
  safety_stock: number;
  shelf_life_days: number;
}

export interface OptimizerWeights {
  horizon_days: number;
  w_profit: number;
  w_turn: number;
  w_stockout_a: number;
  w_stockout_b: number;
  w_stockout_c: number;
  w_holding: number;
  w_credit_cost: number;
}

export interface OrOptimizationProblem {
  tenant_id: number;
  business_type: BusinessType;
  survival_mode: SurvivalMode;
  free_spendable_cash_usd: number;
  weights: OptimizerWeights;
  suppliers: OptimizerSupplierInput[];
  skus: OptimizerSkuInput[];
}

export interface RecommendedOrderLine {
  product_id: number;
  name: string;
  abc_class: "A" | "B" | "C";
  packs_to_order: number;
  pack_factor: number;
  ordered_qty: number;
  unit_cost_usd: number;
  line_cost_usd: number;
  expected_units_sold: number;
  expected_profit_usd: number;
  stockout_shortfall: number;
}

export interface RecommendedSupplierPlan {
  supplier_id: number;
  supplier_name: string;
  payment_plan: PaymentPlan;
  expected_delivery_date: string;
  order_total_usd: number;
  cash_payment_usd: number;
  credit_payment_usd: number;
  debt_paydown_usd: number;
  items: RecommendedOrderLine[];
}

export interface BindingConstraintInsight {
  code: "CASH_BUDGET" | "SUPPLIER_CREDIT_LIMIT" | "SHELF_LIFE_CAP" | "MOQ_THRESHOLD" | "NO_REORDER_NEEDED";
  message: string;
  shadow_price_usd?: number | null; // marginal objective/profit gain per extra $1
  supplier_id?: number;
}

export interface OrOptimizationSolution {
  solver: "highs-wasm" | "ortools-cloud";
  status: "Optimal" | "Infeasible" | "Empty" | "Error";
  solve_time_ms: number;
  horizon_days: number;
  business_type: BusinessType;
  survival_mode: SurvivalMode;
  cash_budget_usd: number;
  total_cash_used_usd: number;
  total_credit_used_usd: number;
  total_debt_paydown_usd: number;
  total_order_value_usd: number;
  expected_gross_profit_usd: number;
  marginal_cash_roi: number | null;
  binding_constraints: BindingConstraintInsight[];
  supplier_plans: RecommendedSupplierPlan[];
}

export interface SolverAdapter {
  readonly name: "highs-wasm" | "ortools-cloud";
  solve(problem: OrOptimizationProblem): Promise<OrOptimizationSolution>;
}
