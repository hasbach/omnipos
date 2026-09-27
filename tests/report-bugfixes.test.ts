// Regression tests for the reporting bugs fixed alongside the 1.2.0 pricing/costing work:
// unpaid-sales/unpaid-purchases/custom-builder used to subtract payments.amount RAW, ignoring
// that it's stored in the PAYMENT's own currency (must divide by exchange_rate) and that a
// 'credit' entry isn't real money received.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Report Bugfix Test Co", "report-bugfix-test@example.com");
});

after(async () => {
  await app.close();
});

test("unpaid-sales converts an LBP payment to USD before computing balance, instead of subtracting the raw LBP amount", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BUG-1", name: "LBP Paid Item", price: 100, stock: 10 });
  const customer = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "LBP Customer", type: "customer" } });

  // Sale totals $100 (USD basis). Customer pays with 4,500,000 LBP at rate 90000 -> $50 actual.
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customer.body.id,
      type: "sale",
      items: [{ id: productId, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 4_500_000, method: "cash", currency: "LBP", exchange_rate: 90000 }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  const unpaid = await app.api("GET", "/api/reports/unpaid-sales", { tenantId });
  assert.equal(unpaid.status, 200);
  assert.equal(unpaid.body.length, 1, "the sale should still show as unpaid (only $50 of $100 actually paid)");
  assert.equal(unpaid.body[0].balance, 50, "balance must be $100 - $50 (LBP amount converted to USD), not $100 - 4,500,000");
});

test("unpaid-sales excludes 'credit' payments from the paid amount", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BUG-2", name: "On Account Item", price: 40, stock: 10 });
  const customer = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Credit Customer", type: "customer" } });

  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customer.body.id,
      type: "sale",
      items: [{ id: productId, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 40, method: "credit", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  const unpaid = await app.api("GET", "/api/reports/unpaid-sales", { tenantId });
  const row = unpaid.body.find((r: any) => r.id === sale.body.id);
  assert.ok(row, "a fully 'credit' sale must still show as unpaid — credit isn't real money received");
  assert.equal(row.balance, 40);
});

test("unpaid-purchases applies the same amount/exchange_rate and credit-exclusion fix", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BUG-3", name: "Purchased Item", price: 30, stock: 0 });
  const supplier = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "LBP Supplier", type: "supplier" } });

  const purchase = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: supplier.body.id,
      type: "purchase",
      items: [{ id: productId, quantity: 3, price: 20 }], // $60 total
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 1_800_000, method: "cash", currency: "LBP", exchange_rate: 90000 }], // $20 actual
    },
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));

  const unpaid = await app.api("GET", "/api/reports/unpaid-purchases", { tenantId });
  const row = unpaid.body.find((r: any) => r.id === purchase.body.id);
  assert.ok(row);
  assert.equal(row.balance, 40, "$60 - $20 actually paid = $40, not $60 - 1,800,000");
});

test("custom-builder's paid_amount/balance and paid/unpaid status filter use the same fixed math", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BUG-4", name: "Custom Builder Item", price: 50, stock: 10 });
  const customer = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Custom Builder Customer", type: "customer" } });

  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customer.body.id,
      type: "sale",
      items: [{ id: productId, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 4_500_000, method: "cash", currency: "LBP", exchange_rate: 90000 }], // $50 actual
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  const all = await app.api("POST", "/api/reports/custom-builder", { tenantId, body: {} });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  const row = all.body.find((r: any) => r.invoice_no === sale.body.id);
  assert.ok(row);
  assert.equal(row.paid_amount, 50);
  assert.equal(row.balance, 0);

  const paidOnly = await app.api("POST", "/api/reports/custom-builder", { tenantId, body: { status: "paid" } });
  assert.ok(paidOnly.body.some((r: any) => r.invoice_no === sale.body.id), "should be classified as paid now that LBP is converted correctly");

  const unpaidOnly = await app.api("POST", "/api/reports/custom-builder", { tenantId, body: { status: "unpaid" } });
  assert.ok(!unpaidOnly.body.some((r: any) => r.invoice_no === sale.body.id));
});
