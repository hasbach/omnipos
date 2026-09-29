// Roles & permissions (docs/plans/2026-09-29-roles-cashflow-ui-connections.md, workstream A).
// The tenant "owner" session (no PIN user) stays unrestricted; once a PIN user is on the session
// (x-test-user-id in tests, POST /api/auth/verify-pin for real) the role's permissions apply.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, findRule, roleAllows } from "../server/permissions.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let n = 0;

before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

function setup() {
  n++;
  const tenantId = seedTenant(app.db, `Perm Shop ${n}`, `perm${n}-${Date.now()}@example.com`);
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  const mk = (name: string, role: string, pin: string) =>
    Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, ?, ?, ?)").run(tenantId, name, role, pin).lastInsertRowid);
  app.db.prepare("UPDATE users SET pin = '1111' WHERE id = ?").run(admin);
  return {
    tenantId, admin,
    manager: mk("Mia", "manager", "2222"),
    accountant: mk("Adam", "accountant", "3333"),
    staff: mk("Sam", "staff", "4444"),
    cashier: mk("Cara", "cashier", "5555"),
  };
}

test("no PIN user on the session: everything is allowed (owner / legacy)", async () => {
  const s = setup();
  for (const [m, u] of [["GET", "/api/logs"], ["GET", "/api/cash-flow"], ["GET", "/api/reports/summary"]] as const) {
    const r = await app.api(m, u, { tenantId: s.tenantId });
    assert.equal(r.status, 200, `${m} ${u}`);
  }
  const post = await app.api("POST", "/api/settings", { tenantId: s.tenantId, body: { shop_name: "X" } });
  assert.equal(post.status, 200);
});

test("whoami: no user => not enforced; PIN user => role permissions", async () => {
  const s = setup();
  const anon = await app.api("GET", "/api/auth/whoami", { tenantId: s.tenantId });
  assert.equal(anon.status, 200);
  assert.equal(anon.body.user, null);
  assert.equal(anon.body.enforced, false);
  assert.deepEqual(anon.body.permissions, ALL_PERMISSIONS);

  const c = await app.api("GET", "/api/auth/whoami", { tenantId: s.tenantId, userId: s.cashier });
  assert.equal(c.body.enforced, true);
  assert.deepEqual(c.body.user, { id: s.cashier, name: "Cara", role: "cashier" });
  assert.deepEqual([...c.body.permissions].sort(), [...DEFAULT_ROLE_PERMISSIONS.cashier].sort());

  const a = await app.api("GET", "/api/auth/whoami", { tenantId: s.tenantId, userId: s.admin });
  assert.deepEqual([...a.body.permissions].sort(), [...ALL_PERMISSIONS].sort());

  const unauth = await app.api("GET", "/api/auth/whoami");
  assert.equal(unauth.status, 401);
});

test("cashier defaults: sensitive dashboard data is 403 PERMISSION_DENIED, POS reads stay open", async () => {
  const s = setup();
  const as = { tenantId: s.tenantId, userId: s.cashier };
  for (const [m, u] of [
    ["GET", "/api/logs"], ["GET", "/api/cash-flow"], ["GET", "/api/cash-flow/summary"], ["GET", "/api/reports/summary"],
    ["GET", "/api/reports/profit-and-loss"], ["GET", "/api/purchases"], ["GET", "/api/settlements/1"],
    ["POST", "/api/tenant/settlement"], ["POST", "/api/tenant/cashout"], ["POST", "/api/tenant/reset"],
    ["POST", "/api/cash-flow"], ["PUT", "/api/cash-flow/1"], ["DELETE", "/api/transactions/1"], ["PUT", "/api/transactions/1"],
    ["POST", "/api/users"], ["DELETE", "/api/users/1"], ["POST", "/api/settings"], ["POST", "/api/products"],
    ["POST", "/api/stock/adjust"], ["POST", "/api/import/products"], ["GET", "/api/system/network-info"],
    ["POST", "/api/permissions"],
  ] as const) {
    const r = await app.api(m, u, m === "GET" ? as : { ...as, body: {} });
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.body.code, "PERMISSION_DENIED");
    assert.ok(r.body.permission);
  }
  for (const u of ["/api/products", "/api/stakeholders", "/api/currencies", "/api/settings", "/api/users", "/api/reports/daily-sales", "/api/transactions/recent", "/api/printers", "/api/auth/me"]) {
    const r = await app.api("GET", u, as);
    assert.notEqual(r.status, 403, `GET ${u} must stay open for the POS`);
  }
  // A plain sale goes through the permission check (fails later on validation, not with 403).
  const sale = await app.api("POST", "/api/transactions", { ...as, body: { items: [] } });
  assert.notEqual(sale.status, 403);
  // Language switch is harmless.
  const lang = await app.api("POST", "/api/settings", { ...as, body: { language: "ar" } });
  assert.equal(lang.status, 200);
});

