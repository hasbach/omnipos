import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildSupplierScorecards, preferredSupplierPrices, supplierComparisons } from '../server/or/supplierScorecard.js';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

const now = new Date('2026-11-27T12:00:00Z');
const profiles = [1, 2, 3].map(id => ({ id, name: `Supplier ${id}`, fill_rate_score: id === 1 ? 0.79 : 0.9, payment_terms_days: 14 }));
const price = (supplier_id: number, value: number, date = '2026-11-20', quantity = 1) => ({ supplier_id, product_id: 1, product_name: 'Item', date, quantity, price: value });

test('price trend preserves per-piece prices and quantity weights the 90-day average', () => {
  const cards = buildSupplierScorecards(profiles, [price(1, 2, '2026-01-01'), price(1, 4, '2026-10-01', 3), price(1, 3)], [], [], [], now);
  const p = cards[0].products[0];
  assert.equal(p.last_price, 3);
  assert.equal(p.change, -1);
  assert.equal(p.average_90d, 3.75);
  assert.deepEqual(p.history.map(h => h.price), [2, 4, 3]);
});

test('cheapest reliable supplier skips poor fill rate and late deliveries; unknown delivery history is allowed', () => {
  const prices = [price(1, 1), price(2, 2), price(3, 3)];
  const cards = buildSupplierScorecards(profiles, prices, [], [{ supplier_id: 2, expected: '2026-11-01', received: '2026-11-02' }], [], now);
  assert.deepEqual(preferredSupplierPrices(cards).get(1), { supplier_id: 3, unit_cost_usd: 3 });
  assert.equal(supplierComparisons(cards)[0].cheapest_last.supplier_id, 1);
  assert.equal(supplierComparisons(cards)[0].cheapest_average_90d!.supplier_id, 1);
  assert.equal(preferredSupplierPrices([cards[2]]).size, 0);
  assert.equal(preferredSupplierPrices(cards.map(c => ({ ...c, fill_rate_score: 0.1 }))).size, 0);
});

test('totals use invoice amounts, include older purchases only all time, and sum derived open debt', () => {
  const [card] = buildSupplierScorecards(profiles, [], [
    { supplier_id: 1, date: '2026-01-01', amount: 100 },
    { supplier_id: 1, date: '2026-11-01', amount: 80 },
    { supplier_id: 999, date: '2026-11-01', amount: 900 },
  ], [], [{ party_id: 1, amount_usd: 20 }, { party_id: 1, amount_usd: 5 }], now);
  assert.equal(card.bought_all_usd, 180);
  assert.equal(card.bought_90d_usd, 80);
  assert.equal(card.owed_usd, 25);
});

let app: Awaited<ReturnType<typeof createTestApp>>;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

test('loader includes archived prices, derived owed and tenant isolation; optimizer overrides primary supplier and cost', async () => {
  const tenantId = seedTenant(app.db, 'Scorecard', 'supplier-scorecard@example.com');
  const otherTenant = seedTenant(app.db, 'Other Scorecard', 'other-scorecard@example.com');
  await app.api('POST', '/api/stakeholders', { tenantId: otherTenant, body: { name: 'Other supplier', type: 'supplier' } });
  const product = seedProduct(app.db, tenantId, { barcode: 'SCORECARD', name: 'Item', price: 10, stock: 10 });
  const suppliers: number[] = [];
  for (const [index, cost] of [1, 2, 3].entries()) {
    const supplier = (await app.api('POST', '/api/stakeholders', { tenantId, body: { name: `Score ${index}`, type: 'supplier' } })).body.id;
    suppliers.push(supplier);
    app.db.prepare('INSERT INTO or_supplier_profiles (tenant_id, supplier_id, fill_rate_score) VALUES (?, ?, ?)').run(tenantId, supplier, index === 0 ? 0.5 : 1);
    const result = await app.api('POST', '/api/transactions', { tenantId, body: {
      type: 'purchase', stakeholder_id: supplier, items: [{ id: product, quantity: 2, price: cost }], currency: 'USD', exchange_rate: 1, payments: [],
    } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (index === 1) {
      app.db.prepare(`INSERT INTO archived_transactions (id, tenant_id, stakeholder_id, type, total_amount, currency, exchange_rate, created_at)
        SELECT id, tenant_id, stakeholder_id, type, total_amount, currency, exchange_rate, created_at FROM transactions WHERE id = ?`).run(result.body.id);
      app.db.prepare(`INSERT INTO archived_transaction_items (id, transaction_id, product_id, quantity, unit_price, unit_cost)
        SELECT id, transaction_id, product_id, quantity, unit_price, unit_cost FROM transaction_items WHERE transaction_id = ?`).run(result.body.id);
      app.db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run(result.body.id);
      app.db.prepare('DELETE FROM transactions WHERE id = ?').run(result.body.id);
    }
  }
  const { loadSupplierScorecards } = await import('../server/or/supplierScorecardData.js');
  app.db.prepare("INSERT INTO or_po_commitments (tenant_id, supplier_id, expected_delivery_date, status, settled_at) VALUES (?, ?, '2026-11-10', 'SETTLED', '2026-11-10 12:00:00')").run(tenantId, suppliers[1]);
  const cards = loadSupplierScorecards(tenantId);
  assert.equal(cards.length, 3);
  assert.equal(cards.find(c => c.id === suppliers[1])!.on_time_rate, 1);
  assert.equal((await app.api('GET', '/api/or/suppliers/scorecard', { tenantId })).status, 403);
  app.db.prepare("UPDATE tenants SET or_license_type = 'lifetime' WHERE id = ?").run(tenantId);
  const response = await app.api('GET', '/api/or/suppliers/scorecard', { tenantId });
  assert.equal(response.status, 200);
  assert.equal(response.body.suppliers.length, 3);
  assert.equal((await app.api('GET', '/api/or/suppliers/' + suppliers[1] + '/scorecard', { tenantId: otherTenant })).status, 403);
  app.db.prepare("UPDATE tenants SET or_license_type = 'lifetime' WHERE id = ?").run(otherTenant);
  assert.equal((await app.api('GET', '/api/or/suppliers/' + suppliers[1] + '/scorecard', { tenantId: otherTenant })).status, 404);
  assert.equal(cards.find(c => c.id === suppliers[1])!.products[0].last_price, 2);
  assert.equal(cards.find(c => c.id === suppliers[1])!.owed_usd, 4);
  const { ensureOrInitialized } = await import('../server/or/config.js');
  ensureOrInitialized(tenantId);
  app.db.prepare('UPDATE products SET cost = 9 WHERE id = ?').run(product);
  app.db.prepare(`INSERT INTO or_sku_metrics (tenant_id, product_id, weighted_daily_sales, primary_supplier_id) VALUES (?, ?, 1, ?)`).run(tenantId, product, suppliers[2]);
  const { buildOptimizationProblem } = await import('../server/or/optimizer.js');
  const sku = buildOptimizationProblem(tenantId, { cashBudgetOverride: 100 }).skus.find(s => s.product_id === product)!;
  assert.equal(sku.supplier_id, suppliers[1]);
  assert.equal(sku.unit_cost_usd, 2);
});
