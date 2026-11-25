// OmniPulse OR configuration, industry presets, draw policies, and fixed obligations.
import { db } from "../db.js";
import { ValidationError } from "../errors.js";
import { stableGlobalId } from "./stableId.js";

export type BusinessType = "RETAIL" | "RESTAURANT" | "SERVICE" | "HYBRID";
export type SurvivalMode = "CRISIS" | "RECOVERY" | "GROWTH";

export interface OrTenantConfig {
  id: number;
  tenant_id: number;
  business_type: BusinessType;
  survival_mode: SurvivalMode;
  enable_owner_draw: number;
  enable_po_cash_lock: number;
  enable_cycle_count: number;
  enable_recipe_deduction: number;
  min_drawer_float: number;
  cycle_count_daily_limit: number;
  variance_alert_pct: number;
  owner_stakeholder_id?: number | null;
}

export interface OrDrawPolicy {
  id: number;
  tenant_id: number;
  survival_mode: SurvivalMode;
  max_daily_cash: number;
  max_daily_goods_cost: number;
  max_monthly_total: number;
  require_override_reason: number;
}

export const INDUSTRY_PRESETS: Record<
  BusinessType,
  {
    config: Omit<OrTenantConfig, "id" | "tenant_id">;
    policies: Record<SurvivalMode, { max_daily_cash: number; max_daily_goods_cost: number; max_monthly_total: number }>;
  }
> = {
  RETAIL: {
    config: {
      business_type: "RETAIL",
      survival_mode: "RECOVERY",
      enable_owner_draw: 1,
      enable_po_cash_lock: 1,
      enable_cycle_count: 1,
      enable_recipe_deduction: 0,
      min_drawer_float: 30,
      cycle_count_daily_limit: 8,
      variance_alert_pct: 5,
    },
    policies: {
      CRISIS: { max_daily_cash: 10, max_daily_goods_cost: 5, max_monthly_total: 350 },
      RECOVERY: { max_daily_cash: 25, max_daily_goods_cost: 10, max_monthly_total: 800 },
      GROWTH: { max_daily_cash: 60, max_daily_goods_cost: 20, max_monthly_total: 1800 },
    },
  },
  RESTAURANT: {
    config: {
      business_type: "RESTAURANT",
      survival_mode: "RECOVERY",
      enable_owner_draw: 1,
      enable_po_cash_lock: 1,
      enable_cycle_count: 1,
      enable_recipe_deduction: 1,
      min_drawer_float: 50,
      cycle_count_daily_limit: 10,
      variance_alert_pct: 3,
    },
    policies: {
      CRISIS: { max_daily_cash: 15, max_daily_goods_cost: 10, max_monthly_total: 500 },
      RECOVERY: { max_daily_cash: 35, max_daily_goods_cost: 15, max_monthly_total: 1100 },
      GROWTH: { max_daily_cash: 75, max_daily_goods_cost: 25, max_monthly_total: 2400 },
    },
  },
  SERVICE: {
    config: {
      business_type: "SERVICE",
      survival_mode: "RECOVERY",
      enable_owner_draw: 1,
      enable_po_cash_lock: 1,
      enable_cycle_count: 0,
      enable_recipe_deduction: 0,
      min_drawer_float: 20,
      cycle_count_daily_limit: 5,
      variance_alert_pct: 5,
    },
    policies: {
      CRISIS: { max_daily_cash: 15, max_daily_goods_cost: 0, max_monthly_total: 400 },
      RECOVERY: { max_daily_cash: 40, max_daily_goods_cost: 5, max_monthly_total: 1000 },
      GROWTH: { max_daily_cash: 90, max_daily_goods_cost: 10, max_monthly_total: 2500 },
    },
  },
  HYBRID: {
    config: {
      business_type: "HYBRID",
      survival_mode: "RECOVERY",
      enable_owner_draw: 1,
      enable_po_cash_lock: 1,
      enable_cycle_count: 1,
      enable_recipe_deduction: 0,
      min_drawer_float: 30,
      cycle_count_daily_limit: 8,
      variance_alert_pct: 5,
    },
    policies: {
      CRISIS: { max_daily_cash: 10, max_daily_goods_cost: 5, max_monthly_total: 400 },
      RECOVERY: { max_daily_cash: 30, max_daily_goods_cost: 10, max_monthly_total: 900 },
      GROWTH: { max_daily_cash: 70, max_daily_goods_cost: 20, max_monthly_total: 2000 },
    },
  },
};

