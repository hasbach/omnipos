// Matches the exact per-item discount math used by POST /api/transactions (unit_price*qty, then a
// percentage or fixed discount applied on top; fixed is floored at 0).
export function lineNet(unitPrice: number, qty: number, discountType: string | null, discountValue: number | null): number {
  let total = unitPrice * qty;
  if (discountValue) {
    total = discountType === "percentage" ? total * (1 - discountValue / 100) : Math.max(0, total - discountValue);
  }
  return total;
}

// The global (whole-invoice) discount amount, matching POST's clamping: a percentage is applied to
// the subtotal, a fixed amount is clamped to it (never inflates a line's share past 100%).
export function globalDiscountAmount(subtotal: number, discountType: string | null, discountValue: number | null): number {
  if (!discountValue) return 0;
  if (discountType === "percentage") return subtotal * (discountValue / 100);
  if (discountType === "fixed") return Math.min(discountValue, subtotal);
  return 0;
}

// Daily Sales and Profit bucket invoices by the store's original local calendar date.
export const dailySalesDate = "date(created_at, 'localtime')";
export const dailySalesTypeFilter = "type != 'purchase'";
