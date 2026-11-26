import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenant: number;
let margins: typeof import("../server/or/marginAlerts.js");
before(async () => {
  app = await createTestApp();
  tenant = seedTenant(app.db, "Margins", "margins@example.com");
  margins = await import("../server/or/marginAlerts.js");
});
after(async () => { await app.close(); });

test("cost rise crossing target and a drop over five points above target both alert", () => {
  assert.equal(margins.evaluateMargin(0.47, 0.4, 0.55)!.erosion, true);
  const drop = margins.evaluateMargin(0.6, 0.5, 1)!;
  assert.equal(drop.under_target, false);
  assert.equal(drop.erosion, true);
  assert.equal(margins.evaluateMargin(0.55, 0.5, 1)!.erosion, false);
  assert.equal(margins.evaluateMargin(0.4, 0.47, 0.55)!.erosion, false);
});

test("suggestions round up to cents and local step, without adding a cent at exact boundaries", () => {
  assert.equal(margins.suggestedPrice(0.47, 20), 0.59);
  assert.equal(margins.suggestedPrice(0.48, 20), 0.6);
  assert.equal(margins.suggestedPrice(42000, 20, 1000), 53000);
  assert.equal(margins.evaluateMargin(0, null, 1), null);
  assert.equal(margins.evaluateMargin(NaN, null, 1), null);
});

test("receipt reversal uses WAC and all duplicate invoice lines rather than last supplier price", () => {
  assert.ok(Math.abs(margins.previousReceiptCost(0.6, 30, [
    { quantity: 10, unit_cost: 0.6, unit_price: 0.6 },
    { quantity: 10, unit_cost: null, unit_price: 0.8 },
  ])! - 0.4) < 1e-9);
  assert.equal(margins.previousReceiptCost(1, 10, [{ quantity: 10, unit_cost: 1, unit_price: 1 }]), null);
});

test("LBP price at today's rate alerts below cost and respects category targets and tenant isolation", () => {
  const id = seedProduct(app.db, tenant, { barcode: 'LBP-MARGIN', name: 'Chips', price: 1 });
  app.db.prepare("UPDATE products SET cost = 0.6, price_lbp = 50000 WHERE id = ?").run(id);
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate) VALUES (?, 'LBP', 'LL', 100000)").run(tenant);
  const row = margins.loadMarginAlerts(tenant).find(p => p.product_id === id)!;
  assert.ok(row.lbp_margin! < 0);
  assert.equal(row.suggested_price_lbp, 75000);
  app.db.prepare("UPDATE products SET price_lbp = NULL, cost = 0.79 WHERE id = ?").run(id);
  assert.equal(margins.loadMarginAlerts(tenant).some(p => p.product_id === id), false);
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'margin_target_pct_by_category', ?)").run(tenant, JSON.stringify({ general: 25 }));
  assert.equal(margins.loadMarginAlerts(tenant).find(p => p.product_id === id)!.target_pct, 25);
  const other = seedTenant(app.db, 'Other', 'margin-other@example.com');
  assert.equal(margins.loadMarginAlerts(other).length, 0);
  const unknown = seedProduct(app.db, tenant, { barcode: 'NO-COST', name: 'Unknown', price: 0 });
  assert.equal(margins.loadMarginAlerts(tenant).some(p => p.product_id === unknown), false);
});

test("latest purchase cost comparison remains correct after subsequent sales and archived history", async () => {
  const id = seedProduct(app.db, tenant, { barcode: 'WAC-MARGIN', name: 'WAC', price: 1, stock: 10 });
  app.db.prepare("UPDATE products SET cost = 0.6 WHERE id = ?").run(id);
  const receipt = await app.api('POST', '/api/transactions', { tenantId: tenant, body: {
    type: 'purchase', items: [{ id, quantity: 10, price: 1.2 }], currency: 'USD', exchange_rate: 1, payments: [],
  } });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  const row = margins.loadMarginAlerts(tenant).find(p => p.product_id === id)!;
  assert.ok(Math.abs(row.cost - 0.9) < 1e-6);
  assert.ok(Math.abs(row.previous_cost! - 0.6) < 1e-6);
  assert.equal(row.erosion, true);
  const sale = await app.api('POST', '/api/transactions', { tenantId: tenant, body: {
    type: 'sale', items: [{ id, quantity: 5, price: 1 }], currency: 'USD', exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  app.db.prepare("UPDATE transactions SET created_at = datetime('now', '+1 minute') WHERE id = ?").run(sale.body.id);
  assert.ok(Math.abs(margins.loadMarginAlerts(tenant).find(p => p.product_id === id)!.previous_cost! - 0.6) < 1e-6);
  // Settlement preserves transaction ids; copy the receipt using the shared archive columns.
  for (const [source, archived, where] of [
    ['transactions', 'archived_transactions', 'id'],
    ['transaction_items', 'archived_transaction_items', 'transaction_id'],
  ]) {
    const sourceCols = new Set((app.db.prepare(`PRAGMA table_info(${source})`).all() as any[]).map(c => c.name));
    const cols = (app.db.prepare(`PRAGMA table_info(${archived})`).all() as any[])
      .map(c => c.name).filter(c => sourceCols.has(c)).join(', ');
    app.db.prepare(`INSERT INTO ${archived} (${cols}) SELECT ${cols} FROM ${source} WHERE ${where} = ?`).run(receipt.body.id);
  }
  app.db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run(receipt.body.id);
  app.db.prepare('DELETE FROM transactions WHERE id = ?').run(receipt.body.id);
  assert.ok(Math.abs(margins.loadMarginAlerts(tenant).find(p => p.product_id === id)!.previous_cost! - 0.6) < 1e-6);
});