test("accountant: finance yes, admin functions no; cash-flow edit / analytics are mapped", async () => {
  const s = setup();
  const as = { tenantId: s.tenantId, userId: s.accountant };
  assert.equal((await app.api("GET", "/api/cash-flow", as)).status, 200);
  assert.equal((await app.api("GET", "/api/cash-flow/summary", as)).status, 200);
  assert.equal((await app.api("GET", "/api/reports/summary", as)).status, 200);
  assert.equal((await app.api("GET", "/api/logs", as)).status, 200);
  assert.equal((await app.api("POST", "/api/users", { ...as, body: { name: "x" } })).status, 403);
  assert.equal((await app.api("POST", "/api/settings", { ...as, body: { a: "b" } })).status, 403);
  assert.equal((await app.api("POST", "/api/tenant/reset", { ...as, body: {} })).status, 403);
  assert.equal((await app.api("POST", "/api/products", { ...as, body: {} })).status, 403);
  // cash_flow.edit is held: the permission layer lets the request through (route may 404/400 itself).
  assert.notEqual((await app.api("PUT", "/api/cash-flow/999", { ...as, body: {} })).status, 403);
  assert.notEqual((await app.api("GET", "/api/cash-flow/analytics", as)).status, 403);
  // ...while a cashier is denied both.
  const c = { tenantId: s.tenantId, userId: s.cashier };
  assert.equal((await app.api("PUT", "/api/cash-flow/999", { ...c, body: {} })).status, 403);
  assert.equal((await app.api("GET", "/api/cash-flow/analytics", c)).status, 403);
});

test("staff and manager defaults", async () => {
  const s = setup();
  const staff = { tenantId: s.tenantId, userId: s.staff };
  assert.equal((await app.api("GET", "/api/purchases", staff)).status, 403);
  assert.equal((await app.api("GET", "/api/cash-flow", staff)).status, 403);
  assert.notEqual((await app.api("GET", "/api/stock/adjustments", staff)).status, 403);
  assert.equal((await app.api("POST", "/api/stock/adjust", { ...staff, body: {} })).status, 403);
  const mgr = { tenantId: s.tenantId, userId: s.manager };
  assert.equal((await app.api("GET", "/api/purchases", mgr)).status, 200);
  assert.equal((await app.api("POST", "/api/users", { ...mgr, body: { name: "x" } })).status, 403);
  assert.equal((await app.api("POST", "/api/tenant/reset", { ...mgr, body: {} })).status, 403);
  assert.equal((await app.api("POST", "/api/permissions", { ...mgr, body: { role_permissions: {} } })).status, 403);
});

test("POST /api/transactions is body-aware: refund, purchase and discounted sales", async () => {
  const s = setup();
  const cashier = { tenantId: s.tenantId, userId: s.cashier };
  const staff = { tenantId: s.tenantId, userId: s.staff };
  const refund = { type: "refund", items: [] };
  assert.notEqual((await app.api("POST", "/api/transactions", { ...cashier, body: refund })).status, 403); // pos.refund
  assert.equal((await app.api("POST", "/api/transactions", { ...cashier, body: { type: "purchase", items: [] } })).status, 403);
  const discounted = { items: [{ product_id: 1, quantity: 1, discount: { type: "percentage", value: 10 } }] };
  assert.equal((await app.api("POST", "/api/transactions", { ...cashier, body: discounted })).status, 403);
  assert.notEqual((await app.api("POST", "/api/transactions", { ...staff, body: discounted })).status, 403); // pos.discount
  assert.equal((await app.api("POST", "/api/transactions", { ...cashier, body: { items: [], discount: { type: "fixed", value: 5 } } })).status, 403);
});

