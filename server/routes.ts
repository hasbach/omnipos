import { getLanAddresses } from "./discovery.js";
import { db, logAction } from "./db.js";
import { buildStatement } from "./statement.js";
import { recomputeStakeholderBalance, adjustStakeholderBaseline, stakeholderTxEffect, transactionBalanceEffect, writeBalanceLog } from "./balance.js";
import bcrypt from "bcryptjs";
import { anonSupabase } from "./supabase.js";
import { forceInitialSync } from "./sync.js";
import {
  setActiveSession,
  getActiveSession,
  rehydrateActiveSession,
  createAuthedClient,
  clearActiveSession,
} from "./session.js";
import { EscPos } from "./printing/escpos.js";
import { buildReceiptBuffer, buildTestPrintBuffer, buildArabicTestBuffer } from "./printing/receipt.js";
import { sendToPrinter } from "./printing/transport.js";
import { setupReportRoutes } from "./reports.js";
import { setupImportRoutes } from "./importer.js";
import { setupTenantResetRoutes } from "./tenantReset.js";
import { setupCashFlowRoutes } from "./cashFlow.js";
import { normalizeLevel, saleLineUnitPrice, lineTotal, computeTotals, uomUnitPrice, type PriceLevel } from "./pricing.js";
import {
  loadUnitsByProduct, loadUnitsForProduct, loadUnit, normalizeUnitsPayload, assertBarcodesFree, saveProductUnits,
  legacyPackageColumns, refundLineStates, displayFields,
} from "./uom.js";
import { applyPurchaseCost, reversePurchaseCost } from "./costing.js";
import { editTransaction, getTransactionEdits } from "./invoiceEdit.js";
import { resolveArchiveIdCollisions } from "./settlementIds.js";
import { ValidationError, validationErrorBody } from "./errors.js";
import { setSessionUser } from "./permissions.js";
import {
  computeRegisterSummary, parseRegisterScope, parseSettlementBody, beginSettlement, finishSettlement,
  listDailyReports, setupSettlementRoutes,
} from "./settlement.js";
import { isValidPaymentMethod, isRealMoney } from "./paymentMethods.js";

// The super-admin's app-wide identity string ('hasbach') isn't a valid email, so Supabase Auth
// can't use it directly — translate it to the real address backing that Auth user (kept in
// sync with src/MonitorApp.tsx's SUPER_ADMIN_AUTH_EMAIL).
const SUPER_ADMIN_LOGIN = 'hasbach';
const SUPER_ADMIN_AUTH_EMAIL = 'hsalloum60+superadmin@gmail.com';

// Resolve a user_id that is guaranteed to belong to this tenant. Transactions/cash_flow reference
// users, and the cloud users FK rejects a user_id from another tenant (e.g. the old hard-coded
// default of 1, which is a seed tenant's user that never syncs) — that would block the whole
// sync batch. Falls back to the tenant's admin/first user, or null if the tenant has none.
function tenantUserId(tenantId: number, requested: any): number | null {
  if (requested) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND tenant_id = ?").get(requested, tenantId) as any;
    if (u) return u.id;
  }
  const first = db.prepare("SELECT id FROM users WHERE tenant_id = ? ORDER BY (role = 'admin') DESC, id LIMIT 1").get(tenantId) as any;
  return first ? first.id : null;
}

// This is a local desktop app running on the store's own PC, so "today" for date-labeled records
// (a settlement report's `date`, a shift's `date`, the cashier-shifts history filter) must be the
// machine's LOCAL calendar day, not UTC — otherwise the business day flips at UTC midnight (3am in
// Lebanon/EEST) instead of local midnight. The live register itself (/api/cash-flow,
// /api/cash-flow/summary, /api/tenant/cashout) no longer uses this at all — see
// lastRegisterClose() below, which keeps it open across any number of days instead of resetting
// at midnight the way a `date = today` filter used to.
function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split('T')[0];
}

// The cash-flow register (its summary, its movements list, and Cash Out's reconciliation) must
// stay open across any number of calendar days until the owner explicitly closes it — a routine
// per-shift Cash Out or the rarer full End-of-Day Settlement, whichever happened most recently —
// instead of silently resetting at local midnight the way a `date = today` filter used to. This
// finds that boundary: the most recent close of either kind, and the cash counted at it (which
// becomes the next period's opening balance). No prior close ever ⇒ everything since the beginning.
// (Implementation lives in server/settlement.ts, together with the settlement detail logic; a
// counted-cash correction on the latest close makes the corrected count the opening balance.)

// End-of-Day settlement moves rows out of `transactions`/`transaction_items`/`payments` into
// `archived_transactions`/`archived_transaction_items`/`archived_payments` and deletes them from
// the live tables (see /api/tenant/settlement below). Every read path that lists or searches
// historical sales/invoices has to UNION both, or settled data silently disappears — these two
// column lists keep that UNION consistent across every query that needs it. `archived_transactions`
// has no `idempotency_key` column (that check only matters for still-live inserts), so the
// archived side selects NULL in its place to keep the column count/order aligned.
export const TX_LIVE_COLUMNS = "id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, idempotency_key, original_transaction_id, price_level, notes, reference, edited_at, edit_count, created_at";
export const TX_ARCHIVED_COLUMNS = "id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, NULL as idempotency_key, original_transaction_id, price_level, notes, reference, edited_at, edit_count, created_at";

// Same guard for stakeholder_id. The POS defaults the customer to id 1, which for any tenant
// other than the seed tenant is a FOREIGN tenant's Walk-in — pushing that trips the cloud
// stakeholders FK and blocks sync. Resolve to this tenant's Walk-in (or first customer), else null.
// Printer Arabic settings: a code page is an ESC t table number (0-255); blank = images.
function parseCodepage(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}
function parseArabicEncoding(v: any): 'cp864' | 'cp1256' {
  return v === 'cp1256' ? 'cp1256' : 'cp864';
}

function tenantStakeholderId(tenantId: number, requested: any): number | null {
  if (requested) {
    const s = db.prepare("SELECT id FROM stakeholders WHERE id = ? AND tenant_id = ?").get(requested, tenantId) as any;
    if (s) return s.id;
  }
  const walkIn = db.prepare(
    "SELECT id FROM stakeholders WHERE tenant_id = ? ORDER BY (name = 'Walk-in Customer') DESC, (type = 'customer') DESC, id LIMIT 1"
  ).get(tenantId) as any;
  return walkIn ? walkIn.id : null;
}

// A refund must reference the sale it's refunding, so its price and quantity can be checked
// against what was actually sold — otherwise a modified client could submit an arbitrary refund
// amount (see POST /api/transactions). The sale may already have been archived by an End-of-Day
// settlement by the time it's refunded, so this checks both tables.
function findOriginalSale(tenantId: number, originalTransactionId: number): { tx: any; items: any[] } | null {
  let tx = db.prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ?").get(originalTransactionId, tenantId) as any;
  let itemsTable = "transaction_items";
  if (!tx) {
    tx = db.prepare("SELECT * FROM archived_transactions WHERE id = ? AND tenant_id = ?").get(originalTransactionId, tenantId) as any;
    itemsTable = "archived_transaction_items";
  }
  if (!tx) return null;
  const items = db.prepare(
    `SELECT id, product_id, quantity, unit_price, discount_type, discount_value, unit_cost, uom_id, uom_name, uom_factor, uom_qty FROM ${itemsTable} WHERE transaction_id = ? ORDER BY id`
  ).all(originalTransactionId) as any[];
  return { tx, items };
}

// What fraction of an invoice's line subtotal was actually charged: total_amount (after the
// whole-invoice discount and tax) divided by the sum of its line totals (after per-line discounts).
// A refund of some lines pays back the same fraction — otherwise refunding one item from an invoice
// that had a 10% global discount would return more than the customer paid for it.
function chargedFactor(original: { tx: any; items: any[] }): number {
  const subtotal = original.items.reduce(
    (sum, oi) => sum + lineTotal(oi.unit_price, oi.quantity, { type: oi.discount_type, value: oi.discount_value }), 0);
  return subtotal > 0 ? (original.tx.total_amount || 0) / subtotal : 1;
}

// The original invoice's whole-invoice discount and tax expressed as the percentages they actually
// came to. A refund stores THESE as its own discount/tax, so (a) its total is exactly the charged
// fraction of the refunded lines (subtotal x (1-d) x (1+t) = chargedFactor x subtotal), and (b) every
// report that allocates an invoice's own discount to its lines treats refunds consistently too.
function originalAdjustmentPcts(original: { tx: any; items: any[] }): { discountPct: number; taxPct: number } {
  const subtotal = original.items.reduce(
    (sum, oi) => sum + lineTotal(oi.unit_price, oi.quantity, { type: oi.discount_type, value: oi.discount_value }), 0);
  if (subtotal <= 0) return { discountPct: 0, taxPct: 0 };
  const t = original.tx;
  const discAmt = !t.discount_value ? 0
    : t.discount_type === 'percentage' ? subtotal * (t.discount_value / 100) : Math.min(t.discount_value, subtotal);
  const afterDiscount = subtotal - discAmt;
  const taxAmt = (t.total_amount || 0) - afterDiscount;
  return {
    discountPct: (discAmt / subtotal) * 100,
    taxPct: afterDiscount > 0 ? (taxAmt / afterDiscount) * 100 : 0,
  };
}

function getSettingsMap(tenantId: number): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings WHERE tenant_id = ?").all(tenantId) as any[];
  const map = rows.reduce((acc: any, r: any) => { acc[r.key] = r.value; return acc; }, {} as Record<string, string>);

  // Every tenant already has a real business name (`tenants.name` is NOT NULL) — fall back to
  // it whenever the owner hasn't set a separate Store Name in Settings, instead of leaving
  // receipts/reports/the Settings page itself to show a hardcoded, unbranded placeholder.
  if (!map.store_name) {
    const tenant = db.prepare("SELECT name FROM tenants WHERE id = ?").get(tenantId) as any;
    if (tenant?.name) map.store_name = tenant.name;
  }

  return map;
}

