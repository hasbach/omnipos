// Refund rules used by the back-office refund screen and the POS: a partial refund pays back what
// the customer was actually charged for those units (line discount prorated, invoice-level discount
// and tax applied), belongs to the original sale's customer, and GET /refundable reports it exactly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
before(async () => { app = await createTestApp(); tenantId = seedTenant(app.db, "Refund Co", "refund-co@example.com"); });
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-6, `${msg} ${a} != ${b}`);
const bal = (id: number) => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(id) as any).balance;

test("a partial refund applies the original invoice's global discount and tax", async () => {
  const a = seedProduct(app.db, tenantId, { barcode: "RF-A", name: "A", price: 10, stock: 50 });
  const b = seedProduct(app.db, tenantId, { barcode: "RF-B", name: "B", price: 20, stock: 50 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Refund Customer", type: "customer" } })).body.id;
  // Lines: 2xA = 20, 1xB = 20 -> 40; -10% global = 36; +10% tax = 39.6. Charged factor = 0.99.
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: a, quantity: 2 }, { id: b, quantity: 1 }], currency: "USD", exchange_rate: 1,
    discount: { type: "percentage", value: 10 }, tax: { type: "percentage", value: 10 },
    payments: [{ amount: 39.6, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  const info = await app.api("GET", `/api/transactions/${sale.body.id}/refundable`, { tenantId });
  assert.equal(info.status, 200, JSON.stringify(info.body));
  near(info.body.factor, 0.99);
  const lineA = info.body.lines.find((l: any) => l.product_id === a);
  near(lineA.unit_refund, 9.9);
  assert.equal(lineA.remaining_qty, 2);

  // Refund one A; the client sends a bogus discount and no customer -- the server corrects both.
  const refund = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "refund", original_transaction_id: sale.body.id, stakeholder_id: null, items: [{ id: a, quantity: 1 }],
    currency: "USD", exchange_rate: 1, discount: { type: "fixed", value: 5 },
    payments: [{ amount: 9.9, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const r = app.db.prepare("SELECT total_amount, stakeholder_id, discount_type FROM transactions WHERE id = ?").get(refund.body.id) as any;
  near(r.total_amount, 9.9, "refund total");
  assert.equal(r.stakeholder_id, cust);
  assert.equal(r.discount_type, "percentage"); // the original invoice's effective 10%, not the client's bogus $5
  near(bal(cust), 0, "balance");

  const after2 = await app.api("GET", `/api/transactions/${sale.body.id}/refundable`, { tenantId });
  assert.equal(after2.body.lines.find((l: any) => l.product_id === a).remaining_qty, 1);
  assert.equal(after2.body.refunds.length, 1);
});

test("refunding everything returns exactly the invoice total; a refund to account clears the debt", async () => {
  const p = seedProduct(app.db, tenantId, { barcode: "RF-C", name: "C", price: 7, stock: 50 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "On Account", type: "customer" } })).body.id;
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: p, quantity: 3, discount: { type: "fixed", value: 1 } }], currency: "USD", exchange_rate: 1,
    discount: { type: "fixed", value: 2 }, payments: [] } }); // 21 - 1 - 2 = 18, all on account
  assert.equal(sale.status, 200);
  near(bal(cust), -18);
  const refund = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "refund", original_transaction_id: sale.body.id, stakeholder_id: cust, items: [{ id: p, quantity: 3 }],
    currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(refund.status, 200);
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(refund.body.id) as any).total_amount, 18);
  near(bal(cust), 0, "debt cleared by refund to account");
});

test("refundable works for settled sales and rejects non-sales", async () => {
  const p = seedProduct(app.db, tenantId, { barcode: "RF-D", name: "D", price: 4, stock: 50 });
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", items: [{ id: p, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 8, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  await app.api("POST", "/api/tenant/settlement", { tenantId });
  const info = await app.api("GET", `/api/transactions/${sale.body.id}/refundable`, { tenantId });
  assert.equal(info.status, 200);
  assert.equal(info.body.transaction.archived, 1);
  near(info.body.transaction.paid_amount, 8);
  const purchase = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "purchase", items: [{ id: p, quantity: 1, price: 2 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal((await app.api("GET", `/api/transactions/${purchase.body.id}/refundable`, { tenantId })).status, 400);
});
