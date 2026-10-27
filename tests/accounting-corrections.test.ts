import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";
let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Accounting corrections", "accounting-corrections@example.com");
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate) VALUES (?, 'LBP', 'LBP', 90000)").run(tenantId);
});
after(async () => { await app.close(); });

test("balance-payment correction uses party rate, survives archival and category reversal", async () => {
  const party = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, local_rate) VALUES (?, 'Correction customer', 'customer', 90000)").run(tenantId).lastInsertRowid);
  assert.equal((await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: party, amount: 180000, currency: "USD", direction: "collect" } })).status, 200);
  const row = app.db.prepare("SELECT * FROM cash_flow WHERE stakeholder_id = ?").get(party) as any;
  const edit = await app.api("PUT", `/api/cash-flow/${row.id}`, { tenantId, body: { currency: "LBP", exchange_rate: 1, edit_reason: "Correct currency" } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const balance = () => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(party) as any).balance;
  assert.equal(balance(), 2);
  const log = app.db.prepare("SELECT delta FROM stakeholder_balance_log WHERE reference_id = ? AND source = 'balance_payment_edit'").get(row.id) as any;
  assert.equal(log.delta, -179998);
  const settled = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.ok([200, 207].includes(settled.status), JSON.stringify(settled.body));
  assert.equal((app.db.prepare("SELECT stakeholder_id FROM archived_cash_flow WHERE id = ?").get(row.id) as any).stakeholder_id, party);
  assert.equal((await app.api("PUT", `/api/cash-flow/${row.id}?archived=1`, { tenantId, body: { amount: 360000, edit_reason: "Correct amount" } })).status, 200);
  assert.equal(balance(), 4);
  assert.equal((await app.api("PUT", `/api/cash-flow/${row.id}?archived=1`, { tenantId, body: { category: "other", edit_reason: "Remove collection" } })).status, 200);
  assert.equal(balance(), 0);
});

test("purchase create, edit and delete keep local product cost in step with WAC", async () => {
  const id = seedProduct(app.db, tenantId, { barcode: "COST-CORRECTION", name: "Cost correction", price: 10, stock: 10 });
  app.db.prepare("UPDATE products SET cost = 4, cost_lbp = 1 WHERE id = ?").run(id);
  const purchase = await app.api("POST", "/api/transactions", { tenantId, body: { type: "purchase", items: [{ id, quantity: 10, price: 6 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  const cost = () => app.db.prepare("SELECT cost, cost_lbp FROM products WHERE id = ?").get(id) as any;
  assert.deepEqual(cost(), { cost: 5, cost_lbp: 450000 });
  const edited = await app.api("PUT", `/api/transactions/${purchase.body.id}`, { tenantId, body: { items: [{ product_id: id, quantity: 10, unit_price: 8 }] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(cost(), { cost: 6, cost_lbp: 540000 });
  assert.equal((await app.api("DELETE", `/api/transactions/${purchase.body.id}`, { tenantId })).status, 200);
  assert.deepEqual(cost(), { cost: 4, cost_lbp: 360000 });
});


test("legacy matching is tenant-scoped and skips ambiguous names", async () => {
  const party = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, balance, balance_baseline) VALUES (?, 'Legacy correction', 'customer', 10, 10)").run(tenantId).lastInsertRowid);
  const row = Number(app.db.prepare("INSERT INTO cash_flow (tenant_id, type, amount, currency, exchange_rate, category, counterparty, reason) VALUES (?, 'in', 10, 'USD', 1, 'customer_collection', 'Legacy correction', 'Balance collection from Legacy correction')").run(tenantId).lastInsertRowid);
  assert.equal((await app.api("PUT", `/api/cash-flow/${row}`, { tenantId, body: { amount: 5, edit_reason: "Legacy correction" } })).status, 200);
  assert.equal((app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(party) as any).balance, 5);
  app.db.prepare("UPDATE cash_flow SET stakeholder_id = NULL WHERE id = ?").run(row);
  app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Legacy correction', 'customer')").run(tenantId);
  assert.equal((await app.api("PUT", `/api/cash-flow/${row}`, { tenantId, body: { amount: 3, edit_reason: "Ambiguous correction" } })).status, 200);
  assert.equal((app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(party) as any).balance, 5);
});
