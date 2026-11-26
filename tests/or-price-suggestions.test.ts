import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fitElasticity, categoryElasticities, evaluateCandidates, type SaleDay } from '../server/or/priceSuggestions.js';
import { roundedLocalPrice } from '../server/lbpRateAlerts.js';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

function synthetic(elasticity = -1.5): SaleDay[] {
  return Array.from({ length: 56 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
    const price = i < 28 ? 10 : 12;
    return { day, price, units: 100 * (price / 10) ** elasticity * (1 + new Date(day).getUTCDay() / 10) };
  });
}
const product = { id: 1, name: 'Product', category: 'Food', cost: 6, price: 10 };

test('weekday fixed effects recover known elasticity, standard error and fit', () => {
  const fit = fitElasticity(synthetic())!;
  assert.ok(Math.abs(fit.elasticity + 1.5) < 1e-9);
  assert.ok(fit.standard_error < 1e-6);
  assert.ok(fit.r_squared > 0.999999);
});

test('elasticity clamps extreme slopes and rejects flat or positive ones', () => {
  assert.equal(fitElasticity(synthetic(-8))!.elasticity, -4);
  // A positive slope is not evidence of price sensitivity: no fit (falls back to category / margin target).
  assert.equal(fitElasticity(synthetic(2)), null);
  assert.equal(fitElasticity(synthetic(0)), null);
});

test('short price runs and one level are insufficient; category pools only eligible products', () => {
  assert.equal(fitElasticity(synthetic().slice(0, 28)), null);
  assert.equal(fitElasticity(synthetic().map((d, i) => ({ ...d, price: i % 2 ? 10 : 12 }))), null);
  const fit = fitElasticity(synthetic())!;
  const pooled = categoryElasticities([product, { ...product, id: 2 }, { ...product, id: 3, category: 'Other' }], new Map([[1, fit]]));
  assert.equal(pooled.get('Food')!.elasticity, fit.elasticity);
  assert.equal(pooled.has('Other'), false);
});

test('candidate optimum respects target and ten percent volume cap; impossible constraints return null', () => {
  const fit = fitElasticity(synthetic(-2))!;
  const result = evaluateCandidates(product, 100, 20, 7.5, fit)!;
  assert.ok(result.volume_change_pct >= -10);
  assert.ok((1 - product.cost / result.suggested_price) * 100 >= 20);
  assert.equal(result.suggested_price, 10.5);
  assert.equal(evaluateCandidates({ ...product, cost: 9.9 }, 100, 50, 19.8, fit), null);
});

test('insufficient-data fallback uses only margin target and does not imply measured sensitivity', () => {
  const result = evaluateCandidates(product, 10, 20, 7.5, null)!;
  assert.equal(result.suggested_price, 7.5);
  assert.equal(result.units_change, 0);
  assert.equal(result.profit_change, -25);
});

test('USD candidates round to cents and LBP equivalents use shop rounding', () => {
  const result = evaluateCandidates(product, 10, 20, 7.51, fitElasticity(synthetic()))!;
  assert.ok(Math.abs(result.suggested_price * 100 - Math.round(result.suggested_price * 100)) < 1e-9);
  assert.equal(roundedLocalPrice(1.23, 89500, 5000), 110000);
});

let app: Awaited<ReturnType<typeof createTestApp>>;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

test('loader includes live/archive net line sales, excludes deleted/incomplete/old and other tenant rows', async () => {
  const tenant = seedTenant(app.db, 'Price suggestions', 'price-suggestions@example.com');
  const other = seedTenant(app.db, 'Other prices', 'price-suggestions-other@example.com');
  const id = seedProduct(app.db, tenant, { name: 'Price product', barcode: 'PRICE-TEST', price: 10 });
  app.db.prepare('UPDATE products SET cost = 6 WHERE id = ?').run(id);
  const sale = await app.api('POST', '/api/transactions', { tenantId: tenant, body: {
    type: 'sale', items: [{ id, quantity: 10, price: 10, discount_type: 'percentage', discount_value: 10 }],
    currency: 'USD', exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  app.db.prepare("UPDATE transactions SET created_at = datetime('now', '-1 day') WHERE id = ?").run(sale.body.id);
  const { loadPriceSuggestions } = await import('../server/or/priceSuggestionsData.js');
  assert.equal(loadPriceSuggestions(other).products.length, 0);
  assert.ok(Math.abs(loadPriceSuggestions(tenant).products[0].current_units - 10 / 28) < 1e-9);
  for (const [source, archive, key] of [
    ['transactions', 'archived_transactions', 'id'],
    ['transaction_items', 'archived_transaction_items', 'transaction_id'],
  ]) {
    const existing = new Set((app.db.prepare(`PRAGMA table_info(${source})`).all() as any[]).map(c => c.name));
    const cols = (app.db.prepare(`PRAGMA table_info(${archive})`).all() as any[]).map(c => c.name).filter(c => existing.has(c)).join(', ');
    app.db.prepare(`INSERT INTO ${archive} (${cols}) SELECT ${cols} FROM ${source} WHERE ${key} = ?`).run(sale.body.id);
  }
  app.db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run(sale.body.id);
  app.db.prepare('DELETE FROM transactions WHERE id = ?').run(sale.body.id);
  assert.ok(Math.abs(loadPriceSuggestions(tenant).products[0].current_units - 10 / 28) < 1e-9);
  app.db.prepare("UPDATE archived_transactions SET status = 'draft' WHERE id = ?").run(sale.body.id);
  assert.equal(loadPriceSuggestions(tenant).products[0].current_units, 0);
  app.db.prepare("UPDATE archived_transactions SET status = 'completed', deleted_at = datetime('now') WHERE id = ?").run(sale.body.id);
  assert.equal(loadPriceSuggestions(tenant).products[0].current_units, 0);
  app.db.prepare("UPDATE archived_transactions SET deleted_at = NULL, created_at = datetime('now', '-400 days') WHERE id = ?").run(sale.body.id);
  assert.equal(loadPriceSuggestions(tenant).products[0].current_units, 0);
});
