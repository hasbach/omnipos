// Shared types + small pure helpers for the Invoice/Purchase management pages. Page-local (not in
// src/lib/*) per the page-agent brief — this area owns these files.
import { lineTotal, type LineDiscount } from '../../lib/pricing';

export type TxType = 'sale' | 'purchase' | 'refund';
export type PaymentMethod = 'cash' | 'card' | 'credit' | 'store_credit';
export type PayStatus = 'paid' | 'partial' | 'unpaid';

export interface CurrencyRow {
  id?: number;
  code: string;
  symbol: string;
  rate: number;
  is_default?: number;
}

/** Row shape returned by GET /api/transactions/recent (and used to build the combined invoices list). */
export interface InvoiceListRow {
  id: number;
  type: TxType;
  stakeholder_id: number | null;
  stakeholder_name?: string;
  user_name?: string;
  total_amount: number;
  currency: string;
  exchange_rate: number;
  created_at: string;
  archived: 0 | 1 | boolean;
  edited_at?: string | null;
  edit_count?: number;
  paid_amount: number;
  item_count: number;
  reference?: string | null;
  notes?: string | null;
  /** Set on a refund row — the sale it refunds (server's TX_LIVE_COLUMNS/TX_ARCHIVED_COLUMNS). */
  original_transaction_id?: number | null;
}

/** Row shape returned by GET /api/purchases. */
export interface PurchaseListRow extends Omit<InvoiceListRow, 'type' | 'stakeholder_name'> {
  type: 'purchase';
  supplier_id: number | null;
  supplier_name?: string;
  status?: string;
}

export interface LineDraft {
  _key: string;
  product_id: number;
  name: string;
  barcode?: string;
  quantity: number;
  unit_price: number;
  unit_cost?: number | null;
  discount: LineDiscount;
  /** Catalog tier price at the moment this line was added/repriced — for the "tier price" hint. */
  catalogPrice?: number;
  minPrice?: number | null;
}

export interface PaymentDraft {
  _key: string;
  id?: number; // present => an existing payment row; omitted => a new one to insert
  amount: number;
  method: PaymentMethod;
  currency: string;
  exchange_rate: number;
  created_at?: string;
  removed?: boolean; // existing payment marked for removal (omitted from the PUT payments array)
}

export function payStatus(total: number, paid: number): PayStatus {
  if (total <= 0.0001) return paid > 0 ? 'paid' : 'unpaid';
  if (paid >= total - 0.01) return 'paid';
  if (paid > 0.005) return 'partial';
  return 'unpaid';
}

export function lineDraftTotal(l: LineDraft): number {
  return lineTotal(l.unit_price, l.quantity, l.discount);
}

/**
 * Mirrors server/pricing.ts computeTotals(lineTotals, discount, tax) exactly — including tax as
 * a percentage/fixed adjustment, which src/lib/pricing.ts's own computeTotals() does not support
 * (it only takes a flat tax percent). Kept page-local rather than editing the shared lib.
 */
export function computeInvoiceTotals(
  lines: LineDraft[],
  discount: LineDiscount | null | undefined,
  tax: LineDiscount | null | undefined,
): { subtotal: number; discountAmount: number; taxAmount: number; total: number } {
  const subtotal = lines.reduce((sum, l) => sum + lineDraftTotal(l), 0);

  let discountAmount = 0;
  if (discount) {
    discountAmount =
      discount.type === 'percentage'
        ? subtotal * (Math.max(0, Math.min(100, discount.value)) / 100)
        : Math.min(Math.max(0, discount.value), subtotal);
  }
  const afterDiscount = Math.max(0, subtotal - discountAmount);

  let taxAmount = 0;
  if (tax) {
    taxAmount =
      tax.type === 'percentage'
        ? afterDiscount * (Math.max(0, tax.value) / 100)
        : Math.max(0, tax.value);
  }

  const total = Math.max(0, afterDiscount + taxAmount);
  return { subtotal, discountAmount, taxAmount, total };
}

let keySeq = 0;
export function nextKey(prefix: string): string {
  keySeq += 1;
  return `${prefix}_${keySeq}_${Date.now()}`;
}

/**
 * What counts as "paid" for invoice settlement status (paid_amount, due, aging): 'credit' does NOT
 * settle the invoice; 'store_credit' DOES (it's not money, but the invoice is considered paid) — see
 * server/paymentMethods.ts SETTLED_SQL ("method != 'credit'"). Summed in USD.
 */
export function paidFromPayments(payments: PaymentDraft[]): number {
  return payments
    .filter((p) => !p.removed && p.method !== 'credit')
    .reduce((sum, p) => sum + p.amount / (p.exchange_rate || 1), 0);
}

/**
 * Real money collected/paid out (excludes BOTH 'credit' and 'store_credit' — neither is money; see
 * server/paymentMethods.ts REAL_MONEY_SQL). Used for balance-effect / cash-register math, never for
 * invoice settlement status. Summed in USD.
 */
export function realMoneyFromPayments(payments: PaymentDraft[]): number {
  return payments
    .filter((p) => !p.removed && p.method !== 'credit' && p.method !== 'store_credit')
    .reduce((sum, p) => sum + p.amount / (p.exchange_rate || 1), 0);
}

/** Sum of (non-removed) store_credit payments, in USD — must not exceed the party's available balance. */
export function storeCreditFromPayments(payments: PaymentDraft[]): number {
  return payments
    .filter((p) => !p.removed && p.method === 'store_credit')
    .reduce((sum, p) => sum + p.amount / (p.exchange_rate || 1), 0);
}

/** Server error shape thrown by postJson/putJson below — carries `code`/`field`/`available` that the
 * shared src/lib/api.ts (page agents may not edit) discards, needed here for inline field errors. */
export class ApiFieldError extends Error {
  code?: string;
  field?: string;
  available?: number;
  constructor(body: any, status: number) {
    super((body && typeof body === 'object' && body.error) || `Request failed (${status})`);
    this.code = body?.code;
    this.field = body?.field;
    this.available = body?.available;
  }
}

async function requestJson(method: 'POST' | 'PUT', url: string, data?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiFieldError(body, res.status);
  return body;
}

/** Like api.post, but the rejected promise carries `.code`/`.field`/`.available` for inline errors. */
export function postJson<T = any>(url: string, data?: unknown): Promise<T> {
  return requestJson('POST', url, data);
}
/** Like api.put, but the rejected promise carries `.code`/`.field`/`.available` for inline errors. */
export function putJson<T = any>(url: string, data?: unknown): Promise<T> {
  return requestJson('PUT', url, data);
}
