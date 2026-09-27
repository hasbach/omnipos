// Regression/behavior tests for PUT /api/transactions/:id (server/invoiceEdit.ts) — editing a
// live OR settled (archived) sale/purchase invoice in place: lines, prices, stock, WAC cost,
// balances, payments (add/remove), stakeholder reassignment, the refunded-qty guard, and the
// transaction_edits audit trail.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Invoice Edit Test Co", "invoice-edit-test@example.com");
});

after(async () => {
  await app.close();
});

test("editing a live sale's qty/price updates total, stock, and stakeholder balance", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-1", name: "Widget", price: 10, stock: 100 });
  const customer = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Edit Customer", type: "customer" } });
  const customerId = customer.body.id;

  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customerId,
      type: "sale",
      items: [{ id: productId, quantity: 3 }], // 3 x $10 = $30
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }], // partial payment, $20 owed
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const txId = sale.body.id;

  const stockAfterSale = (app.db.prepare("SELECT stock FROM products WHERE id = ?").get(productId) as any).stock;
  assert.equal(stockAfterSale, 97, "3 units should have been deducted");

  // Edit: bump quantity to 5 and change the unit price to $12 -> new total $60. Keep the existing
  // payment explicitly by id (unambiguous — omitting `payments` entirely would also keep it, per
  // the route's default, but this exercises the "kept by id" path directly).
  const detailBefore = await app.api("GET", `/api/transactions/${txId}`, { tenantId });
  const existingPaymentId = detailBefore.body.payments[0].id;

  const edit2 = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      stakeholder_id: customerId,
      items: [{ product_id: productId, quantity: 5, unit_price: 12 }],
      payments: [{ id: existingPaymentId }],
    },
  });
  assert.equal(edit2.status, 200, JSON.stringify(edit2.body));
  assert.equal(edit2.body.total_amount, 60, "5 x $12 = $60");

  const stockAfterEdit = (app.db.prepare("SELECT stock FROM products WHERE id = ?").get(productId) as any).stock;
  assert.equal(stockAfterEdit, 95, "stock should reflect the NEW quantity (100 - 5), not double-deducted");

  const customerRow = app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(customerId) as any;
  assert.equal(customerRow.balance, -50, "owes $60 - $10 paid = $50, negative convention");

  const edits = await app.api("GET", `/api/transactions/${txId}/edits`, { tenantId });
  assert.equal(edits.status, 200);
  assert.equal(edits.body.length >= 1, true, "an audit row must be written for the edit");
});

test("editing an invoice can add and remove payments", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-2", name: "Gadget", price: 20, stock: 50 });

  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  const txId = sale.body.id;
  const detail = await app.api("GET", `/api/transactions/${txId}`, { tenantId });
  const originalPaymentId = detail.body.payments[0].id;

  // Remove the cash payment, add a card payment instead.
  const edit = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      items: [{ product_id: productId, quantity: 1, unit_price: 20 }],
      payments: [{ amount: 20, method: "card", currency: "USD", exchange_rate: 1 }], // omits the old id -> deleted, new one inserted
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.payments.length, 1);
  assert.equal(edit.body.payments[0].method, "card");
  assert.notEqual(edit.body.payments[0].id, originalPaymentId);
});

test("editing a settled (archived) invoice adjusts balance_baseline so the balance matches what it would be had the invoice been created that way", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-3", name: "Settled Item", price: 10, stock: 100 });
  const customer = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Settle Edit Customer", type: "customer" } });
  const customerId = customer.body.id;

  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customerId,
      type: "sale",
      items: [{ id: productId, quantity: 2 }], // $20, unpaid
      currency: "USD",
      exchange_rate: 1,
      payments: [],
    },
  });
  const txId = sale.body.id;

  await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });

  const balanceAfterSettle = (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(customerId) as any).balance;
  assert.equal(balanceAfterSettle, -20, "unpaid $20 sale owed after settlement");

  // Now edit the settled invoice: bump quantity to 4 -> $40 (still unpaid).
  const edit = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      items: [{ product_id: productId, quantity: 4, unit_price: 10 }],
      payments: [],
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.archived, 1); // SQLite integer boolean, same shape as GET /api/transactions/:id
  assert.equal(edit.body.total_amount, 40);

  const balanceAfterEdit = (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(customerId) as any).balance;
  assert.equal(balanceAfterEdit, -40, "balance must equal what it would be had the invoice been for $40 from the start");

  // Adding a payment on the archived invoice should write a cash_flow row for the open register.
  const editWithPayment = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      items: [{ product_id: productId, quantity: 4, unit_price: 10 }],
      payments: [{ amount: 15, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(editWithPayment.status, 200, JSON.stringify(editWithPayment.body));
  const balanceAfterPayment = (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(customerId) as any).balance;
  assert.equal(balanceAfterPayment, -25, "$40 owed - $15 just paid = $25");

  const cashFlowRows = app.db.prepare("SELECT * FROM cash_flow WHERE tenant_id = ? AND reason LIKE ?").all(tenantId, `%invoice #${txId}%`) as any[];
  assert.equal(cashFlowRows.length, 1, "a cash_flow row must be written for the new payment on the settled invoice");
  assert.equal(cashFlowRows[0].type, "in");
  assert.equal(cashFlowRows[0].amount, 15);
});