test("custom role_permissions are respected; admin is always everything and not editable", async () => {
  const s = setup();
  const owner = { tenantId: s.tenantId };
  const cashier = { tenantId: s.tenantId, userId: s.cashier };
  assert.equal((await app.api("GET", "/api/logs", cashier)).status, 403);

  const saved = await app.api("POST", "/api/permissions", {
    ...owner,
    body: { role_permissions: { cashier: ["logs.view", "not.a.permission"], admin: [] } },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.roles.cashier, ["logs.view"]);
  assert.deepEqual([...saved.body.roles.admin].sort(), [...ALL_PERMISSIONS].sort());

  assert.equal((await app.api("GET", "/api/logs", cashier)).status, 200);
  assert.equal((await app.api("GET", "/api/reports/daily-sales", cashier)).status, 200); // open route regardless
  assert.equal((await app.api("POST", "/api/tenant/cashout", { ...cashier, body: {} })).status, 403);
  // Other roles keep their defaults.
  const staff = { tenantId: s.tenantId, userId: s.staff };
  assert.equal((await app.api("GET", "/api/logs", staff)).status, 403);
  assert.equal((await app.api("GET", "/api/products/export", staff)).status, 200);

  // Even a nonsense stored admin entry cannot lock an admin out.
  app.db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'role_permissions', ?)").run(s.tenantId, JSON.stringify({ admin: [], cashier: [] }));
  const admin = { tenantId: s.tenantId, userId: s.admin };
  assert.equal((await app.api("GET", "/api/logs", admin)).status, 200);
  assert.equal((await app.api("GET", "/api/permissions", admin)).status, 200);
  assert.equal((await app.api("GET", "/api/reports/daily-sales", cashier)).status, 200);
  assert.equal((await app.api("GET", "/api/cash-flow", cashier)).status, 403);
});

