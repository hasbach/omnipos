// Roles & permissions (docs/plans/2026-09-29-roles-cashflow-ui-connections.md, workstream A).
// The tenant "owner" session (no PIN user) stays unrestricted; once a PIN user is on the session
// (x-test-user-id in tests, POST /api/auth/verify-pin for real) the role's permissions apply.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, findRule } from "../server/permissions.js";

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
