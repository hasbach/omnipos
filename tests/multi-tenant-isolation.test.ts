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
