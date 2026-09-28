// Payment method classification — shared by server/balance.ts, server/routes.ts,
// server/invoiceEdit.ts and server/reports.ts. See docs/plans/2026-09-28-store-credit-and-levels.md
// section 1 for the full rationale. `store_credit` ("pay from the stakeholder's own positive
// balance") behaves differently depending on WHICH question is being asked:
//
//   - BALANCE MATH (server/balance.ts, settlement banking, the archived-edit effect delta,
//     credit-limit's prospective balance): store_credit is NOT money, exactly like `credit` — an
//     invoice paid with it stays "unpaid" in the derived-balance sense, so its effect still
//     consumes the positive balance that made the store_credit payment possible in the first place.
//   - INVOICE SETTLEMENT STATUS (paid_amount, unpaid/paid filters, aging, refundable, statements):
//     store_credit COUNTS as paid — the invoice itself is settled. `credit` still doesn't.
//   - REAL MONEY (the cash register, reports "collected", by-payment-method's own row): store_credit
//     is not cash/card collected, same as credit.
//
// REAL_MONEY_SQL / SETTLED_SQL are raw SQL text (not bound params) meant to be spliced directly
// into a template string's `method != '...'` / `method NOT IN (...)` position.
export const PAYMENT_METHODS = ['cash', 'card', 'credit', 'store_credit'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

export const REAL_MONEY_SQL = "method NOT IN ('credit','store_credit')";
export const SETTLED_SQL = "method != 'credit'";

export function isRealMoney(method: string | null | undefined): boolean {
  return method !== 'credit' && method !== 'store_credit';
}

export function settlesInvoice(method: string | null | undefined): boolean {
  return method !== 'credit';
}

export function isValidPaymentMethod(method: any): method is PaymentMethod {
  return typeof method === 'string' && (PAYMENT_METHODS as readonly string[]).includes(method);
}
