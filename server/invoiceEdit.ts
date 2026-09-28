// PUT /api/transactions/:id — edit a LIVE or ARCHIVED (settled) sale/purchase invoice in place.
// Kept out of server/routes.ts to keep that file readable; the route handler there just calls
// editTransaction() and re-renders the same response shape as GET /api/transactions/:id.
import { db, logAction } from "./db.js";
import { recomputeStakeholderBalance, transactionBalanceEffect } from "./balance.js";
import { getActiveSession } from "./session.js";
import { normalizeLevel, saleLineUnitPrice, lineTotal, computeTotals, uomUnitPrice, type PriceLevel } from "./pricing.js";
import { loadUnit, loadUnitsForProduct } from "./uom.js";
import { applyPurchaseCost, reversePurchaseCost } from "./costing.js";
import { ValidationError } from "./errors.js";
import { isValidPaymentMethod, isRealMoney } from "./paymentMethods.js";

// Same guard as tenantStakeholderId in server/routes.ts (kept local to avoid a circular import
// between routes.ts and this module) — resolves to a stakeholder that actually belongs to this
// tenant, falling back to Walk-in Customer, so a stale/foreign id can never be stored.
function resolveStakeholderId(tenantId: number, requested: any): number | null {
  if (requested) {
    const s = db.prepare("SELECT id FROM stakeholders WHERE id = ? AND tenant_id = ?").get(requested, tenantId) as any;
    if (s) return s.id;
  }
  const walkIn = db.prepare(
    "SELECT id FROM stakeholders WHERE tenant_id = ? ORDER BY (name = 'Walk-in Customer') DESC, (type = 'customer') DESC, id LIMIT 1"
  ).get(tenantId) as any;
  return walkIn ? walkIn.id : null;
}

// Same query as getSettingsMap in server/routes.ts (kept local to avoid a circular import between
// routes.ts and this module — routes.ts imports editTransaction from here).
function getSettingsMap(tenantId: number): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings WHERE tenant_id = ?").all(tenantId) as any[];
  return rows.reduce((acc: any, r: any) => { acc[r.key] = r.value; return acc; }, {} as Record<string, string>);
}

// Quantity of each product already refunded against a given original sale — same query as
// refundedQuantityByProduct in server/routes.ts. A sale being edited can't have any of its lines
// reduced below what's already been refunded against them.
function refundedQuantityByProduct(tenantId: number, originalTransactionId: number): Record<number, number> {
  const rows = db.prepare(`
    SELECT ti.product_id, SUM(ti.quantity) as qty
    FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'refund' AND t.original_transaction_id = ?
    GROUP BY ti.product_id
    UNION ALL
    SELECT ti.product_id, SUM(ti.quantity) as qty
    FROM archived_transaction_items ti JOIN archived_transactions t ON ti.transaction_id = t.id
    WHERE t.tenant_id = ? AND t.type = 'refund' AND t.original_transaction_id = ?
    GROUP BY ti.product_id
  `).all(tenantId, originalTransactionId, tenantId, originalTransactionId) as any[];
  const map: Record<number, number> = {};
  for (const r of rows) map[r.product_id] = (map[r.product_id] || 0) + (r.qty || 0);
  return map;
}

// Best-effort cloud delete of specific rows by global_id — same pattern/limitations as
// purgeCloudTransaction in server/routes.ts (no-ops when offline or never synced). Used for the
// item rows (always fully replaced on edit) and any payment rows the edit removes.
async function purgeCloudRows(table: 'payments' | 'transaction_items', globalIds: (string | null | undefined)[]): Promise<void> {
  const ids = globalIds.filter((g): g is string => !!g);
  if (!ids.length) return;
  const session = getActiveSession();
  if (!session || !session.globalId) return;
  const { error } = await session.client.from(table).delete().in('global_id', ids);
  if (error) throw error;
}

interface EditItemInput {
  product_id: number;
  uom_id?: number | null; // unit of measure; quantity and unit_price are in THIS unit (absent = base pieces)
  quantity: number;
  unit_price?: number;
  discount?: { type?: 'percentage' | 'fixed' | null; value?: number | null } | null;
}

interface EditPaymentInput {
  id?: number;
  amount?: number;
  method?: string;
  currency?: string;
  exchange_rate?: number;
}

