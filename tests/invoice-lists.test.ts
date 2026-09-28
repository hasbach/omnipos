// Invoice/purchase list endpoints used by the back-office Invoices and Purchases screens: they must
// include settled (archived) rows, report real money paid (USD, excluding on-account 'credit'), and
// support search.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
before(async () => { app = await createTestApp(); tenantId = seedTenant(app.db, "Lists Co", "lists@example.com"); });
after(async () => { await app.close(); });

test("recent invoices include paid_amount (USD, no credit), item_count, archived rows and search", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "L-1", name: "Thing", price: 10 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Zeina Shop", type: "customer" } })).body.id;
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    stakeholder_id: cust, type: "sale", items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 895000, method: "cash", currency: "LBP", exchange_rate: 89500 }, { amount: 10, method: "credit", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(sale.status, 200);
  await app.api("POST", "/api/tenant/settlement", { tenantId });
  const list = await app.api("GET", "/api/transactions/recent?q=Zeina", { tenantId });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].archived, 1);
  assert.equal(list.body[0].item_count, 1);
  assert.ok(Math.abs(list.body[0].paid_amount - 10) < 1e-9, `paid ${list.body[0].paid_amount}`);
});

test("purchases list and detail include settled purchases", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "L-2", name: "Crate", price: 10 });
  const sup = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Supplier X", type: "supplier" } })).body.id;
  const p = await app.api("POST", "/api/transactions", { tenantId, body: {
    stakeholder_id: sup, type: "purchase", reference: "SUP-77", items: [{ id: productId, quantity: 5, price: 4 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(p.status, 200);
  await app.api("POST", "/api/tenant/settlement", { tenantId });
  const list = await app.api("GET", "/api/purchases?search=SUP-77", { tenantId });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].archived, 1);
  assert.equal(list.body[0].paid_amount, 5);
  const unpaid = await app.api("GET", "/api/purchases?status=unpaid", { tenantId });
  assert.ok(unpaid.body.some((r: any) => r.id === p.body.id));
  const detail = await app.api("GET", `/api/purchases/${p.body.id}`, { tenantId });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.balance, 15);
});
