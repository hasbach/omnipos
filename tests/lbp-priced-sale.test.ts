// A cart the POS priced in the LOCAL currency (price_lbp, not USD x rate) is re-priced by the server
// from the same LBP columns (server/pricing.ts mirrors src/lib/pricing.ts), so total_amount equals
// what the cashier charged and no 0.01-0.02 USD residue lands on the customer's balance.
// Balance math also treats a sale within one cent of fully paid as settled (PAID_TOLERANCE_USD).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let walkIn: number;

const RATE = 90000;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "LBP Priced Co", "lbp-priced@example.com");
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', ?, 0)").run(tenantId, RATE);
  walkIn = (app.db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'").get(tenantId) as any).id;
});
after(async () => { await app.close(); });

let n = 0;
const mkProduct = (price: number, price_lbp: number | null) => {
  const id = seedProduct(app.db, tenantId, { barcode: `LP-${++n}`, name: `P${n}`, price, stock: 1000 });
  if (price_lbp != null) app.db.prepare("UPDATE products SET price_lbp = ? WHERE id = ?").run(price_lbp, id);
  return id;
};
const mkCustomer = async () => {
  const r = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: `Cust ${++n}`, type: "customer" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
const balanceOf = (id: number) => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(id) as any).balance as number;
const txOf = (id: number) => app.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as any;
const sale = (stakeholder_id: number, items: any[], payments: any[], price_currency?: string) =>
  app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "sale", stakeholder_id, items, currency: "USD", exchange_rate: 1, price_currency, payments },
  });
const lbpCash = (amount: number) => ({ amount, method: "cash", currency: "LBP", exchange_rate: RATE });

test("walk-in sale priced in LBP (0.22 USD / 20,000 LBP x3) stores 60,000/90,000 and leaves the balance at 0", async () => {
  const p = mkProduct(0.22, 20000);
  const r = await sale(walkIn, [{ id: p, quantity: 3 }], [lbpCash(60000)], "LBP");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  near(txOf(r.body.id).total_amount, 60000 / RATE);
  near(balanceOf(walkIn), 0);
  const item = app.db.prepare("SELECT unit_price, quantity FROM transaction_items WHERE transaction_id = ?").get(r.body.id) as any;
  near(item.unit_price, 20000 / RATE);
  assert.equal(item.quantity, 3);
});

test("the same sale priced in USD (or without price_currency) keeps the USD total 0.66", async () => {
  const p = mkProduct(0.22, 20000);
  const usd = await sale(walkIn, [{ id: p, quantity: 3 }], [{ amount: 0.66, method: "cash", currency: "USD", exchange_rate: 1 }], "USD");
  assert.equal(usd.status, 200, JSON.stringify(usd.body));
  near(txOf(usd.body.id).total_amount, 0.66);
  const none = await sale(walkIn, [{ id: p, quantity: 3 }], [{ amount: 0.66, method: "cash", currency: "USD", exchange_rate: 1 }]);
  near(txOf(none.body.id).total_amount, 0.66);
  // an unrelated code is not the local currency either
  const other = await sale(walkIn, [{ id: p, quantity: 3 }], [{ amount: 0.66, method: "cash", currency: "USD", exchange_rate: 1 }], "EUR");
  near(txOf(other.body.id).total_amount, 0.66);
});

test("a UoM line and a percentage-discounted line priced in LBP match the client formula", async () => {
  const a = mkProduct(1, 90000);
  app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price, price_lbp) VALUES (?, ?, 'Carton', 12, 10, 950000)").run(tenantId, a);
  const unit = app.db.prepare("SELECT id FROM product_units WHERE product_id = ?").get(a) as any;
  const b = mkProduct(0.22, 20000);
  const c = mkProduct(0.22, 20000);
  // client: carton 950,000 x 2 = 1,900,000; b 20,000 x 10 less 10% = 180,000; c 20,000 x 4 less fixed $0.05 = 80,000 - 4,500
  const lbp = 1_900_000 + 180_000 + (80_000 - 0.05 * RATE);
  const cust = await mkCustomer();
  const r = await sale(cust, [
    { id: a, quantity: 2, uom_id: unit.id },
    { id: b, quantity: 10, discount: { type: "percentage", value: 10 } },
    { id: c, quantity: 4, discount: { type: "fixed", value: 0.05 } },
  ], [lbpCash(Math.round(lbp))], "LBP");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  near(txOf(r.body.id).total_amount, lbp / RATE);
  const carton = app.db.prepare("SELECT unit_price, quantity FROM transaction_items WHERE transaction_id = ? AND product_id = ?").get(r.body.id, a) as any;
  assert.equal(carton.quantity, 24);
  near(carton.unit_price, 950000 / RATE / 12);
  assert.ok(Math.abs(balanceOf(cust)) < 0.01, `customer balance ${balanceOf(cust)}`);
});

test("balance math: 0.006 USD short leaves the balance unchanged, 0.02 short still books -0.02", async () => {
  const p = mkProduct(10, null);
  const pay = (amount: number) => [{ amount, method: "cash", currency: "USD", exchange_rate: 1 }];
  const c1 = await mkCustomer();
  const r1 = await sale(c1, [{ id: p, quantity: 1 }], pay(9.994), "USD");
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(balanceOf(c1), 0);
  const c2 = await mkCustomer();
  const r2 = await sale(c2, [{ id: p, quantity: 1 }], pay(9.98), "USD");
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  near(balanceOf(c2), -0.02, 1e-6);
  // an overpayment of 0.006 is not store credit either
  const c3 = await mkCustomer();
  await sale(c3, [{ id: p, quantity: 1 }], pay(10.006), "USD");
  assert.equal(balanceOf(c3), 0);
});
