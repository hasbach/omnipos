// Workflow B: PO Cash-Lock & Partial Receiving.
// Pre-delivery DRAFT/APPROVED_LOCKED POs live in `or_po_commitments` + `or_po_commitment_items`.
// Upon receiving, an ACID transaction creates the real OmniPOS Core `transactions(type='purchase')` + `payments`,
// releases any unused locked cash back to Free Spendable Cash, and updates supplier fill_rate_score.
import { db, logAction } from "../db.js";
import { ValidationError } from "../errors.js";
import { ensureOrInitialized } from "./config.js";
import { createPurchaseFromPoCore, localDateIso, resolveTenantUserId, round2 } from "./coreBridge.js";
import { computeSpendableCash, recordBucketLedger } from "./spendableCash.js";

export type PaymentPlan = "CASH_ON_DELIVERY" | "CREDIT" | "SPLIT";

export interface PoCommitmentItemInput {
  product_id: number;
  ordered_qty: number;
  unit_cost?: number;
}

export interface CreatePoCommitmentInput {
  supplier_id: number;
  po_number?: string | null;
  expected_delivery_date: string;
  payment_plan?: PaymentPlan;
  estimated_order_total?: number;
  locked_cash_amount?: number; // optional for SPLIT
  notes?: string | null;
  items?: PoCommitmentItemInput[];
}

function generatePoNumber(tenantId: number): string {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM or_po_commitments WHERE tenant_id = ?")
    .get(tenantId) as any;
  const seq = Number(row?.c || 0) + 1;
  return `PO-${localDateIso().replace(/-/g, "")}-${String(seq).padStart(3, "0")}`;
}

export function listPoCommitments(tenantId: number, status?: string) {
  let sql = `
    SELECT c.*, s.name AS supplier_name, s.balance AS supplier_balance,
           u.name AS approved_by_name,
           (SELECT COUNT(*) FROM or_po_commitment_items i WHERE i.po_commitment_id = c.id AND i.deleted_at IS NULL) AS item_count
      FROM or_po_commitments c
      LEFT JOIN stakeholders s ON s.id = c.supplier_id
      LEFT JOIN users u ON u.id = c.approved_by_user_id
     WHERE c.tenant_id = ? AND c.deleted_at IS NULL`;
  const params: any[] = [tenantId];
  if (status && status !== "all") {
    sql += " AND c.status = ?";
    params.push(status);
  }
  sql += " ORDER BY CASE c.status WHEN 'APPROVED_LOCKED' THEN 1 WHEN 'PARTIALLY_RECEIVED' THEN 2 WHEN 'DRAFT' THEN 3 ELSE 4 END, c.expected_delivery_date ASC, c.id DESC";
  return db.prepare(sql).all(...params);
}

