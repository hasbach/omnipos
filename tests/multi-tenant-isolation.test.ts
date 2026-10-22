// Regression test for Phase 5 of the audit (multi-tenant isolation): one business's data must
// never be visible to another. v1.1.6/v1.1.7 fixed two cross-tenant sync leaks with no test
// guarding either fix from regressing — this covers the read-side equivalent: Business A creates
// an invoice, Business B searches/looks up invoices and products, and must never see it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantA: number;
let tenantB: number;
let productA: number;
let invoiceA: number;

test('tenant B order mirrors are never returned to tenant A via /api/orders (enable with T032)', { todo: true }, () => {});

test('order mirrors carry tenant scope and live/archived transactions carry the order link', () => {
  for (const table of ['orders', 'order_lines', 'order_events']) {
    const columns = app.db.prepare(`PRAGMA table_info(${table})`).all().map((col: any) => col.name);
    for (const column of ['id', 'tenant_id', 'global_id', 'created_at', 'updated_at', 'deleted_at', 'last_synced_at']) {
      assert.ok(columns.includes(column), `${table}.${column}`);
    }
    for (const column of ['network_hash', 'idempotency_key', 'status_key_hash']) assert.ok(!columns.includes(column));
    assert.deepEqual(app.db.prepare(`PRAGMA foreign_key_list(${table})`).all(), []);
  }
  for (const table of ['transactions', 'archived_transactions']) {
    const columns = app.db.prepare(`PRAGMA table_info(${table})`).all();
    assert.ok(columns.some((col: any) => col.name === 'order_global_id' && col.type === 'TEXT'));
  }
  const index = app.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_transactions_order'").get() as any;
  assert.match(index.sql, /UNIQUE INDEX.*transactions\(order_global_id\) WHERE order_global_id IS NOT NULL/i);
});

before(async () => {
  app = await createTestApp();
  tenantA = seedTenant(app.db, "Business A", "business-a@example.com");
  tenantB = seedTenant(app.db, "Business B", "business-b@example.com");
  productA = seedProduct(app.db, tenantA, { barcode: "ISO-A", name: "Business A Product", price: 20 });

  const created = await app.api("POST", "/api/transactions", {
    tenantId: tenantA,
    body: {
      type: "sale",
      items: [{ id: productA, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  invoiceA = created.body.id;
});

after(async () => {
  await app.close();
});

test("Business B's invoice search never returns Business A's invoice", async () => {
  const list = await app.api("GET", "/api/transactions/recent", { tenantId: tenantB });
  assert.equal(list.status, 200);
  assert.ok(!list.body.some((t: any) => t.id === invoiceA), "Business B saw Business A's invoice in the list");
});

test("Business B cannot fetch Business A's invoice directly by id", async () => {
  const detail = await app.api("GET", `/api/transactions/${invoiceA}`, { tenantId: tenantB });
  assert.equal(detail.status, 404, "Business B was able to open Business A's invoice by id");
});

test("Business B's product list never includes Business A's product", async () => {
  const products = await app.api("GET", "/api/products", { tenantId: tenantB });
  assert.equal(products.status, 200);
  assert.ok(!products.body.some((p: any) => p.id === productA), "Business B saw Business A's product");
});

test("Business B's reports never include Business A's revenue", async () => {
  const sales = await app.api("GET", "/api/reports/sales", { tenantId: tenantB });
  assert.equal(sales.status, 200);
  const total = sales.body.reduce((sum: number, row: any) => sum + row.total, 0);
  assert.equal(total, 0, "Business B's sales report picked up Business A's revenue");
});

test("an unauthenticated request (no tenant at all) is rejected", async () => {
  const res = await app.api("GET", "/api/transactions/recent");
  assert.equal(res.status, 401);
});

// Online store (specs/001-commerce-domain-foundation): stores and store_listings carry tenant_id and
// every /api/commerce route is scoped to the session tenant. The full matrix lives in
// tests/commerce-listings.test.ts; this is the constitution's per-table isolation case.
test("Business B can't read or change Business A's online store or listings", async () => {
  for (const t of [tenantA, tenantB]) {
    app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'commerce_enabled', '1') ON CONFLICT(tenant_id, key) DO UPDATE SET value = '1'").run(t);
  }
  const storeA = (await app.api("POST", "/api/commerce/stores", { tenantId: tenantA, body: { name: "A Shop" } })).body;
  const storeB = (await app.api("POST", "/api/commerce/stores", { tenantId: tenantB, body: { name: "B Shop" } })).body;
  const listed = await app.api("PUT", `/api/commerce/stores/${storeA.id}/listings/${productA}`, { tenantId: tenantA, body: { published: true } });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));

  // B sees only its own store; A's store and listings answer "not found", never data.
  const storesB = await app.api("GET", "/api/commerce/stores", { tenantId: tenantB });
  assert.deepEqual(storesB.body.map((s: any) => s.id), [storeB.id]);
  for (const [m, u, body] of [
    ["GET", `/api/commerce/stores/${storeA.id}/listings`, undefined],
    ["PUT", `/api/commerce/stores/${storeA.id}`, { name: "Taken over" }],
    ["PUT", `/api/commerce/stores/${storeA.id}/listings/${productA}`, { published: false }],
    ["DELETE", `/api/commerce/stores/${storeA.id}`, undefined],
  ] as const) {
    const r = await app.api(m, u, { tenantId: tenantB, body });
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.ok(!JSON.stringify(r.body).includes("A Shop"), `${m} ${u} leaked A's store`);
  }
  // B can't list A's product in its own store, nor read A's product listings.
  assert.equal((await app.api("PUT", `/api/commerce/stores/${storeB.id}/listings/${productA}`, { tenantId: tenantB, body: { published: true } })).status, 404);
  assert.equal((await app.api("GET", `/api/commerce/products/${productA}/listings`, { tenantId: tenantB })).status, 404);

  // A's rows are untouched.
  const a = app.db.prepare("SELECT s.name, l.published FROM stores s JOIN store_listings l ON l.store_id = s.id WHERE s.id = ?").get(storeA.id) as any;
  assert.deepEqual({ ...a }, { name: "A Shop", published: 1 });
  // And without a tenant at all, the commerce routes are closed.
  assert.equal((await app.api("GET", "/api/commerce/stores")).status, 401);
});
