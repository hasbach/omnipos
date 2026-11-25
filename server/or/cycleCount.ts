// Workflow C: 5-Minute Daily ABC Cycle Count & Stock Anomaly Queue.
import { db, logAction } from "../db.js";
import { ValidationError } from "../errors.js";
import { ensureOrInitialized } from "./config.js";
import { adjustProductStockCore, localDateIso, resolveTenantUserId, round2 } from "./coreBridge.js";
import { rowGlobalId, stableGlobalId } from "./stableId.js";

export type AnomalyType = "NEGATIVE_STOCK_SALE" | "STAFF_SHELF_EMPTY" | "HIGH_VARIANCE" | "EXPIRY_CHECK";

/** Records a stock anomaly (deduped if an OPEN/QUEUED anomaly already exists for the same product & type). */
export function recordStockAnomaly(
  tenantId: number,
  productId: number,
  anomalyType: AnomalyType,
  reportedByUserId?: number | null
) {
  const existing = db
    .prepare(
      `SELECT id FROM or_stock_anomalies
        WHERE tenant_id = ? AND product_id = ? AND anomaly_type = ? AND status IN ('OPEN', 'QUEUED') AND deleted_at IS NULL`
    )
    .get(tenantId, productId, anomalyType) as any;
  if (existing) return existing.id;

  const info = db
    .prepare(
      `INSERT INTO or_stock_anomalies (tenant_id, product_id, anomaly_type, reported_by_user_id, status)
       VALUES (?, ?, ?, ?, 'OPEN')`
    )
    .run(tenantId, productId, anomalyType, reportedByUserId ?? null);
  return Number(info.lastInsertRowid);
}

export function listStockAnomalies(tenantId: number, status = "OPEN") {
  let sql = `
    SELECT a.*, p.name AS product_name, p.barcode, p.stock AS current_stock, u.name AS reported_by_name
      FROM or_stock_anomalies a
      LEFT JOIN products p ON p.id = a.product_id
      LEFT JOIN users u ON u.id = a.reported_by_user_id
     WHERE a.tenant_id = ? AND a.deleted_at IS NULL`;
  const params: any[] = [tenantId];
  if (status && status !== "all") {
    sql += " AND a.status = ?";
    params.push(status);
  }
  sql += " ORDER BY a.created_at DESC, a.id DESC LIMIT 200";
  return db.prepare(sql).all(...params);
}

/**
 * Generates today's 5-minute Cycle Count session (idempotent for the same date unless `force` is true).
 * Priority order:
 *  1. Open items in `or_stock_anomalies`
 *  2. Restaurant mode: highest-cost tracked items not counted in the last 2 days
 *  3. Retail/Hybrid mode: ABC Class A items with oldest `last_counted_at`, then B/C fallback
 */
