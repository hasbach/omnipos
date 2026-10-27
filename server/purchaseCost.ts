import { db } from "./db.js";
import { localCurrencyFor } from "./localCurrency.js";

// Product costs use the tenant global rate, independent of supplier payment rates.
export function updatePurchaseProductCost(tenantId: number, productId: number, cost: number | null | undefined): void {
  const local = localCurrencyFor(tenantId);
  const localCost = local && cost != null ? Math.round(cost * local.rate * 100) / 100 : null;
  db.prepare("UPDATE products SET cost = ?, cost_lbp = CASE WHEN ? THEN ? ELSE cost_lbp END WHERE id = ? AND tenant_id = ?")
    .run(cost ?? null, local ? 1 : 0, localCost, productId, tenantId);
}
