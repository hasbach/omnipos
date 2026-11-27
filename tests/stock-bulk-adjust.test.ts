// POST /api/stock/bulk-adjust: set many products' stock to one quantity, audited per product.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Bulk Stock Co", "bulk-stock-test@example.com");
});

after(async () => {
  await app.close();
});

const stockOf = (id: number) => (app.db.prepare("SELECT stock FROM products WHERE id = ?").get(id) as any).stock;
const adjCount = (id: number) => (app.db.prepare("SELECT COUNT(*) AS n FROM stock_adjustments WHERE product_id = ?").get(id) as any).n;

test("scope 'negative' zeroes only negative tracked products and records an adjustment each", async () => {
  const neg = seedProduct(app.db, tenantId, { barcode: "BSA-1", name: "Negative", price: 1, stock: -4 });
  const zero = seedProduct(app.db, tenantId, { barcode: "BSA-2", name: "Zero", price: 1, stock: 0 });
  const pos = seedProduct(app.db, tenantId, { barcode: "BSA-3", name: "Positive", price: 1, stock: 7 });
  const service = seedProduct(app.db, tenantId, { barcode: "BSA-4", name: "Service", price: 1, stock: -2 });
  app.db.prepare("UPDATE products SET track_inventory = 0 WHERE id = ?").run(service);

  const res = await app.api("POST", "/api/stock/bulk-adjust", { tenantId, body: { scope: "negative", new_qty: 0, reason: "Count correction" } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, 1);
  assert.equal(stockOf(neg), 0);
  assert.equal(stockOf(zero), 0);
  assert.equal(stockOf(pos), 7);
  assert.equal(stockOf(service), -2);
  const adj = app.db.prepare("SELECT qty_before, qty_after, delta, reason FROM stock_adjustments WHERE product_id = ?").get(neg) as any;
  assert.deepEqual({ ...adj }, { qty_before: -4, qty_after: 0, delta: 4, reason: "Count correction" });
  assert.equal(adjCount(zero), 0);
});

test("product_ids sets the chosen quantity, skipping products already at it", async () => {
  const a = seedProduct(app.db, tenantId, { barcode: "BSA-5", name: "A", price: 1, stock: -1 });
  const b = seedProduct(app.db, tenantId, { barcode: "BSA-6", name: "B", price: 1, stock: 10 });
  const c = seedProduct(app.db, tenantId, { barcode: "BSA-7", name: "C", price: 1, stock: 3 });

  const res = await app.api("POST", "/api/stock/bulk-adjust", { tenantId, body: { product_ids: [a, b, c], new_qty: 10 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.updated, 2);
  assert.equal(res.body.skipped, 1);
  assert.equal(stockOf(a), 10);
  assert.equal(stockOf(c), 10);
  assert.equal(adjCount(b), 0);
});

test("rejects a negative or missing quantity and a request with no target", async () => {
  assert.equal((await app.api("POST", "/api/stock/bulk-adjust", { tenantId, body: { scope: "out", new_qty: -1 } })).status, 400);
  assert.equal((await app.api("POST", "/api/stock/bulk-adjust", { tenantId, body: { scope: "out" } })).status, 400);
  assert.equal((await app.api("POST", "/api/stock/bulk-adjust", { tenantId, body: { new_qty: 0 } })).status, 400);
});

test("does not touch another tenant's products", async () => {
  const other = seedTenant(app.db, "Other Co", "bulk-stock-other@example.com");
  const theirs = seedProduct(app.db, other, { barcode: "BSA-8", name: "Theirs", price: 1, stock: -5 });
  const res = await app.api("POST", "/api/stock/bulk-adjust", { tenantId, body: { product_ids: [theirs], new_qty: 0 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 0);
  assert.equal(stockOf(theirs), -5);
});