test("an admin PIN user can edit the matrix; GET returns roles, defaults and groups; validation", async () => {
  const s = setup();
  const admin = { tenantId: s.tenantId, userId: s.admin };
  const got = await app.api("GET", "/api/permissions", admin);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.defaults.cashier, DEFAULT_ROLE_PERMISSIONS.cashier);
  assert.equal(got.body.customized, false);
  assert.ok(Array.isArray(got.body.groups) && got.body.groups.length > 0);

  const bad = await app.api("POST", "/api/permissions", { ...admin, body: { role_permissions: { janitor: [] } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_PERMISSIONS");
  const bad2 = await app.api("POST", "/api/permissions", { ...admin, body: { role_permissions: "nope" } });
  assert.equal(bad2.status, 400);

  const ok = await app.api("POST", "/api/permissions", { ...admin, body: { role_permissions: { staff: ["cash_flow.view"] } } });
  assert.equal(ok.status, 200);
  assert.equal((await app.api("GET", "/api/permissions", admin)).body.customized, true);
  assert.equal((await app.api("GET", "/api/cash-flow", { tenantId: s.tenantId, userId: s.staff })).status, 200);
});

test("a PIN user that no longer exists is denied on protected routes", async () => {
  const s = setup();
  app.db.prepare("DELETE FROM users WHERE id = ?").run(s.cashier);
  assert.equal((await app.api("GET", "/api/logs", { tenantId: s.tenantId, userId: s.cashier })).status, 403);
});

test("verify-pin puts the user on the session, lock locks it", async () => {
  const s = setup();
  let cookie = "";
  const call = async (method: string, url: string, body?: any) => {
    const res = await fetch(`${app.baseUrl}${url}`, {
      method,
      headers: { "Content-Type": "application/json", "x-test-tenant-id": String(s.tenantId), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  assert.equal((await call("GET", "/api/logs")).status, 200); // owner
  assert.equal((await call("POST", "/api/auth/verify-pin", { userId: s.cashier, pin: "0000" })).status, 401);
  assert.equal((await call("GET", "/api/logs")).status, 200); // failed PIN did not restrict
  const ok = await call("POST", "/api/auth/verify-pin", { userId: s.cashier, pin: "5555" });
  assert.equal(ok.status, 200);
  const who = await call("GET", "/api/auth/whoami");
  assert.equal(who.body.user.role, "cashier");
  assert.equal(who.body.enforced, true);
  assert.equal((await call("GET", "/api/logs")).status, 403);

  const locked = await call("POST", "/api/auth/lock");
  assert.equal(locked.status, 200);
  const whoLocked = (await call("GET", "/api/auth/whoami")).body;
  assert.equal(whoLocked.user, null);
  assert.equal(whoLocked.locked, true);
  assert.deepEqual(whoLocked.permissions, []);
  // A locked register is NOT the owner: protected routes stay closed until a PIN is entered again
  // (a dashboard window left open behind the lock screen must not become unrestricted).
  assert.equal((await call("GET", "/api/logs")).status, 403);
  assert.equal((await call("GET", "/api/products")).status, 200); // POS reads stay open

  // Switching users replaces the session user.
  await call("POST", "/api/auth/verify-pin", { userId: s.accountant, pin: "3333" });
  assert.equal((await call("GET", "/api/logs")).status, 200);
  await call("POST", "/api/auth/verify-pin", { userId: s.cashier, pin: "5555" });
  assert.equal((await call("GET", "/api/logs")).status, 403);
});

test("route table: specific paths win over :param siblings", () => {
  assert.equal(findRule("GET", "/api/cash-flow/analytics")?.pattern, "/api/cash-flow/analytics");
  assert.equal(findRule("PUT", "/api/cash-flow/12")?.pattern, "/api/cash-flow/:id");
  assert.equal(findRule("GET", "/api/products/12"), undefined);
  assert.equal(findRule("GET", "/api/products/export")?.pattern, "/api/products/export");
  assert.equal(findRule("POST", "/api/tenant/reset")?.need, "data.reset");
  assert.equal(findRule("GET", "/api/nothing/here"), undefined);
});

// ---- settlement.view, cash-out isolation, price override, defaults table (audit of 2026-09-29) --------

function grant(tenantId: number, role: string, list: string[]) {
  const row = app.db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'role_permissions'").get(tenantId) as any;
  const map = row?.value ? JSON.parse(row.value) : {};
  map[role] = list;
  app.db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'role_permissions', ?)").run(tenantId, JSON.stringify(map));
  app.db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'role_permissions_version', '2')").run(tenantId);
}

test("settlement.view is a catalogue permission: accountant and manager have it, staff and cashier do not", () => {
  assert.ok(ALL_PERMISSIONS.includes("settlement.view"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.accountant.includes("settlement.view"));
  assert.ok(DEFAULT_ROLE_PERMISSIONS.manager.includes("settlement.view"));
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.staff.includes("settlement.view"));
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.cashier.includes("settlement.view"));
});

test("only settlement.cash_out: cash-out works end to end, history / detail / corrections / close stay 403", async () => {
  const s = setup();
  grant(s.tenantId, "staff", ["settlement.cash_out"]);
  const as = { tenantId: s.tenantId, userId: s.staff };

  // What the Cash Out step actually calls.
  assert.equal((await app.api("GET", "/api/cash-flow/summary", as)).status, 200);
  assert.equal((await app.api("GET", "/api/tenant/cashier-shifts", as)).status, 200);
  assert.equal((await app.api("GET", "/api/users", as)).status, 200);
  assert.equal((await app.api("GET", "/api/currencies", as)).status, 200);
  const cash = await app.api("POST", "/api/tenant/cashout", { ...as, body: { user_id: s.staff, opening_balance: 0, actual_cash: 0, notes: "shift" } });
  assert.equal(cash.status, 200, JSON.stringify(cash.body));

  for (const [m, u] of [
    ["GET", "/api/reports/daily"], ["GET", "/api/reports/yearly"], ["GET", "/api/settlements/1"],
    ["POST", "/api/settlements/1/corrections"], ["POST", "/api/tenant/settlement"], ["POST", "/api/reports/daily"], ["POST", "/api/reports/yearly"],
    ["GET", "/api/reports/summary"],
  ] as const) {
    const r = await app.api(m, u, m === "GET" ? as : { ...as, body: {} });
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.body.code, "PERMISSION_DENIED");
  }
});

test("reports.view / settlement.close / settlement.correct without settlement.view cannot read history", async () => {
  const s = setup();
  grant(s.tenantId, "staff", ["reports.view", "settlement.close", "settlement.correct"]);
  const as = { tenantId: s.tenantId, userId: s.staff };
  for (const u of ["/api/reports/daily", "/api/reports/yearly", "/api/settlements/1", "/api/tenant/cashier-shifts"]) {
    assert.equal((await app.api("GET", u, as)).status, 403, u);
  }
  // Summary still serves the close step.
  assert.equal((await app.api("GET", "/api/cash-flow/summary", as)).status, 200);
});

test("settlement.view alone reads history but cannot correct, close or cash out", async () => {
  const s = setup();
  grant(s.tenantId, "staff", ["settlement.view"]);
  const as = { tenantId: s.tenantId, userId: s.staff };
  for (const u of ["/api/reports/daily", "/api/reports/yearly", "/api/tenant/cashier-shifts"]) {
    assert.equal((await app.api("GET", u, as)).status, 200, u);
  }
  assert.notEqual((await app.api("GET", "/api/settlements/999", as)).status, 403); // 404 from the handler
  for (const [m, u] of [["POST", "/api/settlements/1/corrections"], ["POST", "/api/tenant/settlement"], ["POST", "/api/tenant/cashout"], ["POST", "/api/reports/yearly"]] as const) {
    assert.equal((await app.api(m, u, { ...as, body: {} })).status, 403, `${m} ${u}`);
  }
  assert.equal((await app.api("GET", "/api/cash-flow/summary", as)).status, 403);
});

test("migration v2: roles that could close or correct get settlement.view once; idempotent", async () => {
  const s = setup();
  app.db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'role_permissions', ?)").run(s.tenantId, JSON.stringify({
    manager: ["settlement.close", "invoices.view"],
    accountant: ["settlement.correct"],
    staff: ["logs.view"],
    cashier: ["settlement.cash_out", "settlement.view"],
  }));
  const who = async (userId: number) => (await app.api("GET", "/api/auth/whoami", { tenantId: s.tenantId, userId })).body.permissions as string[];
  assert.ok((await who(s.manager)).includes("settlement.view"));
  assert.ok((await who(s.accountant)).includes("settlement.view"));
  assert.ok(!(await who(s.staff)).includes("settlement.view"));
  assert.equal((await who(s.cashier)).filter((k) => k === "settlement.view").length, 1);
  const ver = app.db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'role_permissions_version'").get(s.tenantId) as any;
  assert.equal(ver.value, "2");

  // The admin later removes it on purpose: the version stamp keeps the migration from re-adding it.
  const saved = await app.api("POST", "/api/permissions", { tenantId: s.tenantId, body: { role_permissions: { manager: ["settlement.close"] } } });
  assert.equal(saved.status, 200);
  assert.ok(!(await who(s.manager)).includes("settlement.view"));

  // A tenant with no stored map just gets stamped and uses the defaults.
  const s2 = setup();
  assert.ok((await app.api("GET", "/api/auth/whoami", { tenantId: s2.tenantId, userId: s2.accountant })).body.permissions.includes("settlement.view"));
  const row = app.db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'role_permissions'").get(s2.tenantId);
  assert.equal(row, undefined);
});

