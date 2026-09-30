// Shapes returned by the settlement-detail API (docs/plans/2026-09-29-settlement-detail.md).

export type MethodMap = { cash?: number; card?: number; credit?: number; store_credit?: number };
export type NativeMap = Record<string, number>;

export interface FlowBlock {
  count: number;
  total: number;
  by_method?: MethodMap;
  cash_by_currency?: NativeMap;
}

export interface CashMoveBlock {
  total: number;
  count?: number;
  by_currency?: NativeMap;
}

export interface RegisterBlock {
  opening: number;
  cash_sales: number;
  cash_refunds: number;
  cash_purchases: number;
  cash_in: number;
  cash_out: number;
  expected: number;
}

export interface ShiftSnapshot {
  user_name: string;
  expected_cash: number;
  actual_cash: number;
  difference: number;
  created_at?: string;
}

export interface Breakdown {
  legacy?: boolean;
  period_start?: string | null;
  period_end?: string | null;
  sales?: FlowBlock;
  refunds?: FlowBlock;
  purchases?: FlowBlock;
  cash_in?: CashMoveBlock;
  cash_out?: CashMoveBlock;
  register?: RegisterBlock;
  shifts?: ShiftSnapshot[];
}

export interface CountedLine {
  currency: string;
  amount: number;
  rate: number;
  amount_usd?: number;
}

export interface SettlementDiff {
  path: string;
  recorded: number;
  rebuilt: number;
}

export interface EditedInvoice {
  transaction_id: number;
  edited_at: string;
  user_name?: string | null;
  reason?: string | null;
  before_total: number;
  after_total: number;
}

export interface LatePayment {
  transaction_id: number;
  amount_usd: number;
  method: string;
  created_at: string;
}

export interface SettlementCorrection {
  id: number;
  kind: 'counted' | 'adjustment';
  currency: string | null;
  old_value: number | null;
  new_value: number | null;
  amount_usd: number;
  reason: string;
  user_name?: string | null;
  created_at: string;
}

export interface SettlementReport {
  id: number;
  date: string;
  user_name?: string | null;
  opening_balance?: number;
  total_sales?: number;
  total_refunds?: number;
  total_purchases?: number;
  total_cash_in?: number;
  total_cash_out?: number;
  closing_balance: number;
  actual_balance: number;
  difference: number;
  notes?: string | null;
  settled_at?: string | null;
  created_at?: string | null;
  period_start?: string | null;
  adjustments_total?: number;
  corrected_actual_balance?: number | null;
  effective_actual?: number;
  effective_expected?: number;
  effective_difference?: number;
  corrections_count?: number;
  changed_after_close?: boolean;
  /** Closed before v1.7.1: the recorded register only covered the time since the last cashier Cash Out. */
  window_widened?: boolean;
}

export interface SettlementDetail {
  report: SettlementReport;
  recorded: Breakdown | null;
  rebuilt: Breakdown | null;
  counted: CountedLine[];
  corrected_counted: CountedLine[] | null;
  changes: {
    changed: boolean;
    window_widened?: boolean;
    diffs: SettlementDiff[];
    edited_invoices: EditedInvoice[];
    late_payments: LatePayment[];
  };
  corrections: SettlementCorrection[];
}

/** Effective (post-correction) figures for a history row; falls back to the recorded ones. */
export function effectiveOf(r: SettlementReport) {
  const expected = r.effective_expected ?? r.closing_balance;
  const actual = r.effective_actual ?? r.corrected_actual_balance ?? r.actual_balance;
  const difference = r.effective_difference ?? actual - expected;
  return { expected, actual, difference };
}
