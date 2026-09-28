// The `field` hint on a validation error (server/errors.ts) — lets the invoice editor point at the
// exact line/field that caused a 400, instead of just a toast (docs/plans/2026-09-28-store-credit-and-levels.md
// section 1).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Validation Fields Co", "validation-fields-co@example.com");
});
after(async () => { await app.close(); });

test("POST: a price below min_price is rejected with field items.0.unit_price", async () => {
  const result = app.db.prepare(
    "INSERT INTO products (tenant_id, barcode, name, price, min_price, stock, category) VALUES (?, 'VF-1', 'Guarded', 10, 8, 50, 'general')"
  ).run(tenantId);
  const productId = Number(result.lastInsertRowid);
  await app.api("POST", "/api/settings", { tenantId, body: { enforce_min_price: "1", allow_price_override: "1" } });

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", items: [{ id: productId, quantity: 1, unit_price: 5 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 400, JSON.stringify(sale.body));
  assert.equal(sale.body.field, "items.0.unit_price");
});

test("POST: exceeding the credit limit is rejected with field stakeholder_id and code CREDIT_LIMIT", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "VF-2", name: "Limited", price: 100, stock: 10 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Limited Customer", type: "customer", credit_limit: 50 } })).body.id;
  await app.api("POST", "/api/settings", { tenantId, body: { enforce_credit_limit: "1" } });

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 400, JSON.stringify(sale.body));
  assert.equal(sale.body.code, "CREDIT_LIMIT");
  assert.equal(sale.body.field, "stakeholder_id");
});

test("PUT: the refunded-qty guard is rejected with field items.<i>.quantity", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "VF-3", name: "Refund Guarded", price: 10, stock: 50 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Refund Guard Customer", type: "customer" } })).body.id;
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 5 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 50, method: "cash", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  const refund = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "refund", original_transaction_id: sale.body.id, stakeholder_id: cust, items: [{ id: productId, quantity: 3 }],
    currency: "USD", exchange_rate: 1, payments: [{ amount: 30, method: "cash", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));

  // Editing the sale down to qty 2 (below the 3 already refunded) must be rejected.
  const edit = await app.api("PUT", `/api/transactions/${sale.body.id}`, { tenantId, body: {
    stakeholder_id: cust,
    items: [{ product_id: productId, quantity: 2, unit_price: 10 }],
    payments: [],
  } });
  assert.equal(edit.status, 400, JSON.stringify(edit.body));
  assert.equal(edit.body.field, "items.0.quantity");
});

test("POST: an unrecognized payment method is rejected with field payments", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "VF-4", name: "Bad Payment Item", price: 10, stock: 50 });
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "bitcoin", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 400, JSON.stringify(sale.body));
  assert.equal(sale.body.field, "payments");
});

test("PUT: an unrecognized payment method is rejected with field payments", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "VF-5", name: "Bad Payment Edit Item", price: 10, stock: 50 });
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 200);

  const edit = await app.api("PUT", `/api/transactions/${sale.body.id}`, { tenantId, body: {
    items: [{ product_id: productId, quantity: 1, unit_price: 10 }],
    payments: [{ amount: 10, method: "bitcoin", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(edit.status, 400, JSON.stringify(edit.body));
  assert.equal(edit.body.field, "payments");
});