test("pos.price_override is enforced on POST /api/transactions; the back-office editor needs invoices.edit", async () => {
  const s = setup();
  const staff = { tenantId: s.tenantId, userId: s.staff }; // pos.discount, no pos.price_override, no invoices.edit
  const manager = { tenantId: s.tenantId, userId: s.manager };
  const override = { items: [{ id: 1, quantity: 1, unit_price: 3.5 }] };

  assert.equal((await app.api("POST", "/api/transactions", { ...staff, body: override })).status, 403);
  // Ordinary sale lines (no unit_price) and a null unit_price are not overrides.
  assert.notEqual((await app.api("POST", "/api/transactions", { ...staff, body: { items: [{ id: 1, quantity: 1 }] } })).status, 403);
  assert.notEqual((await app.api("POST", "/api/transactions", { ...staff, body: { items: [{ id: 1, quantity: 1, unit_price: null }] } })).status, 403);

  // An override plus a discount needs both permissions.
  grant(s.tenantId, "staff", ["pos.price_override"]);
  assert.notEqual((await app.api("POST", "/api/transactions", { ...staff, body: override })).status, 403);
  const both = { items: [{ id: 1, quantity: 1, unit_price: 3.5, discount: { type: "percentage", value: 10 } }] };
  assert.equal((await app.api("POST", "/api/transactions", { ...staff, body: both })).status, 403); // no pos.discount now
  grant(s.tenantId, "staff", ["pos.price_override", "pos.discount"]);
  assert.notEqual((await app.api("POST", "/api/transactions", { ...staff, body: both })).status, 403);

  // Back office: source 'backoffice' is invoice editing, not a till override.
  const backoffice = { source: "backoffice", items: [{ id: 1, quantity: 1, price: 3.5, unit_price: 3.5 }] };
  assert.equal((await app.api("POST", "/api/transactions", { ...staff, body: backoffice })).status, 403); // has pos.price_override but not invoices.edit
  assert.notEqual((await app.api("POST", "/api/transactions", { ...manager, body: backoffice })).status, 403);
  // The cashier default (no pos.price_override) is denied a till override.
  assert.equal((await app.api("POST", "/api/transactions", { tenantId: s.tenantId, userId: s.cashier, body: override })).status, 403);
});

