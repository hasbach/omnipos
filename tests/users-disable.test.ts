// Users can be disabled instead of deleted: history keeps them, sign-in and pickers drop them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let n = 0;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

function setup() {
  n++;
  const tenantId = seedTenant(app.db, `Users Co ${n}`, `users${n}-${Date.now()}@example.com`);
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Cash', 'cashier', '1234')").run(tenantId).lastInsertRowid);
  return { tenantId, admin, cashier, as: { tenantId } };
}

test("a disabled user can't sign in, leaves the default list, and can be enabled again", async () => {
  const s = setup();
  const off = await app.api("PUT", `/api/users/${s.cashier}/active`, { ...s.as, body: { active: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));

  const pin = await app.api("POST", "/api/auth/verify-pin", { ...s.as, body: { userId: s.cashier, pin: "1234" } });
  assert.equal(pin.status, 403);
  assert.equal(pin.body.code, "USER_DISABLED");

  const list = await app.api("GET", "/api/users", s.as);
  assert.ok(!list.body.some((u: any) => u.id === s.cashier), "hidden from pickers and the lock screen");
  const all = await app.api("GET", "/api/users?include_inactive=1", s.as);
  const row = all.body.find((u: any) => u.id === s.cashier);
  assert.equal(row.active, 0, "still there for User Management and history");

  const on = await app.api("PUT", `/api/users/${s.cashier}/active`, { ...s.as, body: { active: true } });
  assert.equal(on.status, 200);
  assert.equal((await app.api("POST", "/api/auth/verify-pin", { ...s.as, body: { userId: s.cashier, pin: "1234" } })).status, 200);
});

test("the last active admin can't be disabled, and nobody can disable themselves", async () => {
  const s = setup();
  const last = await app.api("PUT", `/api/users/${s.admin}/active`, { ...s.as, body: { active: false } });
  assert.equal(last.status, 400);
  assert.equal(last.body.code, "USER_LAST_ADMIN");

  const admin2 = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Boss 2', 'admin', '9999')").run(s.tenantId).lastInsertRowid);
  const self = await app.api("PUT", `/api/users/${admin2}/active`, { tenantId: s.tenantId, userId: admin2, body: { active: false } });
  assert.equal(self.body.code, "USER_DISABLE_SELF");
  // Another admin may disable it; then the remaining one is the last active admin and can't be deleted
  assert.equal((await app.api("PUT", `/api/users/${admin2}/active`, { tenantId: s.tenantId, userId: s.admin, body: { active: false } })).status, 200);
  const del = await app.api("DELETE", `/api/users/${s.admin}`, s.as);
  assert.equal(del.status, 400);
});

test("only users.manage may disable users", async () => {
  const s = setup();
  const res = await app.api("PUT", `/api/users/${s.admin}/active`, { tenantId: s.tenantId, userId: s.cashier, body: { active: false } });
  assert.equal(res.status, 403);
});
