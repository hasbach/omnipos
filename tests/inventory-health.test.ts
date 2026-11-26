import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readInventoryHealth } from "../server/reports/inventoryHealth.js";

const now = new Date('2026-11-27T12:00:00Z');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, tenant_id INTEGER, name TEXT, category TEXT,
      stock REAL, cost REAL, track_inventory INTEGER DEFAULT 1, is_bundle INTEGER DEFAULT 0, deleted_at TEXT);
    CREATE TABLE stakeholders (id INTEGER PRIMARY KEY, tenant_id INTEGER, name TEXT);
    CREATE TABLE stock_adjustments (tenant_id INTEGER, product_id INTEGER, delta REAL, deleted_at TEXT);
  `);
  for (const prefix of ['', 'archived_']) {
    db.exec(`CREATE TABLE ${prefix}transactions (id INTEGER PRIMARY KEY, tenant_id INTEGER, type TEXT,
      created_at TEXT, stakeholder_id INTEGER, discount_type TEXT, discount_value REAL, status TEXT, deleted_at TEXT);
      CREATE TABLE ${prefix}transaction_items (transaction_id INTEGER, product_id INTEGER, quantity REAL,
      unit_price REAL, unit_cost REAL, discount_type TEXT, discount_value REAL, deleted_at TEXT);`);
  }
  const product = (id: number, stock: number, cost = 10, extra: { tenant?: number; category?: string; tracked?: number; bundle?: number; deleted?: string } = {}) => {
    db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, extra.tenant ?? 1, `Product ${id}`, extra.category ?? 'Food', stock, cost, extra.tracked ?? 1, extra.bundle ?? 0, extra.deleted ?? null);
  };
  const tx = (id: number, type: string, productId: number, quantity: number, date: string, extra: { archive?: boolean; tenant?: number; supplier?: number; status?: string; deleted?: string; price?: number; cost?: number; discount?: number } = {}) => {
    const prefix = extra.archive ? 'archived_' : '';
    db.prepare(`INSERT INTO ${prefix}transactions VALUES (?, ?, ?, ?, ?, 'fixed', ?, ?, ?)`)
      .run(id, extra.tenant ?? 1, type, date, extra.supplier ?? null, extra.discount ?? 0, extra.status ?? 'completed', extra.deleted ?? null);
    db.prepare(`INSERT INTO ${prefix}transaction_items VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`)
      .run(id, productId, quantity, extra.price ?? 20, extra.cost ?? 6);
  };
  return { db, product, tx };
}

test('positive tracked stock is valued at current cost and attributed to the latest live or archived purchase', () => {
  const { db, product, tx } = fixture();
  try {
    product(1, 5); product(2, -4); product(3, 100, 50, { tracked: 0 });
    product(4, 100, 50, { bundle: 1 }); product(5, 100, 50, { tenant: 2 });
    product(6, 100, 50, { deleted: '2026-11-01' });
    db.exec("INSERT INTO stakeholders VALUES (1, 1, 'Old'), (2, 1, 'Latest')");
    tx(1, 'purchase', 1, 2, '2026-01-01 12:00:00', { supplier: 1 });
    tx(2, 'purchase', 1, 3, '2026-02-01 12:00:00', { supplier: 2, archive: true });
    const report = readInventoryHealth(db, 1, now);
    assert.equal(report.totalValue, 50);
    assert.equal(report.categories[0].value, 50);
    assert.equal(report.suppliers.find(s => s.supplierId === 2)?.value, 50);
    assert.equal(report.suppliers.reduce((sum, s) => sum + s.value, 0), 50);
  } finally { db.close(); }
});

test('dead stock includes never sold items and respects inclusive 60 and 90 day thresholds', () => {
  const { db, product, tx } = fixture();
  try {
    for (let id = 1; id <= 4; id++) product(id, 1);
    const ago = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();
    tx(1, 'sale', 1, 1, ago(60));
    tx(2, 'sale', 2, 1, ago(90), { archive: true });
    tx(3, 'sale', 3, 1, ago(59));
    tx(4, 'sale', 4, 1, ago(1), { status: 'voided' });
    const report = readInventoryHealth(db, 1, now);
    assert.deepEqual(report.deadStock[0].items.map(p => p.id), [1, 2, 4]);
    assert.deepEqual(report.deadStock[1].items.map(p => p.id), [2, 4]);
    assert.equal(report.deadStock[0].value, 30);
  } finally { db.close(); }
});

test('365 day turns and GMROI use recorded costs, allocated invoice discounts and refunds', () => {
  const { db, product, tx } = fixture();
  try {
    product(1, 10); product(2, 0, 10, { category: 'Empty' });
    tx(1, 'sale', 1, 2, '2026-11-01 12:00:00', { discount: 10 });
    // Same invoice: the fixed discount must be allocated over both lines.
    db.exec('INSERT INTO transaction_items VALUES (1, 2, 1, 20, 6, NULL, NULL, NULL)');
    tx(1, 'refund', 1, 1, '2026-11-02 12:00:00', { archive: true });
    tx(2, 'sale', 1, 99, '2025-01-01 12:00:00');
    tx(3, 'sale', 1, 99, '2026-11-01 12:00:00', { tenant: 2 });
    tx(4, 'sale', 1, 99, '2026-11-01 12:00:00', { deleted: '2026-11-02' });
    const report = readInventoryHealth(db, 1, now);
    const food = report.categories.find(c => c.category === 'Food')!;
    assert.equal(food.cogs, 6);
    assert.ok(Math.abs(food.grossMargin - (40 * 5 / 6 - 20 - 6)) < 1e-9);
    assert.equal(food.turns, 0.06);
    assert.equal(food.gmroi, food.grossMargin / 100);
    assert.equal(report.categories.find(c => c.category === 'Empty')?.turns, null);
  } finally { db.close(); }
});

test('negative stock groups prioritize recorded negative adjustments and exclude foreign history', () => {
  const { db, product, tx } = fixture();
  try {
    product(1, -1); product(2, -2); product(3, -3); product(4, -1);
    tx(1, 'sale', 1, 1, '2026-11-01 12:00:00');
    tx(2, 'purchase', 2, 1, '2026-11-01 12:00:00');
    tx(3, 'sale', 2, 3, '2026-11-02 12:00:00');
    tx(4, 'sale', 3, 3, '2026-11-02 12:00:00');
    tx(5, 'purchase', 1, 99, '2026-11-01 12:00:00', { tenant: 2 });
    db.exec('INSERT INTO stock_adjustments VALUES (1, 3, -3, NULL), (2, 1, -1, NULL)');
    const report = readInventoryHealth(db, 1, now);
    assert.deepEqual(report.negatives.map(g => g.items.map(p => p.id)), [[1], [2], [3, 4]]);
    assert.equal(report.totalValue, 0);
  } finally { db.close(); }
});
