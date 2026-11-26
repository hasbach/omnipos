import { loadForecastAccuracy, saveForecastConfig } from "./demandForecastData.js";
import { loadCashForecast } from "./cashForecastData.js";
import { loadOpenPayablesReceivables } from "./payablesData.js";
import { stableGlobalId, rowGlobalId } from "./stableId.js";
// Express routes for OmniPulse OR (paid add-on module).
import { db } from "../db.js";
import { ValidationError, validationErrorBody } from "../errors.js";
import { getOrLicenseStatus, requireOrLicense } from "./license.js";
import { sessionHasPermission } from "../permissions.js";
import {
  applyIndustryPreset,
  createFixedObligation,
  deleteFixedObligation,
  ensureOrInitialized,
  listDrawPolicies,
  listFixedObligations,
  updateFixedObligation,
  updateOrConfig,
  upsertDrawPolicy,
  type BusinessType,
  type SurvivalMode,
} from "./config.js";
import { computeSpendableCash, listBucketLedger } from "./spendableCash.js";
import { createOwnerDraw, getOwnerDrawById, getOwnerDrawUsage, listOwnerDraws } from "./ownerDraw.js";
import {
  approvePoCommitment,
  cancelPoCommitment,
  createPoCommitment,
  getPoCommitmentById,
  listPoCommitments,
  receivePoCommitment,
} from "./poCommitments.js";
import {
  approveAndCompleteCycleCount,
  generateCycleCountSession,
  getCycleCountSession,
  listCycleCountSessions,
  listStockAnomalies,
  recordStockAnomaly,
  submitCycleCount,
} from "./cycleCount.js";
import { runNightlyOrPipeline } from "./pipeline.js";
import { applyOptimizationPlan, runOrOptimizer } from "./optimizer.js";
import { localDateIso } from "./coreBridge.js";
import { loadMarginAlerts } from "./marginAlerts.js";
import { readBundleIdeas } from "./bundleIdeasData.js";