test("a purchase invoice can be edited / deleted with purchases.edit; a sale still needs invoices.edit", async () => {
  const s = setup();
  grant(s.tenantId, "staff", ["purchases.edit"]);
  const purchaseId = Number(app.db.prepare("INSERT INTO transactions (tenant_id, user_id, type, total_amount, currency, exchange_rate, status) VALUES (?, ?, 'purchase', 0, 'USD', 1, 'completed')").run(s.tenantId, s.admin).lastInsertRowid);
  const saleId = Number(app.db.prepare("INSERT INTO transactions (tenant_id, user_id, type, total_amount, currency, exchange_rate, status) VALUES (?, ?, 'sale', 0, 'USD', 1, 'completed')").run(s.tenantId, s.admin).lastInsertRowid);
  assert.equal(roleAllows(s.tenantId, "staff", "PUT", `/api/transactions/${purchaseId}`), true);
  assert.equal(roleAllows(s.tenantId, "staff", "PUT", `/api/transactions/${saleId}`), false);
  assert.equal(roleAllows(s.tenantId, "staff", "DELETE", `/api/transactions/${saleId}`), false);
  assert.equal((await app.api("PUT", `/api/transactions/${saleId}`, { tenantId: s.tenantId, userId: s.staff, body: {} })).status, 403);
  assert.notEqual((await app.api("PUT", `/api/transactions/${purchaseId}`, { tenantId: s.tenantId, userId: s.staff, body: {} })).status, 403);
});

test("GET /api/users hides PINs from users without users.manage", async () => {
  const s = setup();
  const cashier = (await app.api("GET", "/api/users", { tenantId: s.tenantId, userId: s.cashier })).body as any[];
  assert.ok(cashier.length >= 5);
  assert.ok(cashier.every((u) => !("pin" in u)));
  const admin = (await app.api("GET", "/api/users", { tenantId: s.tenantId, userId: s.admin })).body as any[];
  assert.ok(admin.every((u) => "pin" in u));
  const owner = (await app.api("GET", "/api/users", { tenantId: s.tenantId })).body as any[];
  assert.ok(owner.every((u) => "pin" in u));
});

test("update scheduling needs settings.manage", async () => {
  const s = setup();
  for (const u of ["/api/tenant/schedule-update", "/api/tenant/install-update"]) {
    assert.equal((await app.api("POST", u, { tenantId: s.tenantId, userId: s.cashier, body: {} })).status, 403, u);
  }
});

