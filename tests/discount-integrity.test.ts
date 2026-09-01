// Regression test for the server-side discount bug: the server used to compute total_amount as
// unitPrice * quantity with no reference to the per-item "DISC" discount, so a discounted sale's
// recorded total was higher than what was actually charged and collected. Covers: a percentage
// discount, a fixed discount, and the core claim — total_amount must always equal what payments
// actually collected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Discount Test Co", "discount-test@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "DISC-1", name: "Discounted Widget", price: 10 });
});

after(async () => {
  await app.close();
});

test("a 20% per-item discount is reflected in the stored total (3 x $10 -> $24, not $30)", async () => {
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 3, discount: { type: "percentage", value: 20 } }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 24, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  const detail = await app.api("GET", `/api/transactions/${sale.body.id}`, { tenantId });
  assert.equal(detail.body.total_amount, 24, "total_amount did not reflect the per-item discount");
  assert.equal(detail.body.paid_amount, 24);
});

test("a fixed per-item discount is reflected in the stored total (2 x $10, $5 off -> $15)", async () => {
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 2, discount: { type: "fixed", value: 5 } }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 15, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const detail = await app.api("GET", `/api/transactions/${sale.body.id}`, { tenantId });
  assert.equal(detail.body.total_amount, 15);
});

test("total_amount always matches what was actually collected — the core financial-integrity claim", async () => {
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 5, discount: { type: "percentage", value: 50 } }], // 5*10*0.5 = 25
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 25, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const detail = await app.api("GET", `/api/transactions/${sale.body.id}`, { tenantId });
  const collected = detail.body.payments.reduce((sum: number, p: any) => sum + p.amount, 0);
  assert.equal(detail.body.total_amount, collected, "recorded revenue does not match cash actually collected");
});