export function generateCycleCountSession(
  tenantId: number,
  opts: { sessionDate?: string; assignedUserId?: number | null; force?: boolean } = {}
) {
  const config = ensureOrInitialized(tenantId);
  if (!config.enable_cycle_count && !opts.force) {
    return null;
  }
  const sessionDate = opts.sessionDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.sessionDate) ? opts.sessionDate : localDateIso();

  if (!opts.force) {
    const existing = db
      .prepare(
        `SELECT id FROM or_cycle_count_sessions
          WHERE tenant_id = ? AND session_date = ? AND status IN ('OPEN', 'IN_PROGRESS', 'PENDING_APPROVAL') AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`
      )
      .get(tenantId, sessionDate) as any;
    if (existing) return getCycleCountSession(tenantId, existing.id, false);
  }

  const limit = Math.max(1, Number(config.cycle_count_daily_limit) || 8);
  const selected: Array<{ product_id: number; priority_reason: string; stock: number; cost: number }> = [];
  const seen = new Set<number>();

  // 1. Open anomalies first
  const anomalies = db
    .prepare(
      `SELECT a.id AS anomaly_id, p.id AS product_id, p.stock, p.cost
         FROM or_stock_anomalies a
         JOIN products p ON p.id = a.product_id AND p.tenant_id = a.tenant_id AND p.deleted_at IS NULL
        WHERE a.tenant_id = ? AND a.status = 'OPEN' AND a.deleted_at IS NULL AND IFNULL(p.track_inventory, 1) = 1
        ORDER BY a.created_at ASC`
    )
    .all(tenantId) as any[];
  const queuedAnomalyIds: number[] = [];
  for (const a of anomalies) {
    if (selected.length >= limit) break;
    if (seen.has(a.product_id)) continue;
    seen.add(a.product_id);
    queuedAnomalyIds.push(a.anomaly_id);
    selected.push({
      product_id: a.product_id,
      priority_reason: "ANOMALY_FLAG",
      stock: Number(a.stock) || 0,
      cost: Number(a.cost) || 0,
    });
  }

  // 2. Industry-specific priority fill
  if (selected.length < limit) {
    const remaining = limit - selected.length;
    if (config.business_type === "RESTAURANT") {
      const perishables = db
        .prepare(
          `SELECT p.id AS product_id, p.stock, p.cost, m.last_counted_at
             FROM products p
             LEFT JOIN or_sku_metrics m ON m.tenant_id = p.tenant_id AND m.product_id = p.id
            WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND IFNULL(p.active, 1) = 1 AND IFNULL(p.track_inventory, 1) = 1
              AND (m.last_counted_at IS NULL OR date(m.last_counted_at) <= date(?, '-2 days'))
            ORDER BY IFNULL(p.cost, 0) DESC, m.last_counted_at ASC
            LIMIT ?`
        )
        .all(tenantId, sessionDate, remaining + seen.size) as any[];
      for (const p of perishables) {
        if (selected.length >= limit) break;
        if (seen.has(p.product_id)) continue;
        seen.add(p.product_id);
        selected.push({
          product_id: p.product_id,
          priority_reason: "PERISHABLE_HIGH_COST",
          stock: Number(p.stock) || 0,
          cost: Number(p.cost) || 0,
        });
      }
    } else {
      const abcRows = db
        .prepare(
          `SELECT p.id AS product_id, p.stock, p.cost, COALESCE(m.abc_class, 'C') AS abc_class, m.last_counted_at
             FROM products p
             LEFT JOIN or_sku_metrics m ON m.tenant_id = p.tenant_id AND m.product_id = p.id
            WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND IFNULL(p.active, 1) = 1 AND IFNULL(p.track_inventory, 1) = 1
            ORDER BY CASE COALESCE(m.abc_class, 'C') WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END,
                     CASE WHEN m.last_counted_at IS NULL THEN 0 ELSE 1 END,
                     m.last_counted_at ASC,
                     IFNULL(p.cost, 0) * ABS(IFNULL(p.stock, 0)) DESC
            LIMIT ?`
        )
        .all(tenantId, remaining + seen.size) as any[];
      for (const p of abcRows) {
        if (selected.length >= limit) break;
        if (seen.has(p.product_id)) continue;
        seen.add(p.product_id);
        selected.push({
          product_id: p.product_id,
          priority_reason: p.abc_class === "A" ? "ABC_CLASS_A" : "OVERDUE_COUNT",
          stock: Number(p.stock) || 0,
          cost: Number(p.cost) || 0,
        });
      }
    }
  }

  if (selected.length === 0) return null;

  const sessionType = config.business_type === "RESTAURANT" ? "PERISHABLE_CHECK" : "DAILY_ABC";
  const sessionId = db.transaction(() => {
    // The automatic daily session gets the same id on every register (a manual "force" one is unique).
    let sessionGid = opts.force ? null : stableGlobalId(tenantId, "or_cycle_count_sessions", sessionDate);
    if (sessionGid && db.prepare("SELECT 1 FROM or_cycle_count_sessions WHERE global_id = ?").get(sessionGid)) sessionGid = null;
    const info = db
      .prepare(
        `INSERT INTO or_cycle_count_sessions (global_id, tenant_id, session_date, session_type, assigned_user_id, status, total_items_planned)
         VALUES (?, ?, ?, ?, ?, 'OPEN', ?)`
      )
      .run(sessionGid, tenantId, sessionDate, sessionType, opts.assignedUserId ?? null, selected.length);
    const sid = Number(info.lastInsertRowid);

    const insItem = db.prepare(
      `INSERT INTO or_cycle_count_items (global_id, tenant_id, session_id, product_id, priority_reason, system_qty_snapshot, unit_cost_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of selected) {
      const itemGid = sessionGid ? stableGlobalId(tenantId, "or_cycle_count_items", sessionGid, rowGlobalId("products", item.product_id) || item.product_id) : null;
      insItem.run(itemGid, tenantId, sid, item.product_id, item.priority_reason, item.stock, item.cost);
    }

    if (queuedAnomalyIds.length > 0) {
      const updAnom = db.prepare("UPDATE or_stock_anomalies SET status = 'QUEUED' WHERE id = ? AND tenant_id = ?");
      for (const aid of queuedAnomalyIds) updAnom.run(aid, tenantId);
    }
    return sid;
  })();

  return getCycleCountSession(tenantId, sessionId, false);
}

export function listCycleCountSessions(tenantId: number, limit = 30) {
  return db
    .prepare(
      `SELECT s.*, u.name AS assigned_user_name,
              (SELECT COUNT(*) FROM or_cycle_count_items i WHERE i.session_id = s.id AND i.counted_qty IS NOT NULL AND i.deleted_at IS NULL) AS counted_items
         FROM or_cycle_count_sessions s
         LEFT JOIN users u ON u.id = s.assigned_user_id
        WHERE s.tenant_id = ? AND s.deleted_at IS NULL
        ORDER BY s.session_date DESC, s.id DESC
        LIMIT ?`
    )
    .all(tenantId, Math.max(1, Math.min(200, limit)));
}

/**
 * Retrieves a cycle count session with its items.
 * When `blind = true` and the session is still OPEN / IN_PROGRESS, `system_qty_snapshot` is masked (`null`)
 * to prevent lazy "copy-paste" counting by staff.
 */
export function getCycleCountSession(tenantId: number, sessionId: number, blind = true) {
  const session = db
    .prepare(
      `SELECT s.*, u.name AS assigned_user_name
         FROM or_cycle_count_sessions s
         LEFT JOIN users u ON u.id = s.assigned_user_id
        WHERE s.id = ? AND s.tenant_id = ? AND s.deleted_at IS NULL`
    )
    .get(sessionId, tenantId) as any;
  if (!session) return null;

  const hideSnapshot = blind && (session.status === "OPEN" || session.status === "IN_PROGRESS");
  const rawItems = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.barcode, p.category, p.unit
         FROM or_cycle_count_items i
         LEFT JOIN products p ON p.id = i.product_id
        WHERE i.session_id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL
        ORDER BY i.id ASC`
    )
    .all(sessionId, tenantId) as any[];

  const items = rawItems.map((it) =>
    hideSnapshot
      ? { ...it, system_qty_snapshot: null, variance_qty: null, variance_cost: null }
      : it
  );
  return { ...session, items };
}

/**
 * Staff submits physical counts for a session.
 * If any item exceeds `variance_alert_pct`, the session moves to `PENDING_APPROVAL` for owner review.
 * Otherwise, it auto-completes and posts Core `stock_adjustments` immediately in the same transaction.
 */
export function submitCycleCount(
  tenantId: number,
  sessionId: number,
  counts: Array<{ item_id?: number; product_id?: number; counted_qty: number }>,
  userId?: number | null
) {
  const config = ensureOrInitialized(tenantId);
  const session = db
    .prepare("SELECT * FROM or_cycle_count_sessions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(sessionId, tenantId) as any;
  if (!session) throw new ValidationError("Cycle count session not found.", 404, { code: "OR_CYCLE_NOT_FOUND" });
  if (!["OPEN", "IN_PROGRESS"].includes(session.status)) {
    throw new ValidationError(`Session cannot be submitted in status ${session.status}.`, 400, { code: "OR_CYCLE_STATUS_INVALID" });
  }
  if (!Array.isArray(counts) || counts.length === 0) {
    throw new ValidationError("Provide at least one counted item.", 400, { code: "OR_CYCLE_COUNTS_EMPTY" });
  }

  const items = db
    .prepare("SELECT * FROM or_cycle_count_items WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .all(sessionId, tenantId) as any[];

  let needsApproval = false;
  let totalVarianceCost = 0;
  const alertPct = Number(config.variance_alert_pct) || 5;

  db.transaction(() => {
    // The variance is measured against the system stock AT COUNT TIME (not when the session was
    // generated): sales/purchases between generation and counting are already on the shelf count.
    const updItem = db.prepare(
      `UPDATE or_cycle_count_items
          SET counted_qty = ?, system_qty_snapshot = ?, variance_qty = ?, variance_cost = ?, counted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ?`
    );
    const stockNow = db.prepare("SELECT stock FROM products WHERE id = ? AND tenant_id = ?");

    for (const c of counts) {
      const target = items.find((i) => (c.item_id ? i.id === c.item_id : i.product_id === c.product_id));
      if (!target) continue;
      const counted = Number(c.counted_qty);
      if (!Number.isFinite(counted) || counted < 0) {
        throw new ValidationError("Counted quantity must be a non-negative number.", 400, { code: "OR_CYCLE_QTY_INVALID" });
      }
      const live = stockNow.get(target.product_id, tenantId) as any;
      const sysQty = live ? Number(live.stock) || 0 : Number(target.system_qty_snapshot) || 0;
      const varQty = round2(counted - sysQty);
      const varCost = round2(varQty * (Number(target.unit_cost_snapshot) || 0));
      totalVarianceCost = round2(totalVarianceCost + varCost);

      const denom = Math.max(1, Math.abs(sysQty));
      const varPct = (Math.abs(varQty) / denom) * 100;
      if (Math.abs(varQty) > 0.0001 && varPct > alertPct) {
        needsApproval = true;
      }
      updItem.run(counted, sysQty, varQty, varCost, target.id, tenantId);
    }

    db.prepare(
      `UPDATE or_cycle_count_sessions
          SET status = ?, total_variance_cost = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND tenant_id = ?`
    ).run(needsApproval ? "PENDING_APPROVAL" : "IN_PROGRESS", totalVarianceCost, sessionId, tenantId);
  })();

  if (!needsApproval) {
    return approveAndCompleteCycleCount(tenantId, sessionId, userId);
  }
  logAction(tenantId, resolveTenantUserId(tenantId, userId), "OR Cycle Count Pending Approval", `Session #${sessionId}: variance $${totalVarianceCost.toFixed(2)}`);
  return getCycleCountSession(tenantId, sessionId, false);
}

/**
 * Approves (or auto-completes) a Cycle Count session: invokes OmniPOS Core `adjustProductStockCore()`
 * for every non-zero variance, stores `core_adjustment_tx_id`, updates `or_sku_metrics.last_counted_at`,
 * and marks linked `or_stock_anomalies` as `RESOLVED`.
 */
export function approveAndCompleteCycleCount(tenantId: number, sessionId: number, userId?: number | null) {
  const session = db
    .prepare("SELECT * FROM or_cycle_count_sessions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(sessionId, tenantId) as any;
  if (!session) throw new ValidationError("Cycle count session not found.", 404, { code: "OR_CYCLE_NOT_FOUND" });
  if (session.status === "COMPLETED") {
    return getCycleCountSession(tenantId, sessionId, false);
  }

  const actorId = resolveTenantUserId(tenantId, userId);
  const items = db
    .prepare("SELECT * FROM or_cycle_count_items WHERE session_id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .all(sessionId, tenantId) as any[];

  db.transaction(() => {
    let totalVarCost = 0;
    for (const it of items) {
      if (it.counted_qty === null || it.counted_qty === undefined) continue;
      const varQty = round2(Number(it.counted_qty) - (Number(it.system_qty_snapshot) || 0));
      const varCost = round2(varQty * (Number(it.unit_cost_snapshot) || 0));
      totalVarCost = round2(totalVarCost + varCost);

      let adjId: number | null = it.core_adjustment_tx_id ?? null;
      if (Math.abs(varQty) > 0.0001 && !adjId) {
        const adj = adjustProductStockCore({
          tenantId,
          productId: it.product_id,
          userId: actorId,
          // Apply the counted DIFFERENCE, never the absolute count: sales made between the count and
          // this approval must stay deducted.
          delta: varQty,
          reason: `OR Cycle Count #${sessionId}`,
          unitCostOverride: Number(it.unit_cost_snapshot) || 0,
        });
        adjId = adj.adjustmentId;
      }

      db.prepare("UPDATE or_cycle_count_items SET core_adjustment_tx_id = ?, variance_qty = ?, variance_cost = ? WHERE id = ?")
        .run(adjId, varQty, varCost, it.id);

      // Mark product's last_counted_at in or_sku_metrics
      db.prepare(
        `INSERT INTO or_sku_metrics (tenant_id, product_id, last_counted_at, computed_at)
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(tenant_id, product_id) DO UPDATE SET last_counted_at = CURRENT_TIMESTAMP`
      ).run(tenantId, it.product_id);

      // Resolve any open/queued anomalies for this product
      db.prepare(
        `UPDATE or_stock_anomalies
            SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ? AND product_id = ? AND status IN ('OPEN', 'QUEUED') AND deleted_at IS NULL`
      ).run(tenantId, it.product_id);
    }

    db.prepare(
      `UPDATE or_cycle_count_sessions
          SET status = 'COMPLETED', total_variance_cost = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ?`
    ).run(totalVarCost, sessionId, tenantId);
  })();

  logAction(tenantId, actorId, "OR Cycle Count Completed", `Session #${sessionId} finalized`);
  return getCycleCountSession(tenantId, sessionId, false);
}