test("editing a sale can move it to a different stakeholder, recomputing both balances", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-4", name: "Movable Item", price: 10, stock: 50 });
  const customerA = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Customer A", type: "customer" } });
  const customerB = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Customer B", type: "customer" } });

  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customerA.body.id,
      type: "sale",
      items: [{ id: productId, quantity: 1 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [],
    },
  });
  const txId = sale.body.id;

  let balanceA = (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(customerA.body.id) as any).balance;
  assert.equal(balanceA, -10);

  const edit = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      stakeholder_id: customerB.body.id,
      items: [{ product_id: productId, quantity: 1, unit_price: 10 }],
      payments: [],
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));

  balanceA = (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(customerA.body.id) as any).balance;
  const balanceB = (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(customerB.body.id) as any).balance;
  assert.equal(balanceA, 0, "the old stakeholder must no longer carry this invoice's debt");
  assert.equal(balanceB, -10, "the new stakeholder now owes for it");
});

test("a sale line can't be edited below its already-refunded quantity", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-5", name: "Refund Guard Item", price: 10, stock: 50 });

  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productId, quantity: 5 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 50, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  const txId = sale.body.id;

  const refund = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "refund",
      original_transaction_id: txId,
      items: [{ id: productId, quantity: 3 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [{ amount: 30, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));

  // 3 of the 5 were refunded — dropping the invoice to quantity 2 should be rejected.
  const badEdit = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      items: [{ product_id: productId, quantity: 2, unit_price: 10 }],
      payments: [],
    },
  });
  assert.equal(badEdit.status, 400, JSON.stringify(badEdit.body));

  // Dropping to exactly the refunded floor (3) should be accepted.
  const okEdit = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      items: [{ product_id: productId, quantity: 3, unit_price: 10 }],
      payments: [],
    },
  });
  assert.equal(okEdit.status, 200, JSON.stringify(okEdit.body));

  // Removing the product entirely (when any of it was refunded) should also be rejected.
  const otherProductId = seedProduct(app.db, tenantId, { barcode: "EDIT-5B", name: "Other Item", price: 5, stock: 50 });
  const removeEdit = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      items: [{ product_id: otherProductId, quantity: 1, unit_price: 5 }],
      payments: [],
    },
  });
  assert.equal(removeEdit.status, 400, JSON.stringify(removeEdit.body));
});

test("a refund transaction itself can't be edited", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-6", name: "Refund Item", price: 10, stock: 50 });
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "sale", items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  const refund = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "refund", original_transaction_id: sale.body.id, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  const edit = await app.api("PUT", `/api/transactions/${refund.body.id}`, {
    tenantId,
    body: { items: [{ product_id: productId, quantity: 1, unit_price: 10 }], payments: [] },
  });
  assert.equal(edit.status, 400);
});

test("editing a purchase reverses and reapplies its WAC cost contribution and stock", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-7", name: "Costed Item", price: 20, stock: 0 });
  // Seed an existing cost basis: 10 units @ $4.
  app.db.prepare("UPDATE products SET cost = 4, stock = 10 WHERE id = ?").run(productId);

  // Purchase 10 more @ $6 -> blended cost (10*4 + 10*6)/20 = $5, stock 20.
  const purchase = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "purchase",
      items: [{ id: productId, quantity: 10, price: 6 }],
      currency: "USD",
      exchange_rate: 1,
      payments: [],
    },
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  let product = app.db.prepare("SELECT stock, cost FROM products WHERE id = ?").get(productId) as any;
  assert.equal(product.stock, 20);
  assert.equal(product.cost, 5);

  // Edit the purchase: change quantity to 10 but at a different unit cost, $8 instead of $6.
  // Reversing the original line restores stock=10, cost=4; reapplying 10 @ $8 gives (10*4+10*8)/20 = $6.
  const txId = purchase.body.id;
  const edit = await app.api("PUT", `/api/transactions/${txId}`, {
    tenantId,
    body: {
      items: [{ product_id: productId, quantity: 10, unit_price: 8 }],
      payments: [],
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));

  product = app.db.prepare("SELECT stock, cost FROM products WHERE id = ?").get(productId) as any;
  assert.equal(product.stock, 20, "stock should be back to 20 after reverse+reapply of the same quantity");
  assert.equal(product.cost, 6, "cost should reflect the reversed-then-reapplied WAC at the new unit cost");
});

test("editing a settled invoice never makes a later End-of-Day settlement collide on archived ids", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-COLLIDE", name: "Collide", price: 5, stock: 100 });
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
      payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  assert.equal(sale.status, 200);
  assert.equal((await app.api("POST", "/api/tenant/settlement", { tenantId })).status, 200);

  // Edit the now-archived invoice: new line rows + a new payment row land in the archive tables.
  const edit = await app.api("PUT", `/api/transactions/${sale.body.id}`, {
    tenantId,
    body: { items: [{ product_id: productId, quantity: 2, unit_price: 5 }],
      payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));

  // New live activity, then settle again — the live item/payment ids must not already exist in the archive.
  for (let i = 0; i < 3; i++) {
    const s = await app.api("POST", "/api/transactions", {
      tenantId,
      body: { type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
        payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }] },
    });
    assert.equal(s.status, 200);
  }
  const settle2 = await app.api("POST", "/api/tenant/settlement", { tenantId });
  assert.equal(settle2.status, 200, JSON.stringify(settle2.body));
});

test("a newly added payment is validated", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "EDIT-PAYV", name: "PayV", price: 5, stock: 10 });
  const sale = await app.api("POST", "/api/transactions", {
    tenantId, body: { type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] },
  });
  const bad = await app.api("PUT", `/api/transactions/${sale.body.id}`, {
    tenantId, body: { items: [{ product_id: productId, quantity: 1, unit_price: 5 }], payments: [{ amount: -3, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  assert.equal(bad.status, 400);
});
