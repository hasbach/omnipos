// Weighted-average cost (WAC) for products, pure functions — no DB access. Called BEFORE the
// stock increment/decrement so `currentStock` here always means "stock before this line's effect".

// A purchase receipt blends the new cost into the running average, weighted by quantity on hand.
// If there's no existing cost basis yet (null/0 cost, or non-positive stock — nothing to average
// against), the new unit cost simply becomes the product's cost.
// Costs are kept to 6 decimals: enough for a cost keyed in the local currency to convert back to the
// same whole local amount (195,000 LL at 89,500 must not come back as 195,003 or 194,450), without the
// float noise (1.0877483443708609) a running average otherwise accumulates and shows in the UI.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function applyPurchaseCost(currentStock: number, currentCost: number | null | undefined, qty: number, unitCost: number): number {
  const stock = Math.max(currentStock || 0, 0);
  if (!currentCost || currentCost <= 0 || stock <= 0) return round6(unitCost);
  return round6((stock * currentCost + qty * unitCost) / (stock + qty));
}

// Reverses a purchase line's contribution to the WAC (used when that purchase is edited or
// deleted). Only well-defined when removing this line still leaves stock behind and the result is
// non-negative — otherwise there's nothing sound to reverse to, so the cost is left unchanged.
export function reversePurchaseCost(currentStock: number, currentCost: number | null | undefined, qty: number, unitCost: number): number | null | undefined {
  const remaining = currentStock - qty;
  if (remaining > 0) {
    const cost = currentCost || 0;
    const result = (currentStock * cost - qty * unitCost) / remaining;
    if (result >= 0) return round6(result);
  }
  return currentCost;
}
