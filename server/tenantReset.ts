// Tenant data reset ("Danger zone" in Settings) — docs/plans/2026-09-29-tenant-data-reset.md.
//
// Wipes the CURRENT tenant's business data (locally and in the cloud) for the selected scopes.
// Never touches other tenants, and never touches the tenants row, users, settings, currencies,
// printers or user_logs. EVERY statement below is scoped by tenant_id (child tables via their
// parent's tenant) — this is destructive code, keep it that way.
import fs from "fs";
import path from "path";
import { db, dbDir, logAction } from "./db.js";
import { getActiveSession } from "./session.js";
import { pauseSync, resumeSync } from "./sync.js";
import { ValidationError, validationErrorBody } from "./errors.js";

export const RESET_SCOPES = ["transactions", "stock", "products", "parties"] as const;
export type ResetScope = (typeof RESET_SCOPES)[number];

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// The admin of THIS tenant whose PIN matches (or null). No SUPER_ADMIN_PIN backdoor here. Same
// comparison as POST /api/auth/verify-pin: PINs are stored and compared as plain text. Shared with
// the settlement corrections (server/settlement.ts).
export function findAdminByPin(tenantId: number, rawPin: unknown): { id: number; pin: string } | null {
  const pin = typeof rawPin === "string" || typeof rawPin === "number" ? String(rawPin) : "";
  if (!pin) return null;
  const adminRows = db.prepare("SELECT id, pin FROM users WHERE tenant_id = ? AND role = 'admin'").all(tenantId) as any[];
  return adminRows.find((u) => u.pin === pin) || null;
}

// The tenant's default Walk-in customer: the same lookup the POS uses to default the customer
// (tenantStakeholderId in server/routes.ts) — the row literally named 'Walk-in Customer' (the name
// is only translated for DISPLAY, the stored name never changes), else the first customer.
export function findWalkInId(tenantId: number): number | null {
  const row = db.prepare(
    "SELECT id FROM stakeholders WHERE tenant_id = ? ORDER BY (name = 'Walk-in Customer') DESC, (type = 'customer') DESC, id LIMIT 1"
  ).get(tenantId) as any;
  return row ? row.id : null;
}

function count(sql: string, ...params: any[]): number {
  const row = db.prepare(sql).get(...params) as any;
  return Number(row?.c || 0);
}

function previewCounts(tenantId: number) {
  const walkIn = findWalkInId(tenantId);
  return {
    transactions:
      count("SELECT COUNT(*) c FROM transactions WHERE tenant_id = ?", tenantId) +
      count("SELECT COUNT(*) c FROM archived_transactions WHERE tenant_id = ?", tenantId),
    products: count("SELECT COUNT(*) c FROM products WHERE tenant_id = ?", tenantId),
    parties: count("SELECT COUNT(*) c FROM stakeholders WHERE tenant_id = ? AND id IS NOT ?", tenantId, walkIn),
    stock_units: count("SELECT IFNULL(SUM(stock), 0) c FROM products WHERE tenant_id = ? AND stock > 0", tenantId),
  };
}

// Does this tenant have rows in the selected scopes that already reached the cloud? Those must be
// removed from the cloud too, or the next pull would put them straight back.
function hasSyncedData(tenantId: number, scopes: ResetScope[]): boolean {
  const walkIn = findWalkInId(tenantId);
  const checks: { sql: string; params: any[] }[] = [];
  const add = (sql: string, ...params: any[]) => checks.push({ sql, params });
  if (scopes.includes("transactions")) {
    add("SELECT 1 FROM transactions WHERE tenant_id = ? AND last_synced_at IS NOT NULL", tenantId);
    add("SELECT 1 FROM cash_flow WHERE tenant_id = ? AND last_synced_at IS NOT NULL", tenantId);
    add("SELECT 1 FROM daily_reports WHERE tenant_id = ? AND last_synced_at IS NOT NULL", tenantId);
    add("SELECT 1 FROM cashier_shifts WHERE tenant_id = ? AND last_synced_at IS NOT NULL", tenantId);
    add("SELECT 1 FROM payments WHERE last_synced_at IS NOT NULL AND transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)", tenantId);
    add("SELECT 1 FROM transaction_items WHERE last_synced_at IS NOT NULL AND transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)", tenantId);
  }
  if (scopes.includes("products")) {
    add("SELECT 1 FROM products WHERE tenant_id = ? AND last_synced_at IS NOT NULL", tenantId);
    add("SELECT 1 FROM product_units WHERE tenant_id = ? AND last_synced_at IS NOT NULL", tenantId);
    add("SELECT 1 FROM product_barcodes WHERE last_synced_at IS NOT NULL AND product_id IN (SELECT id FROM products WHERE tenant_id = ?)", tenantId);
  }
  if (scopes.includes("parties")) {
    add("SELECT 1 FROM stakeholders WHERE tenant_id = ? AND id IS NOT ? AND last_synced_at IS NOT NULL", tenantId, walkIn);
  }
  return checks.some((c) => !!db.prepare(c.sql + " LIMIT 1").get(...c.params));
}

