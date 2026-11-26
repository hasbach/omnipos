import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';
import { localPricePatch, staleLocalPrices, roundedLocalPrice, paymentCurrencyShares } from '../server/lbpRateAlerts.js';

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenant: number;
before(async () => {
  app = await createTestApp();
  tenant = seedTenant(app.db, 'Rate alerts', 'rate-alerts@example.com');
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate) VALUES (?, 'LBP', 'LL', 100000)").run(tenant);
});
after(async () => { await app.close(); });

test('tolerance includes the boundary and compares configured tiers', () => {
  assert.equal(staleLocalPrices({ price: 1, price_lbp: 97000 }, 100000), false);
  assert.equal(staleLocalPrices({ price: 1, price_lbp: 96999 }, 100000), true);
  assert.equal(staleLocalPrices({ price: 1, price_lbp: 100000, price_wholesale: 0.8, price_wholesale_lbp: 70000 }, 100000), true);
  assert.equal(staleLocalPrices({ price: 0, price_lbp: 1 }, 100000), true);
});

test('rounding follows editor nearest integer and configured step for every existing tier', () => {
  assert.equal(roundedLocalPrice(1.234567, 100000), 123457);
  assert.equal(roundedLocalPrice(1.234, 100000, 1000), 123000);
  assert.deepEqual(localPricePatch({ price: 1, price_lbp: 1, price_wholesale: 0.8, price_wholesale_lbp: 1,
    price_super_wholesale: 0.6, price_super_wholesale_lbp: 1, package_price: 5, package_price_lbp: 1 }, 100000),
  { price_lbp: 100000, price_wholesale_lbp: 80000, price_super_wholesale_lbp: 60000, package_price_lbp: 500000 });
  assert.deepEqual(localPricePatch({ price: 1, price_lbp: null, price_wholesale: 0.8, price_wholesale_lbp: 1 }, 100000), {});
  assert.deepEqual(localPricePatch({ price: 1, price_lbp: 1, price_wholesale: 0.8, price_wholesale_lbp: null }, 100000), { price_lbp: 100000 });
});

test('currency shares weight USD equivalents, subtract refunds, and handle empty denominators', () => {
  const shares = paymentCurrencyShares([
    { type: 'sale', currency: 'LBP', usd: 90 }, { type: 'sale', currency: 'USD', usd: 30 },
    { type: 'refund', currency: 'LBP', usd: 20 },
    { type: 'purchase', currency: 'USD', usd: 80 }, { type: 'purchase', currency: 'LBP', usd: 20 },
  ], 'LBP');
  assert.equal(shares.lbp_sales_pct, 70);
  assert.equal(shares.usd_costs_pct, 80);
  assert.equal(paymentCurrencyShares([], 'LBP').lbp_sales_pct, null);
});

test('route updates selected stale products, preserves USD and null local prices, logs and isolates tenants', async () => {
  const id = seedProduct(app.db, tenant, { barcode: 'RATE-1', name: 'Rate product', price: 1 });
  const untouched = seedProduct(app.db, tenant, { barcode: 'RATE-NULL', name: 'No local price', price: 2 });
  app.db.prepare('UPDATE products SET price_lbp = 50000, price_wholesale = 0.8, price_wholesale_lbp = 40000 WHERE id = ?').run(id);
  const review = await app.api('GET', '/api/local-rate/stale-prices', { tenantId: tenant });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.ok(review.body.products.some((p: any) => p.id === id));
  const result = await app.api('POST', '/api/local-rate/update-prices', { tenantId: tenant, body: { product_ids: [id] } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.updated, 1);
  const product = app.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
  assert.equal(product.price, 1);
  assert.equal(product.price_wholesale, 0.8);
  assert.equal(product.price_lbp, 100000);
  assert.equal(product.price_wholesale_lbp, 80000);
  assert.equal((app.db.prepare('SELECT price_lbp FROM products WHERE id = ?').get(untouched) as any).price_lbp, null);
  assert.ok(app.db.prepare("SELECT id FROM user_logs WHERE tenant_id = ? AND action = 'Product Updated' AND details LIKE ?").get(tenant, `%ID: ${id}, LBP rate:%`));
  const other = seedTenant(app.db, 'Other rate tenant', 'other-rate@example.com');
  const foreign = await app.api('POST', '/api/local-rate/update-prices', { tenantId: other, body: { product_ids: [id] } });
  assert.equal(foreign.body.updated, 0);
  const invalid = await app.api('POST', '/api/local-rate/update-prices', { tenantId: tenant, body: {} });
  assert.equal(invalid.status, 400);
});

test('party override and configured tolerance apply without changing the global rate', async () => {
  const id = seedProduct(app.db, tenant, { barcode: 'RATE-PARTY', name: 'Party price', price: 1 });
  app.db.prepare('UPDATE products SET price_lbp = 100000 WHERE id = ?').run(id);
  const party = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, local_rate) VALUES (?, 'Rate customer', 'customer', 120000)").run(tenant).lastInsertRowid);
  const review = await app.api('GET', `/api/local-rate/stale-prices?stakeholder_id=${party}`, { tenantId: tenant });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.local.rate, 120000);
  assert.ok(review.body.products.some((p: any) => p.id === id));
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'lbp_stale_tolerance_pct', '20')").run(tenant);
  const relaxed = await app.api('GET', `/api/local-rate/stale-prices?stakeholder_id=${party}`, { tenantId: tenant });
  assert.equal(relaxed.body.products.some((p: any) => p.id === id), false);
});

