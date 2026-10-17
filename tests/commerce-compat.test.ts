// Commerce foundation, Slice A — US1 "existing shops keep working unchanged"
// (specs/001-commerce-domain-foundation). Commerce is off by default, nothing is created
// automatically, the status routes are permissioned, and ordinary flows are untouched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let n = 0;

before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

function setup() {
  n++;
  const tenantId = seedTenant(app.db, `Compat Shop ${n}`, `compat${n}-${Date.now()}@example.com`);
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Cara', 'cashier', '5555')").run(tenantId).lastInsertRowid);
  return { tenantId, admin, cashier };
}

test("schema: stores / store_listings exist with sync metadata and the live-listing unique index", () => {
  for (const t of ["stores", "store_listings"]) {
    const cols = (app.db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    for (const c of ["id", "tenant_id", "global_id", "created_at", "updated_at", "deleted_at", "last_synced_at"]) {
      assert.ok(cols.includes(c), `${t}.${c}`);
    }
  }
  const storeCols = (app.db.prepare("PRAGMA table_info(stores)").all() as any[]).map((c) => c.name);
  for (const c of ["name", "slug", "mode", "status", "settings", "default_language"]) assert.ok(storeCols.includes(c), `stores.${c}`);
  const listingCols = (app.db.prepare("PRAGMA table_info(store_listings)").all() as any[]).map((c) => c.name);
  // A listing never stores price, cost or stock (FR-011/012).
  for (const c of ["price", "price_lbp", "cost", "stock"]) assert.ok(!listingCols.includes(c), `store_listings must not have ${c}`);
  const idx = app.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_store_listings_live'").get() as any;
  assert.match(idx.sql, /WHERE deleted_at IS NULL/);
});

test("a new tenant has commerce off and no store, listing or commerce setting", async () => {
  const s = setup();
  const setting = app.db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'commerce_enabled'").get(s.tenantId);
  assert.equal(setting, undefined);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM stores WHERE tenant_id = ?").get(s.tenantId) as any).c, 0);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM store_listings WHERE tenant_id = ?").get(s.tenantId) as any).c, 0);

  const r = await app.api("GET", "/api/commerce/status", { tenantId: s.tenantId });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.equal(r.body.store, null);
  assert.equal(r.body.online_license_valid, false);
});

test("ordinary flows are unchanged: products list, a sale and settings carry no commerce side effects", async () => {
  const s = setup();
  const productId = seedProduct(app.db, s.tenantId, { barcode: `C${n}`, name: "Cola", price: 1.5, stock: 10 });
  const products = await app.api("GET", "/api/products", { tenantId: s.tenantId });
  assert.equal(products.status, 200);
  const p = products.body.find((x: any) => x.id === productId);
  assert.ok(p);
  for (const k of Object.keys(p)) assert.ok(!/listing|store_|published/.test(k), `unexpected product field ${k}`);

  const sale = await app.api("POST", "/api/transactions", {
    tenantId: s.tenantId,
    body: { type: "sale", items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [{ method: "cash", amount: 3, currency: "USD", exchange_rate: 1 }] },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal((app.db.prepare("SELECT stock FROM products WHERE id = ?").get(productId) as any).stock, 8);

  const settings = await app.api("GET", "/api/settings", { tenantId: s.tenantId });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.commerce_enabled, undefined);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM stores WHERE tenant_id = ?").get(s.tenantId) as any).c, 0);
});

test("turning commerce on/off: admin only, audited, keeps the setting row (no replace)", async () => {
  const s = setup();
  const denied = await app.api("PUT", "/api/commerce/status", { tenantId: s.tenantId, userId: s.cashier, body: { enabled: true } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "PERMISSION_DENIED");
  const deniedRead = await app.api("GET", "/api/commerce/status", { tenantId: s.tenantId, userId: s.cashier });
  assert.equal(deniedRead.status, 403);

  const bad = await app.api("PUT", "/api/commerce/status", { tenantId: s.tenantId, userId: s.admin, body: { enabled: "yes" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "COMMERCE_ENABLED_INVALID");
  assert.equal(bad.body.field, "enabled");

  const on = await app.api("PUT", "/api/commerce/status", { tenantId: s.tenantId, userId: s.admin, body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  const row1 = app.db.prepare("SELECT value, global_id FROM settings WHERE tenant_id = ? AND key = 'commerce_enabled'").get(s.tenantId) as any;
  assert.equal(row1.value, "1");

  const off = await app.api("PUT", "/api/commerce/status", { tenantId: s.tenantId, userId: s.admin, body: { enabled: false } });
  assert.equal(off.body.enabled, false);
  const row2 = app.db.prepare("SELECT value, global_id FROM settings WHERE tenant_id = ? AND key = 'commerce_enabled'").get(s.tenantId) as any;
  assert.equal(row2.value, "0");
  assert.equal(row2.global_id, row1.global_id, "upsert keeps the synced row identity");

  const logs = app.db.prepare("SELECT user_id, details FROM user_logs WHERE tenant_id = ? AND action = 'commerce_toggle' ORDER BY id").all(s.tenantId) as any[];
  assert.equal(logs.length, 2);
  assert.equal(logs[0].user_id, s.admin);
  assert.deepEqual(JSON.parse(logs[0].details).after, { enabled: true });

  // Setting the same value again is a no-op (no extra audit entry).
  await app.api("PUT", "/api/commerce/status", { tenantId: s.tenantId, userId: s.admin, body: { enabled: false } });
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM user_logs WHERE tenant_id = ? AND action = 'commerce_toggle'").get(s.tenantId) as any).c, 2);
});

test("online license: lifetime or a future expiry is valid; past or missing is not", async () => {
  const s = setup();
  const status = async () => (await app.api("GET", "/api/commerce/status", { tenantId: s.tenantId })).body.online_license_valid;
  app.db.prepare("UPDATE tenants SET online_license_type = 'monthly', online_license_expiry = ? WHERE id = ?").run("2000-01-01 00:00:00", s.tenantId);
  assert.equal(await status(), false);
  app.db.prepare("UPDATE tenants SET online_license_expiry = ? WHERE id = ?").run("2999-01-01 00:00:00", s.tenantId);
  assert.equal(await status(), true);
  app.db.prepare("UPDATE tenants SET online_license_type = 'lifetime', online_license_expiry = NULL WHERE id = ?").run(s.tenantId);
  assert.equal(await status(), true);
});

test("tenant isolation: one tenant's commerce flag never affects another", async () => {
  const a = setup();
  const b = setup();
  await app.api("PUT", "/api/commerce/status", { tenantId: a.tenantId, body: { enabled: true } });
  const rb = await app.api("GET", "/api/commerce/status", { tenantId: b.tenantId });
  assert.equal(rb.body.enabled, false);
});
