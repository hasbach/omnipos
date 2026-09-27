// Weighted-average cost (WAC) for products, pure functions — no DB access. Called BEFORE the
// stock increment/decrement so `currentStock` here always means "stock before this line's effect".

// A purchase receipt blends the new cost into the running average, weighted by quantity on hand.
// If there's no existing cost basis yet (null/0 cost, or non-positive stock — nothing to average
// against), the new unit cost simply becomes the product's cost.
export function applyPurchaseCost(currentStock: number, currentCost: number | null | undefined, qty: number, unitCost: number): number {
  const stock = Math.max(currentStock || 0, 0);
  if (!currentCost || currentCost <= 0 || stock <= 0) return unitCost;
  return (stock * currentCost + qty * unitCost) / (stock + qty);
}

// Reverses a purchase line's contribution to the WAC (used when that purchase is edited or
// deleted). Only well-defined when removing this line still leaves stock behind and the result is
// non-negative — otherwise there's nothing sound to reverse to, so the cost is left unchanged.
export function reversePurchaseCost(currentStock: number, currentCost: number | null | undefined, qty: number, unitCost: number): number | null | undefined {
  const remaining = currentStock - qty;
  if (remaining > 0) {
    const cost = currentCost || 0;
    const result = (currentStock * cost - qty * unitCost) / remaining;
    if (result >= 0) return result;
  }
  return currentCost;
}
