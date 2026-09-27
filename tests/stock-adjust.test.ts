// Tests for the new inventory endpoints: POST /api/stock/adjust, GET /api/stock/adjustments, and
// GET /api/stock/movements/:productId (the unified sales/refunds/purchases/adjustments ledger).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Stock Adjust Test Co", "stock-adjust-test@example.com");
});

after(async () => {
  await app.close();
});

test("POST /api/stock/adjust with new_qty sets stock and records qty_before/qty_after/delta", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "STK-1", name: "Countable Item", price: 5, stock: 20 });

  const res = await app.api("POST", "/api/stock/adjust", {
    tenantId,
    body: { product_id: productId, new_qty: 17, reason: "Stock take shrinkage" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.qty_before, 20);
  assert.equal(res.body.qty_after, 17);
  assert.equal(res.body.delta, -3);

  const product = app.db.prepare("SELECT stock FROM products WHERE id = ?").get(productId) as any;
  assert.equal(product.stock, 17);

  const adjustments = await app.api("GET", `/api/stock/adjustments?product_id=${productId}`, { tenantId });
  assert.equal(adjustments.status, 200);
  assert.equal(adjustments.body.length, 1);
  assert.equal(adjustments.body[0].reason, "Stock take shrinkage");
  assert.equal(adjustments.body[0].delta, -3);
});

test("POST /api/stock/adjust with delta adds/subtracts from current stock", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "STK-2", name: "Delta Item", price: 5, stock: 10 });

  const res = await app.api("POST", "/api/stock/adjust", {
    tenantId,
    body: { product_id: productId, delta: 5, reason: "Found extra stock" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.qty_after, 15);

  const product = app.db.prepare("SELECT stock FROM products WHERE id = ?").get(productId) as any;
  assert.equal(product.stock, 15);
});

test("POST /api/stock/adjust rejects a request with neither new_qty nor delta", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "STK-3", name: "Bad Request Item", price: 5, stock: 10 });
  const res = await app.api("POST", "/api/stock/adjust", { tenantId, body: { product_id: productId, reason: "no numbers given" } });
  assert.equal(res.status, 400);
});

test("GET /api/stock/movements/:productId lists sales/refunds/purchases/adjustments oldest-first with a running balance ending at current stock", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "STK-4", name: "Ledger Item", price: 10, stock: 0 });

  // Purchase 20 in.
  const purchase = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "purchase", items: [{ id: productId, quantity: 20, price: 5 }], currency: "USD", exchange_rate: 1, payments: [] },
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));

  // Sell 8.
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "sale", items: [{ id: productId, quantity: 8 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 80, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  // Refund 2 of that sale.
  const refund = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "refund", original_transaction_id: sale.body.id, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));

  // Manual adjustment: -1 (damage).
  const adjust = await app.api("POST", "/api/stock/adjust", { tenantId, body: { product_id: productId, delta: -1, reason: "Damaged unit" } });
  assert.equal(adjust.status, 200, JSON.stringify(adjust.body));

  const currentStock = (app.db.prepare("SELECT stock FROM products WHERE id = ?").get(productId) as any).stock;
  assert.equal(currentStock, 20 - 8 + 2 - 1, "sanity check on the actual stock math");

  const movements = await app.api("GET", `/api/stock/movements/${productId}`, { tenantId });
  assert.equal(movements.status, 200, JSON.stringify(movements.body));
  assert.equal(movements.body.length, 4, "purchase, sale, refund, adjustment");

  // Oldest-first ordering.
  const types = movements.body.map((m: any) => m.type);
  assert.deepEqual(types, ["purchase", "sale", "refund", "adjustment"]);

  // Running balance must end exactly at the product's current stock.
  const last = movements.body[movements.body.length - 1];
  assert.equal(last.balance_after, currentStock);

  // And each step should be internally consistent.
  assert.equal(movements.body[0].balance_after, 20); // after purchase
  assert.equal(movements.body[1].balance_after, 12); // after -8 sale
  assert.equal(movements.body[2].balance_after, 14); // after +2 refund
  assert.equal(movements.body[3].balance_after, 13); // after -1 adjustment
});

test("GET /api/stock/movements/:productId 404s for an unknown product", async () => {
  const res = await app.api("GET", "/api/stock/movements/999999", { tenantId });
  assert.equal(res.status, 404);
});
