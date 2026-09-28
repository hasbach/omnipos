// Shared response shapes for server/reports.ts, used by every tab under src/pages/reports/.
// Kept local to the reports area (see docs/plans/page-agent-brief.md — don't touch src/types.ts).
import type { CurrencyLike, DateRange } from '../../lib/format';

/** Common props every report tab receives from src/pages/Reports.tsx. */
export interface ReportTabProps {
  range: DateRange;
  /** The tenant's local (non-USD) currency, if configured — null if only USD is set up. */
  localCurrency: CurrencyLike | null;
  businessName: string;
}

export interface ReportSummary {
  from: string;
  to: string;
  sales: number;
  refunds: number;
  net_sales: number;
  discounts: number;
  cogs: number;
  gross_profit: number;
  margin_pct: number;
  purchases: number;
  tax: number;
  cash_in: number;
  cash_out: number;
  tx_count: number;
  sale_count: number;
  avg_ticket: number;
  collected: number;
  receivables: number;
  payables: number;
  inventory_value_cost: number;
  inventory_value_retail: number;
  low_stock_count: number;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  revenue: number;
  cogs: number;
  gross_profit: number;
  expenses: number;
  net_profit: number;
}

export interface SalesTrendPoint {
  period: string;
  sales: number;
  refunds: number;
  net: number;
  cogs: number;
  profit: number;
  count: number;
}

export interface ByProductRow {
  product_id: number;
  name: string;
  barcode: string | null;
  category: string;
  qty: number;
  revenue: number;
  cogs: number;
  profit: number;
  margin_pct: number;
}

export interface ByCategoryRow {
  category: string;
  qty: number;
  revenue: number;
  cogs: number;
  profit: number;
  margin_pct: number;
  share_pct: number;
}

export interface ByCustomerRow {
  stakeholder_id: number;
  name: string;
  invoices: number;
  revenue: number;
  profit: number;
  paid: number;
  balance: number;
}

export interface ByCashierRow {
  user_id: number;
  name: string;
  invoices: number;
  revenue: number;
  refunds: number;
  avg_ticket: number;
}

export interface ByPaymentMethodRow {
  kind: 'sale' | 'purchase' | 'refund';
  method: string;
  currency: string;
  amount: number;
  amount_usd: number;
  count: number;
}

export interface BySupplierRow {
  stakeholder_id: number;
  name: string;
  purchases: number;
  amount: number;
  paid: number;
  balance: number;
}

export interface InventoryValuationRow {
  product_id: number;
  name: string;
  barcode: string | null;
  category: string;
  stock: number;
  cost: number;
  value_cost: number;
  price: number;
  value_retail: number;
  potential_profit: number;
}

export interface InventoryValuationResponse {
  rows: InventoryValuationRow[];
  totals: {
    value_cost: number;
    value_retail: number;
    potential_profit: number;
    product_count: number;
  };
}

export interface LowStockRow {
  product_id: number;
  name: string;
  barcode: string | null;
  category: string;
  stock: number;
  reorder_point: number;
  cost: number;
  price: number;
  suggested_order: number;
}

export interface SlowMoverRow {
  product_id: number;
  name: string;
  barcode: string | null;
  category: string;
  stock: number;
  qty_sold: number;
  last_sold_at: string | null;
}

export interface AgingRow {
  stakeholder_id: number;
  name: string;
  balance: number;
  current: number;
  d31_60: number;
  d61_90: number;
  d90_plus: number;
  oldest_invoice_at: string | null;
}

export interface CustomBuilderRow {
  invoice_no: number;
  date: string;
  type: 'sale' | 'purchase' | 'refund';
  stakeholder: string | null;
  total_amount: number;
  currency: string;
  paid_amount: number;
  balance: number;
  processed_by: string | null;
}

export interface CustomerStatementRow {
  date: string;
  type: 'sale' | 'refund' | 'purchase' | 'payment';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  user: string | null;
}

export interface DailyReportRow {
  id: number;
  date: string;
  opening_balance: number;
  total_sales: number;
  total_purchases: number;
  total_cash_in: number;
  total_cash_out: number;
  closing_balance: number;
  actual_balance: number;
  difference: number;
  notes: string | null;
  user_name: string | null;
  // Settlement-detail API: effective values include admin corrections.
  effective_actual?: number;
  effective_expected?: number;
  effective_difference?: number;
  corrections_count?: number;
  changed_after_close?: boolean;
}

export interface YearlyReportRow {
  id: number;
  year: number;
  total_sales: number;
  total_purchases: number;
  total_profit: number;
  notes: string | null;
  user_name: string | null;
}

export interface StakeholderLite {
  id: number;
  name: string;
  type: 'customer' | 'supplier';
  balance: number;
}

export interface ProductLite {
  id: number;
  name: string;
  category: string;
}
