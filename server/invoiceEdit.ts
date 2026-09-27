// PUT /api/transactions/:id — edit a LIVE or ARCHIVED (settled) sale/purchase invoice in place.
// Kept out of server/routes.ts to keep that file readable; the route handler there just calls
// editTransaction() and re-renders the same response shape as GET /api/transactions/:id.
import { db, logAction } from "./db.js";
import { recomputeStakeholderBalance } from "./balance.js";
import { getActiveSession } from "./session.js";
import { normalizeLevel, saleLineUnitPrice, lineTotal, computeTotals, type PriceLevel } from "./pricing.js";
import { applyPurchaseCost, reversePurchaseCost } from "./costing.js";
import { ValidationError } from "./errors.js";

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
export async function editTransaction(tenantId: number, id: number, body: EditTransactionBody): Promise<{ id: number; archived: boolean }> {
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

  for (const item of items) {
    if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
      throw new ValidationError(`Invalid quantity for product ${item.product_id}.`);
    }
    if (item.unit_price !== undefined && !(Number.isFinite(item.unit_price) && item.unit_price >= 0)) {
      throw new ValidationError(`Invalid unit price for product ${item.product_id}.`);
    }
    const discErr = invalidAdjustment(item.discount, 'line discount');
    if (discErr) throw new ValidationError(discErr);
  }
  for (const p of Array.isArray(body.payments) ? body.payments : []) {
    if (p.id !== undefined && p.id !== null) continue; // existing payment, kept as-is
    if (!(Number.isFinite(p.amount) && (p.amount as number) > 0)) throw new ValidationError("Invalid payment amount.");
    if (!['cash', 'card', 'credit'].includes(String(p.method))) throw new ValidationError("Invalid payment method.");
    if (!p.currency) throw new ValidationError("Payment currency is required.");
    if (p.exchange_rate !== undefined && !(Number.isFinite(p.exchange_rate) && (p.exchange_rate as number) > 0)) throw new ValidationError("Invalid payment exchange rate.");
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
  for (const oi of oldItems) oldByProduct[oi.product_id] = oi;

  // A sale can't drop a product's quantity below however much of it has already been refunded,
  // and can't remove a product entirely if any of it was refunded.
  if (tx.type === 'sale') {
    const refunded = refundedQuantityByProduct(tenantId, id);
    const newQtyByProduct: Record<number, number> = {};
    for (const it of items) newQtyByProduct[it.product_id] = (newQtyByProduct[it.product_id] || 0) + it.quantity;
    for (const [productIdStr, refundedQty] of Object.entries(refunded)) {
      const productId = Number(productIdStr);
      if ((refundedQty as number) <= 0) continue;
      const newQty = newQtyByProduct[productId] || 0;
      if (newQty < (refundedQty as number) - 1e-9) {
        throw new ValidationError(
          `Product ${productId} has ${refundedQty} already refunded — the invoice can't hold less than that.`
        );
      }
    }
  }

  const resolvedStakeholderId = body.stakeholder_id !== undefined
    ? resolveStakeholderId(tenantId, body.stakeholder_id)
    : tx.stakeholder_id;
  const oldStakeholderId = tx.stakeholder_id;

  const priceLevel: PriceLevel = normalizeLevel(body.price_level ?? tx.price_level);

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
  const processedItems = items.map((item) => {
    const product = getProduct(item.product_id);
    if (!product) throw new ValidationError(`Product ${item.product_id} not found.`);

    let unitPrice = item.unit_price;
    if (unitPrice === undefined || unitPrice === null) {
      if (tx.type === 'sale') unitPrice = saleLineUnitPrice(product, priceLevel, item.quantity);
      else throw new ValidationError(`Unit price is required for product ${item.product_id}.`);
    }
    const discountType = item.discount?.type ?? null;
    const discountValue = item.discount?.value ?? null;
    const total = lineTotal(unitPrice as number, item.quantity, { type: discountType, value: discountValue });
    lineTotals.push(total);

    // Lines keep their old unit_cost for the same product; a newly-added product snapshots the
    // current cost (sale) or its own price (purchase — the cost paid IS this line's unit cost).
    const oldLine = oldByProduct[item.product_id];
    const unitCost = oldLine ? oldLine.unit_cost : (tx.type === 'purchase' ? unitPrice : (product.cost ?? null));

    return { ...item, unitPrice: unitPrice as number, discountType, discountValue, unitCost, product };
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
        const newCost = applyPurchaseCost(product.stock || 0, product.cost, item.quantity, item.unitPrice);
        product.cost = newCost;
        db.prepare("UPDATE products SET cost = ? WHERE id = ? AND tenant_id = ?").run(newCost, product.id, tenantId);
      }
      if (product.track_inventory !== 0) {
        const delta = tx.type === 'sale' ? -item.quantity : item.quantity;
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
    const insertItem = db.prepare(`INSERT INTO ${itemsTable} (id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of processedItems) {
      const rowId = archived ? reserveSharedId('transaction_items', 'archived_transaction_items') : null;
      insertItem.run(rowId, id, item.product_id, item.quantity, item.unitPrice, item.discountType, item.discountValue, null, null, item.unitCost);
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
        if (p.method !== 'credit') {
          // An archived (settled) invoice's cash register was already closed out — a newly-added
          // real payment on it is money arriving NOW, so the open cash register needs to see it.
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
      body.created_at || null,
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
      const oldPaid = existingPayments.reduce((sum, p) => p.method === 'credit' ? sum : sum + (p.amount || 0) / (p.exchange_rate || 1), 0);
      // existingPayments was queried BEFORE the deletes/inserts above — re-query for the current,
      // post-edit set to compute what this invoice's effect is now.
      const currentPayments = db.prepare(`SELECT * FROM ${paymentsTable} WHERE transaction_id = ?`).all(id) as any[];
      const newPaid = currentPayments.reduce((sum, p) => p.method === 'credit' ? sum : sum + (p.amount || 0) / (p.exchange_rate || 1), 0);

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

    return { removedItemGlobalIds, removedPaymentGlobalIds };
  });

  const { removedItemGlobalIds, removedPaymentGlobalIds } = run();

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

  return { id, archived };
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
