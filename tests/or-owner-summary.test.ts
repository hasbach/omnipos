import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildOwnerSummary, ownerSummaryWhatsappUrl, type OwnerSummaryInput } from '../server/or/ownerSummary.js';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

const fixture = (overrides: Partial<OwnerSummaryInput> = {}): OwnerSummaryInput => ({
  date: '2026-11-26', licensed: true, sales: 200, gross: 80, net: 60, saleCount: 5,
  cash: 300, free: 100, shortfall: '2026-12-01', due: 90,
  local: { code: 'LBP', rate: 90000 },
  reorder: ['Milk', 'Bread', 'Coffee', 'Fourth'].map(name => ({ name, days_of_supply: 1.5 })),
  chase: ['Maya', 'Rami', 'Nour', 'Fourth'].map(name => ({ name, amount_usd: 20 })),
  alerts: { margin: { count: 2, top: 'Milk' }, stale: { count: 4, top: 'Coffee' }, risk: { count: 1, top: 'Cashier Ali' } },
  ...overrides,
});

test('Arabic is default; Arabic, English and French carry the same concise monetary data', () => {
  for (const [language, title, net] of [
    ['ar', 'الملخص اليومي', 'صافي الربح'],
    ['en', 'Daily summary', 'Net profit'],
    ['fr', 'Résumé quotidien', 'Bénéfice net'],
  ] as const) {
    const text = buildOwnerSummary(fixture(), language);
    assert.ok(text.startsWith(`${title} — 2026-11-26`));
    assert.ok(text.includes(`${net}: $60.00 [5,400,000 LBP]`));
    assert.ok(text.includes('$200.00 [18,000,000 LBP]'));
    assert.ok(text.includes('Cashier Ali'));
    assert.ok(text.includes('2026-12-01'));
    assert.ok(!text.includes('Fourth'));
    assert.equal(text.split('\n').length, 14);
  }
  assert.equal(buildOwnerSummary(fixture()), buildOwnerSummary(fixture(), 'ar'));
});

test('empty optional sections are omitted, but zero financial results remain visible', () => {
  const text = buildOwnerSummary(fixture({ sales: 0, gross: 0, net: 0, local: null,
    due: 0, shortfall: null, reorder: [], chase: [], alerts: {}, free: 0 }), 'en');
  assert.equal(text.split('\n').length, 7);
  assert.ok(text.includes('Sales: $0.00'));
  assert.ok(text.includes('Free spendable cash: $0.00'));
  for (const label of ['Bills', 'shortfall', 'Reorder', 'Customers', 'alerts', 'LBP']) assert.ok(!text.includes(label));
});

test('unlicensed summary excludes all OR data and cashier names even when supplied', () => {
  const text = buildOwnerSummary(fixture({ licensed: false }), 'en');
  assert.equal(text.split('\n').length, 7);
  assert.ok(text.includes('Customers to chase: Maya $20.00'));
  assert.ok(text.includes('Cash on hand: $300.00'));
  for (const value of ['Cashier Ali', 'Free spendable', 'Milk', 'shortfall', 'due this week']) assert.ok(!text.includes(value));
});

test('WhatsApp URL encodes Arabic and normalizes Lebanese and international numbers', () => {
  const text = buildOwnerSummary(fixture());
  for (const phone of ['70 123 456', '+961 70 123 456', '0096170123456']) {
    const url = new URL(ownerSummaryWhatsappUrl(text, phone));
    assert.equal(url.pathname, '/96170123456');
    assert.equal(url.searchParams.get('text'), text);
    assert.ok(url.href.includes('%D8'));
  }
  assert.equal(new URL(ownerSummaryWhatsappUrl(text, '03 123 456')).pathname, '/9613123456');
  assert.equal(new URL(ownerSummaryWhatsappUrl(text)).pathname, '/');
  assert.equal(new URL(ownerSummaryWhatsappUrl(text, '+33 6 12 34 56 78')).pathname, '/33612345678');
});

let app: Awaited<ReturnType<typeof createTestApp>>;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

