// Setting `enable_price_levels`: missing key = on (default); '0' = off, which forces every sale to
// retail pricing and stores price_level 'retail' regardless of what the stakeholder/request asked
// for (docs/plans/2026-09-28-store-credit-and-levels.md section 3).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Price Levels Co", "price-levels-co@example.com");
});
after(async () => { await app.close(); });

function seedTieredProduct(barcode: string) {
  const result = app.db.prepare(
    "INSERT INTO products (tenant_id, barcode, name, price, price_wholesale, price_super_wholesale, stock, category) VALUES (?, ?, 'Tiered', 10, 8, 6, 100, 'general')"
  ).run(tenantId, barcode);
  return Number(result.lastInsertRowid);
}

test("price levels default ON (missing setting key) — a wholesale sale uses the tier price", async () => {
  const productId = seedTieredProduct("PL-1");
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Wholesale Customer", type: "customer", price_level: "wholesale" } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const item = app.db.prepare("SELECT unit_price FROM transaction_items WHERE transaction_id = ?").get(sale.body.id) as any;
  assert.equal(item.unit_price, 8, "wholesale tier price applies by default");
  const tx = app.db.prepare("SELECT price_level FROM transactions WHERE id = ?").get(sale.body.id) as any;
  assert.equal(tx.price_level, "wholesale");
});

test("enable_price_levels = '0' forces retail pricing and price_level 'retail', even for a wholesale customer", async () => {
  await app.api("POST", "/api/settings", { tenantId, body: { enable_price_levels: "0" } });
  const productId = seedTieredProduct("PL-2");
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Would-be Wholesale Customer", type: "customer", price_level: "wholesale" } })).body.id;

  // Even an explicit price_level in the request body is ignored while the toggle is off.
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [],
    price_level: "super_wholesale",
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const item = app.db.prepare("SELECT unit_price FROM transaction_items WHERE transaction_id = ?").get(sale.body.id) as any;
  assert.equal(item.unit_price, 10, "retail price, not the $6 super_wholesale tier");
  const tx = app.db.prepare("SELECT price_level FROM transactions WHERE id = ?").get(sale.body.id) as any;
  assert.equal(tx.price_level, "retail");

  // Turn it back on for the other tests in this file.
  await app.api("POST", "/api/settings", { tenantId, body: { enable_price_levels: "1" } });
});

test("enable_price_levels = '0' also forces retail on PUT /api/transactions/:id", async () => {
  const productId = seedTieredProduct("PL-3");
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Edit Wholesale Customer", type: "customer" } })).body.id;
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 200);

  await app.api("POST", "/api/settings", { tenantId, body: { enable_price_levels: "0" } });
  const edit = await app.api("PUT", `/api/transactions/${sale.body.id}`, { tenantId, body: {
    stakeholder_id: cust,
    items: [{ product_id: productId, quantity: 1 }], // no unit_price -> re-derived from price_level
    price_level: "wholesale",
    payments: [],
  } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.price_level, "retail");
  assert.equal(edit.body.items[0].price, 10);

  await app.api("POST", "/api/settings", { tenantId, body: { enable_price_levels: "1" } });
});
