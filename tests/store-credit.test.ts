// The `store_credit` payment method ("pay a sale/purchase from the stakeholder's own positive
// balance" — docs/plans/2026-09-28-store-credit-and-levels.md section 1). Exercises all three
// classifications: BALANCE MATH (it's not money — its effect keeps consuming the balance that
// funded it), INVOICE SETTLEMENT STATUS (the invoice itself IS paid), and REAL MONEY (the cash
// register and reports' "collected" never see it).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Store Credit Co", "store-credit-co@example.com");
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const bal = (id: number) => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(id) as any).balance;

test("a refund kept on account creates a positive balance, then a sale can be paid from it", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "SC-1", name: "Widget", price: 20, stock: 100 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Store Credit Customer", type: "customer" } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));

  // Refund kept on the customer's account (no payments array) -> +$20 balance (store credit).
  const refund = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "refund", original_transaction_id: sale.body.id, stakeholder_id: cust,
    items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  near(bal(cust), 20, "balance after refund-to-account");
  near(refund.body.balance_after, 20, "POST response balance_after");

  // Now a new sale, paid entirely from that store credit.
  const sale2 = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 20, method: "store_credit", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale2.status, 200, JSON.stringify(sale2.body));
  near(sale2.body.balance_before, 20);
  near(sale2.body.balance_after, 0, "store credit fully consumed the balance");
  near(bal(cust), 0, "balance consumed to zero");

  const detail = await app.api("GET", `/api/transactions/${sale2.body.id}`, { tenantId });
  near(detail.body.paid_amount, 20, "settlement status: store_credit counts as paid");
  near(detail.body.balance_effect, -20, "balance math: store_credit is not money, so it's still unpaid");

  // Cash register must be untouched by a store_credit sale.
  const cashFlow = await app.api("GET", "/api/cash-flow/summary", { tenantId });
  assert.equal(cashFlow.status, 200, JSON.stringify(cashFlow.body));
  near(cashFlow.body.totalSales, 20, "the earlier CASH sale is the only thing in the cash total");

  // Reports: "collected" (real money) must exclude the store_credit sale entirely; by-payment-method
  // must still show it as its own row.
  const summary = await app.api("GET", "/api/reports/summary", { tenantId });
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  near(summary.body.collected, 20, "collected = only the first sale's cash, not the store_credit sale");

  const byMethod = await app.api("GET", "/api/reports/by-payment-method", { tenantId });
  assert.equal(byMethod.status, 200, JSON.stringify(byMethod.body));
  const scRow = byMethod.body.find((r: any) => r.method === "store_credit" && r.kind === "sale");
  assert.ok(scRow, "store_credit should have its own by-payment-method row");
  near(scRow.amount_usd, 20);
});

test("store_credit exceeding the available balance is rejected with STORE_CREDIT_EXCEEDED", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "SC-2", name: "Gadget", price: 50, stock: 10 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Small Credit Customer", type: "customer", balance: 10 } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 50, method: "store_credit", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 400, JSON.stringify(sale.body));
  assert.equal(sale.body.code, "STORE_CREDIT_EXCEEDED");
  near(sale.body.available, 10);
});

test("store_credit can't be used by Walk-in Customer", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "SC-3", name: "Thing", price: 5, stock: 10 });
  const walkIn = (app.db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'").get(tenantId) as any).id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: walkIn, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 5, method: "store_credit", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 400, JSON.stringify(sale.body));
  assert.equal(sale.body.code, "STORE_CREDIT_WALKIN");
});

test("store_credit can't be used to pay out a refund", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "SC-4", name: "Refundable", price: 15, stock: 10 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Refund Store Credit Customer", type: "customer" } })).body.id;
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 15, method: "cash", currency: "USD", exchange_rate: 1 }],
  } });
  const refund = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "refund", original_transaction_id: sale.body.id, stakeholder_id: cust, items: [{ id: productId, quantity: 1 }],
    currency: "USD", exchange_rate: 1, payments: [{ amount: 15, method: "store_credit", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(refund.status, 400, JSON.stringify(refund.body));
});

test("a purchase can be paid from a supplier's positive balance", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "SC-5", name: "Stock Item", price: 1, stock: 0 });
  const supplier = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Credit Supplier", type: "supplier", balance: 100 } })).body.id;
  near(bal(supplier), 100, "seeded supplier balance");

  const purchase = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "purchase", stakeholder_id: supplier, items: [{ id: productId, quantity: 10, price: 8 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 80, method: "store_credit", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  near(bal(supplier), 20, "supplier's credit consumed by the purchase total");
  const detail = await app.api("GET", `/api/transactions/${purchase.body.id}`, { tenantId });
  near(detail.body.paid_amount, 80, "settlement status: purchase is settled");
});

test("PUT can keep an existing store_credit payment by id, still counted toward the available check", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "SC-6", name: "Editable", price: 10, stock: 50 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Edit Store Credit Customer", type: "customer", balance: 15 } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "store_credit", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  near(bal(cust), 5, "15 - 10 store credit used");

  const detailBefore = await app.api("GET", `/api/transactions/${sale.body.id}`, { tenantId });
  const storeCreditPaymentId = detailBefore.body.payments.find((p: any) => p.method === "store_credit").id;

  // Bump qty to 2 (=$20), keep the existing $10 store_credit payment by id. Available (balance
  // without this invoice) is 5 (current) + 10 (this invoice's own unpaid effect) = 15, so a kept
  // $10 store_credit payment fits comfortably.
  const edit = await app.api("PUT", `/api/transactions/${sale.body.id}`, { tenantId, body: {
    stakeholder_id: cust,
    items: [{ product_id: productId, quantity: 2, unit_price: 10 }],
    payments: [{ id: storeCreditPaymentId }],
  } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.total_amount, 20);
  near(bal(cust), -5, "owes $20 - $10 store credit = $10 more debt than before (5 -> -5)");
});

test("settlement banks the store_credit effect correctly, and an archived edit keeps balances right", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "SC-7", name: "Settled Item", price: 30, stock: 50 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Settlement Store Credit Customer", type: "customer", balance: 30 } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 30, method: "store_credit", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  near(bal(cust), 0, "store credit fully consumed before settlement");

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  near(bal(cust), 0, "balance unchanged by settlement (baseline absorbed the same effect)");

  // Editing the now-archived invoice down to a smaller quantity should reduce what the store credit
  // covers, i.e. it must still owe less unpaid remainder proportionally... simplest check: total
  // drops and the archived-effect delta is banked into balance_baseline correctly.
  const edit = await app.api("PUT", `/api/transactions/${sale.body.id}`, { tenantId, body: {
    items: [{ product_id: productId, quantity: 1, unit_price: 20 }],
    payments: [], // drop the store_credit payment entirely on edit
  } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  // Old effect was -(30 - 0 realMoney) = -30 (store_credit isn't real money). New effect is
  // -(20 - 0) = -20. Baseline adjusts by -(-30) + (-20) = +10 net vs the pre-edit 0 -> balance = +10.
  near(bal(cust), 10, "archived edit banks the effect delta correctly");
});