// Table-driven: [method, path, roles that must be allowed] — everything else must be denied.
const DEFAULT_TABLE: [string, string, string[]][] = [
  ["GET", "/api/reports/daily", ["admin", "manager", "accountant"]],
  ["GET", "/api/reports/yearly", ["admin", "manager", "accountant"]],
  ["GET", "/api/settlements/1", ["admin", "manager", "accountant"]],
  ["POST", "/api/settlements/1/corrections", ["admin", "manager", "accountant"]],
  ["POST", "/api/tenant/settlement", ["admin", "manager", "accountant"]],
  ["POST", "/api/tenant/cashout", ["admin", "manager", "accountant"]],
  ["GET", "/api/tenant/cashier-shifts", ["admin", "manager", "accountant"]],
  ["GET", "/api/cash-flow/summary", ["admin", "manager", "accountant"]],
  ["GET", "/api/cash-flow", ["admin", "manager", "accountant"]],
  ["POST", "/api/cash-flow", ["admin", "manager", "accountant"]],
  ["PUT", "/api/cash-flow/1", ["admin", "manager", "accountant"]],
  ["POST", "/api/balance-payment", ["admin", "manager", "accountant"]],
  ["GET", "/api/reports/summary", ["admin", "manager", "accountant", "staff"]],
  ["GET", "/api/reports/profit-and-loss", ["admin", "manager", "accountant"]],
  ["GET", "/api/reports/daily-sales", ["admin", "manager", "accountant", "staff", "cashier"]],
  ["GET", "/api/reports/inventory-valuation", ["admin", "manager", "accountant", "staff"]],
  ["GET", "/api/logs", ["admin", "manager", "accountant"]],
  ["GET", "/api/purchases", ["admin", "manager", "accountant"]],
  ["PUT", "/api/purchases/1/receive", ["admin", "manager"]],
  ["POST", "/api/products", ["admin", "manager"]],
  ["DELETE", "/api/products/1", ["admin", "manager"]],
  ["POST", "/api/products/bulk-price", ["admin", "manager"]],
  ["GET", "/api/products", ["admin", "manager", "accountant", "staff", "cashier"]],
  ["POST", "/api/stock/adjust", ["admin", "manager"]],
  ["GET", "/api/stock/adjustments", ["admin", "manager", "staff"]],
  ["DELETE", "/api/stakeholders/1", ["admin", "manager"]],
  ["POST", "/api/stakeholders", ["admin", "manager", "accountant", "staff", "cashier"]],
  ["POST", "/api/users", ["admin"]],
  ["POST", "/api/settings", ["admin"]],
  ["POST", "/api/currencies", ["admin"]],
  ["POST", "/api/printers", ["admin"]],
  ["POST", "/api/tenant/reset", ["admin"]],
  ["POST", "/api/tenant/schedule-update", ["admin"]],
  ["POST", "/api/import/products", ["admin", "manager"]],
  ["POST", "/api/permissions", ["admin", "manager", "accountant"].slice(0, 1)],
  ["GET", "/api/system/network-info", ["admin", "accountant"]],
  ["DELETE", "/api/transactions/999999", ["admin", "manager"]],
  ["PUT", "/api/transactions/999999", ["admin", "manager"]],
];

test("default roles against a representative route table", () => {
  const s = setup();
  for (const [method, path, allowed] of DEFAULT_TABLE) {
    for (const role of ["admin", "manager", "accountant", "staff", "cashier"]) {
      assert.equal(roleAllows(s.tenantId, role, method, path), allowed.includes(role), `${role} ${method} ${path}`);
    }
  }
});

test("default roles: a body-aware sale, discount, refund and price override per role", () => {
  const s = setup();
  const can = (role: string, body: any) => roleAllows(s.tenantId, role, "POST", "/api/transactions", { body });
  const plain = { items: [{ id: 1, quantity: 1 }] };
  const disc = { items: [{ id: 1, quantity: 1, discount: { type: "fixed", value: 1 } }] };
  const over = { items: [{ id: 1, quantity: 1, unit_price: 2 }] };
  const back = { source: "backoffice", items: [{ id: 1, quantity: 1, unit_price: 2 }] };
  const refund = { type: "refund", items: [] };
  const purchase = { type: "purchase", items: [] };
  const expected: Record<string, boolean[]> = {
    //            plain  disc   over   back   refund purchase
    admin:      [true,  true,  true,  true,  true,  true],
    manager:    [true,  true,  true,  true,  true,  true],
    accountant: [true,  false, false, false, false, false],
    staff:      [true,  true,  false, false, true,  false],
    cashier:    [true,  false, false, false, true,  false],
  };
  for (const [role, want] of Object.entries(expected)) {
    assert.deepEqual([plain, disc, over, back, refund, purchase].map((b) => can(role, b)), want, role);
  }
});

test("a PIN user's actions are always recorded under that user, whatever user_id the client sends", async () => {
  const s = setup();
  const res = await app.api("POST", "/api/cash-flow", {
    tenantId: s.tenantId, userId: s.accountant, // accountant has cash_flow.add by default
    body: { type: "in", amount: 10, currency: "USD", exchange_rate: 1, reason: "float", category: "top_up", user_id: s.admin },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = app.db.prepare("SELECT user_id FROM cash_flow WHERE tenant_id = ? ORDER BY id DESC LIMIT 1").get(s.tenantId) as any;
  assert.equal(row.user_id, s.accountant);
});