// The cloud session, but only if it belongs to THIS tenant (never purge another tenant's cloud).
function sessionFor(tenantId: number) {
  const s = getActiveSession();
  return s && s.globalId && s.localId === tenantId ? s : null;
}

function tsStamp(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

// Cloud copy of the selected scopes, children first, as the RLS-scoped tenant. Idempotent, so a
// retry after a partial failure is safe.
async function purgeCloudScopes(
  tenantId: number,
  scopes: ResetScope[],
  purgeCloudTransactionalData: () => Promise<void>,
  walkInGlobalId: string | null,
): Promise<void> {
  const session = sessionFor(tenantId);
  if (!session) return;
  const client = session.client;
  const tg = session.globalId;
  const isMissingTable = (e: any) => e && (e.code === "PGRST205" || e.code === "42P01" || e.status === 404 || e.statusCode === 404);

  if (scopes.includes("transactions")) {
    // payments, items, transactions, cash_flow, cashier_shifts (same routine End-of-Day uses)
    await purgeCloudTransactionalData();
    const { error: scErr } = await client.from("settlement_corrections").delete().eq("tenant_id", tg);
    if (scErr && !isMissingTable(scErr)) throw scErr;
    const { error } = await client.from("daily_reports").delete().eq("tenant_id", tg);
    if (error) throw error;
  }

  if (scopes.includes("products")) {
    // Fetch the product ids from the cloud (source of truth); delete children before parents.
    const { data: prodRows, error: pe } = await client.from("products").select("global_id").eq("tenant_id", tg);
    if (pe) throw pe;
    const productIds = (prodRows || []).map((r: any) => r.global_id).filter(Boolean);

    const { error: ue } = await client.from("product_units").delete().eq("tenant_id", tg);
    if (ue && !isMissingTable(ue)) throw ue;
    for (const ids of chunk(productIds, 100)) {
      const { error } = await client.from("product_barcodes").delete().in("product_id", ids);
      if (error) throw error;
    }
    const { error: de } = await client.from("products").delete().eq("tenant_id", tg);
    if (de) throw de;
  }

  if (scopes.includes("parties")) {
    let q = client.from("stakeholders").delete().eq("tenant_id", tg);
    if (walkInGlobalId) q = q.neq("global_id", walkInGlobalId);
    const { error } = await q;
    if (error) throw error;
  }
}

function localDelete(t: number, scopes: ResetScope[], walkInId: number | null) {
  if (scopes.includes("transactions")) {
    // children first, each via its own parent's tenant
    db.prepare("DELETE FROM payments WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)").run(t);
    db.prepare("DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)").run(t);
    db.prepare("DELETE FROM transactions WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM archived_payments WHERE transaction_id IN (SELECT id FROM archived_transactions WHERE tenant_id = ?)").run(t);
    db.prepare("DELETE FROM archived_transaction_items WHERE transaction_id IN (SELECT id FROM archived_transactions WHERE tenant_id = ?)").run(t);
    db.prepare("DELETE FROM archived_transactions WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM cash_flow WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM archived_cash_flow WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM settlement_corrections WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM daily_reports WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM yearly_reports WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM cashier_shifts WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM transaction_edits WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM cash_flow_edits WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM stock_adjustments WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM stakeholder_balance_log WHERE tenant_id = ?").run(t);
    // Balances derive from baseline + transactions; with no transactions left, zero both.
    db.prepare("UPDATE stakeholders SET balance = 0, balance_baseline = 0 WHERE tenant_id = ? AND (IFNULL(balance, 0) <> 0 OR IFNULL(balance_baseline, 0) <> 0)").run(t);
  }

  if (scopes.includes("stock")) {
    db.prepare("UPDATE products SET stock = 0 WHERE tenant_id = ? AND IFNULL(stock, 0) <> 0").run(t);
  }

  if (scopes.includes("products")) {
    db.prepare("DELETE FROM product_barcodes WHERE product_id IN (SELECT id FROM products WHERE tenant_id = ?)").run(t);
    db.prepare("DELETE FROM product_units WHERE tenant_id = ?").run(t);
    db.prepare("DELETE FROM products WHERE tenant_id = ?").run(t);
  }

  if (scopes.includes("parties")) {
    db.prepare("DELETE FROM stakeholders WHERE tenant_id = ? AND id IS NOT ?").run(t, walkInId);
  }
}

export function setupTenantResetRoutes(
  app: any,
  authenticate: any,
  broadcast: Function,
  deps: { purgeCloudTransactionalData: () => Promise<void> },
) {
  app.get("/api/tenant/reset/preview", authenticate, (req: any, res: any) => {
    const tenantId = req.session.tenantId;
    const all = [...RESET_SCOPES] as ResetScope[];
    res.json({
      ...previewCounts(tenantId),
      cloud: { connected: !!sessionFor(tenantId), hasSyncedData: hasSyncedData(tenantId, all) },
    });
  });

  let resetRunning = false;

  app.post("/api/tenant/reset", authenticate, async (req: any, res: any) => {
    const tenantId: number = req.session.tenantId;
    const body = req.body || {};
    try {
      // ---- validation (nothing has been touched yet) ----
      const raw = body.scopes;
      if (!Array.isArray(raw) || raw.length === 0 || raw.some((s: any) => !(RESET_SCOPES as readonly string[]).includes(s))) {
        throw new ValidationError("Choose at least one valid data scope to delete.", 400, { code: "RESET_SCOPE_INVALID", field: "scopes" });
      }
      const scopes = RESET_SCOPES.filter((s) => raw.includes(s)); // de-duped, canonical order
      if ((scopes.includes("products") || scopes.includes("parties")) && !scopes.includes("transactions")) {
        throw new ValidationError("Deleting products or customers/suppliers also requires deleting all transactions.", 400, { code: "RESET_SCOPE_DEPENDENCY", field: "scopes" });
      }
      if (body.confirm !== "DELETE") {
        throw new ValidationError("Type DELETE to confirm.", 400, { code: "RESET_CONFIRM_REQUIRED", field: "confirm" });
      }
      const admin = findAdminByPin(tenantId, body.admin_pin);
      if (!admin) {
        throw new ValidationError("Incorrect admin PIN.", 403, { code: "RESET_PIN_INVALID", field: "admin_pin" });
      }

      if (resetRunning) {
        throw new ValidationError("A reset is already running.", 409, { code: "RESET_IN_PROGRESS" });
      }
      resetRunning = true;
      try {
        // ---- stop the sync engine before anything else (waits for a cycle already in flight) ----
        await pauseSync();
        try {
          const needsCloud = hasSyncedData(tenantId, scopes);
          const session = sessionFor(tenantId);
          if (needsCloud && !session) {
            throw new ValidationError("Connect to the internet and log in, then retry. The cloud copy of this data must be deleted too.", 409, { code: "RESET_NEEDS_CLOUD" });
          }

          // ---- backup first ----
          const backupDir = path.join(dbDir, "backups");
          const backupPath = path.join(backupDir, `pos-before-reset-${tenantId}-${tsStamp()}.db`);
          try {
            fs.mkdirSync(backupDir, { recursive: true });
            await db.backup(backupPath);
          } catch (e: any) {
            console.error("[RESET] Backup failed:", e?.message || e);
            try { fs.rmSync(backupPath, { force: true }); } catch {}
            throw new ValidationError("Could not create the safety backup, so nothing was deleted.", 500, { code: "RESET_BACKUP_FAILED" });
          }

          const walkInId = findWalkInId(tenantId);
          const before = previewCounts(tenantId);

          // ---- cloud first ----
          if (session && needsCloud) {
            const walkIn = walkInId
              ? (db.prepare("SELECT global_id FROM stakeholders WHERE id = ? AND tenant_id = ?").get(walkInId, tenantId) as any)
              : null;
            try {
              await purgeCloudScopes(tenantId, scopes, deps.purgeCloudTransactionalData, walkIn?.global_id || null);
            } catch (e: any) {
              console.error("[RESET] Cloud purge failed:", e?.message || JSON.stringify(e));
              throw new ValidationError(
                "The cloud copy could not be deleted (it may be partially deleted). Nothing was deleted on this computer. Check your connection and retry; retrying is safe.",
                502,
                { code: "RESET_CLOUD_FAILED" },
              );
            }
          }

          // ---- then local, one atomic transaction ----
          db.transaction(() => localDelete(tenantId, scopes, walkInId))();

          logAction(tenantId, admin.id, "Tenant data reset", `Scopes: ${scopes.join(", ")}. Backup: ${path.basename(backupPath)}`);

          const deleted: Record<string, number> = {};
          if (scopes.includes("transactions")) deleted.transactions = before.transactions;
          if (scopes.includes("stock")) deleted.stock_units = before.stock_units;
          if (scopes.includes("products")) deleted.products = before.products;
          if (scopes.includes("parties")) deleted.parties = before.parties;

          broadcast({ type: "PRODUCTS_UPDATED" }, tenantId);
          broadcast({ type: "TRANSACTIONS_UPDATED" }, tenantId);
          broadcast({ type: "CASH_FLOW_UPDATED" }, tenantId);
          broadcast({ type: "STAKEHOLDERS_UPDATED" }, tenantId);
          broadcast({ type: "PURCHASES_UPDATED" }, tenantId);

          res.json({ success: true, backup: backupPath, deleted });
        } finally {
          resumeSync();
        }
      } finally {
        resetRunning = false;
      }
    } catch (err: any) {
      if (err instanceof ValidationError) return res.status(err.status).json(validationErrorBody(err));
      console.error("[RESET] failed:", err);
      res.status(500).json({ error: err?.message || "Reset failed", code: "RESET_FAILED" });
    }
  });
}