/** Idempotently seeds `or_tenant_config`, `or_draw_policies` (all 3 modes), and virtual `or_cash_buckets`. */
export function ensureOrInitialized(tenantId: number, defaultType: BusinessType = "RETAIL"): OrTenantConfig {
  const existing = db
    .prepare("SELECT * FROM or_tenant_config WHERE tenant_id = ? AND deleted_at IS NULL")
    .get(tenantId) as OrTenantConfig | undefined;

  if (!existing) {
    const preset = INDUSTRY_PRESETS[defaultType];
    db.prepare(
      `INSERT INTO or_tenant_config (
        global_id, tenant_id, business_type, survival_mode, enable_owner_draw, enable_po_cash_lock,
        enable_cycle_count, enable_recipe_deduction, min_drawer_float, cycle_count_daily_limit, variance_alert_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      stableGlobalId(tenantId, "or_tenant_config"),
      tenantId,
      preset.config.business_type,
      preset.config.survival_mode,
      preset.config.enable_owner_draw,
      preset.config.enable_po_cash_lock,
      preset.config.enable_cycle_count,
      preset.config.enable_recipe_deduction,
      preset.config.min_drawer_float,
      preset.config.cycle_count_daily_limit,
      preset.config.variance_alert_pct
    );
  }

  // Ensure all 3 survival mode draw policies exist
  const presetType = (existing?.business_type || defaultType) as BusinessType;
  const presetPolicies = INDUSTRY_PRESETS[presetType]?.policies || INDUSTRY_PRESETS.RETAIL.policies;
  const insertPolicy = db.prepare(
    `INSERT OR IGNORE INTO or_draw_policies (global_id, tenant_id, survival_mode, max_daily_cash, max_daily_goods_cost, max_monthly_total, require_override_reason)
     VALUES (?, ?, ?, ?, ?, ?, 1)`
  );
  for (const mode of ["CRISIS", "RECOVERY", "GROWTH"] as SurvivalMode[]) {
    const p = presetPolicies[mode];
    insertPolicy.run(stableGlobalId(tenantId, "or_draw_policies", mode), tenantId, mode, p.max_daily_cash, p.max_daily_goods_cost, p.max_monthly_total);
  }

  // Ensure core virtual buckets exist
  const insertBucket = db.prepare(
    `INSERT OR IGNORE INTO or_cash_buckets (global_id, tenant_id, code, name, target_amount, current_balance, priority)
     VALUES (?, ?, ?, ?, 0, 0, ?)`
  );
  insertBucket.run(stableGlobalId(tenantId, "or_cash_buckets", "OPEX_RESERVE"), tenantId, "OPEX_RESERVE", "OpEx & Fixed Obligations Reserve", 1);
  insertBucket.run(stableGlobalId(tenantId, "or_cash_buckets", "CORE_RESTOCK"), tenantId, "CORE_RESTOCK", "Supplier PO Cash-Lock Reserve", 2);

  return db
    .prepare("SELECT * FROM or_tenant_config WHERE tenant_id = ? AND deleted_at IS NULL")
    .get(tenantId) as OrTenantConfig;
}

export function applyIndustryPreset(tenantId: number, businessType: BusinessType): { config: OrTenantConfig; policies: OrDrawPolicy[] } {
  const preset = INDUSTRY_PRESETS[businessType];
  if (!preset) {
    throw new ValidationError("Invalid business_type. Use RETAIL, RESTAURANT, SERVICE, or HYBRID.", 400, {
      code: "OR_BUSINESS_TYPE_INVALID",
      field: "business_type",
    });
  }
  ensureOrInitialized(tenantId, businessType);
  db.transaction(() => {
    db.prepare(
      `UPDATE or_tenant_config
          SET business_type = ?, enable_owner_draw = ?, enable_po_cash_lock = ?, enable_cycle_count = ?,
              enable_recipe_deduction = ?, min_drawer_float = ?, cycle_count_daily_limit = ?, variance_alert_pct = ?
        WHERE tenant_id = ?`
    ).run(
      preset.config.business_type,
      preset.config.enable_owner_draw,
      preset.config.enable_po_cash_lock,
      preset.config.enable_cycle_count,
      preset.config.enable_recipe_deduction,
      preset.config.min_drawer_float,
      preset.config.cycle_count_daily_limit,
      preset.config.variance_alert_pct,
      tenantId
    );
    const updPolicy = db.prepare(
      `UPDATE or_draw_policies
          SET max_daily_cash = ?, max_daily_goods_cost = ?, max_monthly_total = ?
        WHERE tenant_id = ? AND survival_mode = ?`
    );
    for (const mode of ["CRISIS", "RECOVERY", "GROWTH"] as SurvivalMode[]) {
      const p = preset.policies[mode];
      updPolicy.run(p.max_daily_cash, p.max_daily_goods_cost, p.max_monthly_total, tenantId, mode);
    }
  })();

  const config = ensureOrInitialized(tenantId);
  const policies = db
    .prepare("SELECT * FROM or_draw_policies WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY CASE survival_mode WHEN 'CRISIS' THEN 1 WHEN 'RECOVERY' THEN 2 ELSE 3 END")
    .all(tenantId) as OrDrawPolicy[];
  return { config, policies };
}

export function updateOrConfig(tenantId: number, patch: Partial<OrTenantConfig>): OrTenantConfig {
  const cur = ensureOrInitialized(tenantId);
  const businessType = patch.business_type ?? cur.business_type;
  if (!["RETAIL", "RESTAURANT", "SERVICE", "HYBRID"].includes(businessType)) {
    throw new ValidationError("Invalid business_type.", 400, { code: "OR_BUSINESS_TYPE_INVALID" });
  }
  const survivalMode = patch.survival_mode ?? cur.survival_mode;
  if (!["CRISIS", "RECOVERY", "GROWTH"].includes(survivalMode)) {
    throw new ValidationError("Invalid survival_mode.", 400, { code: "OR_SURVIVAL_MODE_INVALID" });
  }
  const boolVal = (v: any, fallback: number) => (v === undefined ? fallback : v ? 1 : 0);
  const minFloat = patch.min_drawer_float !== undefined ? Math.max(0, Number(patch.min_drawer_float) || 0) : cur.min_drawer_float;
  const dailyLimit = patch.cycle_count_daily_limit !== undefined ? Math.max(1, Math.min(50, Math.round(Number(patch.cycle_count_daily_limit) || 8))) : cur.cycle_count_daily_limit;
  const variancePct = patch.variance_alert_pct !== undefined ? Math.max(0, Number(patch.variance_alert_pct) || 5) : cur.variance_alert_pct;

  let ownerStakeholderId: number | null = cur.owner_stakeholder_id ?? null;
  if (patch.owner_stakeholder_id !== undefined) {
    if (patch.owner_stakeholder_id === null || patch.owner_stakeholder_id === ("" as any) || Number(patch.owner_stakeholder_id) === 0) {
      ownerStakeholderId = null;
    } else {
      const sid = Number(patch.owner_stakeholder_id);
      const st = db
        .prepare("SELECT id FROM stakeholders WHERE id = ? AND tenant_id = ? AND type = 'customer' AND deleted_at IS NULL")
        .get(sid, tenantId) as any;
      if (!st) {
        throw new ValidationError("Selected owner customer not found.", 404, {
          code: "OR_OWNER_CUSTOMER_NOT_FOUND",
          field: "owner_stakeholder_id",
        });
      }
      ownerStakeholderId = st.id;
    }
  }

  db.prepare(
    `UPDATE or_tenant_config
        SET business_type = ?, survival_mode = ?, enable_owner_draw = ?, enable_po_cash_lock = ?,
            enable_cycle_count = ?, enable_recipe_deduction = ?, min_drawer_float = ?,
            cycle_count_daily_limit = ?, variance_alert_pct = ?, owner_stakeholder_id = ?
      WHERE tenant_id = ?`
  ).run(
    businessType,
    survivalMode,
    boolVal(patch.enable_owner_draw, cur.enable_owner_draw),
    boolVal(patch.enable_po_cash_lock, cur.enable_po_cash_lock),
    boolVal(patch.enable_cycle_count, cur.enable_cycle_count),
    boolVal(patch.enable_recipe_deduction, cur.enable_recipe_deduction),
    minFloat,
    dailyLimit,
    variancePct,
    ownerStakeholderId,
    tenantId
  );

  return ensureOrInitialized(tenantId);
}

export function listDrawPolicies(tenantId: number): OrDrawPolicy[] {
  ensureOrInitialized(tenantId);
  return db
    .prepare(
      "SELECT * FROM or_draw_policies WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY CASE survival_mode WHEN 'CRISIS' THEN 1 WHEN 'RECOVERY' THEN 2 ELSE 3 END"
    )
    .all(tenantId) as OrDrawPolicy[];
}

export function upsertDrawPolicy(
  tenantId: number,
  mode: SurvivalMode,
  patch: { max_daily_cash: number; max_daily_goods_cost: number; max_monthly_total: number; require_override_reason?: boolean | number }
): OrDrawPolicy {
  if (!["CRISIS", "RECOVERY", "GROWTH"].includes(mode)) {
    throw new ValidationError("Invalid survival_mode.", 400, { code: "OR_SURVIVAL_MODE_INVALID" });
  }
  ensureOrInitialized(tenantId);
  db.prepare(
    `UPDATE or_draw_policies
        SET max_daily_cash = ?, max_daily_goods_cost = ?, max_monthly_total = ?, require_override_reason = ?
      WHERE tenant_id = ? AND survival_mode = ?`
  ).run(
    Math.max(0, Number(patch.max_daily_cash) || 0),
    Math.max(0, Number(patch.max_daily_goods_cost) || 0),
    Math.max(0, Number(patch.max_monthly_total) || 0),
    patch.require_override_reason === false || patch.require_override_reason === 0 ? 0 : 1,
    tenantId,
    mode
  );
  return db
    .prepare("SELECT * FROM or_draw_policies WHERE tenant_id = ? AND survival_mode = ?")
    .get(tenantId, mode) as OrDrawPolicy;
}

/** Daily USD burn rate for an obligation frequency. */
export function dailyObligationRate(amountUsd: number, frequency: string): number {
  const amt = Math.max(0, Number(amountUsd) || 0);
  if (frequency === "daily") return amt;
  if (frequency === "weekly") return amt / 7;
  if (frequency === "yearly") return amt / 365;
  return amt / 30; // monthly default
}

export function listFixedObligations(tenantId: number) {
  return db
    .prepare("SELECT * FROM or_fixed_obligations WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY active DESC, id ASC")
    .all(tenantId) as any[];
}

export function createFixedObligation(tenantId: number, body: any) {
  const name = String(body?.name || "").trim();
  if (!name) throw new ValidationError("Obligation name is required.", 400, { code: "OR_OBLIGATION_NAME_REQUIRED", field: "name" });
  const amountUsd = Number(body?.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new ValidationError("Amount must be greater than zero.", 400, { code: "OR_OBLIGATION_AMOUNT_INVALID", field: "amount_usd" });
  }
  const frequency = ["daily", "weekly", "monthly", "yearly"].includes(body?.frequency) ? body.frequency : "monthly";
  const dueDay = Math.max(1, Math.min(31, Math.round(Number(body?.due_day) || 1)));
  const category = String(body?.category || "opex").trim() || "opex";
  const notes = body?.notes ? String(body.notes).trim() : null;

  const info = db
    .prepare(
      `INSERT INTO or_fixed_obligations (tenant_id, name, category, amount_usd, frequency, due_day, active, notes)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(tenantId, name, category, amountUsd, frequency, dueDay, notes);
  return db.prepare("SELECT * FROM or_fixed_obligations WHERE id = ?").get(Number(info.lastInsertRowid));
}

export function updateFixedObligation(tenantId: number, id: number, body: any) {
  const cur = db
    .prepare("SELECT * FROM or_fixed_obligations WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(id, tenantId) as any;
  if (!cur) throw new ValidationError("Obligation not found.", 404, { code: "OR_OBLIGATION_NOT_FOUND" });
  const name = body?.name !== undefined ? String(body.name).trim() : cur.name;
  if (!name) throw new ValidationError("Obligation name is required.", 400, { code: "OR_OBLIGATION_NAME_REQUIRED" });
  const amountUsd = body?.amount_usd !== undefined ? Number(body.amount_usd) : cur.amount_usd;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new ValidationError("Amount must be greater than zero.", 400, { code: "OR_OBLIGATION_AMOUNT_INVALID" });
  }
  const frequency = body?.frequency && ["daily", "weekly", "monthly", "yearly"].includes(body.frequency) ? body.frequency : cur.frequency;
  const dueDay = body?.due_day !== undefined ? Math.max(1, Math.min(31, Math.round(Number(body.due_day) || 1))) : cur.due_day;
  const category = body?.category !== undefined ? String(body.category).trim() || "opex" : cur.category;
  const active = body?.active !== undefined ? (body.active ? 1 : 0) : cur.active;
  const notes = body?.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : cur.notes;

  db.prepare(
    `UPDATE or_fixed_obligations SET name = ?, category = ?, amount_usd = ?, frequency = ?, due_day = ?, active = ?, notes = ?
      WHERE id = ? AND tenant_id = ?`
  ).run(name, category, amountUsd, frequency, dueDay, active, notes, id, tenantId);
  return db.prepare("SELECT * FROM or_fixed_obligations WHERE id = ?").get(id);
}

export function deleteFixedObligation(tenantId: number, id: number) {
  const cur = db
    .prepare("SELECT id FROM or_fixed_obligations WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL")
    .get(id, tenantId);
  if (!cur) throw new ValidationError("Obligation not found.", 404, { code: "OR_OBLIGATION_NOT_FOUND" });
  db.prepare("UPDATE or_fixed_obligations SET deleted_at = CURRENT_TIMESTAMP, active = 0 WHERE id = ? AND tenant_id = ?").run(id, tenantId);
}
