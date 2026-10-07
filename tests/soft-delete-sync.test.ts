// v1.7.9: deleting a currency / user / customer is a SOFT delete (deleted_at) so the cloud copy gets the
// deletion and it doesn't come back on the next pull; pulls skip unknown deleted rows and a duplicate
// live currency code; the Walk-in Customer and the last admin can't be deleted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let sync: typeof import("../server/sync.js");
let session: typeof import("../server/session.js");
let tenant: number;
const GID = "cccccccc-0000-4000-8000-000000000001";
let cloud: Record<string, any[]> = {};

// Minimal fake Supabase client: selects return every cloud row of the table (one short page), writes succeed.
function makeFake() {
  return {
    auth: {
      setSession: async (t: any) => ({ data: { session: { ...t } }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: { message: "no" } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from(table: string) {
      let write = false;
      const q: any = {
        select() { return q; }, gt() { return q; }, gte() { return q; }, or() { return q; }, eq() { return q; },
        in() { return q; }, order() { return q; }, limit() { return q; }, not() { return q; }, is() { return q; },
        upsert() { write = true; return q; }, update() { write = true; return q; }, delete() { write = true; return q; },
        then(resolve: any, reject: any) {
          if (write) return Promise.resolve({ error: null }).then(resolve, reject);
          const rows = (cloud[table] || []).map((r) => ({ ...r, synced_at: new Date(r.updated_at + "Z").toISOString() }));
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const row = (table: string, id: number) => app.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any;
const pending = (r: any) => r.last_synced_at == null || String(r.updated_at) > String(r.last_synced_at);
const one = (sql: string, ...a: any[]) => app.db.prepare(sql).get(...a) as any;

before(async () => {
  app = await createTestApp();
  sync = await import("../server/sync.js");
  session = await import("../server/session.js");
  tenant = seedTenant(app.db, "Soft Co", "soft@example.com");
  app.db.prepare("UPDATE tenants SET global_id = ? WHERE id = ?").run(GID, tenant);
  session.__setClientFactory(makeFake as any);
  await session.setActiveSession(tenant, GID, "soft@example.com", { access_token: "a", refresh_token: "r" });
});
after(async () => { session.__setClientFactory(); await app.close(); });

test("DELETE currency / user / stakeholder is soft, hidden from lists and marked for push", async () => {
  const lbp = Number(app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'L', 90000, 0)").run(tenant).lastInsertRowid);
  const staff = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Sam', 'staff')").run(tenant).lastInsertRowid);
  const cust = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Bob', 'customer')").run(tenant).lastInsertRowid);

  for (const [path, table, id] of [["currencies", "currencies", lbp], ["users", "users", staff], ["stakeholders", "stakeholders", cust]] as const) {
    // pretend it was already pushed (in the past), so only the delete can make it pending again
    app.db.prepare(`UPDATE ${table} SET last_synced_at = '2000-01-01 00:00:00' WHERE id = ?`).run(id);
    const r = await app.api("DELETE", `/api/${path}/${id}`, { tenantId: tenant });
    assert.equal(r.status, 200);
    const after = row(table, id);
    assert.ok(after, `${table} row still exists`);
    assert.ok(after.deleted_at, `${table} deleted_at set`);
    assert.ok(pending(after), `${table} row is pending push`);
    const list = await app.api("GET", `/api/${path}`, { tenantId: tenant });
    assert.ok(!list.body.some((x: any) => x.id === id), `${table} hidden from list`);
  }
});

test("deleting the default currency promotes USD", async () => {
  const eur = Number(app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'EUR', 'E', 0.9, 0)").run(tenant).lastInsertRowid);
  await app.api("PUT", `/api/currencies/${eur}`, { tenantId: tenant, body: { code: "EUR", symbol: "E", rate: 0.9, is_default: true } });
  assert.equal(one("SELECT is_default d FROM currencies WHERE code = 'USD' AND tenant_id = ?", tenant).d, 0);
  await app.api("DELETE", `/api/currencies/${eur}`, { tenantId: tenant });
  assert.equal(one("SELECT is_default d FROM currencies WHERE code = 'USD' AND tenant_id = ?", tenant).d, 1);
});

test("pull skips an unknown deleted row and a second live USD", async () => {
  const stamp = "2099-01-01T00:00:00.000000";
  cloud.currencies = [
    { global_id: "dddddddd-0000-4000-8000-000000000001", tenant_id: GID, code: "USD", symbol: "$", rate: 1, is_default: 1, updated_at: stamp },
    { global_id: "dddddddd-0000-4000-8000-000000000002", tenant_id: GID, code: "GBP", symbol: "P", rate: 0.8, is_default: 0, updated_at: stamp, deleted_at: stamp },
    { global_id: "dddddddd-0000-4000-8000-000000000003", tenant_id: GID, code: "CAD", symbol: "C", rate: 1.3, is_default: 0, updated_at: stamp },
  ];
  cloud.users = [{ global_id: "dddddddd-0000-4000-8000-000000000004", tenant_id: GID, name: "Gone", role: "staff", pin: "0000", updated_at: stamp, deleted_at: stamp }];
  cloud.stakeholders = [{ global_id: "dddddddd-0000-4000-8000-000000000005", tenant_id: GID, name: "Gone Cust", type: "customer", balance: 0, updated_at: stamp, deleted_at: stamp }];
  await sync.pullFromCloud((session.getActiveSession() as any).client, tenant, GID, ["currencies", "users", "stakeholders"]);
  assert.equal(one("SELECT COUNT(*) c FROM currencies WHERE tenant_id = ? AND UPPER(code) = 'USD' AND deleted_at IS NULL", tenant).c, 1, "no second USD");
  assert.equal(one("SELECT COUNT(*) c FROM currencies WHERE code = 'GBP'").c, 0, "unknown deleted currency skipped");
  assert.equal(one("SELECT COUNT(*) c FROM currencies WHERE code = 'CAD'").c, 1, "a genuinely new live currency is still pulled");
  assert.equal(one("SELECT COUNT(*) c FROM users WHERE name = 'Gone'").c, 0);
  assert.equal(one("SELECT COUNT(*) c FROM stakeholders WHERE name = 'Gone Cust'").c, 0);
});

test("cannot delete the Walk-in Customer or the last admin", async () => {
  const walkIn = one("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'", tenant).id;
  let r = await app.api("DELETE", `/api/stakeholders/${walkIn}`, { tenantId: tenant });
  assert.equal(r.status, 400);
  assert.equal(row("stakeholders", walkIn).deleted_at, null);

  const admin = one("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin' AND deleted_at IS NULL", tenant).id;
  r = await app.api("DELETE", `/api/users/${admin}`, { tenantId: tenant });
  assert.equal(r.status, 400);
  assert.equal(row("users", admin).deleted_at, null);

  // with a second admin, deleting one is fine; a soft-deleted user can't verify a PIN
  const second = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Boss2', 'admin', '1234')").run(tenant).lastInsertRowid);
  r = await app.api("DELETE", `/api/users/${second}`, { tenantId: tenant });
  assert.equal(r.status, 200);
  r = await app.api("POST", "/api/auth/verify-pin", { tenantId: tenant, body: { userId: second, pin: "1234" } });
  assert.equal(r.status, 404);
});