// After an End-of-Day settlement clears the tenant's transactional data locally, the same rows
// must be removed from the cloud too. Otherwise the sync engine's next pull re-inserts them
// (the local pull cursor resets once the local rows are gone), and the "settled" sales reappear
// in history, daily sales and the Live Monitor. Runs as the logged-in tenant, so RLS scopes
// every delete to their own rows. No-ops (safely) when offline or for non-cloud accounts.
async function purgeCloudTransactionalData(): Promise<void> {
  const session = getActiveSession();
  if (!session || !session.globalId) return;
  const client = session.client;
  const tenantGlobalId = session.globalId;

  const chunk = <T,>(arr: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  // Use the cloud as the source of truth for what to remove, so children (which have no
  // ON DELETE CASCADE in the cloud schema) are always deleted before their transactions.
  const { data: txRows, error } = await client
    .from('transactions')
    .select('global_id')
    .eq('tenant_id', tenantGlobalId);
  if (error) throw error;

  const txIds = (txRows || []).map((r: any) => r.global_id).filter(Boolean);
  for (const ids of chunk(txIds, 100)) {
    const { error: pErr } = await client.from('payments').delete().in('transaction_id', ids);
    if (pErr) throw pErr;
    const { error: iErr } = await client.from('transaction_items').delete().in('transaction_id', ids);
    if (iErr) throw iErr;
  }

  const { error: tErr } = await client.from('transactions').delete().eq('tenant_id', tenantGlobalId);
  if (tErr) throw tErr;
  const { error: cErr } = await client.from('cash_flow').delete().eq('tenant_id', tenantGlobalId);
  if (cErr) throw cErr;
  const { error: sErr } = await client.from('cashier_shifts').delete().eq('tenant_id', tenantGlobalId);
  if (sErr) throw sErr;
}

// Delete ONE transaction (and its children) from the cloud. Needed when a synced transaction is
// deleted or edited (edit = delete + recreate) on the desktop: without this the local delete
// never reaches Supabase, so the next sync pull re-inserts the original transaction and its
// balance, silently undoing the change. The stakeholder balance itself rides back to the cloud
// through the normal push sync (the local balance UPDATE bumps updated_at). No-ops when offline.
async function purgeCloudTransaction(txGlobalId: string): Promise<void> {
  const session = getActiveSession();
  if (!session || !session.globalId || !txGlobalId) return;
  const client = session.client;
  const { error: pErr } = await client.from('payments').delete().eq('transaction_id', txGlobalId);
  if (pErr) throw pErr;
  const { error: iErr } = await client.from('transaction_items').delete().eq('transaction_id', txGlobalId);
  if (iErr) throw iErr;
  const { error: tErr } = await client.from('transactions').delete().eq('global_id', txGlobalId);
  if (tErr) throw tErr;
}

// Shared login routine used by both /api/auth/login and auto-login after registration.
// Tries real Supabase Auth first (so cloud sync + RLS work); falls back to the local bcrypt
// check when the cloud is unreachable (offline mode) so the local POS keeps working.
async function establishLogin(
  email: string,
  password: string,
  req: any
): Promise<{ ok: boolean; status: number; error: string | null; tenant: any }> {
  const loginEmail = String(email).trim().toLowerCase() === SUPER_ADMIN_LOGIN
    ? SUPER_ADMIN_AUTH_EMAIL
    : email;

  // 1. Attempt cloud auth.
  let cloudSession: { access_token: string; refresh_token: string } | null = null;
  let cloudUserId: string | null = null;
  try {
    const { data, error } = await anonSupabase.auth.signInWithPassword({ email: loginEmail, password });
    if (!error && data.session && data.user) {
      cloudSession = { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
      cloudUserId = data.user.id;
    }
  } catch {
    // network/offline — fall through to the local bcrypt fallback below
  }

  if (cloudSession && cloudUserId) {
    // Read the tenant's own row (RLS-scoped) to mirror it locally.
    const authed = await createAuthedClient(cloudSession);
    const { data: cloudTenant, error: tErr } = await authed
      .from('tenants')
      .select('*')
      .eq('global_id', cloudUserId)
      .single();
    if (tErr || !cloudTenant) {
      return { ok: false, status: 500, error: 'Signed in, but could not load your business profile.', tenant: null };
    }

    // Upsert into local SQLite (source of truth for the offline POS).
    const existing = db.prepare("SELECT id FROM tenants WHERE global_id = ? OR email = ?")
      .get(cloudTenant.global_id, cloudTenant.email) as any;
    let localId: number;
    if (existing) {
      db.prepare(`UPDATE tenants SET global_id = ?, name = ?, email = ?, password = ?, local_license_type = ?, local_license_expiry = ?, online_license_type = ?, online_license_expiry = ?, current_version = COALESCE(?, current_version), available_version = COALESCE(?, available_version), scheduled_update_at = ? WHERE id = ?`)
        .run(cloudTenant.global_id, cloudTenant.name, cloudTenant.email, cloudTenant.password, cloudTenant.local_license_type, cloudTenant.local_license_expiry, cloudTenant.online_license_type, cloudTenant.online_license_expiry, cloudTenant.current_version, cloudTenant.available_version, cloudTenant.scheduled_update_at, existing.id);
      localId = existing.id;
    } else {
      const insert = db.prepare(`INSERT INTO tenants (global_id, name, email, password, local_license_type, local_license_expiry, online_license_type, online_license_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(cloudTenant.global_id, cloudTenant.name, cloudTenant.email, cloudTenant.password, cloudTenant.local_license_type, cloudTenant.local_license_expiry, cloudTenant.online_license_type, cloudTenant.online_license_expiry);
      localId = Number(insert.lastInsertRowid);
    }

    const isSuperAdmin = cloudTenant.email === SUPER_ADMIN_AUTH_EMAIL || cloudTenant.email === SUPER_ADMIN_LOGIN;
    const isSeed = ['demo@example.com', 'admin@example.com'].includes(cloudTenant.email);

    // Seed the minimum a POS needs (Walk-in customer, Admin user, default currency, store name)
    // the first time a real business appears on this machine — registration now happens in the
    // cloud (edge function) and no longer seeds these locally. Seeding store_name from the
    // tenant's own registered name means receipts print the real business from day one instead
    // of a hardcoded placeholder (getSettingsMap falls back the same way for any tenant that
    // already existed before this seed was added).
    if (!isSuperAdmin && !isSeed) {
      const userCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE tenant_id = ?").get(localId) as any;
      if (userCount.c === 0) {
        db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, ?, ?)").run(localId, "Walk-in Customer", "customer");
        db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, ?, ?)").run(localId, "Admin", "admin");
        db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, ?, ?, ?, ?)").run(localId, "USD", "$", 1, 1);
        db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'store_name', ?)").run(localId, cloudTenant.name);
      }
    }

    // Register the authenticated session so sync + admin endpoints can act as this tenant.
    await setActiveSession(localId, cloudTenant.global_id, cloudTenant.email, cloudSession);
    req.session.tenantId = localId;
    delete req.session.locked; // a fresh business sign-in starts unlocked (the POS lock screen follows)
    req.session.tenantName = cloudTenant.name;
    req.session.sbRefresh = cloudSession.refresh_token;
    req.session.sbGlobalId = cloudTenant.global_id;
    req.session.sbEmail = cloudTenant.email;

    // Pull this tenant's cloud data down (no-op for super-admin/seed accounts).
    try { await forceInitialSync(); } catch (e) { console.error('Initial sync error:', e); }

    const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(localId) as any;
    return { ok: true, status: 200, error: null, tenant };
  }

  // 2. Offline fallback: local bcrypt check (only works for a tenant already mirrored locally).
  const localTenant = db.prepare("SELECT * FROM tenants WHERE email = ?").get(email) as any;
  if (localTenant && await bcrypt.compare(password, localTenant.password)) {
    req.session.tenantId = localTenant.id;
    delete req.session.locked;
    req.session.tenantName = localTenant.name;
    return { ok: true, status: 200, error: null, tenant: localTenant };
  }

  return { ok: false, status: 401, error: 'Invalid email or password', tenant: null };
}

export function setupRoutes(app: any, wss: any, broadcast: Function, authenticate: any) {
  setupReportRoutes(app, authenticate);
  setupImportRoutes(app, authenticate, broadcast);
  setupTenantResetRoutes(app, authenticate, broadcast, { purgeCloudTransactionalData });
  setupSettlementRoutes(app, authenticate, broadcast);
  setupCashFlowRoutes(app, authenticate, broadcast);
  // API Routes
  // Auth Routes
  app.post("/api/auth/register", async (req, res) => {
    const { name, email, password } = req.body;
    try {
      // Account creation needs the service-role key, which must never ship in this app — so it
      // runs in the trusted `register-tenant` Supabase Edge Function. We call it with the public
      // anon key; the function creates the Auth user + cloud tenant row (license inactive).
      const { data: fnData, error: fnError } = await anonSupabase.functions.invoke('register-tenant', {
        body: { name, email, password },
      });

      if (fnError) {
        let msg = 'Registration failed. Please try again.';
        try {
          const ctx = (fnError as any).context;
          if (ctx && typeof ctx.json === 'function') {
            const j = await ctx.json();
            if (j?.error) msg = j.error;
          }
        } catch { /* keep default message */ }
        return res.status(400).json({ error: msg });
      }
      if (!fnData || !fnData.success) {
        return res.status(400).json({ error: fnData?.error || 'Registration failed. Please try again.' });
      }

      // Account exists in the cloud now — log in to establish the session and seed local data.
      const result = await establishLogin(email, password, req);
      if (!result.ok) {
        return res.status(200).json({ success: true, needsLogin: true, name });
      }
      res.json({ success: true, tenantId: result.tenant.id, name: result.tenant.name });
    } catch (error: any) {
      console.error("Register Error:", error);
      res.status(400).json({ error: error.message || "Registration failed" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    try {
      const result = await establishLogin(email, password, req);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      const tenant = result.tenant;
      res.json({
        success: true,
        tenantId: tenant.id,
        name: tenant.name,
        email: tenant.email,
        local_license_type: tenant.local_license_type,
        local_license_expiry: tenant.local_license_expiry,
        online_license_type: tenant.online_license_type,
        online_license_expiry: tenant.online_license_expiry,
        current_version: tenant.current_version,
        available_version: tenant.available_version,
        scheduled_update_at: tenant.scheduled_update_at
      });
    } catch (err) {
      console.error("Login Error:", err);
      res.status(500).json({ error: "Internal server error during login" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    clearActiveSession();
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  // The addresses other registers / a browser on the same network use to reach THIS host (shown on the
  // Live Monitor page so the owner can always find the link again). Loopback/virtual-only machines
  // return an empty list.
  app.get("/api/system/network-info", authenticate, (req: any, res) => {
    const port = Number(process.env.PORT) || 3000;
    res.json({ port, addresses: getLanAddresses().map((ip) => ({ ip, url: `http://${ip}:${port}` })) });
  });

  app.get("/api/auth/me", async (req: any, res) => {
    if (!req.session.tenantId) {
      return res.status(401).json({ error: "Not logged in" });
    }
    const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
    if (!tenant) {
      return res.status(401).json({ error: "Not logged in" });
    }

    // After an app restart the Express cookie still says "logged in", but the in-memory cloud
    // session is gone. Rehydrate it from the stored refresh token so sync + admin keep working.
    if (!getActiveSession() && req.session.sbRefresh && req.session.sbGlobalId) {
      const ok = await rehydrateActiveSession(
        req.session.tenantId,
        req.session.sbGlobalId,
        req.session.sbEmail || tenant.email,
        req.session.sbRefresh
      );
      if (ok) {
        const s = getActiveSession();
        if (s) req.session.sbRefresh = s.refreshToken;
        forceInitialSync().catch(() => {});
      }
    }

    res.json({
      tenantId: req.session.tenantId,
      name: req.session.tenantName,
      email: tenant.email,
      local_license_type: tenant.local_license_type,
      local_license_expiry: tenant.local_license_expiry,
      online_license_type: tenant.online_license_type,
      online_license_expiry: tenant.online_license_expiry,
      current_version: tenant.current_version,
      available_version: tenant.available_version,
      scheduled_update_at: tenant.scheduled_update_at
    });
  });

  // Super-admin: list ALL tenants from the cloud (not just those mirrored locally), scoped by
  // the "Super admin read all tenants" RLS policy under the active hasbach session.
  app.get("/api/admin/tenants", authenticate, async (req: any, res) => {
    const currentTenant = db.prepare("SELECT email FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
    if (!currentTenant || currentTenant.email !== 'hasbach') {
      return res.status(403).json({ error: "Forbidden" });
    }
    const session = getActiveSession();
    if (!session) {
      return res.status(503).json({ error: "Cloud session unavailable. Please log out and log back in." });
    }
    const { data, error } = await session.client
      .from('tenants')
      .select('global_id, name, email, local_license_type, local_license_expiry, online_license_type, online_license_expiry, created_at')
      .order('created_at', { ascending: false });
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    res.json(data);
  });

  // Verify User PIN
  app.post("/api/auth/verify-pin", authenticate, (req: any, res) => {
    const { userId, pin } = req.body;
    const tenantId = req.session.tenantId;

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND tenant_id = ?").get(userId, tenantId) as any;
    
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Default pin is '0000'. Optional support backdoor — only active if explicitly configured;
    // no hardcoded fallback, so a fresh install has no bypass PIN at all.
    const superAdminPin = process.env.SUPER_ADMIN_PIN;
    if (user.pin !== pin && (!superAdminPin || pin !== superAdminPin)) {
      return res.status(401).json({ error: "Invalid PIN" });
    }

    // Remember who is at the till: server/permissions.ts restricts the session by this user's role.
    setSessionUser(req, { id: user.id, name: user.name, role: user.role });
    res.json({ success: true, user: { id: user.id, name: user.name, role: user.role } });
  });

  // Super-admin: update any tenant's license in the cloud, keyed by the tenant's global_id.
  // Goes through the admin_update_tenant_license RPC under the active hasbach session (which
  // re-checks super-admin server-side and only ever touches the four license columns).
  app.post("/api/admin/tenants/:id/license", authenticate, async (req: any, res) => {
    const currentTenant = db.prepare("SELECT email FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
    if (!currentTenant || currentTenant.email !== 'hasbach') {
      return res.status(403).json({ error: "Forbidden" });
    }
    const session = getActiveSession();
    if (!session) {
      return res.status(503).json({ error: "Cloud session unavailable. Please log out and log back in." });
    }
    const { id } = req.params; // tenant global_id (UUID)
    const { local_license_type, local_license_expiry, online_license_type, online_license_expiry } = req.body;

    const { error } = await session.client.rpc('admin_update_tenant_license', {
      p_tenant_id: id,
      p_local_license_type: local_license_type,
      p_local_license_expiry: local_license_expiry || null,
      p_online_license_type: online_license_type,
      p_online_license_expiry: online_license_expiry || null,
    });
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Mirror into the local row too, if this tenant happens to exist locally.
    try {
      db.prepare(`UPDATE tenants SET local_license_type = ?, local_license_expiry = ?, online_license_type = ?, online_license_expiry = ?, updated_at = CURRENT_TIMESTAMP WHERE global_id = ?`)
        .run(local_license_type, local_license_expiry || null, online_license_type, online_license_expiry || null, id);
    } catch { /* local mirror is best-effort */ }

    res.json({ success: true });
  });

  app.post("/api/admin/tenants/trigger-update", authenticate, (req, res) => {
    const currentTenant = db.prepare("SELECT email FROM tenants WHERE id = ?").get(req.session.tenantId) as any;
    if (currentTenant.email !== 'hasbach') {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { version } = req.body;

    db.prepare("UPDATE tenants SET available_version = ?").run(version);

    // Broadcast update available to all connected clients
    wss.clients.forEach((client: any) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'UPDATE_AVAILABLE', version }));
      }
    });

    res.json({ success: true });
  });

  app.post("/api/tenant/schedule-update", authenticate, (req, res) => {
    const tenantId = req.session.tenantId;
    const { scheduled_at } = req.body;

    db.prepare("UPDATE tenants SET scheduled_update_at = ? WHERE id = ?").run(scheduled_at, tenantId);
    res.json({ success: true });
  });

  app.post("/api/tenant/install-update", authenticate, (req, res) => {
    const tenantId = req.session.tenantId;
    const tenant = db.prepare("SELECT available_version FROM tenants WHERE id = ?").get(tenantId) as any;

    db.prepare("UPDATE tenants SET current_version = ?, available_version = ?, scheduled_update_at = NULL WHERE id = ?")
      .run(tenant.available_version, tenant.available_version, tenantId);

    res.json({ success: true });
  });

  app.post("/api/tenant/settlement", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;

    // New flow: body { user_id, counted: [{currency, amount, rate}], notes } — the report, its
    // snapshot and the archive links are all written inside the one transaction below
    // (server/settlement.ts). No `counted` = legacy client (report posted first): still links.
    let settlementInput: ReturnType<typeof parseSettlementBody>;
    try {
      settlementInput = parseSettlementBody(tenantId, req.body);
    } catch (err: any) {
      if (err instanceof ValidationError) return res.status(err.status).json(validationErrorBody(err));
      return res.status(500).json({ error: err.message });
    }
    const settlementUserId = tenantUserId(tenantId, req.body?.user_id);
    let settlementReportId: number | null = null;

    const settleData = db.transaction(() => {
      // Before archiving, renumber any of THIS tenant's live rows whose id is already taken in the
      // archive (only possible after a past sequence reset) — see server/settlementIds.ts.
      resolveArchiveIdCollisions(tenantId);

      // Snapshot the live breakdown + write/complete the daily report BEFORE any row is moved.
      const settlementCtx = beginSettlement(tenantId, settlementUserId, localToday(), settlementInput);
      settlementReportId = settlementCtx.reportId;

      // Move payments
      db.prepare(`
      INSERT INTO archived_payments (id, transaction_id, amount, method, currency, exchange_rate, created_at)
      SELECT id, transaction_id, amount, method, currency, exchange_rate, created_at 
      FROM payments WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)
    `).run(tenantId);

      // Move transaction items
      db.prepare(`
      INSERT INTO archived_transaction_items (id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value, unit_cost, uom_id, uom_name, uom_factor, uom_qty, original_item_id)
      SELECT id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value, unit_cost, uom_id, uom_name, uom_factor, uom_qty, original_item_id
      FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)
    `).run(tenantId);

      // Move transactions
      db.prepare(`
      INSERT INTO archived_transactions (id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, original_transaction_id, price_level, notes, reference, edited_at, edit_count, created_at)
      SELECT id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, original_transaction_id, price_level, notes, reference, edited_at, edit_count, created_at
      FROM transactions WHERE tenant_id = ?
    `).run(tenantId);

      // CRITICAL: balance is derived from ACTIVE transactions + baseline. These transactions are
      // about to be archived and removed from the active table, so BANK each stakeholder's current
      // active-transaction effect into their baseline first — otherwise their carried-over debt
      // would vanish at settlement (this is exactly what wiped balances before).
      const affected = db.prepare("SELECT DISTINCT stakeholder_id FROM transactions WHERE tenant_id = ? AND stakeholder_id IS NOT NULL").all(tenantId) as any[];
      for (const row of affected) {
        const eff = stakeholderTxEffect(row.stakeholder_id, tenantId);
        if (Math.abs(eff) > 0.0000001) {
          db.prepare("UPDATE stakeholders SET balance_baseline = IFNULL(balance_baseline, 0) + ? WHERE id = ? AND tenant_id = ?").run(eff, row.stakeholder_id, tenantId);
        }
      }

      // Delete records from active tables
      db.prepare("DELETE FROM payments WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)").run(tenantId);
      db.prepare("DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ?)").run(tenantId);
      db.prepare("DELETE FROM transactions WHERE tenant_id = ?").run(tenantId);

      // Archive manual cash movements before clearing them, same as transactions above — settlement
      // used to just delete these with no trace anywhere, which meant every itemized cash-in/out
      // and its reason was permanently unrecoverable after every settlement.
      db.prepare(`
        INSERT INTO archived_cash_flow (id, tenant_id, user_id, type, amount, currency, exchange_rate, reason, created_at, category, counterparty)
        SELECT id, tenant_id, user_id, type, amount, currency, exchange_rate, reason, created_at, category, counterparty
        FROM cash_flow WHERE tenant_id = ?
      `).run(tenantId);

      // Clear manual cash movements so everything resets to zero
      db.prepare("DELETE FROM cash_flow WHERE tenant_id = ?").run(tenantId);

      // NOTE: daily_reports are intentionally KEPT — they are the Settlement History shown on
      // the Settlement page. The just-created report (dated today) is excluded from the opening
      // balance by /api/cash-flow/summary, so today still zeroes out while the record persists.

      // Point every archived row this settlement moved back at its daily report.
      finishSettlement(tenantId, settlementCtx);

      // Clear cashier shifts as the day is closed
      db.prepare("DELETE FROM cashier_shifts WHERE tenant_id = ?").run(tenantId);
    });

    try {
      // Clear the cloud FIRST, then do the local reset. The local reset runs synchronously with
      // no await after it, so no concurrent sync-pull can slip in between and re-insert the rows
      // we just removed. If the cloud purge fails (e.g. offline) we still settle locally and warn
      // the operator — the settled sales may resync once the connection returns.
      let cloudPurged = true;
      try {
        await purgeCloudTransactionalData();
      } catch (cloudErr: any) {
        cloudPurged = false;
        console.error('❌ [SETTLEMENT] Cloud purge failed:', cloudErr?.message || cloudErr);
      }

      settleData();

      logAction(
        tenantId,
        settlementUserId,
        'End of Day Settlement',
        cloudPurged
          ? 'Archived transactions and reset counters (local + cloud)'
          : 'Local reset done, but CLOUD purge failed — sales may resync. Check connection.'
      );
      broadcast({ type: 'TRANSACTIONS_UPDATED' }, tenantId);
      broadcast({ type: 'CASH_FLOW_UPDATED' }, tenantId);

      if (!cloudPurged) {
        return res.status(207).json({
          success: true,
          report_id: settlementReportId,
          cloudPurged: false,
          warning: 'Local settlement complete, but the cloud copy could not be cleared. Reconnect and settle again, or the settled sales may reappear.'
        });
      }
      res.json({ success: true, report_id: settlementReportId, cloudPurged: true });
    } catch (err: any) {
      if (err instanceof ValidationError) return res.status(err.status).json(validationErrorBody(err));
      res.status(500).json({ error: err.message });
    }
  });

  // Cashier Cash Out: records a shift snapshot, does NOT delete or reset anything
  app.post("/api/tenant/cashout", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = tenantUserId(tenantId, req.body.user_id);
    const { notes } = req.body;
    const actual_cash = Number(req.body.actual_cash) || 0;

    try {
      const today = localToday(); // calendar-day label stamped on the shift row, not a query filter

      // Reconcile the WHOLE drawer since the last close (Cash Out or Settlement) — the same figure
      // the Cash Out screen shows. The drawer is shared, so counting it against only this cashier's
      // own sales made one shift look over and the next look short by the other users' movements
      // (and any sales made before someone else's Cash Out dropped out of the later shift entirely).
      // The opening balance is the server's own (the last counted close), never the client's.
      const reg = computeRegisterSummary(tenantId, 'shift');
      const sales = reg.totalSales;
      const refunds = reg.totalRefunds;
      const purchases = reg.totalPurchases;
      const cashIn = reg.totalIn;
      const cashOut = reg.totalOut;
      const openBal = reg.openingBalance;
      const expectedCash = reg.expectedBalance;
      const difference = actual_cash - expectedCash;

      db.prepare(`
        INSERT INTO cashier_shifts 
        (tenant_id, user_id, date, opening_balance, cash_sales, cash_refunds, cash_purchases, cash_in, cash_out, expected_cash, actual_cash, difference, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tenantId, userId, today, openBal, sales, refunds, purchases, cashIn, cashOut, expectedCash, actual_cash, difference, notes || '');

      logAction(tenantId, userId, 'Cashier Cash Out', `Expected: ${expectedCash.toFixed(2)}, Actual: ${actual_cash.toFixed(2)}, Diff: ${difference.toFixed(2)}`);
      res.json({ 
        success: true, 
        shift: { 
          date: today, user_id: userId, opening_balance: openBal,
          cash_sales: sales, cash_refunds: refunds, cash_purchases: purchases,
          cash_in: cashIn, cash_out: cashOut,
          expected_cash: expectedCash, actual_cash, difference, notes 
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The cashier shifts of the open business day. Settlement clears cashier_shifts, so every live row
  // belongs to the current day — filtering by calendar date hid a shift closed after midnight (or the
  // one before it) from the day it belongs to. ?date= still filters to one calendar day.
  app.get("/api/tenant/cashier-shifts", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const date = req.query.date;
    const shifts = db.prepare(`
      SELECT cs.*, u.name as user_name 
      FROM cashier_shifts cs 
      LEFT JOIN users u ON cs.user_id = u.id 
      WHERE cs.tenant_id = ? ${date ? "AND cs.date = ?" : ""}
      ORDER BY cs.created_at ASC, cs.id ASC
    `).all(...(date ? [tenantId, date] : [tenantId]));
    res.json(shifts);
  });

  // Every product with its barcodes and units of measure. Extra barcodes and units are each loaded in
  // ONE query and grouped in memory (no per-product queries).
  function loadProductsWithBarcodesAndUnits(tenantId: number): any[] {
    const products = db.prepare("SELECT * FROM products WHERE tenant_id = ?").all(tenantId) as any[];
    const extraRows = db.prepare(
      "SELECT pb.product_id, pb.barcode FROM product_barcodes pb JOIN products p ON p.id = pb.product_id WHERE p.tenant_id = ? ORDER BY pb.id"
    ).all(tenantId) as any[];
    const extraByProduct = new Map<number, string[]>();
    for (const r of extraRows) {
      const list = extraByProduct.get(r.product_id);
      if (list) list.push(r.barcode); else extraByProduct.set(r.product_id, [r.barcode]);
    }
    const unitsByProduct = loadUnitsByProduct(tenantId);
    return products.map(p => ({
      ...p,
      barcodes: [p.barcode, ...(extraByProduct.get(p.id) || [])].filter(Boolean),
      units: unitsByProduct.get(p.id) || [],
    }));
  }

  app.get("/api/products/export", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    res.json(loadProductsWithBarcodesAndUnits(tenantId));
  });

  app.post("/api/products/bulk-import", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const products = req.body; // Array of products

    if (!Array.isArray(products)) {
      return res.status(400).json({ error: "Invalid data format. Expected an array." });
    }

    const insertProduct = db.prepare(`
    INSERT INTO products (
      tenant_id, barcode, name, price, package_price, units_per_package, stock, reorder_point, track_inventory, category, currency, unit,
      price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, min_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

    const insertBarcode = db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)");

    const transaction = db.transaction((prods) => {
      for (const p of prods) {
        const barcodes = p.barcodes || [p.barcode].filter(Boolean);
        const primaryBarcode = barcodes.length > 0 ? barcodes[0] : null;

        const result = insertProduct.run(
          tenantId,
          primaryBarcode,
          p.name,
          p.price || 0,
          p.package_price || null,
          p.units_per_package || 1,
          p.stock || 0,
          p.reorder_point || 0,
          p.track_inventory === 0 ? 0 : 1,
          p.category || 'General',
          p.currency || 'USD',
          p.unit || 'pcs',
          p.price_wholesale || null,
          p.price_wholesale_lbp || null,
          p.price_super_wholesale || null,
          p.price_super_wholesale_lbp || null,
          p.min_price || null
        );

        const productId = result.lastInsertRowid;

        if (barcodes.length > 1) {
          for (let i = 1; i < barcodes.length; i++) {
            try {
              insertBarcode.run(productId, barcodes[i]);
            } catch (e) {
              // Skip duplicate barcodes for bulk import
            }
          }
        }
      }
    });

    try {
      transaction(products);
      logAction(tenantId, 1, 'Bulk Import', `Imported ${products.length} products`);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      res.json({ success: true, count: products.length });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/products", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    res.json(loadProductsWithBarcodesAndUnits(tenantId));
  });

  // Shared by POST and PUT: validates the product's barcodes + units (BARCODE_TAKEN is tenant-wide
  // across products.barcode, product_barcodes and product_units), saves them, and mirrors the
  // smallest unit into the legacy package_* columns for older devices/the cloud. Runs INSIDE the
  // caller's db.transaction so a failure changes nothing.
  function saveProductBarcodesAndUnits(tenantId: number, productId: number, isNew: boolean, barcodes: any, unitsPayload: any) {
    const ownBarcodes: string[] = Array.isArray(barcodes) ? barcodes.map((b: any) => String(b ?? '').trim()).filter(Boolean) : [];
    const units = unitsPayload === undefined || unitsPayload === null ? null : normalizeUnitsPayload(unitsPayload);
    assertBarcodesFree(tenantId, isNew ? null : productId, ownBarcodes, units || []);

    db.prepare("UPDATE products SET barcode = ? WHERE id = ? AND tenant_id = ?").run(ownBarcodes[0] ?? null, productId, tenantId);
    db.prepare("DELETE FROM product_barcodes WHERE product_id = ?").run(productId);
    const insertBarcode = db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)");
    for (let i = 1; i < ownBarcodes.length; i++) insertBarcode.run(productId, ownBarcodes[i]);

    if (units) {
      const saved = saveProductUnits(tenantId, productId, units);
      const legacy = legacyPackageColumns(saved);
      db.prepare("UPDATE products SET package_price = ?, package_price_lbp = ?, units_per_package = ? WHERE id = ? AND tenant_id = ?")
        .run(legacy.package_price, legacy.package_price_lbp, legacy.units_per_package, productId, tenantId);
    }
  }

  app.post("/api/products", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { name, price, price_lbp, package_price, package_price_lbp, cost, cost_lbp, units_per_package, stock, reorder_point, track_inventory, category, currency, unit, barcodes, units, price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, min_price, active } = req.body;

    try {
      const productId = db.transaction(() => {
        const result = db.prepare("INSERT INTO products (tenant_id, barcode, name, price, price_lbp, package_price, package_price_lbp, cost, cost_lbp, units_per_package, stock, reorder_point, track_inventory, category, currency, unit, price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, min_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(tenantId, null, name, price, price_lbp || null, package_price || null, package_price_lbp || null, cost || null, cost_lbp || null, units_per_package || 1, stock, reorder_point || 0, track_inventory === 0 ? 0 : 1, category, currency, unit, price_wholesale || null, price_wholesale_lbp || null, price_super_wholesale || null, price_super_wholesale_lbp || null, min_price || null);
        const newId = Number(result.lastInsertRowid);
        if (active !== undefined && active !== null) db.prepare("UPDATE products SET active = ? WHERE id = ? AND tenant_id = ?").run(active === 0 || active === false || active === '0' ? 0 : 1, newId, tenantId);
        saveProductBarcodesAndUnits(tenantId, newId, true, barcodes, units);
        return newId;
      })();

      logAction(tenantId, 1, 'Product Created', `Name: ${name}, Price: ${price}, Stock: ${stock}`);
      res.json({ id: productId });
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
    } catch (error: any) {
      if (error instanceof ValidationError) return res.status(error.status).json(validationErrorBody(error));
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/products/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;
    const { name, price, price_lbp, package_price, package_price_lbp, cost, cost_lbp, units_per_package, stock, reorder_point, track_inventory, category, currency, unit, barcodes, units, price_wholesale, price_wholesale_lbp, price_super_wholesale, price_super_wholesale_lbp, min_price, active } = req.body;

    try {
      db.transaction(() => {
        // `stock` is optional: the product editor no longer sends it (stock changes go through audited
        // POST /api/stock/adjust), because a form holding a stale stock value would otherwise silently
        // undo every sale made while it was open. COALESCE keeps the current value when it's omitted.
        // Absent `units` leaves the product's units untouched.
        const info = db.prepare("UPDATE products SET name = ?, price = ?, price_lbp = ?, package_price = ?, package_price_lbp = ?, cost = ?, cost_lbp = ?, units_per_package = ?, stock = COALESCE(?, stock), reorder_point = ?, track_inventory = ?, category = ?, currency = ?, unit = ?, price_wholesale = ?, price_wholesale_lbp = ?, price_super_wholesale = ?, price_super_wholesale_lbp = ?, min_price = ? WHERE id = ? AND tenant_id = ?")
          .run(name, price, price_lbp || null, package_price || null, package_price_lbp || null, cost || null, cost_lbp || null, units_per_package || 1, (stock === undefined || stock === null || stock === '') ? null : Number(stock), reorder_point || 0, track_inventory === 0 ? 0 : 1, category, currency, unit, price_wholesale || null, price_wholesale_lbp || null, price_super_wholesale || null, price_super_wholesale_lbp || null, min_price || null, id, tenantId);
        // Same tolerance as before for an unknown id (a no-op update), but never touch barcodes/units
        // of a product that isn't this tenant's.
        if (info.changes > 0) saveProductBarcodesAndUnits(tenantId, Number(id), false, barcodes, units);
        // `active` is optional: absent leaves the product's enabled/disabled state unchanged.
        if (info.changes > 0 && active !== undefined && active !== null) {
          db.prepare("UPDATE products SET active = ? WHERE id = ? AND tenant_id = ?").run(active === 0 || active === false || active === '0' ? 0 : 1, id, tenantId);
        }
      })();

      logAction(tenantId, 1, 'Product Updated', `ID: ${id}, Name: ${name}, Price: ${price}, Stock: ${stock}`);
      res.json({ success: true });
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
    } catch (error: any) {
      if (error instanceof ValidationError) return res.status(error.status).json(validationErrorBody(error));
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/products/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    // Units are soft-deleted (so the deletion syncs); barcodes and the product row are removed as before.
    db.prepare("UPDATE product_units SET deleted_at = CURRENT_TIMESTAMP WHERE product_id IN (SELECT id FROM products WHERE id = ? AND tenant_id = ?) AND deleted_at IS NULL").run(req.params.id, tenantId);
    db.prepare("DELETE FROM product_barcodes WHERE product_id IN (SELECT id FROM products WHERE id = ? AND tenant_id = ?)").run(req.params.id, tenantId);
    db.prepare("DELETE FROM products WHERE id = ? AND tenant_id = ?").run(req.params.id, tenantId);
    logAction(tenantId, 1, 'Product Deleted', `ID: ${req.params.id}`);
    res.json({ success: true });
    broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
  });

  // Bulk-updates one price tier's USD value across a set of products (by explicit ids, by
  // category, or the whole catalog when neither is given). Only ever touches the USD column —
  // the *_lbp twin is left for the owner to adjust separately (LBP tends to move with the
  // exchange rate, not with a markup policy).
  app.post("/api/products/bulk-price", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { product_ids, category, tier, mode, value, round_to } = req.body;

    if (!['retail', 'wholesale', 'super_wholesale'].includes(tier)) {
      return res.status(400).json({ error: "Invalid tier." });
    }
    if (!['percent_change', 'markup_on_cost', 'set'].includes(mode)) {
      return res.status(400).json({ error: "Invalid mode." });
    }
    if (!Number.isFinite(value)) {
      return res.status(400).json({ error: "Invalid value." });
    }

    const column = tier === 'retail' ? 'price' : tier === 'wholesale' ? 'price_wholesale' : 'price_super_wholesale';

    let query = "SELECT id, price, price_wholesale, price_super_wholesale, cost FROM products WHERE tenant_id = ?";
    const params: any[] = [tenantId];
    if (Array.isArray(product_ids) && product_ids.length) {
      query += ` AND id IN (${product_ids.map(() => '?').join(',')})`;
      params.push(...product_ids);
    } else if (category) {
      query += " AND category = ?";
      params.push(category);
    }

    const products = db.prepare(query).all(...params) as any[];
    const update = db.prepare(`UPDATE products SET ${column} = ? WHERE id = ? AND tenant_id = ?`);
    const round = (n: number) => (round_to && round_to > 0) ? Math.round(n / round_to) * round_to : n;

    let updated = 0;
    const txn = db.transaction(() => {
      for (const p of products) {
        // markup_on_cost needs a real cost basis to work from — skip products without one.
        if (mode === 'markup_on_cost' && !(p.cost && p.cost > 0)) continue;

        let newPrice: number;
        if (mode === 'set') {
          newPrice = value;
        } else if (mode === 'markup_on_cost') {
          newPrice = p.cost * (1 + value / 100);
        } else {
          // percent_change adjusts the tier's OWN current value — falling back to retail when a
          // wholesale/super-wholesale tier isn't configured yet on this product.
          const base = tier === 'retail' ? p.price : ((p as any)[column] || p.price);
          newPrice = base * (1 + value / 100);
        }
        newPrice = round(Math.max(0, newPrice));
        update.run(newPrice, p.id, tenantId);
        updated++;
      }
    });

    try {
      txn();
      logAction(tenantId, 1, 'Bulk Price Update', `Tier: ${tier}, Mode: ${mode}, Value: ${value}, Updated: ${updated}`);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      res.json({ updated });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/products/:query", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const query = req.params.query;

    let product = db.prepare("SELECT * FROM products WHERE barcode = ? AND tenant_id = ?").get(query, tenantId) as any;

    if (!product) {
      const extra = db.prepare("SELECT pb.product_id FROM product_barcodes pb JOIN products p ON pb.product_id = p.id WHERE pb.barcode = ? AND p.tenant_id = ?").get(query, tenantId) as any;
      if (extra) {
        product = db.prepare("SELECT * FROM products WHERE id = ?").get(extra.product_id);
      }
    }

    // A carton/pack barcode resolves to its product AND the unit that was scanned.
    let matchedUomId: number | null = null;
    if (!product) {
      const unitHit = db.prepare(
        "SELECT pu.id, pu.product_id FROM product_units pu JOIN products p ON p.id = pu.product_id WHERE pu.barcode = ? AND pu.tenant_id = ? AND p.tenant_id = ? AND pu.deleted_at IS NULL"
      ).get(query, tenantId, tenantId) as any;
      if (unitHit) {
        product = db.prepare("SELECT * FROM products WHERE id = ?").get(unitHit.product_id);
        matchedUomId = unitHit.id;
      }
    }

    if (!product) {
      product = db.prepare("SELECT * FROM products WHERE name = ? AND tenant_id = ?").get(query, tenantId);
    }

    if (!product) {
      product = db.prepare("SELECT * FROM products WHERE name LIKE ? AND tenant_id = ? COLLATE NOCASE LIMIT 1").get(`%${query}%`, tenantId);
    }

    if (product && product.active === 0) {
      return res.status(404).json({ error: "This product is disabled.", code: 'PRODUCT_DISABLED', product_id: product.id, name: product.name });
    }

    if (product) {
      const extraBarcodes = db.prepare("SELECT barcode FROM product_barcodes WHERE product_id = ?").all(product.id).map((b: any) => b.barcode);
      res.json({
        ...product,
        barcodes: [product.barcode, ...extraBarcodes].filter(Boolean),
        units: loadUnitsForProduct(tenantId, product.id),
        matched_uom_id: matchedUomId,
      });
    }
    else res.status(404).json({ error: "Product not found" });
  });

  app.get("/api/stakeholders", authenticate, (req: any, res) => {
    const stakeholders = db.prepare("SELECT * FROM stakeholders WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(stakeholders);
  });

  app.get("/api/currencies", authenticate, (req: any, res) => {
    const currencies = db.prepare("SELECT * FROM currencies WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(currencies);
  });

  app.post("/api/currencies", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { code, symbol, rate, is_default } = req.body;
    if (is_default) {
      db.prepare("UPDATE currencies SET is_default = 0 WHERE tenant_id = ?").run(tenantId);
    }
    const info = db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, ?, ?, ?, ?)").run(tenantId, code, symbol, rate, is_default ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  });

  app.put("/api/currencies/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;
    const { code, symbol, rate, is_default } = req.body;
    if (is_default) {
      db.prepare("UPDATE currencies SET is_default = 0 WHERE tenant_id = ?").run(tenantId);
    }
    db.prepare("UPDATE currencies SET code = ?, symbol = ?, rate = ?, is_default = ? WHERE id = ? AND tenant_id = ?").run(code, symbol, rate, is_default ? 1 : 0, id, tenantId);
    res.json({ success: true });
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
  });

  app.delete("/api/currencies/:id", authenticate, (req: any, res) => {
    db.prepare("DELETE FROM currencies WHERE id = ? AND tenant_id = ?").run(req.params.id, req.session.tenantId);
    res.json({ success: true });
  });

  // --- USER MANAGEMENT ---
  app.get("/api/users", authenticate, (req: any, res) => {
    const users = db.prepare("SELECT * FROM users WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(users);
  });

  app.post("/api/users", authenticate, (req: any, res) => {
    const { name, role, pin } = req.body;
    const result = db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, ?, ?, ?)").run(req.session.tenantId, name, role || 'staff', pin || '0000');
    res.json({ id: result.lastInsertRowid });
  });

  app.put("/api/users/:id", authenticate, (req: any, res) => {
    const { name, role, pin } = req.body;
    db.prepare("UPDATE users SET name = ?, role = ?, pin = ? WHERE id = ? AND tenant_id = ?").run(name, role, pin || '0000', req.params.id, req.session.tenantId);
    res.json({ success: true });
  });

  app.delete("/api/users/:id", authenticate, (req: any, res) => {
    db.prepare("DELETE FROM users WHERE id = ? AND tenant_id = ?").run(req.params.id, req.session.tenantId);
    res.json({ success: true });
  });

  app.get("/api/settings", authenticate, (req: any, res) => {
    res.json(getSettingsMap(req.session.tenantId));
  });

  app.post("/api/settings", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const settings = req.body;
    const upsert = db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, ?, ?)");
    for (const [key, value] of Object.entries(settings)) {
      upsert.run(tenantId, key, String(value));
    }
    logAction(tenantId, 1, 'Settings Updated', JSON.stringify(settings));
    res.json({ success: true });
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
  });

  app.post("/api/stakeholders", authenticate, (req: any, res) => {
    try {
      const tenantId = req.session.tenantId;
      const { name, type, email, phone, address, balance, price_level, credit_limit } = req.body;
      // balance is derived (baseline + tx effects). A brand-new stakeholder has no transactions,
      // so any starting balance is stored as the baseline.
      const result = db.prepare("INSERT INTO stakeholders (tenant_id, name, type, email, phone, address, balance, balance_baseline, price_level, credit_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(tenantId, name, type, email || null, phone || null, address || null, balance || 0, balance || 0, normalizeLevel(price_level), credit_limit || null);
      if (balance && Math.abs(Number(balance)) > 0.0000001) {
        writeBalanceLog(Number(result.lastInsertRowid), tenantId, 0, Number(balance), { source: 'opening', user_id: tenantUserId(tenantId, req.body.user_id), note: 'Opening balance at creation' });
      }
      logAction(tenantId, 1, 'Stakeholder Created', `Name: ${name}, Type: ${type}`);
      res.json({ id: result.lastInsertRowid });
    } catch (err: any) {
      console.error("Stakeholder Create Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/stakeholders/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { name, type, email, phone, address, balance, price_level, credit_limit } = req.body;
    // price_level/credit_limit are optional on this endpoint (older/other callers may not send
    // them at all) — leave them untouched rather than silently resetting to 'retail'/unlimited.
    const current = db.prepare("SELECT price_level, credit_limit FROM stakeholders WHERE id = ? AND tenant_id = ?").get(req.params.id, tenantId) as any;
    const resolvedPriceLevel = price_level !== undefined ? normalizeLevel(price_level) : (current?.price_level || 'retail');
    const resolvedCreditLimit = credit_limit !== undefined ? (credit_limit || null) : (current?.credit_limit ?? null);
    db.prepare("UPDATE stakeholders SET name = ?, type = ?, email = ?, phone = ?, address = ?, price_level = ?, credit_limit = ? WHERE id = ? AND tenant_id = ?")
      .run(name, type, email || null, phone || null, address || null, resolvedPriceLevel, resolvedCreditLimit, req.params.id, tenantId);
    // A manually-entered balance is treated as an override: set the baseline so the DERIVED
    // balance equals what was typed (baseline = entered − transaction effect), then recompute.
    if (balance !== undefined && balance !== null) {
      const effect = stakeholderTxEffect(Number(req.params.id), tenantId);
      db.prepare("UPDATE stakeholders SET balance_baseline = ? WHERE id = ? AND tenant_id = ?").run(Number(balance) - effect, req.params.id, tenantId);
      recomputeStakeholderBalance(Number(req.params.id), tenantId, { source: 'manual_edit', user_id: tenantUserId(tenantId, req.body.user_id), note: 'Balance edited manually' });
    }
    logAction(tenantId, 1, 'Stakeholder Updated', `ID: ${req.params.id}, Name: ${name}, Type: ${type}`);
    res.json({ success: true });
  });

  app.delete("/api/stakeholders/:id", authenticate, (req: any, res) => {
    db.prepare("DELETE FROM stakeholders WHERE id = ? AND tenant_id = ?").run(req.params.id, req.session.tenantId);
    logAction(req.session.tenantId, 1, 'Stakeholder Deleted', `ID: ${req.params.id}`);
    res.json({ success: true });
  });

  app.post("/api/stakeholders/settle-balance", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { stakeholder_id, amount, method, currency, exchange_rate } = req.body;
    const debtUserId = tenantUserId(tenantId, req.body.user_id);

    const processDebt = db.transaction(() => {
      // Create a system transaction ticket (0-total 'sale') carrying the payment received. In the
      // derived-balance model this payment is exactly what moves the balance toward zero, so we
      // just recompute afterwards instead of nudging the balance directly.
      const result = db.prepare(`
      INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status)
      VALUES (?, ?, ?, 'sale', 0, ?, ?, 'completed')
    `).run(tenantId, stakeholder_id, debtUserId, currency, exchange_rate); // type sale with 0 total marks a debt payment

      const transactionId = result.lastInsertRowid;

      // Record payment receipt
      db.prepare(`
      INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate)
      VALUES (?, ?, ?, ?, ?)
    `).run(transactionId, amount, method, currency, exchange_rate);

      const stk = db.prepare("SELECT type FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholder_id, tenantId) as any;
      recomputeStakeholderBalance(stakeholder_id, tenantId, {
        source: stk?.type === 'supplier' ? 'supplier_payment' : 'balance_collection',
        reference_id: Number(transactionId),
        user_id: debtUserId,
        note: `${amount} ${currency || 'USD'} via ${method || 'cash'}`,
      });
      return transactionId;
    });

    try {
      const id = processDebt();
      logAction(tenantId, 1, 'Debt Payment Received', `Amount: ${amount} ${currency}`);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      res.json({ success: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/transactions", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { stakeholder_id, user_id, items, currency, exchange_rate, payments, discount, tax, terminalId, original_transaction_id, price_level, notes, reference } = req.body;
    // The POS checkout has never sent `type` (it relied on the INSERT's `type || 'sale'` default),
    // so every branch below that checks `type === 'sale'` was skipped for POS sales: the line was
    // priced from the client's item.price (no package break, no price tier) and its unit_cost was
    // set to the selling price. Normalize once, up front, so a POS sale IS a sale everywhere.
    const type: 'sale' | 'purchase' | 'refund' = req.body.type || 'sale';
    if (!['sale', 'purchase', 'refund'].includes(type)) {
      return res.status(400).json({ error: "Invalid transaction type." });
    }
    // Always store user_id AND stakeholder_id that belong to THIS tenant (never the old hard-coded
    // 1 defaults, which point at a seed tenant's rows and break the cloud FKs, blocking sync).
    const resolvedUserId = tenantUserId(tenantId, user_id);
    let resolvedStakeholderId = tenantStakeholderId(tenantId, stakeholder_id);
    const settings = getSettingsMap(tenantId);
    const stakeholderRow = resolvedStakeholderId
      ? db.prepare("SELECT name, price_level, credit_limit, balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(resolvedStakeholderId, tenantId) as any
      : null;
    // price_level: explicit request value, else the stakeholder's own level, else the tenant's
    // configured default, else retail (normalizeLevel handles any garbled/missing value). When
    // price levels are turned off tenant-wide (Settings > Sales & Pricing), everything sells at
    // retail regardless of what was requested — missing key = on (default).
    const priceLevelsEnabled = settings.enable_price_levels !== '0';
    const resolvedPriceLevel: PriceLevel = priceLevelsEnabled
      ? normalizeLevel(price_level ?? stakeholderRow?.price_level ?? settings.default_price_level)
      : 'retail';

    // A refund's price and discount must come from the sale it's refunding — never from the
    // client — or a modified client could submit an arbitrary refund amount. A purchase's price
    // is legitimately negotiated per order (there's no catalog price to check it against), but it
    // still has to be a real, non-negative number rather than whatever the client happened to send.
    // A refund is resolved PER ORIGINAL SALE LINE (a product sold as pieces AND as a carton has two
    // lines): each refund item names its line via original_item_id and its quantity is in that line's
    // own unit. Items without original_item_id (older clients) are in base pieces and are allocated to
    // that product's lines in id order. refundAlloc[itemIndex] = the line slices that item covers.
    let refundAlloc: Record<number, Array<{ line: any; pieces: number }>> | null = null;
    let refundAdjust = { discountPct: 0, taxPct: 0 };
    let refundStakeholderId: number | null = null;
    if (type === 'refund') {
      if (!original_transaction_id) {
        return res.status(400).json({ error: "A refund must reference the sale it's refunding." });
      }
      const original = findOriginalSale(tenantId, original_transaction_id);
      if (!original || original.tx.type !== 'sale') {
        return res.status(400).json({ error: "The referenced sale could not be found." });
      }
      const states = refundLineStates(tenantId, original_transaction_id, original.items);
      refundAdjust = originalAdjustmentPcts(original);
      refundStakeholderId = original.tx.stakeholder_id ?? null;
      refundAlloc = {};
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
          return res.status(400).json({ error: `Invalid refund quantity for product ${item.id}.`, field: `items.${idx}.quantity` });
        }
        const alloc: Array<{ line: any; pieces: number }> = [];
        if (item.original_item_id !== undefined && item.original_item_id !== null) {
          const st = states.find((s) => s.item.id === Number(item.original_item_id));
          if (!st || (item.id != null && st.item.product_id !== Number(item.id))) {
            return res.status(400).json({ error: `Product ${item.id} was not part of the original sale.`, field: `items.${idx}.quantity` });
          }
          const factor = st.item.uom_factor || 1;
          const pieces = item.quantity * factor;
          if (pieces > st.remaining + 1e-9) {
            return res.status(400).json({ error: `Cannot refund ${item.quantity} of product ${st.item.product_id} — only ${Math.max(0, st.remaining / factor)} remain eligible for refund.`, field: `items.${idx}.quantity` });
          }
          st.remaining -= pieces; // guards duplicate rows for the same line within one request
          alloc.push({ line: st.item, pieces });
        } else {
          const candidates = states.filter((s) => s.item.product_id === Number(item.id));
          if (!candidates.length) {
            return res.status(400).json({ error: `Product ${item.id} was not part of the original sale.`, field: `items.${idx}.quantity` });
          }
          const available = candidates.reduce((sum, s) => sum + s.remaining, 0);
          if (item.quantity > available + 1e-9) {
            return res.status(400).json({ error: `Cannot refund ${item.quantity} of product ${item.id} — only ${Math.max(0, available)} remain eligible for refund.`, field: `items.${idx}.quantity` });
          }
          let left = item.quantity;
          for (const st of candidates) {
            if (left <= 1e-9) break;
            const take = Math.min(left, st.remaining);
            if (take <= 1e-9) continue;
            alloc.push({ line: st.item, pieces: take });
            st.remaining -= take;
            left -= take;
          }
        }
        refundAlloc[idx] = alloc;
      }
    } else if (type === 'purchase') {
      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        if (!(Number.isFinite(item.price) && item.price >= 0)) {
          return res.status(400).json({ error: `Invalid purchase price for product ${item.id}.`, field: `items.${idx}.unit_price` });
        }
        if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
          return res.status(400).json({ error: `Invalid purchase quantity for product ${item.id}.`, field: `items.${idx}.quantity` });
        }
      }
    }

    // Global discount/tax (a whole-sale adjustment, separate from any per-item discount) used to
    // be applied with whatever value the client sent, unbounded — a negative value inflates the
    // total, and a >100% discount empties or overshoots it. A percentage must be a real number in
    // [0, 100]; a fixed amount must be real and non-negative (a fixed discount larger than the
    // subtotal is clamped rather than rejected below — that's a legitimate "round down to zero,"
    // not a suspicious input).
    const invalidAdjustment = (adj: any, label: string): string | null => {
      if (!adj) return null;
      if (adj.type !== 'percentage' && adj.type !== 'fixed') return `Invalid ${label} type.`;
      if (!Number.isFinite(adj.value) || adj.value < 0) return `Invalid ${label} value.`;
      if (adj.type === 'percentage' && adj.value > 100) return `${label === 'discount' ? 'Discount' : 'Tax'} percentage cannot exceed 100%.`;
      return null;
    };
    // A refund always belongs to the customer of the sale it refunds (its effect unwinds THAT
    // customer's balance), whatever the client sent.
    if (type === 'refund' && refundStakeholderId) resolvedStakeholderId = refundStakeholderId;

    // Current balance, before this transaction — the response's balance_before AND the cap for a
    // store_credit payment (Σ store_credit ≤ max(0, this)). Queried fresh (not from stakeholderRow
    // above, which was looked up before a refund's stakeholder reassignment) against the FINAL
    // resolvedStakeholderId.
    const stakeholderForBalance = resolvedStakeholderId
      ? db.prepare("SELECT name, balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(resolvedStakeholderId, tenantId) as any
      : null;
    const balanceBefore: number | null = stakeholderForBalance ? (stakeholderForBalance.balance || 0) : null;

    for (const p of (payments || [])) {
      if (!isValidPaymentMethod(p.method)) {
        return res.status(400).json({ error: `Invalid payment method: ${p.method}.`, field: 'payments' });
      }
    }
    const storeCreditTotal = (payments || [])
      .filter((p: any) => p.method === 'store_credit')
      .reduce((sum: number, p: any) => sum + (p.amount / (p.exchange_rate || 1)), 0);
    if (storeCreditTotal > 1e-9) {
      if (type === 'refund') {
        return res.status(400).json({ error: "Store credit can't be used on a refund.", field: 'payments' });
      }
      if (!resolvedStakeholderId || stakeholderForBalance?.name === 'Walk-in Customer') {
        return res.status(400).json({ error: "Walk-in Customer has no account balance to use.", code: 'STORE_CREDIT_WALKIN' });
      }
      const available = Math.max(0, balanceBefore || 0);
      if (storeCreditTotal > available + 1e-9) {
        return res.status(400).json({
          error: `Store credit exceeds the available balance (${available.toFixed(2)}).`,
          code: 'STORE_CREDIT_EXCEEDED',
          available,
        });
      }
    }

    const discountError = invalidAdjustment(discount, 'discount');
    if (discountError) return res.status(400).json({ error: discountError });
    const taxError = invalidAdjustment(tax, 'tax');
    if (taxError) return res.status(400).json({ error: taxError });

    const transaction = db.transaction(() => {
      // Cache products fetched for this request — a purchase's WAC blend must see the running
      // cost/stock left by an EARLIER line for the same product in the same invoice, not the
      // stale value from the initial (pre-request) row.
      const productCache: Record<number, any> = {};
      const getProduct = (id: number) => {
        if (!(id in productCache)) {
          productCache[id] = db.prepare(
            "SELECT price, price_wholesale, price_super_wholesale, package_price, units_per_package, track_inventory, cost, min_price, stock, active FROM products WHERE id = ? AND tenant_id = ?"
          ).get(id, tenantId) as any;
        }
        return productCache[id];
      };

      const unitsCache: Record<number, any[]> = {};
      const getUnits = (id: number) => (unitsCache[id] ||= loadUnitsForProduct(tenantId, id));

      let calculatedTotal = 0;
      const processedItems = items.flatMap((item: any, idx: number) => {
        const product = getProduct(item.id);

        // Units of measure: `quantity` in the payload is in the line's UNITS; everything stored (and
        // every stock / WAC delta) is in base pieces, with the factor read from the DB — never trusted
        // from the client. A refund takes its unit from the original line instead (below).
        let uom: any = null;
        if (type !== 'refund' && item.uom_id !== undefined && item.uom_id !== null) {
          uom = product ? loadUnit(tenantId, item.id, item.uom_id) : null;
          if (!uom) {
            throw new ValidationError(`Unit ${item.uom_id} is not valid for product ${item.id}.`, 400, { code: 'UOM_INVALID', field: `items.${idx}.uom_id` });
          }
        }
        const factor = uom ? uom.factor : 1;
        const pieces = item.quantity * factor;
        const uomFields = uom
          ? { uomId: uom.id, uomName: uom.name, uomFactor: uom.factor, uomQty: item.quantity }
          : { uomId: null, uomName: null, uomFactor: null, uomQty: null };

        let unitPrice = item.price; // Fallback to provided price (purchases — validated above)
        let itemTotal: number;
        let discountType: string | null = item.discount?.type || null;
        let discountValue: number | null = item.discount?.value ?? null;
        let unitCost: number | null = null;

        if (type === 'sale' && product) {
          if (product.active === 0) {
            throw new ValidationError(`Product ${item.id} is disabled.`, 400, { code: 'PRODUCT_DISABLED', field: `items.${idx}.id`, product_id: item.id });
          }
          // Price of ONE unit of the line's UoM (one piece for base lines, which also get the
          // automatic pack/carton break).
          let perUnit = uom
            ? uomUnitPrice(product, uom, resolvedPriceLevel)
            : saleLineUnitPrice(product, resolvedPriceLevel, item.quantity, getUnits(item.id));

          // A manual price override (cashier types a different price on the line) is only
          // honored when the tenant explicitly turned it on, and only for a real, non-negative
          // number — never trust a garbled/absent client value.
          // The back-office invoice editor is an admin screen whose typed prices are honored the same
          // way PUT /api/transactions/:id honors them on edit (and are visible in the invoice itself);
          // at the POS a typed price needs the explicit tenant setting.
          const overrideAllowed = settings.allow_price_override === '1' || req.body.source === 'backoffice';
          if (overrideAllowed && Number.isFinite(item.unit_price) && item.unit_price >= 0) {
            perUnit = item.unit_price; // per unit of the line's UoM
          }
          unitPrice = perUnit / factor; // stored per base piece
          if (product.min_price && product.min_price > 0 && unitPrice < product.min_price && settings.enforce_min_price === '1') {
            throw new ValidationError(
              `Price for product ${item.id} is below its minimum price of ${product.min_price}.`,
              400,
              { field: `items.${idx}.unit_price` }
            );
          }

          // Apply the per-item discount (the cart's "DISC" control) the same way the client does
          // when computing what the cashier actually charges — otherwise total_amount ends up
          // higher than the payments actually collected on any discounted line item, which
          // silently overstates recorded revenue in every report and end-of-day reconciliation.
          itemTotal = lineTotal(perUnit, item.quantity, { type: discountType as any, value: discountValue });
          // Optional guard: no sale line below cost (after the line's own discount; the invoice-level
          // discount is deliberately not considered).
          if (settings.allow_below_cost === '0' && product.cost > 0 && pieces > 0 && itemTotal / pieces < product.cost - 1e-9) {
            throw new ValidationError(
              `Price for product ${item.id} is below its cost of ${product.cost * factor}.`,
              400,
              { code: 'BELOW_COST', field: `items.${idx}.unit_price`, cost: product.cost * factor }
            );
          }
          unitCost = product.cost ?? null; // USD cost snapshot for COGS (per piece)
        } else if (type === 'refund' && refundAlloc) {
          // Re-derive price AND discount from the original sale line (validated above) — never trust
          // the client's for a refund. A fixed discount is prorated to how much of that original
          // line is actually being refunded, matching the client's own calculateRefundAmount
          // (src/hooks/usePos.ts) so the two stay in agreement. One request item can span several
          // original lines (legacy items without original_item_id), hence one row per slice.
          const rows = refundAlloc[idx].map(({ line, pieces: slicePieces }) => {
            const lineFactor = line.uom_factor || 1;
            let sliceTotal = line.unit_price * slicePieces;
            if (line.discount_type === 'percentage') {
              sliceTotal -= (sliceTotal * (line.discount_value || 0)) / 100;
            } else if (line.discount_type === 'fixed') {
              sliceTotal -= (line.discount_value || 0) * (slicePieces / line.quantity);
            }
            sliceTotal = Math.max(0, sliceTotal);
            calculatedTotal += sliceTotal;
            return {
              productId: line.product_id,
              pieces: slicePieces,
              tax: item.tax,
              unitPrice: line.unit_price,
              discountType: line.discount_type as string | null,
              discountValue: line.discount_value as number | null,
              unitCost: (line.unit_cost ?? null) as number | null, // a refund copies the ORIGINAL sale line's cost snapshot
              trackInventory: product ? product.track_inventory : 1,
              uomId: line.uom_id ?? null,
              uomName: line.uom_name ?? null,
              uomFactor: line.uom_id ? lineFactor : null,
              uomQty: line.uom_id ? slicePieces / lineFactor : null,
              originalItemId: line.id as number,
            };
          });
          return rows;
        } else {
          // Purchase (price/quantity validated above): the cost is legitimately entered per
          // order, but the discount, if any, is applied the same way as a sale.
          // `price` is the cost of ONE unit of the line's UoM; costs/WAC are per base piece.
          itemTotal = lineTotal(unitPrice, item.quantity, { type: discountType as any, value: discountValue });
          unitPrice = unitPrice / factor;
          unitCost = unitPrice; // the purchase price paid IS this line's unit cost (per piece)

          // Blend this line into the product's weighted-average cost BEFORE the stock increment
          // (below, once the transaction row exists) — using the running cache so multiple lines
          // for the same product within one invoice blend in the order they were entered.
          if (type === 'purchase' && product) {
            const newCost = applyPurchaseCost(product.stock || 0, product.cost, pieces, unitPrice);
            product.cost = newCost;
            product.stock = (product.stock || 0) + pieces;
            db.prepare("UPDATE products SET cost = ? WHERE id = ? AND tenant_id = ?").run(newCost, item.id, tenantId);
          }
        }

        calculatedTotal += itemTotal;

        return [{
          productId: item.id, pieces, tax: item.tax, unitPrice, discountType, discountValue, unitCost,
          trackInventory: product ? product.track_inventory : 1, ...uomFields, originalItemId: null as number | null,
        }];
      });

      // Optional guard: a sale may not leave a tracked product below zero stock (pieces summed across
      // all of the request's lines for that product).
      if (type === 'sale' && settings.allow_negative_stock === '0') {
        const need = new Map<number, { total: number; firstIdx: number }>();
        processedItems.forEach((pi: any, i: number) => {
          if (pi.trackInventory === 0) return;
          const e = need.get(pi.productId);
          if (e) e.total += pi.pieces; else need.set(pi.productId, { total: pi.pieces, firstIdx: i });
        });
        for (const [pid, e] of need) {
          const prod = getProduct(pid);
          if (!prod) continue;
          const available = prod.stock || 0;
          if (available - e.total < -1e-9) {
            throw new ValidationError(
              `Insufficient stock for product ${pid}: only ${available} available.`,
              409,
              { code: 'INSUFFICIENT_STOCK', field: `items.${e.firstIdx}.quantity`, available, product_id: pid }
            );
          }
        }
      }

      // Apply global discount/tax if any (bounds validated above) — exactly the same math as
      // before, now shared with PUT /api/transactions/:id via server/pricing.ts.
      // A refund's invoice-level discount/tax come from the original invoice (originalAdjustmentPcts),
      // never from the client — sending them again would double-apply or let a client inflate it.
      const pct = (v: number) => (Math.abs(v) > 1e-9 ? { type: 'percentage' as const, value: v } : null);
      const storedDiscount = type === 'refund' ? pct(refundAdjust.discountPct) : discount;
      const storedTax = type === 'refund' ? pct(refundAdjust.taxPct) : tax;
      const finalTotal = computeTotals([calculatedTotal], storedDiscount, storedTax);

      const termId = terminalId || 'MAIN';
      const sequenceRow = db.prepare(`SELECT IFNULL(MAX(terminal_sequence), 0) + 1 as next_seq FROM transactions WHERE terminal_id = ? AND tenant_id = ?`).get(termId, tenantId) as any;
      const termSeq = sequenceRow.next_seq;

      const info = db.prepare(`
      INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, original_transaction_id, price_level, notes, reference)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        tenantId,
        resolvedStakeholderId,
        resolvedUserId,
        type || 'sale',
        finalTotal,
        currency,
        exchange_rate,
        storedDiscount?.type || null,
        storedDiscount?.value || null,
        storedTax?.type || null,
        storedTax?.value || null,
        'completed',
        termId,
        termSeq,
        type === 'refund' ? original_transaction_id : null,
        resolvedPriceLevel,
        notes || null,
        reference || null
      );

      const transactionId = info.lastInsertRowid;

      const insertItem = db.prepare(`
      INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value, unit_cost, uom_id, uom_name, uom_factor, uom_qty, original_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

      let stockChange = '-';
      if (type === 'purchase') stockChange = '+';
      if (type === 'refund') stockChange = '+';

      const updateStock = db.prepare(`
      UPDATE products SET stock = stock ${stockChange} ? WHERE id = ? AND tenant_id = ?
    `);

      for (const item of processedItems) {
        insertItem.run(
          transactionId,
          item.productId,
          item.pieces,
          item.unitPrice,
          item.discountType,
          item.discountValue,
          item.tax?.type || null,
          item.tax?.value || null,
          item.unitCost ?? null,
          item.uomId,
          item.uomName,
          item.uomFactor,
          item.uomQty,
          item.originalItemId
        );
        if (item.trackInventory !== 0) {
          updateStock.run(item.pieces, item.productId, tenantId);
        }
      }

      let totalPaid = 0;
      if (payments && payments.length > 0) {
        const insertPayment = db.prepare(`
        INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate)
        VALUES (?, ?, ?, ?, ?)
      `);
        for (const payment of payments) {
          insertPayment.run(transactionId, payment.amount, payment.method, payment.currency, payment.exchange_rate);
          // BALANCE MATH (server/paymentMethods.ts): store_credit is not money either, exactly
          // like credit — it stays "unpaid" so its effect keeps consuming the positive balance.
          if (isRealMoney(payment.method)) {
            totalPaid += (payment.amount / (payment.exchange_rate || 1));
          }
        }
      }

      // Credit limit: would this transaction push the stakeholder further past their limit?
      // `stakeholderRow.balance` is this stakeholder's balance BEFORE this transaction, so add
      // just this transaction's own effect (same sign convention as server/balance.ts).
      if (stakeholderRow && stakeholderRow.credit_limit && stakeholderRow.credit_limit > 0 && settings.enforce_credit_limit === '1') {
        let effect = 0;
        if (type === 'sale' || type === 'purchase') effect = -(finalTotal - totalPaid);
        else if (type === 'refund') effect = (finalTotal - totalPaid);
        const prospectiveBalance = (stakeholderRow.balance || 0) + effect;
        if (prospectiveBalance < -stakeholderRow.credit_limit) {
          throw new ValidationError(
            `This would exceed the credit limit (${stakeholderRow.credit_limit}).`,
            400,
            { code: 'CREDIT_LIMIT', field: 'stakeholder_id' }
          );
        }
      }

      // Balance is derived, not nudged: recompute it from this stakeholder's transactions +
      // baseline now that the new transaction and its payments are in place.
      if (resolvedStakeholderId) {
        recomputeStakeholderBalance(resolvedStakeholderId, tenantId, { source: type, reference_id: Number(transactionId), user_id: resolvedUserId });
      }

      return transactionId;
    });

    try {
      const id = transaction();
      const fullTransaction = db.prepare(`
      SELECT t.*, s.name as stakeholder_name, u.name as user_name
      FROM transactions t
      LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = ?
    `).get(id);

      // balance_after: same stakeholder, re-read now that recomputeStakeholderBalance ran inside
      // the transaction above. null when there's no stakeholder (Walk-in has no account balance).
      const balanceAfterRow = resolvedStakeholderId
        ? db.prepare("SELECT balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(resolvedStakeholderId, tenantId) as any
        : null;
      const balanceAfter = balanceAfterRow ? (balanceAfterRow.balance || 0) : null;

      res.json({ id, success: true, balance_before: balanceBefore, balance_after: balanceAfter });
      logAction(tenantId, resolvedUserId, `Transaction: ${type || 'sale'}`, `ID: ${id}, Total: ${fullTransaction.total_amount} ${fullTransaction.currency}`);
      broadcast({ type: 'TRANSACTIONS_UPDATED', transaction: fullTransaction, terminalId }, tenantId);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
    } catch (error: any) {
      if (error instanceof ValidationError) {
        return res.status(error.status).json(validationErrorBody(error));
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/transactions/:id", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;

    const tx = db.prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ?").get(id, tenantId) as any;
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    const assertDeleteAllowed = () => {
      // Optional guard: deleting a purchase/refund takes its stock back out — refuse if that would leave a
      // tracked product below zero.
      if (tx.type !== 'sale' && getSettingsMap(tenantId).allow_negative_stock === '0') {
        const lines = db.prepare(`
          SELECT ti.product_id, ti.quantity, p.track_inventory, p.stock FROM transaction_items ti
          JOIN products p ON p.id = ti.product_id WHERE ti.transaction_id = ?
        `).all(id) as any[];
        const removed = new Map<number, { total: number; stock: number }>();
        for (const l of lines) {
          if (l.track_inventory === 0) continue;
          const en = removed.get(l.product_id);
          if (en) en.total += l.quantity; else removed.set(l.product_id, { total: l.quantity, stock: l.stock || 0 });
        }
        for (const [pid, en] of removed) {
          if (en.stock - en.total < -1e-9) {
            throw new ValidationError(`Deleting this invoice would leave product ${pid} with negative stock.`, 409, { code: 'INSUFFICIENT_STOCK', available: en.stock, product_id: pid });
          }
        }
      }
    };

    const deleteTx = db.transaction(() => {
      // Restore stock
      const items = db.prepare(`
        SELECT ti.*, p.track_inventory, p.stock as current_stock, p.cost as current_cost FROM transaction_items ti
        JOIN products p ON p.id = ti.product_id
        WHERE ti.transaction_id = ?
      `).all(id) as any[];
      for (const item of items) {
        // A purchase's cost was blended into the WAC on receipt — reverse it BEFORE the stock
        // decrement below, using the stock as it stands right now (i.e. still including this line).
        if (tx.type === 'purchase') {
          const newCost = reversePurchaseCost(item.current_stock || 0, item.current_cost, item.quantity, item.unit_cost ?? item.unit_price);
          db.prepare("UPDATE products SET cost = ? WHERE id = ? AND tenant_id = ?").run(newCost, item.product_id, tenantId);
        }
        if (item.track_inventory === 0) continue;
        if (tx.type === 'sale') {
          db.prepare("UPDATE products SET stock = stock + ? WHERE id = ? AND tenant_id = ?").run(item.quantity, item.product_id, tenantId);
        } else if (tx.type === 'purchase' || tx.type === 'refund') {
          db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND tenant_id = ?").run(item.quantity, item.product_id, tenantId);
        }
      }

      db.prepare("DELETE FROM payments WHERE transaction_id = ?").run(id);
      db.prepare("DELETE FROM transaction_items WHERE transaction_id = ?").run(id);
      db.prepare("DELETE FROM transactions WHERE id = ? AND tenant_id = ?").run(id, tenantId);

      // Balance is derived — recompute from the stakeholder's REMAINING transactions.
      if (tx.stakeholder_id) {
        recomputeStakeholderBalance(tx.stakeholder_id, tenantId, { source: 'invoice_delete', reference_id: Number(id), user_id: tenantUserId(tenantId, req.body?.user_id), note: `Deleted ${tx.type} #${id}` });
      }
    });

    try {
      // Remove the cloud copy FIRST (if this transaction was ever synced), then delete locally.
      // Doing it in this order — with no await after the synchronous local delete — means a
      // concurrent sync pull can't re-insert the row we're removing. Best-effort: if the cloud
      // call fails (e.g. offline) we still delete locally so the app keeps working; the row may
      // resync later, which is the same offline limitation the settlement flow has.
      assertDeleteAllowed(); // before touching the cloud copy
      let cloudDeleted = true;
      if (tx.global_id) {
        try {
          await purgeCloudTransaction(tx.global_id);
        } catch (cloudErr: any) {
          cloudDeleted = false;
          console.error('❌ [DELETE TX] Cloud delete failed:', cloudErr?.message || cloudErr);
        }
      }

      deleteTx();
      logAction(tenantId, 1, 'Transaction Deleted', `ID: ${id}, Type: ${tx.type}, Total: ${tx.total_amount}${cloudDeleted ? '' : ' (LOCAL ONLY — cloud delete failed)'}`);
      broadcast({ type: 'TRANSACTIONS_UPDATED' }, tenantId);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      broadcast({ type: 'STAKEHOLDERS_UPDATED' }, tenantId);
      res.json({ success: true, cloudDeleted });
    } catch (error: any) {
      if (error instanceof ValidationError) return res.status(error.status).json(validationErrorBody(error));
      res.status(500).json({ error: error.message });
    }
  });


  app.get("/api/users", authenticate, (req: any, res) => {
    const users = db.prepare("SELECT * FROM users WHERE tenant_id = ?").all(req.session.tenantId);
    res.json(users);
  });

  app.get("/api/reports/daily-sales", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { date } = req.query;
    // Was comparing date(created_at) (UTC) to a UTC-derived default — both need to be the store's
    // LOCAL calendar day, or a sale near midnight lands on the wrong day's report.
    const targetDate = date ? String(date) : localToday();

    const transactions = db.prepare(`
    SELECT t.*, s.name as stakeholder_name, u.name as user_name
    FROM (
      SELECT ${TX_LIVE_COLUMNS} FROM transactions
      WHERE date(created_at, 'localtime') = date(?) AND tenant_id = ? AND type != 'purchase'
      UNION ALL
      SELECT ${TX_ARCHIVED_COLUMNS} FROM archived_transactions
      WHERE date(created_at, 'localtime') = date(?) AND tenant_id = ? AND type != 'purchase'
    ) t
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
    LEFT JOIN users u ON t.user_id = u.id
    ORDER BY t.created_at DESC
  `).all(targetDate, tenantId, targetDate, tenantId);

    res.json(transactions);
  });

  app.get("/api/transactions/recent", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { type, stakeholder_id, date_from, date_to } = req.query;

    // Same filter clause applied to both the live and archived tables, then UNIONed — a settled
    // invoice must match the same search filters as an unsettled one to be found at all.
    let filter = "";
    const filterParams: any[] = [];

    if (type && type !== 'all') {
      filter += " AND type = ?";
      filterParams.push(type);
    }
    if (stakeholder_id && stakeholder_id !== 'all') {
      filter += " AND stakeholder_id = ?";
      filterParams.push(stakeholder_id);
    }
    if (date_from) {
      filter += " AND date(created_at, 'localtime') >= date(?)";
      filterParams.push(date_from);
    }
    if (date_to) {
      filter += " AND date(created_at, 'localtime') <= date(?)";
      filterParams.push(date_to);
    }

    if (req.query.q) {
      // Invoice number, reference, or party name.
      filter += " AND (CAST(id AS TEXT) = ? OR reference LIKE ? OR stakeholder_id IN (SELECT id FROM stakeholders WHERE tenant_id = ? AND name LIKE ?))";
      filterParams.push(String(req.query.q), `%${req.query.q}%`, tenantId, `%${req.query.q}%`);
    }
    // Callers that page through history (Invoices screen) can ask for more than the POS's 200.
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || 200), 10) || 200, 1), 5000);

    // paid_amount = real money received in USD (credit "on account" payments are not money), so the
    // list can show paid / due / status without one detail request per row.
    const query = `
    SELECT t.*, s.name as stakeholder_name, u.name as user_name,
      CASE WHEN t.archived = 1
        THEN (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM archived_payments WHERE transaction_id = t.id AND method != 'credit')
        ELSE (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM payments WHERE transaction_id = t.id AND method != 'credit') END as paid_amount,
      CASE WHEN t.archived = 1
        THEN (SELECT COUNT(*) FROM archived_transaction_items WHERE transaction_id = t.id)
        ELSE (SELECT COUNT(*) FROM transaction_items WHERE transaction_id = t.id) END as item_count
    FROM (
      SELECT ${TX_LIVE_COLUMNS}, 0 as archived FROM transactions WHERE tenant_id = ?${filter}
      UNION ALL
      SELECT ${TX_ARCHIVED_COLUMNS}, 1 as archived FROM archived_transactions WHERE tenant_id = ?${filter}
    ) t
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
    LEFT JOIN users u ON t.user_id = u.id
    ORDER BY t.created_at DESC LIMIT ${limit}`;
    const params = [tenantId, ...filterParams, tenantId, ...filterParams];

    const transactions = db.prepare(query).all(...params);
    res.json(transactions);
  });

  // Shared by GET /api/transactions/:id and PUT /api/transactions/:id (which re-renders the same
  // shape after editing) — looks in the live table first, then archived_transactions so a
  // settled invoice can still be opened/viewed.
  function buildTransactionDetail(tenantId: number, id: any): any | null {
    let transaction = db.prepare(`
    SELECT t.*, s.name as stakeholder_name, u.name as user_name, 0 as archived
    FROM transactions t
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.id = ? AND t.tenant_id = ?
  `).get(id, tenantId) as any;

    // Not found live — it may have gone through End-of-Day settlement, which moves it to
    // archived_transactions. Fall back there so an old invoice can still be opened/viewed
    // (the frontend treats `archived: true` as read-only for delete, but PUT now supports it too).
    let itemsTable = "transaction_items";
    let paymentsTable = "payments";
    if (!transaction) {
      transaction = db.prepare(`
      SELECT t.*, s.name as stakeholder_name, u.name as user_name, 1 as archived
      FROM archived_transactions t
      LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = ? AND t.tenant_id = ?
    `).get(id, tenantId) as any;
      itemsTable = "archived_transaction_items";
      paymentsTable = "archived_payments";
    }

    if (!transaction) return null;

    const items = db.prepare(`
    SELECT ti.*, p.name as product_name, p.barcode, p.cost
    FROM ${itemsTable} ti
    JOIN products p ON ti.product_id = p.id
    WHERE ti.transaction_id = ?
  `).all(id);

    transaction.items = items.map((item: any) => ({
      ...item,
      price: item.unit_price,
      // A line recorded before the unit_cost snapshot existed (or whose backfill missed it) falls
      // back to the product's current cost — the same best-available estimate the one-time
      // unit_cost_backfill_v1 migration used.
      unit_cost: item.unit_cost ?? item.cost ?? null,
      discount: item.discount_type ? { type: item.discount_type, value: item.discount_value } : undefined,
      ...displayFields(item),
    }));

    transaction.discount = transaction.discount_type ? { type: transaction.discount_type, value: transaction.discount_value } : undefined;

    // Include payments and paid_amount for edit support. Credit ("on account") payments are NOT
    // real money received, so they don't count toward paid_amount — mirroring how POST computes
    // the unpaid remainder that goes to the customer's balance.
    const payments = db.prepare(`SELECT * FROM ${paymentsTable} WHERE transaction_id = ? ORDER BY created_at ASC`).all(id) as any[];
    const paidAmount = payments.reduce((sum: number, p: any) => p.method === 'credit' ? sum : sum + (p.amount / (p.exchange_rate || 1)), 0);
    transaction.payments = payments;
    transaction.paid_amount = paidAmount;

    // stakeholder_balance (current) and balance_effect (this tx's own effect on it — BALANCE MATH,
    // server/paymentMethods.ts: store_credit doesn't count as paid here either) for the invoice
    // editor's "old / new balance" panel and the receipt's balance block.
    if (transaction.stakeholder_id) {
      const stRow = db.prepare("SELECT balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(transaction.stakeholder_id, tenantId) as any;
      transaction.stakeholder_balance = stRow ? (stRow.balance || 0) : null;
      transaction.balance_effect = transactionBalanceEffect(
        transaction.type,
        Number(id),
        transaction.total_amount,
        paymentsTable as 'payments' | 'archived_payments'
      );
    } else {
      transaction.stakeholder_balance = null;
      transaction.balance_effect = null;
    }

    return transaction;
  }

  // What is still refundable on a sale: per line, sold / already refunded / remaining quantity and
  // the amount one unit refunds (line discount prorated, invoice-level discount/tax applied through
  // chargedFactor) -- exactly the math POST /api/transactions uses for a refund.
  app.get("/api/transactions/:id/refundable", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const id = Number(req.params.id);
    const original = findOriginalSale(tenantId, id);
    if (!original) return res.status(404).json({ error: "Transaction not found" });
    if (original.tx.type !== 'sale') return res.status(400).json({ error: "Only a sale can be refunded." });
    const factor = chargedFactor(original);
    const states = refundLineStates(tenantId, id, original.items);
    const archived = !db.prepare("SELECT 1 FROM transactions WHERE id = ? AND tenant_id = ?").get(id, tenantId);
    const productStmt = db.prepare("SELECT name, barcode FROM products WHERE id = ? AND tenant_id = ?");
    // One entry per original sale LINE. Quantities and prices are expressed in the line's own unit
    // (a carton line: sold_qty in cartons, unit_price / unit_refund per carton); base-unit lines have
    // uom_id null and uom_factor 1, so they read exactly as before.
    const lines = states.map(({ item: oi, refunded: refundedPieces, remaining }) => {
      const product = productStmt.get(oi.product_id, tenantId) as any;
      const perPieceLine = lineTotal(oi.unit_price, oi.quantity, { type: oi.discount_type, value: oi.discount_value }) / (oi.quantity || 1);
      const uomFactor = oi.uom_factor || 1;
      return {
        item_id: oi.id,
        product_id: oi.product_id,
        product_name: product?.name ?? `#${oi.product_id}`,
        barcode: product?.barcode ?? null,
        uom_id: oi.uom_id ?? null,
        uom_name: oi.uom_name ?? null,
        uom_factor: uomFactor,
        sold_qty: oi.quantity / uomFactor,
        refunded_qty: refundedPieces / uomFactor,
        remaining_qty: remaining / uomFactor,
        unit_price: Math.round(oi.unit_price * uomFactor * 1e6) / 1e6,
        discount_type: oi.discount_type,
        discount_value: oi.discount_value,
        unit_refund: Math.round(perPieceLine * factor * uomFactor * 1e6) / 1e6,
      };
    });
    const paid = db.prepare(`SELECT IFNULL(SUM(amount / exchange_rate), 0) as p FROM ${archived ? 'archived_payments' : 'payments'} WHERE transaction_id = ? AND method != 'credit'`).get(id) as any;
    const refunds = db.prepare(`
      SELECT * FROM (
        SELECT id, created_at, total_amount, 0 as archived FROM transactions WHERE tenant_id = ? AND type = 'refund' AND original_transaction_id = ?
        UNION ALL
        SELECT id, created_at, total_amount, 1 as archived FROM archived_transactions WHERE tenant_id = ? AND type = 'refund' AND original_transaction_id = ?
      ) ORDER BY created_at
    `).all(tenantId, id, tenantId, id);
    const stakeholder = original.tx.stakeholder_id
      ? db.prepare("SELECT id, name, balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(original.tx.stakeholder_id, tenantId)
      : null;
    res.json({
      transaction: { id, created_at: original.tx.created_at, total_amount: original.tx.total_amount, paid_amount: paid.p, archived: archived ? 1 : 0 },
      stakeholder,
      factor,
      lines,
      refunds,
    });
  });

  app.get("/api/transactions/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const transaction = buildTransactionDetail(tenantId, req.params.id);
    if (!transaction) return res.status(404).json({ error: "Transaction not found" });
    res.json(transaction);
  });

  app.get("/api/transactions/:id/edits", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const edits = getTransactionEdits(tenantId, Number(req.params.id));
    res.json(edits);
  });

  // Edits a live OR settled (archived) sale/purchase invoice in place — lines, prices, discounts,
  // customer, notes/reference, and payments (add/remove). See server/invoiceEdit.ts for the full
  // stock/WAC/balance/audit-trail logic; this route just calls it and re-renders the same shape
  // GET /api/transactions/:id returns.
  app.put("/api/transactions/:id", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    try {
      const { id, balance_before, balance_after } = await editTransaction(tenantId, Number(req.params.id), req.body || {});
      const transaction = buildTransactionDetail(tenantId, id);
      transaction.balance_before = balance_before;
      transaction.balance_after = balance_after;
      broadcast({ type: 'TRANSACTIONS_UPDATED' }, tenantId);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      broadcast({ type: 'STAKEHOLDERS_UPDATED' }, tenantId);
      res.json(transaction);
    } catch (error: any) {
      if (error instanceof ValidationError) {
        return res.status(error.status).json(validationErrorBody(error));
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/logs", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const logs = db.prepare(`
    SELECT l.*, u.name as user_name 
    FROM user_logs l 
    LEFT JOIN users u ON l.user_id = u.id 
    WHERE l.tenant_id = ? 
    ORDER BY l.created_at DESC 
    LIMIT 100
  `).all(tenantId);
    res.json(logs);
  });

  app.get("/api/reports/sales", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const sales = db.prepare(`
    SELECT
      DATE(created_at, 'localtime') as date,
      SUM(CASE WHEN type = 'refund' THEN -total_amount ELSE total_amount END) as total,
      COUNT(id) as count
    FROM (
      SELECT id, type, total_amount, created_at FROM transactions WHERE tenant_id = ? AND type != 'purchase'
      UNION ALL
      SELECT id, type, total_amount, created_at FROM archived_transactions WHERE tenant_id = ? AND type != 'purchase'
    )
    GROUP BY DATE(created_at, 'localtime')
    ORDER BY date DESC
    LIMIT 30
  `).all(tenantId, tenantId);
    res.json(sales);
  });

  app.get("/api/reports/daily-sales-by-payment", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const date = req.query.date || localToday();
    // total_usd: payments are stored in their own currency (payments.amount), so a per-method
    // breakdown that just SUMs amount silently mixes currencies — add the USD-converted total too
    // (amount / exchange_rate) so callers can reconcile against total_amount-based reports.
    const sales = db.prepare(`
    SELECT method, SUM(amount) as total, SUM(amount / exchange_rate) as total_usd FROM (
      SELECT p.method, p.amount, p.exchange_rate, p.created_at
      FROM payments p JOIN transactions t ON p.transaction_id = t.id
      WHERE t.tenant_id = ? AND t.type = 'sale' AND date(p.created_at, 'localtime') = ?
      UNION ALL
      SELECT p.method, p.amount, p.exchange_rate, p.created_at
      FROM archived_payments p JOIN archived_transactions t ON p.transaction_id = t.id
      WHERE t.tenant_id = ? AND t.type = 'sale' AND date(p.created_at, 'localtime') = ?
    )
    GROUP BY method
  `).all(tenantId, date, tenantId, date);
    res.json(sales);
  });

  app.get("/api/reports/daily-sales-by-customer", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const date = req.query.date || localToday();
    const sales = db.prepare(`
    SELECT s.name as customer, SUM(t.total_amount) as total
    FROM (
      SELECT stakeholder_id, total_amount FROM transactions WHERE tenant_id = ? AND type = 'sale' AND date(created_at, 'localtime') = ?
      UNION ALL
      SELECT stakeholder_id, total_amount FROM archived_transactions WHERE tenant_id = ? AND type = 'sale' AND date(created_at, 'localtime') = ?
    ) t
    JOIN stakeholders s ON t.stakeholder_id = s.id
    GROUP BY s.id
  `).all(tenantId, date, tenantId, date);
    res.json(sales);
  });

  // Unlike the other /api/reports/* endpoints, this deliberately does NOT union in
  // archived_transactions. Settlement banks each stakeholder's then-outstanding balance into
  // stakeholders.balance_baseline as a single lump sum (see /api/tenant/settlement and
  // server/balance.ts) — there is no per-invoice way to collect against an archived invoice
  // anymore, so listing its stale "unpaid" amount here would just be misleading, not actionable.
  app.get("/api/reports/unpaid-sales", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    // payments.amount is in the PAYMENT's own currency, not the transaction's USD basis — must
    // divide by exchange_rate before comparing to total_amount (USD), and a 'credit' entry isn't
    // real money received, so it can't count toward "paid" either (both bugs the balance/costing
    // work surfaced — this mirrors server/balance.ts's unpaidNonCredit).
    const unpaid = db.prepare(`
    SELECT * FROM (
        SELECT t.id, s.name as customer, t.total_amount,
               (t.total_amount - (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM payments WHERE transaction_id = t.id AND method != 'credit')) as balance,
               t.created_at
        FROM transactions t
        JOIN stakeholders s ON t.stakeholder_id = s.id
        WHERE t.tenant_id = ? AND t.type = 'sale'
    ) WHERE balance > 0.01
    ORDER BY created_at DESC
  `).all(tenantId);
    res.json(unpaid);
  });

  app.get("/api/reports/unpaid-purchases", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const unpaid = db.prepare(`
    SELECT * FROM (
        SELECT t.id, s.name as supplier, t.total_amount,
               (t.total_amount - (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM payments WHERE transaction_id = t.id AND method != 'credit')) as balance,
               t.created_at
        FROM transactions t
        JOIN stakeholders s ON t.stakeholder_id = s.id
        WHERE t.tenant_id = ? AND t.type = 'purchase'
    ) WHERE balance > 0.01
    ORDER BY created_at DESC
  `).all(tenantId);
    res.json(unpaid);
  });

  app.post("/api/reports/custom-builder", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const {
      stakeholderId,
      type,
      status,
      fromDate,
      toDate,
      productId,
      invoiceNumber,
      category
    } = req.body;

    // A settled invoice moves from transactions/transaction_items/payments into their archived_*
    // counterparts (see /api/tenant/settlement), so this search has to run against both sets of
    // tables and UNION the results, or it silently misses anything from before the last
    // settlement — the exact "custom builder can't find an old invoice" bug this fixes.
    const buildFilter = (itemsTable: string) => {
      let sql = "";
      const params: any[] = [];
      if (stakeholderId) { sql += " AND t.stakeholder_id = ?"; params.push(stakeholderId); }
      if (type) { sql += " AND t.type = ?"; params.push(type); }
      if (fromDate) { sql += " AND date(t.created_at, 'localtime') >= date(?)"; params.push(fromDate); }
      if (toDate) { sql += " AND date(t.created_at, 'localtime') <= date(?)"; params.push(toDate); }
      if (invoiceNumber) { sql += " AND t.id = ?"; params.push(invoiceNumber); }
      if (productId) {
        sql += ` AND t.id IN (SELECT transaction_id FROM ${itemsTable} WHERE product_id = ?)`;
        params.push(productId);
      }
      if (category) {
        sql += ` AND t.id IN (SELECT ti.transaction_id FROM ${itemsTable} ti JOIN products p ON ti.product_id = p.id WHERE p.category = ?)`;
        params.push(category);
      }
      return { sql, params };
    };

    const buildBranch = (txTable: string, itemsTable: string, paymentsTable: string) => {
      const filter = buildFilter(itemsTable);
      let sql = `
      SELECT
        t.id as invoice_no,
        t.created_at as date,
        t.type,
        s.name as stakeholder,
        t.total_amount,
        t.currency,
        (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM ${paymentsTable} WHERE transaction_id = t.id AND method != 'credit') as paid_amount,
        (t.total_amount - (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM ${paymentsTable} WHERE transaction_id = t.id AND method != 'credit')) as balance,
        u.name as processed_by
      FROM ${txTable} t
      LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.tenant_id = ?${filter.sql}`;
      if (status === 'paid') {
        sql += ` AND (t.total_amount - (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM ${paymentsTable} WHERE transaction_id = t.id AND method != 'credit')) <= 0.01`;
      } else if (status === 'unpaid') {
        sql += ` AND (t.total_amount - (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM ${paymentsTable} WHERE transaction_id = t.id AND method != 'credit')) > 0.01`;
      }
      return { sql, params: [tenantId, ...filter.params] };
    };

    const live = buildBranch("transactions", "transaction_items", "payments");
    const archived = buildBranch("archived_transactions", "archived_transaction_items", "archived_payments");
    const query = `${live.sql} UNION ALL ${archived.sql} ORDER BY date DESC`;
    const params = [...live.params, ...archived.params];

    try {
      const results = db.prepare(query).all(...params);
      res.json(results);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Balance changelog for one stakeholder (newest first). Written by server/balance.ts.
  app.get("/api/stakeholders/:id/balance-log", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "500"), 10) || 500, 1), 5000);
    const rows = db.prepare(`
      SELECT l.id, l.stakeholder_id, l.created_at, l.source, l.reference_id, l.delta, l.balance_before, l.balance_after,
             l.user_id, l.note, u.name AS user_name
      FROM stakeholder_balance_log l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE l.tenant_id = ? AND l.stakeholder_id = ?
      ORDER BY l.id DESC LIMIT ?
    `).all(tenantId, req.params.id, limit);
    res.json(rows);
  });

  app.get("/api/reports/customer-statement/:id", authenticate, (req: any, res) => {
    // Events + reconciling opening line so the last running balance equals stakeholders.balance
    // (server/statement.ts). Includes archived (settled) invoices.
    res.json(buildStatement(req.session.tenantId, req.params.id));
  });

  // Cash Flow & Reports
  app.get("/api/cash-flow/summary", authenticate, (req: any, res) => {
    // The register spans from the last close (Cash Out or Settlement) through now — see
    // lastRegisterClose() — not a calendar "today". The computation lives in server/settlement.ts
    // so the settlement snapshot and this live view can never drift apart.
    // ?scope=day → since the last settlement (the admin's whole-day view); default = current shift.
    res.json(computeRegisterSummary(req.session.tenantId, parseRegisterScope(req.query.scope)));
  });

  // POST /api/cash-flow, GET /api/cash-flow, the admin edit and the analytics live in server/cashFlow.ts.

  // Balance payment: collect from customer or pay supplier
  app.post("/api/balance-payment", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = tenantUserId(tenantId, req.body.user_id);
    const { stakeholder_id, amount, currency, exchange_rate, direction } = req.body;
    // direction: 'collect' = customer pays us, 'pay' = we pay supplier

    if (!stakeholder_id || !amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid payment data" });
    }

    const stakeholder = db.prepare("SELECT * FROM stakeholders WHERE id = ? AND tenant_id = ?").get(stakeholder_id, tenantId) as any;
    if (!stakeholder) return res.status(404).json({ error: "Stakeholder not found" });

    const amountUSD = amount / (exchange_rate || 1);
    const cur = currency || 'USD';
    const exRate = exchange_rate || 1;
    const bpNote = `${amount} ${cur}`;

    const balancePayment = db.transaction(() => {
      // A balance collection/payment isn't tied to a transaction, so it moves the derived balance
      // toward zero via the stakeholder's BASELINE (negative = owes, so a payment adds toward 0).
      if (direction === 'collect') {
        adjustStakeholderBaseline(stakeholder_id, tenantId, amountUSD, { source: 'balance_collection', user_id: userId, note: bpNote });
        db.prepare("INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason, category, counterparty) VALUES (?, ?, 'in', ?, ?, ?, ?, 'customer_collection', ?)")
          .run(tenantId, userId, amount, cur, exRate, `Balance collection from ${stakeholder.name}`, stakeholder.name);
      } else {
        // Paying a supplier → reduce their outstanding (move toward zero), cash goes out
        adjustStakeholderBaseline(stakeholder_id, tenantId, amountUSD, { source: 'supplier_payment', user_id: userId, note: bpNote });
        db.prepare("INSERT INTO cash_flow (tenant_id, user_id, type, amount, currency, exchange_rate, reason, category, counterparty) VALUES (?, ?, 'out', ?, ?, ?, ?, 'supplier_payment', ?)")
          .run(tenantId, userId, amount, cur, exRate, `Payment to supplier ${stakeholder.name}`, stakeholder.name);
      }
    });

    try {
      balancePayment();
      logAction(tenantId, userId, `Balance ${direction === 'collect' ? 'Collection' : 'Payment'}`,
        `${stakeholder.name}: ${amount} ${cur}`);
      broadcast({ type: 'CASH_FLOW_UPDATED' }, tenantId);
      broadcast({ type: 'STAKEHOLDERS_UPDATED' }, tenantId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/reports/daily", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = tenantUserId(tenantId, req.body.user_id);
    const {
      opening_balance,
      total_sales,
      total_purchases,
      total_cash_in,
      total_cash_out,
      closing_balance,
      actual_balance,
      notes
    } = req.body;

    // The date is decided here, not trusted from the client — the frontend used to compute it
    // with `.toISOString()`, which is UTC and drifts from the store's local business day (see
    // localToday()). Report dates and cash-flow "today" must agree or the opening-balance carry
    // in /api/cash-flow/summary silently breaks.
    const date = localToday();
    const difference = actual_balance - closing_balance;

    const result = db.prepare(`
    INSERT INTO daily_reports
    (tenant_id, user_id, date, opening_balance, total_sales, total_purchases, total_cash_in, total_cash_out, closing_balance, actual_balance, difference, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, userId, date, opening_balance, total_sales, total_purchases, total_cash_in, total_cash_out, closing_balance, actual_balance, difference, notes);

    logAction(tenantId, userId, 'Daily Report Created', `Date: ${date}, Closing: ${closing_balance}, Actual: ${actual_balance}`);
    res.json({ success: true, id: result.lastInsertRowid });
  });

  app.get("/api/reports/daily", authenticate, (req: any, res) => {
    // Every column plus effective_actual/expected/difference, corrections_count, changed_after_close.
    res.json(listDailyReports(req.session.tenantId));
  });

  app.post("/api/reports/yearly", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const userId = tenantUserId(tenantId, req.body.user_id);
    const { year, notes } = req.body;

    // Calculate totals for the year
    // Ignored archived_transactions entirely, so any year containing an End-of-Day settlement
    // (which moves rows out of `transactions`) silently undercounted — and never subtracted
    // refunds, so a refunded sale still counted at its full original amount.
    const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN type = 'sale' THEN total_amount WHEN type = 'refund' THEN -total_amount ELSE 0 END) as sales,
      SUM(CASE WHEN type = 'purchase' THEN total_amount ELSE 0 END) as purchases
    FROM (
      SELECT type, total_amount, created_at FROM transactions WHERE tenant_id = ?
      UNION ALL
      SELECT type, total_amount, created_at FROM archived_transactions WHERE tenant_id = ?
    )
    WHERE strftime('%Y', created_at, 'localtime') = ?
  `).get(tenantId, tenantId, String(year)) as any;

    const totalSales = totals?.sales || 0;
    const totalPurchases = totals?.purchases || 0;
    const totalProfit = totalSales - totalPurchases;

    const result = db.prepare(`
    INSERT INTO yearly_reports (tenant_id, user_id, year, total_sales, total_purchases, total_profit, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, userId, year, totalSales, totalPurchases, totalProfit, notes);

    logAction(tenantId, userId, 'Yearly Report Created', `Year: ${year}, Profit: ${totalProfit}`);
    res.json({ success: true, id: result.lastInsertRowid });
  });

  app.get("/api/reports/yearly", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const reports = db.prepare("SELECT r.*, u.name as user_name FROM yearly_reports r LEFT JOIN users u ON r.user_id = u.id WHERE r.tenant_id = ? ORDER BY r.year DESC").all(tenantId);
    res.json(reports);
  });


  // --- PURCHASE MANAGEMENT ---
  app.get("/api/purchases", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { status, supplier_id, from, to, search } = req.query;

    // Settled purchases live in archived_* — list both, the same way invoice history does, or a
    // supplier's older purchase invoices vanish from this screen after every End-of-Day settlement.
    // paid_amount excludes 'credit' (on-account) payments: they are not money paid to the supplier.
    const branch = (txTable: string, itemsTable: string, paymentsTable: string, archivedFlag: number) => {
      let sql = `
      SELECT
        t.id, t.created_at, t.total_amount, t.currency, t.exchange_rate, t.status, t.terminal_id, t.terminal_sequence,
        t.discount_type, t.discount_value, t.tax_type, t.tax_value, t.reference, t.notes, t.edited_at, t.edit_count,
        s.name as supplier_name, s.id as supplier_id, ${archivedFlag} as archived,
        (SELECT COUNT(*) FROM ${itemsTable} WHERE transaction_id = t.id) as item_count,
        (SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM ${paymentsTable} WHERE transaction_id = t.id AND method != 'credit') as paid_amount
      FROM ${txTable} t
      LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
      WHERE t.tenant_id = ? AND t.type = 'purchase'`;
      const params: any[] = [tenantId];
      if (supplier_id) { sql += " AND t.stakeholder_id = ?"; params.push(supplier_id); }
      if (from) { sql += " AND date(t.created_at, 'localtime') >= date(?)"; params.push(from); }
      if (to) { sql += " AND date(t.created_at, 'localtime') <= date(?)"; params.push(to); }
      if (search) { sql += " AND (s.name LIKE ? OR t.reference LIKE ? OR CAST(t.id AS TEXT) = ?)"; params.push(`%${search}%`, `%${search}%`, String(search)); }
      const paid = `(SELECT IFNULL(SUM(amount / exchange_rate), 0) FROM ${paymentsTable} WHERE transaction_id = t.id AND method != 'credit')`;
      if (status === 'paid') sql += ` AND (t.total_amount - ${paid}) <= 0.01`;
      else if (status === 'unpaid') sql += ` AND (t.total_amount - ${paid}) > 0.01`;
      return { sql, params };
    };
    const live = branch("transactions", "transaction_items", "payments", 0);
    const arch = branch("archived_transactions", "archived_transaction_items", "archived_payments", 1);

    try {
      const purchases = db.prepare(`SELECT * FROM (${live.sql} UNION ALL ${arch.sql}) ORDER BY created_at DESC`).all(...live.params, ...arch.params);
      res.json(purchases);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchases/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;

    const findIn = (txTable: string) => db.prepare(`
    SELECT
      t.*,
      s.name as supplier_name,
      s.email as supplier_email,
      s.phone as supplier_phone,
      u.name as user_name
    FROM ${txTable} t
    LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
    LEFT JOIN users u ON t.user_id = u.id
    WHERE t.id = ? AND t.tenant_id = ? AND t.type = 'purchase'
  `).get(id, tenantId) as any;
    // A settled purchase has moved to the archive — fall back there so it can still be opened.
    let purchase = findIn("transactions");
    let archived = 0;
    if (!purchase) { purchase = findIn("archived_transactions"); archived = 1; }

    if (!purchase) return res.status(404).json({ error: "Purchase order not found" });
    purchase.archived = archived;

    const items = (db.prepare(`
    SELECT ti.*, p.name as product_name, p.barcode, p.category, p.unit, p.cost, p.cost_lbp
    FROM ${archived ? "archived_transaction_items" : "transaction_items"} ti
    JOIN products p ON ti.product_id = p.id
    WHERE ti.transaction_id = ?
  `).all(id) as any[]).map((item) => ({ ...item, ...displayFields(item) }));

    const payments = db.prepare(`
    SELECT * FROM ${archived ? "archived_payments" : "payments"} WHERE transaction_id = ? ORDER BY created_at ASC
  `).all(id);

    // Credit ("on account") payments are not money paid — same rule as balances and GET /api/transactions/:id.
    const paidAmount = (payments as any[]).reduce((sum: number, p: any) => p.method === 'credit' ? sum : sum + (p.amount / (p.exchange_rate || 1)), 0);

    res.json({
      ...purchase,
      items,
      payments,
      paid_amount: paidAmount,
      balance: purchase.total_amount - paidAmount
    });
  });

  app.put("/api/purchases/:id/receive", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;

    const purchase = db.prepare("SELECT * FROM transactions WHERE id = ? AND tenant_id = ? AND type = 'purchase'").get(id, tenantId) as any;
    if (!purchase) return res.status(404).json({ error: "Purchase order not found" });

    db.prepare("UPDATE transactions SET status = 'received' WHERE id = ? AND tenant_id = ?").run(id, tenantId);
    logAction(tenantId, 1, 'Purchase Received', `PO #${id} marked as received`);
    broadcast({ type: 'PURCHASES_UPDATED' }, tenantId);
    res.json({ success: true });
  });

  // --- INVENTORY / STOCK ADJUSTMENTS ---

  // Manually correct a product's stock count (stock take, damage, shrinkage, etc.), keeping an
  // audit trail in stock_adjustments — either the new absolute quantity or a +/- delta.
  app.post("/api/stock/adjust", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { product_id, new_qty, delta, reason } = req.body;

    const product = db.prepare("SELECT id, stock, cost, track_inventory FROM products WHERE id = ? AND tenant_id = ?").get(product_id, tenantId) as any;
    if (!product) return res.status(404).json({ error: "Product not found." });

    const qtyBefore = product.stock || 0;
    let qtyAfter: number;
    if (new_qty !== undefined && new_qty !== null) {
      if (!Number.isFinite(new_qty)) return res.status(400).json({ error: "Invalid new_qty." });
      qtyAfter = new_qty;
    } else if (delta !== undefined && delta !== null) {
      if (!Number.isFinite(delta)) return res.status(400).json({ error: "Invalid delta." });
      qtyAfter = qtyBefore + delta;
    } else {
      return res.status(400).json({ error: "Provide either new_qty or delta." });
    }
    const appliedDelta = qtyAfter - qtyBefore;
    // Optional guard: a manual correction may not push a tracked product below zero (an already
    // negative product may still be corrected upwards).
    if (getSettingsMap(tenantId).allow_negative_stock === '0' && product.track_inventory !== 0 && qtyAfter < -1e-9 && appliedDelta < 0) {
      return res.status(409).json({
        error: "Stock can't go below zero.",
        code: 'INSUFFICIENT_STOCK',
        field: (new_qty !== undefined && new_qty !== null) ? 'new_qty' : 'delta',
        available: qtyBefore,
        product_id: product.id,
      });
    }
    const userId = tenantUserId(tenantId, req.body.user_id);

    const run = db.transaction(() => {
      db.prepare("UPDATE products SET stock = ? WHERE id = ? AND tenant_id = ?").run(qtyAfter, product_id, tenantId);
      return db.prepare(
        "INSERT INTO stock_adjustments (tenant_id, product_id, user_id, qty_before, qty_after, delta, reason, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(tenantId, product_id, userId, qtyBefore, qtyAfter, appliedDelta, reason || null, product.cost ?? null);
    });

    try {
      const info = run();
      logAction(tenantId, userId, 'Stock Adjusted', `Product: ${product_id}, ${qtyBefore} -> ${qtyAfter} (${reason || 'no reason given'})`);
      broadcast({ type: 'PRODUCTS_UPDATED' }, tenantId);
      res.json({ id: info.lastInsertRowid, product_id, qty_before: qtyBefore, qty_after: qtyAfter, delta: appliedDelta });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/stock/adjustments", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { product_id, from, to } = req.query;

    let query = `
      SELECT sa.*, p.name as product_name, u.name as user_name
      FROM stock_adjustments sa
      LEFT JOIN products p ON sa.product_id = p.id
      LEFT JOIN users u ON sa.user_id = u.id
      WHERE sa.tenant_id = ?`;
    const params: any[] = [tenantId];
    if (product_id) { query += " AND sa.product_id = ?"; params.push(product_id); }
    if (from) { query += " AND date(sa.created_at) >= date(?)"; params.push(from); }
    if (to) { query += " AND date(sa.created_at) <= date(?)"; params.push(to); }
    query += " ORDER BY sa.created_at DESC";

    res.json(db.prepare(query).all(...params));
  });

  // Unified stock ledger for one product: sales/refunds/purchases (live + archived) and manual
  // adjustments, oldest first, each carrying the running quantity on hand AFTER that event. The
  // running total is computed BACKWARDS from the product's current stock (rather than forwards
  // from an assumed starting point) so it's always consistent with what's actually on the shelf,
  // even if some history predates this ledger.
  app.get("/api/stock/movements/:productId", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const productId = req.params.productId;

    const product = db.prepare("SELECT stock FROM products WHERE id = ? AND tenant_id = ?").get(productId, tenantId) as any;
    if (!product) return res.status(404).json({ error: "Product not found." });

    const txRows = db.prepare(`
      SELECT * FROM (
        SELECT t.id as transaction_id, t.created_at as date, t.type,
               CASE WHEN t.type = 'sale' THEN -ti.quantity ELSE ti.quantity END as quantity_change,
               ti.quantity as quantity, 0 as archived
        FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.tenant_id = ? AND ti.product_id = ? AND t.type IN ('sale', 'purchase', 'refund')
        UNION ALL
        SELECT t.id as transaction_id, t.created_at as date, t.type,
               CASE WHEN t.type = 'sale' THEN -ti.quantity ELSE ti.quantity END as quantity_change,
               ti.quantity as quantity, 1 as archived
        FROM archived_transaction_items ti JOIN archived_transactions t ON ti.transaction_id = t.id
        WHERE t.tenant_id = ? AND ti.product_id = ? AND t.type IN ('sale', 'purchase', 'refund')
      )
    `).all(tenantId, productId, tenantId, productId) as any[];

    const adjustmentRows = db.prepare(
      "SELECT id, created_at as date, delta as quantity_change, qty_before, qty_after, reason FROM stock_adjustments WHERE tenant_id = ? AND product_id = ?"
    ).all(tenantId, productId) as any[];

    const events = [
      ...txRows.map((r) => ({
        date: r.date,
        type: r.type,
        transaction_id: r.transaction_id,
        archived: !!r.archived,
        quantity: r.quantity,
        quantity_change: r.quantity_change,
      })),
      ...adjustmentRows.map((a) => ({
        date: a.date,
        type: 'adjustment',
        adjustment_id: a.id,
        reason: a.reason,
        quantity_change: a.quantity_change,
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const totalChange = events.reduce((sum, e) => sum + (e.quantity_change || 0), 0);
    let running = (product.stock || 0) - totalChange;
    for (const e of events) {
      running += e.quantity_change || 0;
      (e as any).balance_after = running;
    }

    res.json(events);
  });

  // --- PRINTER MANAGEMENT ---

  // Scan for available printers (USB via OS, Network via TCP port 9100)
  app.get("/api/printers/scan", authenticate, async (req: any, res) => {
    const connType = req.query.type as string; // 'usb' | 'network'

    try {
      if (connType === 'usb') {
        // Use PowerShell to list OS-installed printers with their port names
        const { exec } = require('child_process');
        exec(
          'powershell -NoProfile -Command "Get-Printer | Select-Object Name,PortName | ConvertTo-Json -Compress"',
          { timeout: 12000 },
          (err: any, stdout: string) => {
            if (err) {
              console.error('USB printer scan error:', err.message);
              return res.json({ printers: [] });
            }
            try {
              const raw = JSON.parse(stdout.trim());
              const list = Array.isArray(raw) ? raw : [raw];
              const printers = list
                .filter((p: any) => p.PortName && !['PORTPROMPT:', 'FILE:', 'NPCAP:', 'XPSPort:'].some(x => (p.PortName || '').startsWith(x)))
                .map((p: any) => ({ name: p.Name, address: p.PortName }));
              res.json({ printers });
            } catch {
              res.json({ printers: [] });
            }
          }
        );
      } else if (connType === 'network') {
        // Detect local subnet then probe port 9100 (RAW printing) across all 254 hosts
        const os = require('os');
        const net = require('net');

        let subnet = '192.168.1';
        const ifaces = os.networkInterfaces() as Record<string, any[]>;
        for (const iface of Object.values(ifaces)) {
          for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) {
              subnet = addr.address.split('.').slice(0, 3).join('.');
              break;
            }
          }
        }

        const found: { name: string; address: string }[] = [];
        const TIMEOUT_MS = 600;
        const PORT = 9100;

        const probes = Array.from({ length: 254 }, (_, i) => {
          const ip = `${subnet}.${i + 1}`;
          return new Promise<void>(resolve => {
            const socket = new net.Socket();
            socket.setTimeout(TIMEOUT_MS);
            socket.on('connect', () => {
              found.push({ name: `Network Printer (${ip})`, address: ip });
              socket.destroy();
              resolve();
            });
            socket.on('error', () => { socket.destroy(); resolve(); });
            socket.on('timeout', () => { socket.destroy(); resolve(); });
            socket.connect(PORT, ip);
          });
        });

        await Promise.all(probes);
        res.json({ printers: found });
      } else {
        res.json({ printers: [] });
      }
    } catch (err: any) {
      console.error('Printer scan error:', err.message);
      res.json({ printers: [] });
    }
  });

  app.get("/api/printers", authenticate, (req: any, res) => {
    const printers = db.prepare("SELECT * FROM printers WHERE tenant_id = ? ORDER BY type, name").all(req.session.tenantId);
    res.json(printers);
  });


  app.post("/api/printers", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { name, type, connection, address, paper_width, is_default, enabled, arabic_codepage, arabic_encoding } = req.body;

    // If this is set as default for its type, unset others of same type
    if (is_default) {
      db.prepare("UPDATE printers SET is_default = 0 WHERE tenant_id = ? AND type = ?").run(tenantId, type);
    }

    const result = db.prepare(
      "INSERT INTO printers (tenant_id, name, type, connection, address, paper_width, is_default, enabled, arabic_codepage, arabic_encoding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(tenantId, name, type, connection, address || '', paper_width || 80, is_default ? 1 : 0, enabled !== undefined ? (enabled ? 1 : 0) : 1, parseCodepage(arabic_codepage), parseArabicEncoding(arabic_encoding));

    logAction(tenantId, 1, 'Printer Added', `Name: ${name}, Type: ${type}, Connection: ${connection}`);
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
    res.json({ id: result.lastInsertRowid });
  });

  app.put("/api/printers/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { id } = req.params;
    const { name, type, connection, address, paper_width, is_default, enabled, arabic_codepage, arabic_encoding } = req.body;

    // If this is set as default for its type, unset others of same type
    if (is_default) {
      db.prepare("UPDATE printers SET is_default = 0 WHERE tenant_id = ? AND type = ? AND id != ?").run(tenantId, type, id);
    }

    db.prepare(
      "UPDATE printers SET name = ?, type = ?, connection = ?, address = ?, paper_width = ?, is_default = ?, enabled = ?, arabic_codepage = ?, arabic_encoding = ? WHERE id = ? AND tenant_id = ?"
    ).run(name, type, connection, address || '', paper_width || 80, is_default ? 1 : 0, enabled ? 1 : 0, parseCodepage(arabic_codepage), parseArabicEncoding(arabic_encoding), id, tenantId);

    logAction(tenantId, 1, 'Printer Updated', `ID: ${id}, Name: ${name}`);
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
    res.json({ success: true });
  });

  app.delete("/api/printers/:id", authenticate, (req: any, res) => {
    const tenantId = req.session.tenantId;
    db.prepare("DELETE FROM printers WHERE id = ? AND tenant_id = ?").run(req.params.id, tenantId);
    logAction(tenantId, 1, 'Printer Deleted', `ID: ${req.params.id}`);
    broadcast({ type: 'SETTINGS_UPDATED' }, tenantId);
    res.json({ success: true });
  });

  // --- ESC/POS PRINTING & CASH DRAWER ---

  // Arabic as printer text when a code page has been chosen for this printer, else images.
  function printerArabicMode(printer: any) {
    const codepage = parseCodepage(printer?.arabic_codepage);
    return codepage === null ? null : { codepage, encoding: parseArabicEncoding(printer.arabic_encoding) };
  }

  function resolveReceiptPrinter(tenantId: number, printerId?: number) {
    if (printerId) {
      return db.prepare("SELECT * FROM printers WHERE id = ? AND tenant_id = ? AND enabled = 1").get(printerId, tenantId) as any;
    }
    return db.prepare("SELECT * FROM printers WHERE tenant_id = ? AND type = 'receipt' AND is_default = 1 AND enabled = 1").get(tenantId) as any;
  }

  app.post("/api/print/receipt", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { transactionId, printerId, openDrawer } = req.body;

    try {
      const printer = resolveReceiptPrinter(tenantId, printerId);
      if (!printer) return res.status(404).json({ error: "No enabled receipt printer configured" });

      const transaction = db.prepare(`
        SELECT t.*, s.name as stakeholder_name, s.address as stakeholder_address
        FROM transactions t
        LEFT JOIN stakeholders s ON t.stakeholder_id = s.id
        WHERE t.id = ? AND t.tenant_id = ?
      `).get(transactionId, tenantId) as any;
      if (!transaction) return res.status(404).json({ error: "Transaction not found" });

      const items = db.prepare(`
        SELECT ti.*, p.name FROM transaction_items ti JOIN products p ON ti.product_id = p.id WHERE ti.transaction_id = ?
      `).all(transactionId) as any[];
      transaction.items = items.map((i: any) => ({
        ...i,
        price: i.unit_price,
        discount: i.discount_type ? { type: i.discount_type, value: i.discount_value } : undefined
      }));
      transaction.discount = transaction.discount_type ? { type: transaction.discount_type, value: transaction.discount_value } : undefined;
      transaction.payments = db.prepare("SELECT * FROM payments WHERE transaction_id = ?").all(transactionId);

      // Previous/this/new balance block (non-Walk-in only) — see server/printing/receipt.ts.
      if (transaction.stakeholder_id) {
        const stRow = db.prepare("SELECT balance FROM stakeholders WHERE id = ? AND tenant_id = ?").get(transaction.stakeholder_id, tenantId) as any;
        transaction.stakeholder_balance = stRow ? (stRow.balance || 0) : null;
        transaction.balance_effect = transactionBalanceEffect(transaction.type, Number(transactionId), transaction.total_amount, 'payments');
      }

      const settings = getSettingsMap(tenantId);
      const buffer = buildReceiptBuffer({
        storeName: settings.store_name,
        businessAddress: settings.business_address,
        businessPhone: settings.business_phone,
        receiptFooter: settings.receipt_footer,
        paperWidth: printer.paper_width,
        transaction,
        openDrawer: !!openDrawer,
        arabic: printerArabicMode(printer),
        language: settings.language
      });

      await sendToPrinter(printer, buffer);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Print receipt error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to print receipt' });
    }
  });

  app.post("/api/print/drawer-kick", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { printerId } = req.body;
    try {
      const printer = resolveReceiptPrinter(tenantId, printerId);
      if (!printer) return res.status(404).json({ error: "No enabled receipt printer configured" });
      const buffer = new EscPos().init().openDrawer(0).toBuffer();
      await sendToPrinter(printer, buffer);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Drawer kick error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to open drawer' });
    }
  });

  app.post("/api/print/arabic-test", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    try {
      const printer = db.prepare("SELECT * FROM printers WHERE id = ? AND tenant_id = ?").get(req.body.printerId, tenantId) as any;
      if (!printer) return res.status(404).json({ error: "Printer not found" });
      await sendToPrinter(printer, buildArabicTestBuffer({ paperWidth: printer.paper_width }));
      res.json({ success: true });
    } catch (err: any) {
      console.error('Arabic test print error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to print Arabic test page' });
    }
  });

  app.post("/api/print/test", authenticate, async (req: any, res) => {
    const tenantId = req.session.tenantId;
    const { printerId } = req.body;
    try {
      const printer = printerId
        ? db.prepare("SELECT * FROM printers WHERE id = ? AND tenant_id = ?").get(printerId, tenantId) as any
        : null;
      if (!printer) return res.status(404).json({ error: "Printer not found" });

      const settings = getSettingsMap(tenantId);
      const buffer = buildTestPrintBuffer({
        storeName: settings.store_name,
        printerName: printer.name,
        connection: printer.connection,
        paperWidth: printer.paper_width
      });

      await sendToPrinter(printer, buffer);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Test print error:', err.message);
      res.status(500).json({ error: err.message || 'Failed to print test page' });
    }
  });

}