export function setupOrRoutes(app: any, authenticate: any, broadcast: Function) {
  app.get('/api/or/bundle-ideas', authenticate, requireOrLicense, (req: any, res: any) => {
    try { res.json(readBundleIdeas(req.session.tenantId, req.query)); } catch (e) { fail(res, e); }
  });
  const fail = (res: any, e: any) => {
    if (e instanceof ValidationError) return res.status(e.status).json(validationErrorBody(e));
    if (e?.code === "OR_OPTIMIZER_BUSY" || e?.code === "OR_OPTIMIZER_TIMEOUT") {
      return res.status(e.code === "OR_OPTIMIZER_BUSY" ? 409 : 503).json({ error: e.message, code: e.code });
    }
    return res.status(500).json({ error: e?.message || String(e) });
  };

  app.get('/api/or/forecast-accuracy', authenticate, requireOrLicense, (req: any, res: any) => {
    try { res.json(loadForecastAccuracy(req.session.tenantId)); } catch (e) { fail(res, e); }
  });
  app.put('/api/or/forecast-config', authenticate, requireOrLicense, (req: any, res: any) => {
    try { res.json(saveForecastConfig(req.session.tenantId, req.body)); } catch (e) { fail(res, e); }
  });

  // Public (for authenticated tenants): returns whether the OmniPulse OR add-on is licensed
  app.get("/api/or/status", authenticate, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const license = getOrLicenseStatus(tenantId);
      const config = license.licensed ? ensureOrInitialized(tenantId) : null;
      res.json({ ...license, config });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/or/cash-forecast", authenticate, requireOrLicense, (req: any, res: any) => {
    try { res.json(loadCashForecast(req.session.tenantId)); } catch (e) { fail(res, e); }
  });

  app.get("/api/or/margins", authenticate, requireOrLicense, (req: any, res: any) => {
    try { res.json(loadMarginAlerts(req.session.tenantId)); } catch (e) { fail(res, e); }
  });

  // --- Morning Briefing / Overview ---
  app.get("/api/or/briefing", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const config = ensureOrInitialized(tenantId);
      const spendable = computeSpendableCash(tenantId);
      const drawUsage = getOwnerDrawUsage(tenantId);
      const actions = db
        .prepare(
          `SELECT * FROM or_action_queue
            WHERE tenant_id = ? AND status = 'OPEN' AND deleted_at IS NULL
            ORDER BY CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END, id DESC
            LIMIT 20`
        )
        .all(tenantId);
      const openAnomalies = db
        .prepare("SELECT COUNT(*) AS c FROM or_stock_anomalies WHERE tenant_id = ? AND status IN ('OPEN', 'QUEUED') AND deleted_at IS NULL")
        .get(tenantId) as any;
      const todaySession = db
        .prepare(
          `SELECT id, status, total_items_planned, total_variance_cost
             FROM or_cycle_count_sessions
            WHERE tenant_id = ? AND session_date = ? AND deleted_at IS NULL
            ORDER BY id DESC LIMIT 1`
        )
        .get(tenantId, localDateIso());
      const lastRun = db
        .prepare("SELECT run_date, trigger_source, ran_at FROM or_pipeline_runs WHERE tenant_id = ? ORDER BY run_date DESC LIMIT 1")
        .get(tenantId);

      res.json({
        config,
        spendable,
        settlements: loadOpenPayablesReceivables(tenantId),
        draw_usage: drawUsage,
        actions,
        open_anomalies_count: Number(openAnomalies?.c || 0),
        today_cycle_count: todaySession || null,
        last_pipeline_run: lastRun || null,
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/actions/:id/status", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const id = parseInt(req.params.id, 10);
      const status = ["OPEN", "DISMISSED", "DONE"].includes(req.body?.status) ? req.body.status : "DONE";
      db.prepare("UPDATE or_action_queue SET status = ? WHERE id = ? AND tenant_id = ?").run(status, id, tenantId);
      res.json({ success: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/pipeline/run", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const summary = runNightlyOrPipeline(tenantId, localDateIso(), "manual", true);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(summary);
    } catch (e) {
      fail(res, e);
    }
  });

  // --- Config, Presets, Draw Policies & Fixed Obligations ---
  app.get("/api/or/config", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      res.json({
        config: ensureOrInitialized(tenantId),
        suppliers: db.prepare(`SELECT s.id, s.name, COALESCE(p.payment_terms_days, 0) AS payment_terms_days
          FROM stakeholders s LEFT JOIN or_supplier_profiles p ON p.supplier_id = s.id AND p.tenant_id = s.tenant_id AND p.deleted_at IS NULL
          WHERE s.tenant_id = ? AND s.type = 'supplier' AND s.deleted_at IS NULL ORDER BY s.name`).all(tenantId),
        policies: listDrawPolicies(tenantId),
        obligations: listFixedObligations(tenantId),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.put("/api/or/config", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const config = updateOrConfig(req.session.tenantId, req.body || {});
      broadcast({ type: "OR_UPDATED" }, req.session.tenantId);
      res.json(config);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/apply-preset", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const out = applyIndustryPreset(req.session.tenantId, req.body?.business_type as BusinessType);
      broadcast({ type: "OR_UPDATED" }, req.session.tenantId);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  app.put("/api/or/draw-policies/:mode", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const mode = String(req.params.mode).toUpperCase() as SurvivalMode;
      const policy = upsertDrawPolicy(req.session.tenantId, mode, req.body || {});
      res.json(policy);
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/or/obligations", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      res.json(listFixedObligations(req.session.tenantId));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/obligations", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const row = createFixedObligation(req.session.tenantId, req.body || {});
      res.json(row);
    } catch (e) {
      fail(res, e);
    }
  });

  app.put("/api/or/obligations/:id", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const row = updateFixedObligation(req.session.tenantId, parseInt(req.params.id, 10), req.body || {});
      res.json(row);
    } catch (e) {
      fail(res, e);
    }
  });

  app.delete("/api/or/obligations/:id", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      deleteFixedObligation(req.session.tenantId, parseInt(req.params.id, 10));
      res.json({ success: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.put("/api/or/suppliers/:id/terms", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const supplierId = Number(req.params.id);
      if (!sessionHasPermission(req, "or.manage")) return res.status(403).json({ error: "Permission denied." });
      const terms = req.body?.payment_terms_days;
      if (!Number.isInteger(terms) || terms < 0 || terms > 3650) throw new ValidationError("Invalid supplier payment terms.", 400);
      const supplier = db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND id = ? AND type = 'supplier' AND deleted_at IS NULL").get(tenantId, supplierId);
      if (!supplier) throw new ValidationError("Supplier not found.", 404);
      const supplierGlobalId = rowGlobalId("stakeholders", supplierId);
      if (!supplierGlobalId) throw new ValidationError("Supplier global ID missing.", 409);
      const globalId = stableGlobalId(tenantId, "or_supplier_profiles", supplierGlobalId);
      db.prepare(`INSERT INTO or_supplier_profiles (global_id, tenant_id, supplier_id, payment_terms_days)
        VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, supplier_id) DO UPDATE SET payment_terms_days = excluded.payment_terms_days, deleted_at = NULL`).run(globalId, tenantId, supplierId, terms);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json({ payment_terms_days: terms });
    } catch (e) { fail(res, e); }
  });

  // --- Spendable Cash & Bucket Ledger ---
  app.get("/api/or/spendable-cash", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      res.json(computeSpendableCash(req.session.tenantId));
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/or/bucket-ledger", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const limit = parseInt(String(req.query.limit || "100"), 10);
      res.json(listBucketLedger(req.session.tenantId, Number.isFinite(limit) ? limit : 100));
    } catch (e) {
      fail(res, e);
    }
  });

  // --- Owner Draws ---
  app.get("/api/or/owner-draws", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      res.json({
        usage: getOwnerDrawUsage(tenantId),
        draws: listOwnerDraws(tenantId, {
          from: typeof req.query.from === "string" ? req.query.from : undefined,
          to: typeof req.query.to === "string" ? req.query.to : undefined,
        }),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/or/owner-draws/:id", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const draw = getOwnerDrawById(req.session.tenantId, parseInt(req.params.id, 10));
      if (!draw) return res.status(404).json({ error: "Owner draw not found." });
      res.json(draw);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/owner-draws", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const created = createOwnerDraw(tenantId, {
        ...(req.body || {}),
        recorded_by_user_id: req.session.userId ?? req.body?.recorded_by_user_id ?? null,
      });
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      broadcast({ type: "PRODUCTS_UPDATED" }, tenantId);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(created);
    } catch (e) {
      fail(res, e);
    }
  });

  // --- PO Commitments (Cash-Lock) ---
  app.get("/api/or/po-commitments", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      res.json(listPoCommitments(req.session.tenantId, typeof req.query.status === "string" ? req.query.status : undefined));
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/or/po-commitments/:id", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const po = getPoCommitmentById(req.session.tenantId, parseInt(req.params.id, 10));
      if (!po) return res.status(404).json({ error: "PO commitment not found." });
      res.json(po);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/po-commitments", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const created = createPoCommitment(tenantId, req.body || {}, req.session.userId ?? null);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(created);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/po-commitments/:id/approve", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const out = approvePoCommitment(tenantId, parseInt(req.params.id, 10), {
        userId: req.session.userId ?? null,
        lockAmount: req.body?.lock_amount !== undefined ? Number(req.body.lock_amount) : undefined,
        force: !!req.body?.force,
      });
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/po-commitments/:id/receive", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const out = receivePoCommitment(tenantId, parseInt(req.params.id, 10), {
        ...(req.body || {}),
        userId: req.session.userId ?? null,
      });
      broadcast({ type: "PURCHASES_UPDATED" }, tenantId);
      broadcast({ type: "PRODUCTS_UPDATED" }, tenantId);
      broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/po-commitments/:id/cancel", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const out = cancelPoCommitment(tenantId, parseInt(req.params.id, 10), req.session.userId ?? null);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  // --- Stock Anomalies & 5-Minute Cycle Count ---
  app.get("/api/or/anomalies", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      res.json(listStockAnomalies(req.session.tenantId, typeof req.query.status === "string" ? req.query.status : "OPEN"));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/anomalies", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const productId = parseInt(String(req.body?.product_id), 10);
      if (!Number.isFinite(productId) || productId <= 0) {
        throw new ValidationError("Valid product_id is required.", 400, { code: "PRODUCT_ID_INVALID" });
      }
      const type = ["NEGATIVE_STOCK_SALE", "STAFF_SHELF_EMPTY", "HIGH_VARIANCE", "EXPIRY_CHECK"].includes(req.body?.anomaly_type)
        ? req.body.anomaly_type
        : "STAFF_SHELF_EMPTY";
      const id = recordStockAnomaly(tenantId, productId, type, req.session.userId ?? null);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json({ id, product_id: productId, anomaly_type: type });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/or/cycle-counts", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      res.json(listCycleCountSessions(req.session.tenantId));
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/cycle-counts/generate", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const session = generateCycleCountSession(req.session.tenantId, {
        assignedUserId: req.session.userId ?? null,
        force: !!req.body?.force,
      });
      broadcast({ type: "OR_UPDATED" }, req.session.tenantId);
      const visible = session ? getCycleCountSession(req.session.tenantId, session.id, !sessionHasPermission(req, "or.manage")) : null;
      res.json(visible || { empty: true });
    } catch (e) {
      fail(res, e);
    }
  });

  app.get("/api/or/cycle-counts/:id", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      // Blind mode is decided by the server: only managers (or.manage) may see system quantities
      // before a session is submitted.
      const blind = req.query.blind === "1" || !sessionHasPermission(req, "or.manage");
      const session = getCycleCountSession(req.session.tenantId, parseInt(req.params.id, 10), blind);
      if (!session) return res.status(404).json({ error: "Cycle count session not found." });
      res.json(session);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/cycle-counts/:id/submit", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const out = submitCycleCount(tenantId, parseInt(req.params.id, 10), req.body?.counts || [], req.session.userId ?? null);
      broadcast({ type: "PRODUCTS_UPDATED" }, tenantId);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/cycle-counts/:id/approve", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const out = approveAndCompleteCycleCount(tenantId, parseInt(req.params.id, 10), req.session.userId ?? null);
      broadcast({ type: "PRODUCTS_UPDATED" }, tenantId);
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  // --- Dynamic MILP Optimizer (HiGHS WASM local / OR-Tools cloud adapter) ---
  app.post("/api/or/optimizer/run", authenticate, requireOrLicense, async (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const b = req.body || {};
      const solution = await runOrOptimizer(tenantId, {
        horizonDays: b.horizon_days !== undefined ? Number(b.horizon_days) : undefined,
        cashBudgetOverride: b.cash_budget_usd !== undefined ? Number(b.cash_budget_usd) : undefined,
      });
      res.json(solution);
    } catch (e) {
      fail(res, e);
    }
  });

  app.post("/api/or/optimizer/apply", authenticate, requireOrLicense, async (req: any, res: any) => {
    try {
      const tenantId = req.session.tenantId;
      const b = req.body || {};
      const out = await applyOptimizationPlan(tenantId, req.session.userId ?? null, {
        planId: typeof b.plan_id === "string" ? b.plan_id : undefined,
        supplierIds: Array.isArray(b.supplier_ids) ? b.supplier_ids.map(Number) : undefined,
        horizonDays: b.horizon_days !== undefined ? Number(b.horizon_days) : undefined,
        cashBudgetOverride: b.cash_budget_usd !== undefined ? Number(b.cash_budget_usd) : undefined,
      });
      broadcast({ type: "OR_UPDATED" }, tenantId);
      res.json(out);
    } catch (e) {
      fail(res, e);
    }
  });

  // --- SKU Metrics (ABC / Velocity view) ---
  app.get("/api/or/sku-metrics", authenticate, requireOrLicense, (req: any, res: any) => {
    try {
      const rows = db
        .prepare(
          `SELECT m.*, p.name AS product_name, p.barcode, p.stock, p.cost, p.price, p.category
             FROM or_sku_metrics m
             JOIN products p ON p.id = m.product_id AND p.tenant_id = m.tenant_id AND p.deleted_at IS NULL
            WHERE m.tenant_id = ?
            ORDER BY CASE m.abc_class WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, m.revenue_30d DESC
            LIMIT 300`
        )
        .all(req.session.tenantId);
      res.json(rows);
    } catch (e) {
      fail(res, e);
    }
  });
}