export function getPoCommitmentById(tenantId: number, id: number) {
  const po = db
    .prepare(
      `SELECT c.*, s.name AS supplier_name, s.balance AS supplier_balance, u.name AS approved_by_name
         FROM or_po_commitments c
         LEFT JOIN stakeholders s ON s.id = c.supplier_id
         LEFT JOIN users u ON u.id = c.approved_by_user_id
        WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL`
    )
    .get(id, tenantId) as any;
  if (!po) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.barcode, p.stock AS current_stock, p.cost AS current_cost
         FROM or_po_commitment_items i
         LEFT JOIN products p ON p.id = i.product_id
        WHERE i.po_commitment_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL`
    )
    .all(id, tenantId);
  return { ...po, items };
}

export function createPoCommitment(tenantId: number, input: CreatePoCommitmentInput, userId?: number | null) {
  ensureOrInitialized(tenantId);
  const supplier = db
    .prepare("SELECT id, name FROM stakeholders WHERE id = ? AND tenant_id = ? AND type = 'supplier' AND deleted_at IS NULL")
    .get(input.supplier_id, tenantId) as any;
  if (!supplier) {
    throw new ValidationError("Supplier not found.", 404, { code: "OR_SUPPLIER_NOT_FOUND", field: "supplier_id" });
  }
  const deliveryDate = input.expected_delivery_date && /^\d{4}-\d{2}-\d{2}$/.test(input.expected_delivery_date)
    ? input.expected_delivery_date
    : localDateIso();
  const plan: PaymentPlan = ["CASH_ON_DELIVERY", "CREDIT", "SPLIT"].includes(input.payment_plan || "")
    ? (input.payment_plan as PaymentPlan)
    : "CASH_ON_DELIVERY";

  const rawItems = Array.isArray(input.items) ? input.items.filter((i) => Number(i.ordered_qty) > 0) : [];
  const resolvedItems: Array<{ product_id: number; ordered_qty: number; unit_cost: number }> = [];
  for (const it of rawItems) {
    const prod = db
      .prepare("SELECT id, cost FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
      .get(it.product_id, tenantId) as any;
    if (!prod) throw new ValidationError(`Product #${it.product_id} not found.`, 404, { code: "PRODUCT_NOT_FOUND" });
    const cost = it.unit_cost != null ? Math.max(0, Number(it.unit_cost) || 0) : (Number(prod.cost) || 0);
    resolvedItems.push({ product_id: prod.id, ordered_qty: Number(it.ordered_qty), unit_cost: cost });
  }

  const itemsTotal = round2(resolvedItems.reduce((s, it) => s + it.ordered_qty * it.unit_cost, 0));
  const estimatedTotal = round2(
    input.estimated_order_total != null && Number(input.estimated_order_total) > 0
      ? Number(input.estimated_order_total)
      : itemsTotal
  );
  if (estimatedTotal <= 0) {
    throw new ValidationError("Estimated order total must be greater than zero.", 400, {
      code: "OR_PO_TOTAL_INVALID",
      field: "estimated_order_total",
    });
  }

  const poNumber = input.po_number?.trim() || generatePoNumber(tenantId);

  const poId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO or_po_commitments (
          tenant_id, po_number, supplier_id, expected_delivery_date, payment_plan,
          estimated_order_total, locked_cash_amount, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'DRAFT', ?)`
      )
      .run(tenantId, poNumber, supplier.id, deliveryDate, plan, estimatedTotal, input.notes?.trim() || null);
    const id = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO or_po_commitment_items (tenant_id, po_commitment_id, product_id, ordered_qty, received_qty, unit_cost)
       VALUES (?, ?, ?, ?, 0, ?)`
    );
    for (const it of resolvedItems) {
      ins.run(tenantId, id, it.product_id, it.ordered_qty, it.unit_cost);
    }
    return id;
  })();

  logAction(tenantId, resolveTenantUserId(tenantId, userId), "OR PO Draft Created", `${poNumber} (${supplier.name}) $${estimatedTotal.toFixed(2)}`);
  return getPoCommitmentById(tenantId, poId);
}

