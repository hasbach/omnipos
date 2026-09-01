// Regression test for Bug 2 from the audit: Dashboard invoice search (Invoice Management) lost
// any invoice that predated the last End-of-Day settlement, for the same root cause as Bug 1 —
// /api/transactions/recent and /api/transactions/:id only ever read the live `transactions` table.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let invoiceId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Invoice Search Test Co", "invoice-search-test@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "INV-1", name: "Gadget", price: 40 });

  const created = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 40, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  invoiceId = created.body.id;

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
});

after(async () => {
  await app.close();
});

test("a settled invoice still appears in the recent/search list, flagged as archived", async () => {
  const list = await app.api("GET", "/api/transactions/recent", { tenantId });
  assert.equal(list.status, 200);
  const found = list.body.find((t: any) => t.id === invoiceId);
  assert.ok(found, "settled invoice disappeared from /api/transactions/recent");
  assert.equal(found.total_amount, 40);
  assert.equal(found.archived, 1, "settled invoice should be flagged archived so the UI can make it read-only");
});

test("filtering by date range still finds a settled invoice", async () => {
  const today = new Date().toISOString().split("T")[0];
  const list = await app.api("GET", `/api/transactions/recent?date_from=${today}&date_to=${today}`, { tenantId });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((t: any) => t.id === invoiceId), "date-range filter lost the settled invoice");
});

test("a settled invoice can still be opened by id", async () => {
  const detail = await app.api("GET", `/api/transactions/${invoiceId}`, { tenantId });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.total_amount, 40);
  assert.equal(detail.body.archived, 1);
  assert.equal(detail.body.items.length, 1);
});
