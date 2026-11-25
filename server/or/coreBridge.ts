// Anti-duplication bridge to OmniPOS Core ledger & inventory tables.
// Every function here expects to be called inside the caller's ACID `db.transaction()`.
import { db } from "../db.js";
import { ValidationError } from "../errors.js";
import { resolveAccountId } from "../cashAccounts.js";
import { recomputeStakeholderBalance } from "../balance.js";
import { applyPurchaseCost } from "../costing.js";
import { updatePurchaseProductCost } from "../purchaseCost.js";

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
 * with the same product rules as `POST /api/transactions`: products must belong to the tenant and be live, stock moves only for
 * tracked products, and the product cost is the weighted average (`applyPurchaseCost`), never just the latest price.
 * The unpaid part stays on the supplier balance (total - cash paid), recomputed via `server/balance.ts`.
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
  const getProduct = db.prepare("SELECT id, stock, cost, track_inventory FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL");
  const products = new Map<number, any>();
  for (const it of validItems) {
    const qty = Number(it.quantity);
    const cost = Number(it.unit_cost);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cost) || cost < 0) {
      throw new ValidationError("Each received line needs a positive quantity and a non-negative unit cost.", 400, { code: "PO_RECEIVE_LINE_INVALID" });
    }
    if (!products.has(it.product_id)) {
      const prod = getProduct.get(it.product_id, tenantId) as any;
      if (!prod) {
        throw new ValidationError(`Product #${it.product_id} not found.`, 404, { code: "PRODUCT_NOT_FOUND", field: "items" });
      }
      products.set(it.product_id, { ...prod });
    }
  }

  const totalUsd = round2(validItems.reduce((sum, it) => sum + Number(it.quantity) * Number(it.unit_cost), 0));
  const paidUsd = round2(Math.max(0, Number(cashPaidUsd) || 0));
  if (paidUsd > totalUsd + 0.005) {
    throw new ValidationError(`Cash paid ($${paidUsd.toFixed(2)}) is more than the delivery total ($${totalUsd.toFixed(2)}).`, 400, {
      code: "PO_RECEIVE_OVERPAID",
      field: "actual_cash_paid",
    });
  }
  const creditAddedUsd = round2(Math.max(0, totalUsd - paidUsd));

  const seq = db
    .prepare("SELECT IFNULL(MAX(terminal_sequence), 0) + 1 AS next_seq FROM transactions WHERE terminal_id = 'MAIN' AND tenant_id = ?")
    .get(tenantId) as any;
  const txInfo = db
    .prepare(
      `INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status, reference, notes, terminal_id, terminal_sequence)
       VALUES (?, ?, ?, 'purchase', ?, 'USD', 1, 'completed', ?, ?, 'MAIN', ?)`
    )
    .run(tenantId, supplierId, userId, totalUsd, poNumber || null, notes || "Received via OmniPulse OR PO Cash-Lock", seq.next_seq);
  const txId = Number(txInfo.lastInsertRowid);

  const insertItem = db.prepare(
    `INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost)
     VALUES (?, ?, ?, ?, ?)`
  );
  const updateStock = db.prepare("UPDATE products SET stock = IFNULL(stock, 0) + ? WHERE id = ? AND tenant_id = ?");

  for (const it of validItems) {
    const qty = Number(it.quantity);
    const cost = Number(it.unit_cost) || 0;
    const prod = products.get(it.product_id);
    insertItem.run(txId, it.product_id, qty, cost, cost);
    // Weighted-average cost, blended line by line exactly like a Core purchase.
    const newCost = applyPurchaseCost(Number(prod.stock) || 0, prod.cost, qty, cost);
    prod.cost = newCost;
    prod.stock = (Number(prod.stock) || 0) + qty;
    updatePurchaseProductCost(tenantId, it.product_id, newCost);
    if (prod.track_inventory !== 0) updateStock.run(qty, it.product_id, tenantId);
  }

  if (paidUsd > 0) {
    const accountId = resolveAccountId(tenantId, params.accountId, true);
    db.prepare(
      `INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate, account_id)
       VALUES (?, ?, 'cash', 'USD', 1, ?)`
    ).run(txId, paidUsd, accountId);
  }

  recomputeStakeholderBalance(supplierId, tenantId, {
    source: "or_po_receive",
    reference_id: txId,
    user_id: userId,
    note: poNumber ? `PO ${poNumber} received` : `PO #${txId} received`,
  });

  return { transactionId: txId, totalUsd, creditAddedUsd };
}