export function approvePoCommitment(
  tenantId: number,
  id: number,
  opts: { userId?: number | null; lockAmount?: number; force?: boolean } = {}
) {
  const po = db
    .prepare("SELECT * FROM or_po_commitments WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(id, tenantId) as any;
  if (!po) throw new ValidationError("PO commitment not found.", 404, { code: "OR_PO_NOT_FOUND" });
  if (po.status !== "DRAFT") {
    throw new ValidationError(`Only DRAFT POs can be approved (current status: ${po.status}).`, 400, { code: "OR_PO_STATUS_INVALID" });
  }

  let lockAmount = 0;
  if (po.payment_plan === "CASH_ON_DELIVERY") {
    lockAmount = round2(Number(po.estimated_order_total) || 0);
  } else if (po.payment_plan === "CREDIT") {
    lockAmount = 0;
  } else {
    // SPLIT
    lockAmount = round2(
      opts.lockAmount !== undefined
        ? Math.max(0, Math.min(Number(po.estimated_order_total) || 0, Number(opts.lockAmount) || 0))
        : round2((Number(po.estimated_order_total) || 0) * 0.5)
    );
  }

  const spendable = computeSpendableCash(tenantId);
  const cashCollision = lockAmount > 0 && lockAmount > spendable.free_spendable_cash_usd + 0.005;
  if (cashCollision && !opts.force) {
    const shortfall = round2(lockAmount - spendable.free_spendable_cash_usd);
    throw new ValidationError(
      `Cash collision warning: locking $${lockAmount.toFixed(2)} exceeds Free Spendable Cash ($${spendable.free_spendable_cash_usd.toFixed(2)}) by $${shortfall.toFixed(2)}. Pass force=true to lock anyway.`,
      409,
      { code: "OR_PO_CASH_COLLISION", shortfall }
    );
  }

  const approverId = resolveTenantUserId(tenantId, opts.userId);
  db.transaction(() => {
    db.prepare(
      `UPDATE or_po_commitments
          SET status = 'APPROVED_LOCKED', locked_cash_amount = ?, approved_by_user_id = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ?`
    ).run(lockAmount, approverId, id, tenantId);

    if (lockAmount > 0) {
      recordBucketLedger({
        tenantId,
        bucketCode: "CORE_RESTOCK",
        txType: "PO_LOCK",
        amount: -lockAmount,
        bucketDelta: lockAmount,
        referenceType: "PO_COMMITMENT",
        referenceId: id,
        note: `Locked cash for ${po.po_number || `PO #${id}`} (due ${po.expected_delivery_date})`,
      });
    }
  })();

  logAction(tenantId, approverId, "OR PO Approved & Cash-Locked", `${po.po_number || `#${id}`}: locked $${lockAmount.toFixed(2)}`);
  return { po: getPoCommitmentById(tenantId, id), cash_collision: cashCollision };
}

export interface ReceivePoInput {
  items?: Array<{ product_id: number; received_qty: number; unit_cost?: number }>;
  actual_received_total?: number;
  actual_cash_paid: number;
  actual_credit_added?: number;
  account_id?: number | null;
  partial?: boolean;
  notes?: string | null;
  userId?: number | null;
}

export function receivePoCommitment(tenantId: number, id: number, input: ReceivePoInput) {
  const po = db
    .prepare("SELECT * FROM or_po_commitments WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(id, tenantId) as any;
  if (!po) throw new ValidationError("PO commitment not found.", 404, { code: "OR_PO_NOT_FOUND" });
  if (!["APPROVED_LOCKED", "PARTIALLY_RECEIVED", "DRAFT"].includes(po.status)) {
    throw new ValidationError(`PO cannot be received in status ${po.status}.`, 400, { code: "OR_PO_STATUS_INVALID" });
  }

  const userId = resolveTenantUserId(tenantId, input.userId);
  const existingItems = db
    .prepare("SELECT * FROM or_po_commitment_items WHERE po_commitment_id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .all(id, tenantId) as any[];

  const receivedLines: Array<{ product_id: number; quantity: number; unit_cost: number }> = [];
  if (Array.isArray(input.items) && input.items.length > 0) {
    for (const it of input.items) {
      const qty = Number(it.received_qty) || 0;
      if (qty <= 0) continue;
      const orig = existingItems.find((e) => e.product_id === it.product_id);
      const cost = it.unit_cost != null ? Number(it.unit_cost) : Number(orig?.unit_cost ?? 0);
      receivedLines.push({ product_id: it.product_id, quantity: qty, unit_cost: cost });
    }
  } else if (existingItems.length > 0) {
    for (const orig of existingItems) {
      const remaining = Math.max(0, Number(orig.ordered_qty) - Number(orig.received_qty || 0));
      if (remaining > 0) {
        receivedLines.push({ product_id: orig.product_id, quantity: remaining, unit_cost: Number(orig.unit_cost) || 0 });
      }
    }
  }

  const linesTotal = round2(receivedLines.reduce((s, l) => s + l.quantity * l.unit_cost, 0));
  const actualReceivedTotal = round2(
    input.actual_received_total != null && Number(input.actual_received_total) > 0
      ? Number(input.actual_received_total)
      : linesTotal
  );
  const cashPaid = round2(Math.max(0, Number(input.actual_cash_paid) || 0));
  const creditAdded = round2(
    input.actual_credit_added != null
      ? Math.max(0, Number(input.actual_credit_added) || 0)
      : Math.max(0, actualReceivedTotal - cashPaid)
  );

  const prevLocked = round2(Number(po.locked_cash_amount) || 0);
  const nextStatus = input.partial ? "PARTIALLY_RECEIVED" : "SETTLED";
  const releasedCash = nextStatus === "SETTLED" ? round2(Math.max(0, prevLocked - cashPaid)) : 0;
  const remainingLock = nextStatus === "SETTLED" ? 0 : round2(Math.max(0, prevLocked - cashPaid));

  const result = db.transaction(() => {
    let coreTxId: number | null = po.core_transaction_id ?? null;
    if (receivedLines.length > 0) {
      const coreRes = createPurchaseFromPoCore({
        tenantId,
        supplierId: po.supplier_id,
        userId,
        poNumber: po.po_number,
        notes: input.notes || po.notes,
        items: receivedLines,
        cashPaidUsd: cashPaid,
        accountId: input.account_id,
      });
      coreTxId = coreRes.transactionId;
    }

    // Update received quantities on PO commitment items
    const updItem = db.prepare(
      "UPDATE or_po_commitment_items SET received_qty = IFNULL(received_qty, 0) + ?, unit_cost = ? WHERE po_commitment_id = ? AND product_id = ? AND tenant_id = ?"
    );
    for (const l of receivedLines) {
      updItem.run(l.quantity, l.unit_cost, id, l.product_id, tenantId);
    }

    // Ledger entries: PO_PAYMENT for cash spent, PO_RELEASE for unused lock returned to Free Spendable Cash
    if (cashPaid > 0) {
      recordBucketLedger({
        tenantId,
        bucketCode: "CORE_RESTOCK",
        txType: "PO_PAYMENT",
        amount: -cashPaid,
        bucketDelta: -Math.min(prevLocked, cashPaid),
        referenceType: "PO_COMMITMENT",
        referenceId: id,
        note: `Cash paid on delivery for ${po.po_number || `PO #${id}`}`,
      });
    }
    if (releasedCash > 0) {
      recordBucketLedger({
        tenantId,
        bucketCode: "CORE_RESTOCK",
        txType: "PO_RELEASE",
        amount: releasedCash,
        bucketDelta: -releasedCash,
        referenceType: "PO_COMMITMENT",
        referenceId: id,
        note: `Released unused cash lock from ${po.po_number || `PO #${id}`}`,
      });
    }

    const totalReceived = round2((Number(po.actual_received_total) || 0) + actualReceivedTotal);
    const totalCashPaid = round2((Number(po.actual_cash_paid) || 0) + cashPaid);
    const totalCredit = round2((Number(po.actual_credit_added) || 0) + creditAdded);
    const totalReleased = round2((Number(po.released_cash_amount) || 0) + releasedCash);

    db.prepare(
      `UPDATE or_po_commitments
          SET core_transaction_id = COALESCE(?, core_transaction_id),
              actual_received_total = ?,
              actual_cash_paid = ?,
              actual_credit_added = ?,
              released_cash_amount = ?,
              locked_cash_amount = ?,
              status = ?,
              settled_at = CASE WHEN ? = 'SETTLED' THEN CURRENT_TIMESTAMP ELSE settled_at END
        WHERE id = ? AND tenant_id = ?`
    ).run(
      coreTxId,
      totalReceived,
      totalCashPaid,
      totalCredit,
      totalReleased,
      remainingLock,
      nextStatus,
      nextStatus,
      id,
      tenantId
    );

    // Update supplier fill_rate_score in or_supplier_profiles (exponential moving average)
    if (nextStatus === "SETTLED" && Number(po.estimated_order_total) > 0) {
      const fillRatio = Math.min(1, Math.max(0, totalReceived / Number(po.estimated_order_total)));
      const prof = db
        .prepare("SELECT * FROM or_supplier_profiles WHERE tenant_id = ? AND supplier_id = ? AND deleted_at IS NULL")
        .get(tenantId, po.supplier_id) as any;
      if (prof) {
        const count = Number(prof.deliveries_count || 0);
        const newScore = round2(count === 0 ? fillRatio : (Number(prof.fill_rate_score) * count + fillRatio) / (count + 1));
        db.prepare("UPDATE or_supplier_profiles SET fill_rate_score = ?, deliveries_count = ? WHERE id = ?")
          .run(newScore, count + 1, prof.id);
      } else {
        db.prepare(
          `INSERT INTO or_supplier_profiles (tenant_id, supplier_id, fill_rate_score, deliveries_count, default_payment_plan)
           VALUES (?, ?, ?, 1, ?)`
        ).run(tenantId, po.supplier_id, round2(fillRatio), po.payment_plan);
      }
    }

    return { coreTxId, releasedCash, nextStatus };
  })();

  logAction(
    tenantId,
    userId,
    "OR PO Received",
    `${po.po_number || `#${id}`}: received $${actualReceivedTotal.toFixed(2)}, paid $${cashPaid.toFixed(2)}, released $${result.releasedCash.toFixed(2)}`
  );
  return { po: getPoCommitmentById(tenantId, id), ...result };
}

export function cancelPoCommitment(tenantId: number, id: number, userId?: number | null) {
  const po = db
    .prepare("SELECT * FROM or_po_commitments WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(id, tenantId) as any;
  if (!po) throw new ValidationError("PO commitment not found.", 404, { code: "OR_PO_NOT_FOUND" });
  if (po.status === "SETTLED" || po.status === "CANCELLED") {
    throw new ValidationError(`PO is already ${po.status}.`, 400, { code: "OR_PO_STATUS_INVALID" });
  }
  const locked = round2(Number(po.locked_cash_amount) || 0);
  db.transaction(() => {
    if (locked > 0) {
      recordBucketLedger({
        tenantId,
        bucketCode: "CORE_RESTOCK",
        txType: "PO_RELEASE",
        amount: locked,
        bucketDelta: -locked,
        referenceType: "PO_COMMITMENT",
        referenceId: id,
        note: `Cancelled ${po.po_number || `PO #${id}`} — full cash lock released`,
      });
    }
    db.prepare(
      "UPDATE or_po_commitments SET status = 'CANCELLED', locked_cash_amount = 0, released_cash_amount = IFNULL(released_cash_amount, 0) + ? WHERE id = ? AND tenant_id = ?"
    ).run(locked, id, tenantId);
  })();

  logAction(tenantId, resolveTenantUserId(tenantId, userId), "OR PO Cancelled", `${po.po_number || `#${id}`} (released $${locked.toFixed(2)})`);
  return getPoCommitmentById(tenantId, id);
}

/**
 * Settles an open `or_po_commitments` cash lock from a Core `POST /api/transactions` (`type = 'purchase'`)
 * inside the caller's ACID transaction — so stock + payments + supplier balance are updated by Core
 * AND the cash lock is released atomically without double-counting Free Spendable Cash.
 */
export function settlePoFromCorePurchase(params: {
  tenantId: number;
  poCommitmentId: number;
  coreTransactionId: number;
  supplierId: number;
  totalUsd: number;
  cashPaidUsd: number;
  userId?: number | null;
}): { releasedCash: number; poNumber: string | null } {
  const { tenantId, poCommitmentId, coreTransactionId, supplierId } = params;
  const po = db
    .prepare("SELECT * FROM or_po_commitments WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(poCommitmentId, tenantId) as any;
  if (!po) {
    throw new ValidationError("Linked PO commitment not found.", 404, {
      code: "OR_PO_NOT_FOUND",
      field: "or_po_commitment_id",
    });
  }
  if (Number(po.supplier_id) !== Number(supplierId)) {
    throw new ValidationError("Linked PO commitment belongs to a different supplier.", 400, {
      code: "OR_PO_SUPPLIER_MISMATCH",
      field: "or_po_commitment_id",
    });
  }
  if (!["APPROVED_LOCKED", "PARTIALLY_RECEIVED", "DRAFT"].includes(po.status)) {
    throw new ValidationError(`Linked PO commitment is already ${po.status}.`, 400, {
      code: "OR_PO_STATUS_INVALID",
      field: "or_po_commitment_id",
    });
  }

  const totalUsd = round2(Math.max(0, Number(params.totalUsd) || 0));
  const cashPaid = round2(Math.max(0, Number(params.cashPaidUsd) || 0));
  const creditAdded = round2(Math.max(0, totalUsd - cashPaid));
  const prevLocked = round2(Number(po.locked_cash_amount) || 0);
  const releasedCash = round2(Math.max(0, prevLocked - cashPaid));

  if (cashPaid > 0) {
    recordBucketLedger({
      tenantId,
      bucketCode: "CORE_RESTOCK",
      txType: "PO_PAYMENT",
      amount: -cashPaid,
      bucketDelta: -Math.min(prevLocked, cashPaid),
      referenceType: "PO_COMMITMENT",
      referenceId: po.id,
      note: `Settled via Purchase Invoice #${coreTransactionId} (${po.po_number || `PO #${po.id}`})`,
    });
  }
  if (releasedCash > 0) {
    recordBucketLedger({
      tenantId,
      bucketCode: "CORE_RESTOCK",
      txType: "PO_RELEASE",
      amount: releasedCash,
      bucketDelta: -releasedCash,
      referenceType: "PO_COMMITMENT",
      referenceId: po.id,
      note: `Released unused lock via Purchase Invoice #${coreTransactionId}`,
    });
  }

  const totalReceived = round2((Number(po.actual_received_total) || 0) + totalUsd);
  const totalCashPaid = round2((Number(po.actual_cash_paid) || 0) + cashPaid);
  const totalCredit = round2((Number(po.actual_credit_added) || 0) + creditAdded);
  const totalReleased = round2((Number(po.released_cash_amount) || 0) + releasedCash);

  db.prepare(
    `UPDATE or_po_commitments
        SET core_transaction_id = COALESCE(?, core_transaction_id),
            actual_received_total = ?,
            actual_cash_paid = ?,
            actual_credit_added = ?,
            released_cash_amount = ?,
            locked_cash_amount = 0,
            status = 'SETTLED',
            settled_at = CURRENT_TIMESTAMP
      WHERE id = ? AND tenant_id = ?`
  ).run(coreTransactionId, totalReceived, totalCashPaid, totalCredit, totalReleased, po.id, tenantId);

  if (Number(po.estimated_order_total) > 0) {
    const fillRatio = Math.min(1, Math.max(0, totalReceived / Number(po.estimated_order_total)));
    const prof = db
      .prepare("SELECT * FROM or_supplier_profiles WHERE tenant_id = ? AND supplier_id = ? AND deleted_at IS NULL")
      .get(tenantId, supplierId) as any;
    if (prof) {
      const count = Number(prof.deliveries_count || 0);
      const newScore = round2(count === 0 ? fillRatio : (Number(prof.fill_rate_score) * count + fillRatio) / (count + 1));
      db.prepare("UPDATE or_supplier_profiles SET fill_rate_score = ?, deliveries_count = ? WHERE id = ?")
        .run(newScore, count + 1, prof.id);
    } else {
      db.prepare(
        `INSERT INTO or_supplier_profiles (tenant_id, supplier_id, fill_rate_score, deliveries_count, default_payment_plan)
         VALUES (?, ?, ?, 1, ?)`
      ).run(tenantId, supplierId, round2(fillRatio), po.payment_plan);
    }
  }

  logAction(
    tenantId,
    resolveTenantUserId(tenantId, params.userId),
    "OR PO Settled via Purchase Invoice",
    `${po.po_number || `#${po.id}`} linked to Invoice #${coreTransactionId} (released $${releasedCash.toFixed(2)})`
  );
  return { releasedCash, poNumber: po.po_number || null };
}
