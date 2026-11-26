import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBaskets, basketProducts, suggestBundlePrice, type Basket } from '../server/or/basketAnalysis.js';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

let app: Awaited<ReturnType<typeof createTestApp>>;
before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

const now = new Date('2026-11-27T12:00:00Z');
const products = [1, 2, 3, 4].map((id) => ({ id, name: `Product ${id}`, cost: 5, price: 10 }));
function basket(id: number, ids: number[], soldAt = '2026-11-26T12:00:00Z'): Basket {
  return { id: String(id), soldAt, lines: ids.map((product_id) => ({ product_id, quantity: 1 })) };
}
const baskets = [basket(1, [1, 2, 3]), basket(2, [1, 2, 3]), basket(3, [1, 2]), basket(4, [1]), basket(5, [3])];
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('Apriori computes basket support and directional confidence/lift for pairs and triples', () => {
  const ideas = analyzeBaskets(baskets, products, { minSupport: 2, now });
  const pair = ideas.find((idea) => idea.key === '1,2')!;
  assert.equal(pair.supportCount, 3);
  near(pair.support, 3 / 5);
  const rule = pair.rules.find((r) => r.consequent === 2)!;
  near(rule.confidence, 3 / 4);
  near(rule.lift, 1.25);
  const triple = ideas.find((idea) => idea.key === '1,2,3')!;
  assert.equal(triple.supportCount, 2);
  const tripleRule = triple.rules.find((r) => r.consequent === 3)!;
  near(tripleRule.confidence, 2 / 3);
  near(tripleRule.lift, (2 / 3) / (3 / 5));
});

test('default support cutoff is three baskets; repetitions and quantities do not inflate support', () => {
  assert.deepEqual(analyzeBaskets(baskets, products, { now }).map((idea) => idea.key), ['1,2']);
  assert.deepEqual(analyzeBaskets(baskets, products, { minSupport: 4, now }), []);
  assert.deepEqual(analyzeBaskets([basket(1, [1, 1, 2, 2])], products, { now }), []);
  assert.throws(() => analyzeBaskets(baskets, products, { minSupport: 0 }));
});

test('bundle snapshot rows count the bundle once without leaking its components', () => {
  const lines = [
    { product_id: 1, quantity: 2, bundle_id: 4 },
    { product_id: 2, quantity: 3, bundle_id: 4 },
    { product_id: 3, quantity: 1 },
    { product_id: 1, quantity: 0 },
  ];
  assert.deepEqual(basketProducts(lines), [3, 4]);
  const result = analyzeBaskets([{ id: 'bundle', soldAt: now.toISOString(), lines }],
    products.map((p) => ({ ...p, is_bundle: p.id === 4 ? 1 : 0 })), { minSupport: 1, now });
  assert.equal(result.length, 1);
  assert.equal(result[0].key, '3,4');
  assert.equal(result[0].canCreate, false);
  assert.deepEqual(basketProducts([...lines, { product_id: 1, quantity: 1 }]), [1, 3, 4]);
});

test('suggestion uses markup over cost and never exceeds regular price', () => {
  assert.equal(suggestBundlePrice(10, 20), 12);
  assert.equal(suggestBundlePrice(10, 11), 11);
  assert.equal(suggestBundlePrice(10, 20, 50), 15);
  assert.equal(suggestBundlePrice(0, 20), 0);
  assert.equal(suggestBundlePrice(1.234, 4), 1.48);
  assert.throws(() => suggestBundlePrice(10, 20, NaN));
});

test('slow/fast combinations receive a ranking boost', () => {
  const fixture = [basket(1, [1, 2, 3], '2026-10-01T12:00:00Z'),
    basket(2, [1, 2, 3], '2026-10-02T12:00:00Z'), basket(3, [1, 2, 3], '2026-10-03T12:00:00Z'),
    basket(4, [1, 3]), basket(5, [1, 3]), basket(6, [1, 3])];
  const ideas = analyzeBaskets(fixture, products, { now });
  const slowFast = ideas.find((idea) => idea.key === '1,2')!;
  assert.equal(slowFast.slowFast, true);
  near(slowFast.score, slowFast.lift * Math.log1p(slowFast.supportCount) * 2);
  assert.equal(ideas.find((idea) => idea.key === '1,3')!.slowFast, false);
});

test('data loader includes live and archived sales, filters invalid sales and isolates tenants', async () => {
  const { readBundleIdeas } = await import('../server/or/bundleIdeasData.js');
  const tenant = seedTenant(app.db, 'Basket Co', 'basket-co@example.com');
  const other = seedTenant(app.db, 'Other Basket Co', 'other-basket-co@example.com');
  const first = seedProduct(app.db, tenant, { barcode: 'BA-1', name: 'First', price: 10 });
  const second = seedProduct(app.db, tenant, { barcode: 'BA-2', name: 'Second', price: 10 });
  app.db.prepare('UPDATE products SET cost = 5 WHERE tenant_id = ?').run(tenant);
  let archivedId = 900000;
  function sale(source: 'live' | 'archive', overrides: {
    tenant?: number; status?: string; type?: string; deleted?: string | null; date?: string;
  } = {}) {
    const table = source === 'live' ? 'transactions' : 'archived_transactions';
    const items = source === 'live' ? 'transaction_items' : 'archived_transaction_items';
    const fields = 'tenant_id, type, status, total_amount, currency, exchange_rate, created_at, deleted_at';
    const values = [overrides.tenant ?? tenant, overrides.type ?? 'sale', overrides.status ?? 'completed',
      20, 'USD', 1, overrides.date ?? '2026-11-25 12:00:00', overrides.deleted ?? null];
    const id = source === 'archive' ? archivedId++ : Number(app.db.prepare(`INSERT INTO ${table} (${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...values).lastInsertRowid);
    if (source === 'archive') app.db.prepare(`INSERT INTO ${table} (id, ${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, ...values);
    for (const product of [first, second]) {
      if (source === 'archive') app.db.prepare(`INSERT INTO ${items} (id, transaction_id, product_id, quantity, unit_price) VALUES (?, ?, ?, 1, 10)`).run(archivedId++, id, product);
      else app.db.prepare(`INSERT INTO ${items} (transaction_id, product_id, quantity, unit_price) VALUES (?, ?, 1, 10)`).run(id, product);
    }
  }
  sale('live'); sale('archive'); sale('archive');
  sale('live', { status: 'voided' });
  sale('archive', { status: 'pending' });
  sale('archive', { deleted: '2026-11-26' });
  sale('live', { type: 'purchase' });
  sale('live', { date: '2026-08-01' });
  sale('live', { date: '2026-12-01' });
  sale('live', { tenant: other });
  const result = readBundleIdeas(tenant, {}, now);
  assert.equal(result.basketCount, 3);
  assert.equal(result.ideas.length, 1);
  assert.equal(result.ideas[0].supportCount, 3);
  assert.equal(result.ideas[0].suggestedPrice, 12);
  near(result.ideas[0].support, 1);
  assert.throws(() => readBundleIdeas(tenant, { min_support: 'invalid' }, now));
});
