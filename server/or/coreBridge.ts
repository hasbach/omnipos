// Anti-duplication bridge to OmniPOS Core ledger & inventory tables.
// Every function here expects to be called inside the caller's ACID `db.transaction()`.
import { db } from "../db.js";
import { ValidationError } from "../errors.js";
import { resolveAccountId } from "../cashAccounts.js";
import { recomputeStakeholderBalance } from "../balance.js";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function localDateIso(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resolveTenantUserId(tenantId: number, requested?: number | null): number | null {
  if (requested) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL").get(requested, tenantId) as any;
    if (u) return u.id;
  }
  const first = db
    .prepare("SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY (role = 'admin') DESC, id LIMIT 1")
    .get(tenantId) as any;
  return first ? first.id : null;
}

/**
 * Adjusts a product's stock in OmniPOS Core (`products.stock` + `stock_adjustments`) inside the active transaction.
 * Returns the created `stock_adjustments.id` so OR records can link `core_stock_tx_id` / `core_adjustment_tx_id`.
 */
export function adjustProductStockCore(params: {
  tenantId: number;
  productId: number;
  userId: number | null;
  delta?: number;
  newQty?: number;
  reason: string;
  unitCostOverride?: number | null;
}): { adjustmentId: number; qtyBefore: number; qtyAfter: number; delta: number; unitCost: number } {
  const { tenantId, productId, userId, reason } = params;
  const product = db
    .prepare("SELECT id, stock, cost, track_inventory FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(productId, tenantId) as any;
  if (!product) {
    throw new ValidationError(`Product #${productId} not found.`, 404, { code: "PRODUCT_NOT_FOUND", field: "product_id" });
  }
  const qtyBefore = Number(product.stock) || 0;
  let qtyAfter: number;
  if (params.newQty !== undefined && params.newQty !== null) {
    qtyAfter = Number(params.newQty);
  } else if (params.delta !== undefined && params.delta !== null) {
    qtyAfter = qtyBefore + Number(params.delta);
  } else {
    throw new ValidationError("Provide either newQty or delta.", 400, { code: "STOCK_ADJUST_INVALID" });
  }
  if (!Number.isFinite(qtyAfter)) {
    throw new ValidationError("Invalid stock quantity.", 400, { code: "STOCK_ADJUST_INVALID" });
  }
  const appliedDelta = qtyAfter - qtyBefore;
  const unitCost = params.unitCostOverride != null ? Number(params.unitCostOverride) : (Number(product.cost) || 0);

  db.prepare("UPDATE products SET stock = ? WHERE id = ? AND tenant_id = ?").run(qtyAfter, productId, tenantId);
  const info = db
    .prepare(
      "INSERT INTO stock_adjustments (tenant_id, product_id, user_id, qty_before, qty_after, delta, reason, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(tenantId, productId, userId, qtyBefore, qtyAfter, appliedDelta, reason, unitCost);

  return {
    adjustmentId: Number(info.lastInsertRowid),
    qtyBefore,
    qtyAfter,
    delta: appliedDelta,
    unitCost,
  };
}

/**
 * Writes an `owner_withdrawal` outflow into OmniPOS Core `cash_flow` linked to the chosen `cash_accounts` row.
 * Returns `cash_flow.id` (which is preserved verbatim when End-of-Day Settlement archives to `archived_cash_flow`).
 */
export function recordOwnerDrawCashCore(params: {
  tenantId: number;
  userId: number | null;
  amountNative: number;
  currency: string;
  exchangeRate: number;
  accountId?: number | null;
  counterparty?: string | null;
  reason: string;
}): { cashFlowId: number; accountId: number; amountUsd: number } {
  const { tenantId, userId, amountNative, currency, exchangeRate, counterparty, reason } = params;
  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
  const amt = Number(amountNative);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new ValidationError("Cash draw amount must be greater than zero.", 400, { code: "OR_DRAW_AMOUNT_INVALID" });
  }
  const accountId = resolveAccountId(tenantId, params.accountId, true);
  const info = db
    .prepare(
      `INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, category, counterparty, reason, account_id)
       VALUES (?, ?, 'out', ?, ?, ?, 'owner_withdrawal', ?, ?, ?)`
    )
    .run(tenantId, userId, amt, currency || "USD", rate, counterparty ?? null, reason, accountId);

  return {
    cashFlowId: Number(info.lastInsertRowid),
    accountId,
    amountUsd: round2(amt / rate),
  };
}

/**
 * Converts a received PO commitment into a real OmniPOS Core purchase transaction (`transactions` + `transaction_items` + `payments`),
 * increments `products.stock`, updates weighted product cost if missing, and recomputes supplier balance via `server/balance.ts`.
 */
export function createPurchaseFromPoCore(params: {
  tenantId: number;
  supplierId: number;
  userId: number | null;
  poNumber: string | null;
  notes: string | null;
  items: Array<{ product_id: number; quantity: number; unit_cost: number }>;
  cashPaidUsd: number;
  accountId?: number | null;
}): { transactionId: number; totalUsd: number; creditAddedUsd: number } {
  const { tenantId, supplierId, userId, poNumber, notes, items, cashPaidUsd } = params;
  const validItems = items.filter((it) => Number(it.quantity) > 0);
  if (validItems.length === 0) {
    throw new ValidationError("At least one received item with quantity > 0 is required.", 400, { code: "PO_RECEIVE_EMPTY" });
  }
  const totalUsd = round2(validItems.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_cost), 0));
  const paidUsd = round2(Math.max(0, Number(cashPaidUsd) || 0));
  const creditAddedUsd = round2(Math.max(0, totalUsd - paidUsd));

  const txInfo = db
    .prepare(
      `INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status, reference, notes)
       VALUES (?, ?, ?, 'purchase', ?, 'USD', 1, 'received', ?, ?)`
    )
    .run(tenantId, supplierId, userId, totalUsd, poNumber || null, notes || "Received via OmniPulse OR PO Cash-Lock");
  const txId = Number(txInfo.lastInsertRowid);

  const insertItem = db.prepare(
    `INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost)
     VALUES (?, ?, ?, ?, ?)`
  );
  const updateStock = db.prepare(
    `UPDATE products SET stock = IFNULL(stock, 0) + ?, cost = CASE WHEN ? > 0 THEN ? ELSE cost END WHERE id = ? AND tenant_id = ?`
  );

  for (const it of validItems) {
    const qty = Number(it.quantity);
    const cost = Number(it.unit_cost) || 0;
    insertItem.run(txId, it.product_id, qty, cost, cost);
    updateStock.run(qty, cost, cost, it.product_id, tenantId);
  }

  if (paidUsd > 0) {
    const accountId = resolveAccountId(tenantId, params.accountId, true);
    db.prepare(
      `INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate, account_id)
       VALUES (?, ?, 'cash', 'USD', 1, ?)`
    ).run(txId, paidUsd, accountId);
  }
  if (creditAddedUsd > 0.005) {
    db.prepare(
      `INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate)
       VALUES (?, ?, 'credit', 'USD', 1)`
    ).run(txId, creditAddedUsd);
  }

  recomputeStakeholderBalance(supplierId, tenantId, {
    source: "or_po_receive",
    reference_id: txId,
    user_id: userId,
    note: poNumber ? `PO ${poNumber} received` : `PO #${txId} received`,
  });

  return { transactionId: txId, totalUsd, creditAddedUsd };
}