test('cashier gets 403 on summary and settings, including language overrides', async () => {
  const tenantId = seedTenant(app.db, 'Owner summary', 'owner-summary@example.com');
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Ali', 'cashier', '1234')").run(tenantId).lastInsertRowid);
  for (const path of ['/api/or/owner-summary', '/api/or/owner-summary?language=fr', '/api/or/owner-summary-settings']) {
    const denied = await app.api('GET', path, { tenantId, userId: cashier });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'PERMISSION_DENIED');
  }
});

test('owner can read a nonlicensed summary, save normalized tenant settings and select a language', async () => {
  const tenantId = seedTenant(app.db, 'Owner settings', 'owner-settings@example.com');
  const initial = await app.api('GET', '/api/or/owner-summary?date=2026-11-26', { tenantId });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.language, 'ar');
  assert.equal(new URL(initial.body.whatsapp_url).pathname, '/');
  const saved = await app.api('PUT', '/api/or/owner-summary-settings', { tenantId,
    body: { owner_whatsapp: '70 123 456', owner_summary_language: 'fr' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.owner_whatsapp, '+96170123456');
  const result = await app.api('GET', '/api/or/owner-summary?date=2026-11-26', { tenantId });
  assert.equal(result.body.language, 'fr');
  assert.ok(result.body.text.startsWith('Résumé quotidien'));
  assert.equal(new URL(result.body.whatsapp_url).searchParams.get('text'), result.body.text);
  const other = seedTenant(app.db, 'Other owner', 'other-owner-summary@example.com');
  const isolated = await app.api('GET', '/api/or/owner-summary-settings', { tenantId: other });
  assert.equal(isolated.body.owner_whatsapp, '');
  assert.equal(isolated.body.owner_summary_language, 'ar');
  const invalid = await app.api('GET', '/api/or/owner-summary?date=2026-02-30', { tenantId });
  assert.equal(invalid.status, 400);
});

test('licensed loader uses single-day discounted profit and latest A/B stock metrics', async () => {
  const tenantId = seedTenant(app.db, 'Licensed summary', 'licensed-summary@example.com');
  app.db.prepare("UPDATE tenants SET or_license_type = 'lifetime' WHERE id = ?").run(tenantId);
  const product = seedProduct(app.db, tenantId, { barcode: 'summary-milk', name: 'Summary milk', price: 100 });
  const tx = Number(app.db.prepare(`INSERT INTO transactions
    (tenant_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, created_at)
    VALUES (?, 'sale', 180, 'USD', 1, 'percentage', 10, '2026-11-26T10:00:00Z')`).run(tenantId).lastInsertRowid);
  app.db.prepare(`INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost)
    VALUES (?, ?, 2, 100, 30)`).run(tx, product);
  // Local ids may overlap across the live and archived tables; profit must keep invoices separate.
  app.db.prepare(`INSERT INTO archived_transactions
    (id, tenant_id, type, total_amount, currency, exchange_rate, created_at)
    VALUES (?, ?, 'sale', 50, 'USD', 1, '2026-11-26T09:00:00Z')`).run(tx, tenantId);
  app.db.prepare(`INSERT INTO archived_transaction_items (id, transaction_id, product_id, quantity, unit_price, unit_cost)
    VALUES (?, ?, ?, 1, 50, 10)`).run(tx, tx, product);
  app.db.prepare(`INSERT INTO cash_flow (tenant_id, type, amount, currency, exchange_rate, category, created_at)
    VALUES (?, 'out', 20, 'USD', 1, 'expense', '2026-11-26T11:00:00Z')`).run(tenantId);
  app.db.prepare(`INSERT INTO or_sku_metrics (tenant_id, product_id, abc_class, days_of_supply)
    VALUES (?, ?, 'B', 1.5)`).run(tenantId, product);
  const response = await app.api('GET', '/api/or/owner-summary?date=2026-11-26&language=en', { tenantId });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.text.includes('Sales: $230.00'));
  assert.ok(response.body.text.includes('Gross profit: $160.00'));
  assert.ok(response.body.text.includes('Net profit: $140.00'));
  assert.ok(response.body.text.includes('Sales count: 2'));
  assert.ok(response.body.text.includes('Reorder: Summary milk (1.5 days of supply)'));
});
