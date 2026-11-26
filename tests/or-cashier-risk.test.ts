import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCashierRisk, robustZ, per100, cashierBriefingItems, type CashierDay } from '../server/or/cashierRisk.js';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

const day = (overrides: Partial<CashierDay> = {}): CashierDay => ({
  cashier: 'cashier-global', name: 'Rami', date: '2026-11-25', sales: 20,
  voids: 0, refunds: 0, discounts: 0, overrides: 0, cash_difference: 0, ...overrides,
});

test('MAD z-score, zero dispersion, and one-sided outliers', () => {
  assert.ok(Math.abs(robustZ(10, [0, 1, 2, 3, 4]) - 5.395918) < 0.00001);
  assert.equal(robustZ(6, [0, 0, 0]), Infinity);
  assert.equal(robustZ(0, [0, 0, 0]), 0);
  assert.ok(robustZ(0, [1, 2, 3]) < 0);
});

test('baseline requires 20 sales and excludes yesterday and older than 60 days', () => {
  const target = day({ date: '2026-11-26', voids: 6 });
  assert.equal(analyzeCashierRisk([day({ sales: 19 }), target], target.date)[0].flags.length, 0);
  assert.equal(analyzeCashierRisk([day(), target], target.date)[0].flags[0].metric, 'voids');
  assert.equal(analyzeCashierRisk([day({ date: '2026-01-01' }), target], target.date)[0].flags.length, 0);
});

test('peer normalization compares rates, guards target and each peer sample', () => {
  assert.equal(per100(10, 1000), per100(1, 100));
  const peers = [day({ cashier: 'b', sales: 1000, refunds: 10 }), day({ cashier: 'c', sales: 100, refunds: 1 })];
  assert.equal(analyzeCashierRisk([...peers, day({ date: '2026-11-26', sales: 200, refunds: 2 })], '2026-11-26')[0].flags.length, 0);
  const target = day({ date: '2026-11-26', sales: 100, refunds: 6 });
  assert.equal(analyzeCashierRisk([...peers, target], target.date)[0].flags[0].peer, true);
  assert.equal(analyzeCashierRisk([...peers, { ...target, sales: 19 }], target.date)[0].flags.length, 0);
});

test('briefing has one stable natural category per cashier and metric', () => {
  const target = day({ date: '2026-11-26', voids: 6 });
  const rows = analyzeCashierRisk([day(), target], target.date);
  const items = cashierBriefingItems(rows);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /Rami: 6 voids yesterday/);
  assert.match(items[0].details, /median: 0/);
  assert.equal(items[0].category, 'CASHIER_RISK:cashier-global:voids');
});

let app: Awaited<ReturnType<typeof createTestApp>>;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

test('cashier gets 403 and admin gets tenant-scoped data', async () => {
  const tenantId = seedTenant(app.db, 'Cashier risk', 'risk@example.com');
  app.db.prepare("UPDATE tenants SET or_license_type = 'lifetime' WHERE id = ?").run(tenantId);
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Rami', 'cashier', '1234')").run(tenantId).lastInsertRowid);
  const denied = await app.api('GET', '/api/or/cashier-risk', { tenantId, userId: cashier });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'PERMISSION_DENIED');
  const allowed = await app.api('GET', '/api/or/cashier-risk', { tenantId });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual(allowed.body.cashiers, []);
  const manager = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Manager', 'manager', '5678')").run(tenantId).lastInsertRowid);
  app.db.prepare(`INSERT INTO or_action_queue (tenant_id, action_date, category, title)
    VALUES (?, date('now'), 'CASHIER_RISK:global:voids', 'Sensitive activity')`).run(tenantId);
  const briefing = await app.api('GET', '/api/or/briefing', { tenantId, userId: manager });
  assert.equal(briefing.status, 200, JSON.stringify(briefing.body));
  assert.equal(JSON.stringify(briefing.body).includes('Sensitive activity'), false);
});

test('daily metrics include line/global discounts, refunds, override and shift difference once', async () => {
  const tenantId = seedTenant(app.db, 'Risk metrics', 'risk-metrics@example.com');
  const user = (app.db.prepare('SELECT id FROM users WHERE tenant_id = ?').get(tenantId) as any).id;
  const product = seedProduct(app.db, tenantId, { barcode: 'risk-product', name: 'Item', price: 10 });
  const tx = app.db.prepare(`INSERT INTO transactions
    (tenant_id, user_id, type, total_amount, currency, exchange_rate, price_level, discount_value, created_at)
    VALUES (?, ?, ?, 8, 'USD', 1, 'retail', ?, '2026-11-25 08:00:00')`);
  const sale = Number(tx.run(tenantId, user, 'sale', 1).lastInsertRowid);
  app.db.prepare('INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, discount_value) VALUES (?, ?, 1, 8, 1)').run(sale, product);
  tx.run(tenantId, user, 'refund', 0);
  app.db.prepare(`INSERT INTO cashier_shifts (tenant_id, user_id, date, expected_cash, actual_cash, created_at)
    VALUES (?, ?, '2026-11-25', 10, 7, '2026-11-25 20:00:00')`).run(tenantId, user);
  app.db.prepare(`INSERT INTO user_logs (tenant_id, user_id, action, details, created_at)
    VALUES (?, ?, 'Cashier Cash Out', 'Expected: 10.00, Actual: 7.00, Diff: -3.00', '2026-11-25 20:00:00')`).run(tenantId, user);
  const { loadCashierRisk } = await import('../server/or/cashierRiskData.js');
  const report = loadCashierRisk(tenantId, '2026-11-26');
  assert.equal(report.cashiers[0].sales, 1);
  assert.equal(report.cashiers[0].discounts, 1);
  assert.equal(report.cashiers[0].refunds, 1);
  assert.equal(report.cashiers[0].overrides, 1);
  assert.equal(report.cashiers[0].cash_difference, 3);
  assert.equal(report.shifts[0].sales, 1);
  app.db.prepare('DELETE FROM cashier_shifts WHERE tenant_id = ?').run(tenantId);
  assert.equal(loadCashierRisk(tenantId, '2026-11-26').cashiers[0].cash_difference, 3);
  const other = seedTenant(app.db, 'Other risk', 'other-risk@example.com');
  assert.equal(loadCashierRisk(other, '2026-11-26').daily.length, 0);
});
