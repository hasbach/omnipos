// Regression test for Bug 1 from the audit: Reports stopped showing any sale that predated the
// last End-of-Day settlement, because settlement moves rows out of `transactions` into
// `archived_transactions` and no report query read the archive. Covers the exact repro from the
// audit: create a sale -> settle -> open reports -> verify the sale still appears with the right
// total.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Reports Test Co", "reports-test@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "RPT-1", name: "Widget", price: 25 });
});

after(async () => {
  await app.close();
});

test("a sale still appears in reports after End-of-Day settlement", async () => {
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 2 }], // 2 x $25 = $50
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 50, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.success, true);

  // Sanity check before settlement: the sale is visible.
  const before = await app.api("GET", "/api/reports/sales", { tenantId });
  assert.equal(before.status, 200);
  const beforeTotal = before.body.reduce((sum: number, row: any) => sum + row.total, 0);
  assert.equal(beforeTotal, 50);

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));

  // The whole point of the regression: the sale must still be there after settlement archives it.
  const afterSales = await app.api("GET", "/api/reports/sales", { tenantId });
  assert.equal(afterSales.status, 200);
  const afterTotal = afterSales.body.reduce((sum: number, row: any) => sum + row.total, 0);
  assert.equal(afterTotal, 50, "settled sale disappeared from /api/reports/sales");

  const today = new Date().toISOString().split("T")[0];
  const dailySales = await app.api("GET", `/api/reports/daily-sales?date=${today}`, { tenantId });
  assert.equal(dailySales.status, 200);
  assert.equal(dailySales.body.length, 1, "settled sale disappeared from /api/reports/daily-sales");
  assert.equal(dailySales.body[0].total_amount, 50);
});