test('payment report includes live and archived payments at their historical rates and excludes credit', async () => {
  const isolated = seedTenant(app.db, 'Payment shares', 'rate-shares@example.com');
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate) VALUES (?, 'LBP', 'LL', 200000)").run(isolated);
  const live = Number(app.db.prepare("INSERT INTO transactions (tenant_id, type, total_amount, currency, exchange_rate) VALUES (?, 'sale', 100, 'USD', 1)").run(isolated).lastInsertRowid);
  app.db.prepare("INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate) VALUES (?, 7000000, 'cash', 'LBP', 100000)").run(live);
  app.db.prepare("INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate) VALUES (?, 900, 'store_credit', 'USD', 1)").run(live);
  app.db.prepare("INSERT INTO archived_transactions (id, tenant_id, type, total_amount, currency, exchange_rate, status) VALUES (900001, ?, 'sale', 30, 'USD', 1, 'paid')").run(isolated);
  app.db.prepare("INSERT INTO archived_payments (id, transaction_id, amount, method, currency, exchange_rate, created_at) VALUES (900001, 900001, 30, 'card', 'USD', 1, CURRENT_TIMESTAMP)").run();
  const purchase = Number(app.db.prepare("INSERT INTO transactions (tenant_id, type, total_amount, currency, exchange_rate) VALUES (?, 'purchase', 100, 'USD', 1)").run(isolated).lastInsertRowid);
  app.db.prepare("INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate) VALUES (?, 80, 'cash', 'USD', 1)").run(purchase);
  app.db.prepare("INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate) VALUES (?, 2000000, 'cash', 'LBP', 100000)").run(purchase);
  app.db.prepare("INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate, created_at) VALUES (?, 1000, 'cash', 'USD', 1, datetime('now', '-31 days'))").run(purchase);
  const report = await app.api('GET', '/api/local-rate/stale-prices', { tenantId: isolated });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.shares.lbp_sales_pct, 70);
  assert.equal(report.body.shares.usd_costs_pct, 80);
});

test('review and repricing require product editing permission', async () => {
  const userId = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Rate viewer', 'staff')").run(tenant).lastInsertRowid);
  assert.equal((await app.api('GET', '/api/local-rate/stale-prices', { tenantId: tenant, userId })).status, 403);
  assert.equal((await app.api('POST', '/api/local-rate/update-prices', { tenantId: tenant, userId, body: { product_ids: 'all' } })).status, 403);
});

test('all updates existing local tiers and leaves zero USD values and stock unchanged', async () => {
  const isolated = seedTenant(app.db, 'All local prices', 'all-rate-prices@example.com');
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate) VALUES (?, 'LBP', 'LL', 100000)").run(isolated);
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'lbp_rounding_step', '1000')").run(isolated);
  const id = seedProduct(app.db, isolated, { barcode: 'RATE-ALL', name: 'All tiers', price: 1.234, stock: 19 });
  app.db.prepare('UPDATE products SET price_lbp = 1, price_wholesale = 0, price_wholesale_lbp = 1, package_price = 6.171, package_price_lbp = 1 WHERE id = ?').run(id);
  const updated = await app.api('POST', '/api/local-rate/update-prices', { tenantId: isolated, body: { product_ids: 'all' } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.updated, 1);
  const product = app.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
  assert.equal(product.price_lbp, 123000);
  assert.equal(product.price_wholesale_lbp, 0);
  assert.equal(product.package_price_lbp, 617000);
  assert.equal(product.price_wholesale, 0);
  assert.equal(product.price, 1.234);
  assert.equal(product.package_price, 6.171);
  assert.equal(product.stock, 19);
  assert.equal((await app.api('GET', '/api/local-rate/stale-prices', { tenantId: isolated })).body.products.length, 0);
});