export interface EditTransactionBody {
  stakeholder_id?: number | null;
  items: EditItemInput[];
  payments?: EditPaymentInput[];
  discount?: { type?: 'percentage' | 'fixed' | null; value?: number | null } | null;
  tax?: { type?: 'percentage' | 'fixed' | null; value?: number | null } | null;
  notes?: string | null;
  reference?: string | null;
  price_level?: string | null;
  created_at?: string | null;
  reason?: string | null;
  user_id?: number | null;
}

const invalidAdjustment = (adj: any, label: string): string | null => {
  if (!adj) return null;
  if (adj.type !== 'percentage' && adj.type !== 'fixed') return `Invalid ${label} type.`;
  if (!Number.isFinite(adj.value) || adj.value < 0) return `Invalid ${label} value.`;
  if (adj.type === 'percentage' && adj.value > 100) return `${label === 'discount' ? 'Discount' : 'Tax'} percentage cannot exceed 100%.`;
  return null;
};

// Edits a live or archived sale/purchase invoice in place. Returns which table it lives in so the
// route handler can re-render it with the same shape as GET /api/transactions/:id.
export async function editTransaction(tenantId: number, id: number, body: EditTransactionBody): Promise<{ id: number; archived: boolean; balance_before: number | null; balance_after: number | null }> {
  let archived = false;
  let tx = db.prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ?").get(id, tenantId) as any;
  let txTable = "transactions";
  let itemsTable = "transaction_items";
  let paymentsTable = "payments";
  if (!tx) {
    tx = db.prepare("SELECT * FROM archived_transactions WHERE id = ? AND tenant_id = ?").get(id, tenantId) as any;
    txTable = "archived_transactions";
    itemsTable = "archived_transaction_items";
    paymentsTable = "archived_payments";
    archived = true;
  }
  if (!tx) throw new ValidationError("Transaction not found.", 404);
  if (tx.type === 'refund') throw new ValidationError("A refund can't be edited — refund the delta instead.", 400);

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new ValidationError("An invoice must have at least one line item.");

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
      throw new ValidationError(`Invalid quantity for product ${item.product_id}.`, 400, { field: `items.${idx}.quantity` });
    }
    if (item.unit_price !== undefined && !(Number.isFinite(item.unit_price) && item.unit_price >= 0)) {
      throw new ValidationError(`Invalid unit price for product ${item.product_id}.`, 400, { field: `items.${idx}.unit_price` });
    }
    const discErr = invalidAdjustment(item.discount, 'line discount');
    if (discErr) throw new ValidationError(discErr, 400, { field: `items.${idx}.unit_price` });
  }
  // Resolve each line's unit of measure from the DB (never trust a client factor). Quantities are
  // converted to base pieces from here on; stored unit_price / unit_cost are per piece.
  const lineUoms = items.map((item, idx) => {
    if (item.uom_id === undefined || item.uom_id === null) return null;
    const uom = loadUnit(tenantId, item.product_id, item.uom_id);
    if (!uom) throw new ValidationError(`Unit ${item.uom_id} is not valid for product ${item.product_id}.`, 400, { code: 'UOM_INVALID', field: `items.${idx}.uom_id` });
    return uom;
  });
  for (const p of Array.isArray(body.payments) ? body.payments : []) {
    if (p.id !== undefined && p.id !== null) continue; // existing payment, kept as-is
    if (!(Number.isFinite(p.amount) && (p.amount as number) > 0)) throw new ValidationError("Invalid payment amount.", 400, { field: 'payments' });
    if (!isValidPaymentMethod(p.method)) throw new ValidationError("Invalid payment method.", 400, { field: 'payments' });
    if (!p.currency) throw new ValidationError("Payment currency is required.", 400, { field: 'payments' });
    if (p.exchange_rate !== undefined && !(Number.isFinite(p.exchange_rate) && (p.exchange_rate as number) > 0)) throw new ValidationError("Invalid payment exchange rate.", 400, { field: 'payments' });
  }
  // Same tenant-scoped user guard as tenantUserId() in routes.ts — cash_flow rows reference users.
  const editUserId: number | null = (() => {
    const u = body.user_id ? db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?").get(body.user_id, tenantId) as any : null;
    if (u) return u.id;
    const first = db.prepare("SELECT id FROM users WHERE tenant_id = ? ORDER BY (role = 'admin') DESC, id LIMIT 1").get(tenantId) as any;
    return first ? first.id : null;
  })();
  const discountError = invalidAdjustment(body.discount, 'discount');
  if (discountError) throw new ValidationError(discountError);
  const taxError = invalidAdjustment(body.tax, 'tax');
  if (taxError) throw new ValidationError(taxError);

  const oldItems = db.prepare(`SELECT * FROM ${itemsTable} WHERE transaction_id = ?`).all(id) as any[];
  const oldByProduct: Record<number, any> = {};
  const oldByLine: Record<string, any> = {};
  for (const oi of oldItems) {
    oldByProduct[oi.product_id] = oi;
    oldByLine[`${oi.product_id}:${oi.uom_id ?? 'base'}`] ??= oi;
  }

  // A sale can't drop a product's quantity below however much of it has already been refunded,
  // and can't remove a product entirely if any of it was refunded.
  if (tx.type === 'sale') {
    const refunded = refundedQuantityByProduct(tenantId, id);
    const newQtyByProduct: Record<number, number> = {};
    items.forEach((it, i) => {
      newQtyByProduct[it.product_id] = (newQtyByProduct[it.product_id] || 0) + it.quantity * (lineUoms[i]?.factor || 1);
    });
    for (const [productIdStr, refundedQty] of Object.entries(refunded)) {
      const productId = Number(productIdStr);
      if ((refundedQty as number) <= 0) continue;
      const newQty = newQtyByProduct[productId] || 0;
      if (newQty < (refundedQty as number) - 1e-9) {
        // field points at the FIRST request line for this product (position in body.items), so the
        // UI can highlight the offending row rather than just toasting the error.
        const itemIdx = items.findIndex((it) => it.product_id === productId);
        throw new ValidationError(
          `Product ${productId} has ${refundedQty} already refunded — the invoice can't hold less than that.`,
          400,
          { field: `items.${Math.max(0, itemIdx)}.quantity` }
        );
      }
    }
  }

  const resolvedStakeholderId = body.stakeholder_id !== undefined
    ? resolveStakeholderId(tenantId, body.stakeholder_id)
    : tx.stakeholder_id;
  const oldStakeholderId = tx.stakeholder_id;

  const settings = getSettingsMap(tenantId);
  const priceLevelsEnabled = settings.enable_price_levels !== '0';
  const priceLevel: PriceLevel = priceLevelsEnabled ? normalizeLevel(body.price_level ?? tx.price_level) : 'retail';

  // balance_before for the response — the (post-edit target) stakeholder's current balance, read
  // fresh before any of this edit's mutations run.
  const balanceBeforeRow = resolvedStakeholderId
    ? db.prepare("SELECT balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(resolvedStakeholderId, tenantId) as any
    : null;
  const balanceBefore: number | null = balanceBeforeRow ? (balanceBeforeRow.balance || 0) : null;

  // Store credit: this invoice's OWN current effect on its (pre-edit) stakeholder, computed from
  // the still-unedited DB state — "available" is the balance this stakeholder would have WITHOUT
  // this invoice at all (see docs/plans/2026-09-28-store-credit-and-levels.md section 1). An
  // existing store_credit payment kept by id is "being re-used" and correctly counts toward the
  // new Σ, because this old effect already treated it as unpaid (not money) too.
  const bodyPaymentsForValidation: EditPaymentInput[] | null = Array.isArray(body.payments) ? body.payments : null;
  if (bodyPaymentsForValidation) {
    // Resolve each body payment entry (a new one, sent in full, or an existing one kept "by id"
    // with nothing but that id) to its actual method/amount/exchange_rate, so a kept store_credit
    // payment is counted even though the body only names its id.
    const existingRows = db.prepare(`SELECT id, amount, method, exchange_rate FROM ${paymentsTable} WHERE transaction_id = ?`).all(id) as any[];
    const existingById = new Map(existingRows.map((p) => [Number(p.id), p]));
    const resolvedPayments = bodyPaymentsForValidation.map((p) => {
      if (p.id !== undefined && p.id !== null) {
        const ex = existingById.get(Number(p.id));
        return ex ? { method: ex.method as string, amount: ex.amount as number, exchange_rate: (ex.exchange_rate as number) || 1 } : null;
      }
      return { method: String(p.method), amount: Number(p.amount), exchange_rate: (p.exchange_rate as number) || 1 };
    }).filter((p): p is { method: string; amount: number; exchange_rate: number } => !!p);
    const storeCreditTotal = resolvedPayments
      .filter((p) => p.method === 'store_credit')
      .reduce((sum, p) => sum + (p.amount / p.exchange_rate), 0);
    if (storeCreditTotal > 1e-9) {
      if (tx.type === 'refund') throw new ValidationError("Store credit can't be used on a refund.", 400, { field: 'payments' });
      const targetId = resolvedStakeholderId;
      const targetRow = targetId
        ? db.prepare("SELECT name, balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(targetId, tenantId) as any
        : null;
      if (!targetId || targetRow?.name === 'Walk-in Customer') {
        throw new ValidationError("Walk-in Customer has no account balance to use.", 400, { code: 'STORE_CREDIT_WALKIN' });
      }
      // This invoice's current effect on ITS stakeholder — only meaningful when the invoice isn't
      // moving to a different one (moving it means it isn't part of the target's balance yet, so
      // the effect to subtract is 0).
      const thisInvoiceEffect = (oldStakeholderId && oldStakeholderId === targetId)
        ? transactionBalanceEffect(tx.type, id, tx.total_amount, paymentsTable as 'payments' | 'archived_payments')
        : 0;
      const available = Math.max(0, (targetRow?.balance || 0) - thisInvoiceEffect);
      if (storeCreditTotal > available + 1e-9) {
        throw new ValidationError(
          `Store credit exceeds the available balance (${available.toFixed(2)}).`,
          400,
          { code: 'STORE_CREDIT_EXCEEDED', available }
        );
      }
    }
  }

  // created_at is stored the way SQLite's CURRENT_TIMESTAMP writes it ('YYYY-MM-DD HH:MM:SS', UTC):
  // every date filter and string ORDER BY across live/archived tables assumes that exact format, so
  // an ISO string from the browser ('...T...Z') is normalized rather than stored as-is.
  let createdAt: string | null = null;
  if (body.created_at) {
    const d = new Date(body.created_at);
    if (isNaN(d.getTime())) throw new ValidationError("Invalid invoice date.");
    createdAt = d.toISOString().replace('T', ' ').slice(0, 19);
  }

  const productCache: Record<number, any> = {};
  const getProduct = (pid: number) => {
    if (!(pid in productCache)) {
      productCache[pid] = db.prepare(
        "SELECT id, price, price_wholesale, price_super_wholesale, package_price, units_per_package, track_inventory, cost, min_price, stock FROM products WHERE id = ? AND tenant_id = ?"
      ).get(pid, tenantId) as any;
    }
    return productCache[pid];
  };

  // Recompute each new line's price/discount/total/cost-snapshot, using the pricing math shared
  // with POST /api/transactions.
  const lineTotals: number[] = [];
  const processedItems = items.map((item, idx) => {
    const product = getProduct(item.product_id);
    if (!product) throw new ValidationError(`Product ${item.product_id} not found.`);

    const uom = lineUoms[idx];
    const factor = uom ? uom.factor : 1;
    const pieces = item.quantity * factor;

    // `perUnit` is the price of ONE unit of the line's UoM (one piece for base lines).
    let perUnit = item.unit_price;
    if (perUnit === undefined || perUnit === null) {
      if (tx.type === 'sale') perUnit = uom ? uomUnitPrice(product, uom, priceLevel) : saleLineUnitPrice(product, priceLevel, item.quantity, loadUnitsForProduct(tenantId, product.id));
      else throw new ValidationError(`Unit price is required for product ${item.product_id}.`);
    }
    const discountType = item.discount?.type ?? null;
    const discountValue = item.discount?.value ?? null;
    const total = lineTotal(perUnit as number, item.quantity, { type: discountType, value: discountValue });
    lineTotals.push(total);
    const unitPrice = (perUnit as number) / factor; // stored per base piece

    // Lines keep their old unit_cost for the same product (and unit); a newly-added product snapshots
    // the current cost (sale) or its own price (purchase — the cost paid IS this line's unit cost).
    const oldLine = oldByLine[`${item.product_id}:${uom ? uom.id : 'base'}`] ?? oldByProduct[item.product_id];
    const unitCost = oldLine ? oldLine.unit_cost : (tx.type === 'purchase' ? unitPrice : (product.cost ?? null));

    return {
      ...item, unitPrice, discountType, discountValue, unitCost, product, pieces,
      uomId: uom ? uom.id : null, uomName: uom ? uom.name : null, uomFactor: uom ? uom.factor : null, uomQty: uom ? item.quantity : null,
    };
  });

  const finalTotal = computeTotals(lineTotals, body.discount, body.tax);

  const run = db.transaction(() => {
    // --- Stock + WAC: reverse every OLD line's effect, then apply every NEW line's effect. ---
    for (const old of oldItems) {
      const product = getProduct(old.product_id);
      if (!product) continue;
      if (tx.type === 'purchase') {
        const newCost = reversePurchaseCost(product.stock || 0, product.cost, old.quantity, old.unit_cost ?? old.unit_price);
        product.cost = newCost;
        db.prepare("UPDATE products SET cost = ? WHERE id = ? AND tenant_id = ?").run(newCost, product.id, tenantId);
      }
      if (product.track_inventory !== 0) {
        const delta = tx.type === 'sale' ? old.quantity : -old.quantity; // undo the original sale/purchase stock move
        db.prepare("UPDATE products SET stock = stock + ? WHERE id = ? AND tenant_id = ?").run(delta, product.id, tenantId);
        product.stock = (product.stock || 0) + delta;
      }
    }
    for (const item of processedItems) {
      const product = item.product;
      if (tx.type === 'purchase') {
        const newCost = applyPurchaseCost(product.stock || 0, product.cost, item.pieces, item.unitPrice);
        product.cost = newCost;
        db.prepare("UPDATE products SET cost = ? WHERE id = ? AND tenant_id = ?").run(newCost, product.id, tenantId);
      }
      if (product.track_inventory !== 0) {
        const delta = tx.type === 'sale' ? -item.pieces : item.pieces;
        db.prepare("UPDATE products SET stock = stock + ? WHERE id = ? AND tenant_id = ?").run(delta, product.id, tenantId);
        product.stock = (product.stock || 0) + delta;
      }
    }

    // --- Items: full replace (matches the existing "edit = delete + recreate" convention). ---
    const removedItemGlobalIds = oldItems.map((oi) => oi.global_id);
    db.prepare(`DELETE FROM ${itemsTable} WHERE transaction_id = ?`).run(id);
    // Both tables use a plain INTEGER PRIMARY KEY (not AUTOINCREMENT for the archived twin, since
    // settlement inserts explicit ids carried over from the live table) — omitting the id column
    // lets SQLite assign the next rowid itself, exactly like AUTOINCREMENT would.
    const insertItem = db.prepare(`INSERT INTO ${itemsTable} (id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value, unit_cost, uom_id, uom_name, uom_factor, uom_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const newItemIds: number[] = [];
    for (const item of processedItems) {
      const rowId = archived ? reserveSharedId('transaction_items', 'archived_transaction_items') : null;
      const info = insertItem.run(rowId, id, item.product_id, item.pieces, item.unitPrice, item.discountType, item.discountValue, null, null, item.unitCost, item.uomId, item.uomName, item.uomFactor, item.uomQty);
      newItemIds.push(Number(rowId ?? info.lastInsertRowid));
    }
    // Lines were just replaced with new ids: re-point refunds that reference the old sale lines
    // (original_item_id) at the equivalent new line (same product + unit, in order). Refunds whose
    // line no longer exists simply fall back to per-product allocation (see refundLineStates).
    if (tx.type === 'sale') {
      const claimed = new Set<number>();
      for (const old of oldItems) {
        const j = processedItems.findIndex((it, k) => !claimed.has(k) && it.product_id === old.product_id && (it.uomId ?? null) === (old.uom_id ?? null));
        if (j < 0) continue;
        claimed.add(j);
        for (const [rItems, rTx] of [['transaction_items', 'transactions'], ['archived_transaction_items', 'archived_transactions']]) {
          db.prepare(`UPDATE ${rItems} SET original_item_id = ? WHERE original_item_id = ? AND transaction_id IN (SELECT id FROM ${rTx} WHERE tenant_id = ? AND type = 'refund' AND original_transaction_id = ?)`)
            .run(newItemIds[j], old.id, tenantId, id);
        }
      }
    }

    // --- Payments: keep-by-id, delete omitted, insert new. ---
    const existingPayments = db.prepare(`SELECT * FROM ${paymentsTable} WHERE transaction_id = ?`).all(id) as any[];
    const bodyPayments: EditPaymentInput[] = Array.isArray(body.payments) ? body.payments : existingPayments.map((p) => ({ id: p.id }));
    const keptIds = new Set(bodyPayments.filter((p) => p.id !== undefined && p.id !== null).map((p) => Number(p.id)));
    const toDelete = existingPayments.filter((p) => !keptIds.has(p.id));
    const toInsert = bodyPayments.filter((p) => p.id === undefined || p.id === null);

    const removedPaymentGlobalIds = toDelete.map((p) => p.global_id);
    if (toDelete.length) {
      const del = db.prepare(`DELETE FROM ${paymentsTable} WHERE id = ?`);
      for (const p of toDelete) del.run(p.id);
    }

    if (toInsert.length) {
      const insertPayment = archived
        ? db.prepare(`INSERT INTO archived_payments (id, transaction_id, amount, method, currency, exchange_rate, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        : db.prepare(`INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate) VALUES (?, ?, ?, ?, ?)`);
      for (const p of toInsert) {
        if (archived) insertPayment.run(reserveSharedId('payments', 'archived_payments'), id, p.amount, p.method, p.currency, p.exchange_rate || 1);
        else insertPayment.run(id, p.amount, p.method, p.currency, p.exchange_rate || 1);
        if (isRealMoney(p.method)) {
          // An archived (settled) invoice's cash register was already closed out — a newly-added
          // real payment on it is money arriving NOW, so the open cash register needs to see it.
          // (store_credit isn't money arriving either — same as credit — so it's excluded too.)
          if (archived) {
            db.prepare(
              "INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).run(
              tenantId,
              editUserId,
              tx.type === 'purchase' ? 'out' : 'in',
              p.amount,
              p.currency,
              p.exchange_rate || 1,
              `Payment on invoice #${id}`
            );
          }
        }
      }
    }

    const before = { ...tx, items: oldItems, payments: existingPayments };

    db.prepare(`
      UPDATE ${txTable}
      SET stakeholder_id = ?, total_amount = ?, discount_type = ?, discount_value = ?, tax_type = ?, tax_value = ?,
          notes = ?, reference = ?, price_level = ?, created_at = COALESCE(?, created_at),
          edited_at = CURRENT_TIMESTAMP, edit_count = IFNULL(edit_count, 0) + 1
      WHERE id = ? AND tenant_id = ?
    `).run(
      resolvedStakeholderId,
      finalTotal,
      body.discount?.type || null,
      body.discount?.value || null,
      body.tax?.type || null,
      body.tax?.value || null,
      body.notes ?? tx.notes ?? null,
      body.reference ?? tx.reference ?? null,
      priceLevel,
      createdAt,
      id,
      tenantId
    );

    const after = db.prepare(`SELECT * FROM ${txTable} WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as any;

    // --- Balances. ---
    if (!archived) {
      // Live: the balance is derived fresh from transactions + baseline — just recompute both the
      // old and new stakeholder (if the invoice moved to a different one).
      if (oldStakeholderId) recomputeStakeholderBalance(oldStakeholderId, tenantId);
      if (resolvedStakeholderId && resolvedStakeholderId !== oldStakeholderId) recomputeStakeholderBalance(resolvedStakeholderId, tenantId);
    } else {
      // Archived: this invoice's effect is banked into balance_baseline (it isn't summed live
      // anymore), so adjust the baseline by the delta between its effect before and after this
      // edit, then recompute so `balance` reflects the new baseline.
      const oldPaid = existingPayments.reduce((sum, p) => isRealMoney(p.method) ? sum + (p.amount || 0) / (p.exchange_rate || 1) : sum, 0);
      // existingPayments was queried BEFORE the deletes/inserts above — re-query for the current,
      // post-edit set to compute what this invoice's effect is now.
      const currentPayments = db.prepare(`SELECT * FROM ${paymentsTable} WHERE transaction_id = ?`).all(id) as any[];
      const newPaid = currentPayments.reduce((sum, p) => isRealMoney(p.method) ? sum + (p.amount || 0) / (p.exchange_rate || 1) : sum, 0);

      const effectOf = (total: number, paid: number, type: string) => {
        if (type === 'sale' || type === 'purchase') return -(total - paid);
        if (type === 'refund') return (total - paid);
        return 0;
      };
      const oldEffect = effectOf(tx.total_amount, oldPaid, tx.type);
      const newEffect = effectOf(finalTotal, newPaid, tx.type);

      // Applying "-= oldEffect" then "+= newEffect" to the SAME stakeholder nets out correctly
      // when the invoice didn't move to a different one — no special-casing needed.
      if (oldStakeholderId) {
        db.prepare("UPDATE stakeholders SET balance_baseline = IFNULL(balance_baseline, 0) - ? WHERE id = ? AND tenant_id = ?")
          .run(oldEffect, oldStakeholderId, tenantId);
        recomputeStakeholderBalance(oldStakeholderId, tenantId);
      }
      if (resolvedStakeholderId) {
        db.prepare("UPDATE stakeholders SET balance_baseline = IFNULL(balance_baseline, 0) + ? WHERE id = ? AND tenant_id = ?")
          .run(newEffect, resolvedStakeholderId, tenantId);
        recomputeStakeholderBalance(resolvedStakeholderId, tenantId);
      }
    }

    // --- Audit trail. ---
    db.prepare(
      "INSERT INTO transaction_edits (tenant_id, transaction_id, archived, user_id, reason, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(tenantId, id, archived ? 1 : 0, editUserId, body.reason || null, JSON.stringify(before), JSON.stringify({ ...after, items: processedItems, payments: currentPaymentsSafe(db, paymentsTable, id) }));

    logAction(tenantId, editUserId, 'Transaction Edited', `ID: ${id}, Type: ${tx.type}, Total: ${tx.total_amount} -> ${finalTotal}`);

    // balance_after: same (resolved) stakeholder, now that the balance recompute above has run.
    const balanceAfterRow = resolvedStakeholderId
      ? db.prepare("SELECT balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(resolvedStakeholderId, tenantId) as any
      : null;
    const balanceAfter: number | null = balanceAfterRow ? (balanceAfterRow.balance || 0) : null;

    return { removedItemGlobalIds, removedPaymentGlobalIds, balanceAfter };
  });

  const { removedItemGlobalIds, removedPaymentGlobalIds, balanceAfter } = run();

  // Best-effort cloud cleanup AFTER the local write for archived invoices (never synced, so
  // this is a no-op there), and for live invoices too — items are always fully replaced, so their
  // old global_ids must go; payments only for the ones actually removed.
  if (!archived) {
    try {
      await purgeCloudRows('transaction_items', removedItemGlobalIds);
      await purgeCloudRows('payments', removedPaymentGlobalIds);
    } catch (err: any) {
      console.error('❌ [EDIT TX] Cloud cleanup failed:', err?.message || err);
    }
  }

  return { id, archived, balance_before: balanceBefore, balance_after: balanceAfter };
}

// Rows inserted into archived_transaction_items / archived_payments must use an id the LIVE twin
// will never hand out later: settlement copies live rows into the archive with their ids intact, so
// an archive row that simply took MAX(id)+1 would collide with a future live row and make the next
// End-of-Day settlement fail with a UNIQUE constraint. Reserve the id in the live table's
// AUTOINCREMENT sequence as well, so both tables move past it.
function reserveSharedId(liveTable: 'transaction_items' | 'payments', archivedTable: string): number {
  const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(liveTable) as any;
  const maxLive = (db.prepare(`SELECT IFNULL(MAX(id), 0) as m FROM ${liveTable}`).get() as any).m;
  const maxArch = (db.prepare(`SELECT IFNULL(MAX(id), 0) as m FROM ${archivedTable}`).get() as any).m;
  const next = Math.max(seqRow?.seq || 0, maxLive, maxArch) + 1;
  if (seqRow) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(next, liveTable);
  else db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(liveTable, next);
  return next;
}

function currentPaymentsSafe(dbRef: any, paymentsTable: string, id: number) {
  try {
    return dbRef.prepare(`SELECT * FROM ${paymentsTable} WHERE transaction_id = ?`).all(id);
  } catch {
    return [];
  }
}

export function getTransactionEdits(tenantId: number, transactionId: number) {
  const rows = db.prepare(
    "SELECT * FROM transaction_edits WHERE tenant_id = ? AND transaction_id = ? ORDER BY created_at DESC"
  ).all(tenantId, transactionId) as any[];
  return rows.map((r) => ({
    ...r,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
  }));
}
