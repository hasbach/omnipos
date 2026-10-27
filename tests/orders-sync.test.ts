import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';
import { makeFakeSupabase } from './helpers/fakeSupabase.js';
let app: Awaited<ReturnType<typeof createTestApp>>;
let sync: typeof import('../server/sync.js');
let session: typeof import('../server/session.js');
let cloud: typeof import('../server/cloudCall.js');
let tenant: number, store: number, product: number;
let fake: ReturnType<typeof makeFakeSupabase>;
const one = (sql: string, ...args: any[]) => app.db.prepare(sql).get(...args) as any;
const gid = (table: string, id: number) => one(`SELECT global_id FROM ${table} WHERE id = ?`, id).global_id;
const stamp = '2026-10-01T12:00:00.000Z';
function fixture(state = 'submitted') {
  const order = { global_id: 'order-1', tenant_id: gid('tenants', tenant), store_id: gid('stores', store), state, number: 1042, sale_global_id: 'sale-text', updated_at: stamp, synced_at: stamp };
  fake.setRows('orders', [order]);
  fake.setRows('order_lines', [{ global_id: 'line-1', tenant_id: order.tenant_id, order_id: order.global_id, product_id: gid('products', product), unit_key: 'unit-text', listing_id: 'listing-text', line_no: 1, ordered_qty: 3, updated_at: stamp, synced_at: stamp }, { global_id: 'line-2', tenant_id: order.tenant_id, order_id: order.global_id, product_id: 'missing', unit_key: 'base', line_no: 2, ordered_qty: 1, updated_at: stamp, synced_at: stamp }]);
  fake.setRows('order_events', [{ global_id: 'event-1', tenant_id: order.tenant_id, order_id: order.global_id, kind: 'submitted', detail: { safe: true }, updated_at: stamp, synced_at: stamp }]);
  return order;
}
before(async () => {
  app = await createTestApp(); sync = await import('../server/sync.js'); session = await import('../server/session.js'); cloud = await import('../server/cloudCall.js');
  tenant = seedTenant(app.db, 'Orders sync', 'orders-sync@example.com');
  store = Number(app.db.prepare("INSERT INTO stores (tenant_id, name, settings) VALUES (?, 'Online', ?)").run(tenant, JSON.stringify({ ordering_mode: 'online' })).lastInsertRowid);
  product = seedProduct(app.db, tenant, { barcode: 'SYNC-ORDER', name: 'Widget', price: 5 });
});
after(async () => { cloud.__setRpcCaller(null); session.__resetSessionStateForTests(); await app.close(); });
beforeEach(async () => {
  for (const table of sync.ORDER_PULL_TABLES) app.db.prepare(`DELETE FROM ${table}`).run();
  sync.clearSyncCursors(); sync.resetPullSchedule(); fake = makeFakeSupabase(); session.__setClientFactory(() => fake as any);
  await session.setActiveSession(tenant, gid('tenants', tenant), 'orders-sync@example.com', { access_token: 'test', refresh_token: 'test' });
  cloud.__setRpcCaller(null);
});
test('pull translates order FKs, preserves text IDs, reports insert/update counts, and never pushes mirrors', async () => {
  const o = fixture(); const counts = await sync.pullFromCloud(fake as any, tenant, o.tenant_id, sync.ORDER_PULL_TABLES);
  assert.equal(counts.orders.inserted, 1); assert.equal(counts.orders.updated, 0); assert.equal(counts.order_lines.inserted, 2);
  const local = one('SELECT * FROM orders'); assert.equal(local.tenant_id, tenant); assert.equal(local.store_id, store); assert.equal(local.sale_global_id, 'sale-text');
  const line = one("SELECT * FROM order_lines WHERE global_id = 'line-1'"); assert.equal(line.order_id, local.id); assert.equal(line.product_id, product); assert.equal(line.unit_key, 'unit-text'); assert.equal(line.listing_id, 'listing-text');
  assert.equal(one("SELECT product_id FROM order_lines WHERE global_id = 'line-2'").product_id, null);
  assert.equal(one('SELECT order_id FROM order_events').order_id, local.id);
  assert.equal(local.last_synced_at, local.updated_at);
  app.db.prepare("UPDATE orders SET state = 'rejected', updated_at = '2099-01-01' WHERE id = ?").run(local.id);
  const changed = await sync.pullFromCloud(fake as any, tenant, o.tenant_id, sync.ORDER_PULL_TABLES);
  assert.equal(changed.orders.updated, 1); assert.equal(one('SELECT state FROM orders').state, 'submitted');
  const again = await sync.pullFromCloud(fake as any, tenant, o.tenant_id, sync.ORDER_PULL_TABLES); assert.equal(again.orders.updated, 0);
  const start = fake.calls().length; await sync.pushToCloud(fake as any, tenant);
  assert.ok(!fake.calls().slice(start).some(c => 'table' in c && sync.ORDER_PULL_TABLES.includes(c.table)));
  const first = fake.calls()[0]; assert.ok('name' in first && first.name === 'orders_sweep');
});
test('lines and events read before their order are deferred, then linked once the order arrives', async () => {
  const o = fixture();
  const recent = new Date().toISOString();
  // The cloud rows are recent, so a missing parent defers them instead of dropping them.
  fake.setRows('order_lines', [{ global_id: 'line-r', tenant_id: o.tenant_id, order_id: o.global_id, unit_key: 'base', line_no: 1, ordered_qty: 1, updated_at: recent, synced_at: recent }]);
  fake.setRows('order_events', [{ global_id: 'event-r', tenant_id: o.tenant_id, order_id: o.global_id, kind: 'submitted', updated_at: recent, synced_at: recent }]);
  await sync.pullFromCloud(fake as any, tenant, o.tenant_id, ['order_lines', 'order_events']);
  assert.equal(one('SELECT COUNT(*) c FROM order_lines').c, 0, 'no line without its order');
  assert.equal(one('SELECT COUNT(*) c FROM order_events').c, 0);
  await sync.pullFromCloud(fake as any, tenant, o.tenant_id, sync.ORDER_PULL_TABLES);
  const local = one('SELECT id FROM orders');
  assert.equal(one("SELECT order_id FROM order_lines WHERE global_id = 'line-r'").order_id, local.id);
  assert.equal(one("SELECT order_id FROM order_events WHERE global_id = 'event-r'").order_id, local.id);
});
test('orders schedule is 30 seconds only for online ordering; hot/cold remain unchanged', () => {
  const start = 1000000;
  assert.ok(sync.duePullTables(start, 'tenant', true).includes('orders'));
  assert.deepEqual(sync.duePullTables(start + 29999, 'tenant', true), []);
  assert.deepEqual(sync.duePullTables(start + 30000, 'tenant', true), sync.ORDER_PULL_TABLES);
  const hot = sync.duePullTables(start + 60000, 'tenant', true); assert.ok(hot.includes('orders')); assert.ok(hot.includes('products')); assert.ok(!hot.includes('stores'));
  sync.resetPullSchedule(); sync.duePullTables(start, 'tenant'); assert.deepEqual(sync.duePullTables(start + 30000, 'tenant'), []);
});
test('sweep failure does not block pull; callback fires only for changed order rows', async () => {
  fixture(); fake.onRpc('orders_sweep', () => { throw new Error('offline'); });
  const events: any[] = []; const timer = sync.startSyncEngine({ onPulled: e => events.push(e) });
  try {
    await sync.runSyncCycleAt(1000000);
    assert.deepEqual(events, [{ tenantId: tenant, newSubmitted: 1, changed: 1 }]);
    await sync.runSyncCycleAt(1030000); assert.equal(events.length, 1);
    assert.ok(fake.calls().filter(c => 'name' in c && c.name === 'orders_sweep').length >= 2);
    fake.setRows('orders', [{ ...fixture('confirmed'), updated_at: '2026-10-02T12:00:00.000Z' }]);
    await sync.runSyncCycleAt(1060000); assert.deepEqual(events[1], { tenantId: tenant, newSubmitted: 0, changed: 1 });
  } finally { clearInterval(timer); }
});
test('tenant authority remains cloud-first and order cursors can be cleared per tenant', async () => {
  const globalId = gid('tenants', tenant);
  fake.setRows('tenants', [{ global_id: globalId, name: 'Cloud name', updated_at: stamp, synced_at: stamp }]);
  await sync.pullFromCloud(fake as any, tenant, globalId, ['tenants']);
  assert.equal(one('SELECT name FROM tenants WHERE id = ?', tenant).name, 'Cloud name');
  fixture(); await sync.pullFromCloud(fake as any, tenant, globalId, sync.ORDER_PULL_TABLES);
  assert.equal(one("SELECT COUNT(*) c FROM sync_cursor WHERE tenant_id = ? AND table_name IN ('orders','order_lines','order_events')", tenant).c, 3);
  sync.clearSyncCursors(tenant); assert.equal(one('SELECT COUNT(*) c FROM sync_cursor WHERE tenant_id = ?', tenant).c, 0);
});

test('tenant reset clears only its mirrors and cursors', async () => {
  const resetTenant = seedTenant(app.db, 'Reset mirrors', 'reset-orders@example.com');
  app.db.prepare("UPDATE users SET pin = '1234' WHERE tenant_id = ? AND role = 'admin'").run(resetTenant);
  for (const owner of [tenant, resetTenant]) {
    const id = Number(app.db.prepare("INSERT INTO orders (tenant_id, state) VALUES (?, 'submitted')").run(owner).lastInsertRowid);
    for (const table of ['order_lines', 'order_events']) app.db.prepare(`INSERT INTO ${table} (tenant_id, order_id) VALUES (?, ?)`).run(owner, id);
  }
  sync.clearSyncCursors();
  for (const owner of [tenant, resetTenant]) app.db.prepare("INSERT INTO sync_cursor (tenant_id, table_name, synced_at, global_id) VALUES (?, 'orders', ?, 'test')").run(owner, stamp);
  session.clearActiveSession();
  const r = await app.api('POST', '/api/tenant/reset', { tenantId: resetTenant, body: { scopes: ['transactions'], confirm: 'DELETE', admin_pin: '1234' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const table of sync.ORDER_PULL_TABLES) {
    assert.equal(one(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id = ?`, resetTenant).c, 0);
    assert.equal(one(`SELECT COUNT(*) c FROM ${table} WHERE tenant_id = ?`, tenant).c, 1);
  }
  assert.equal(one('SELECT COUNT(*) c FROM sync_cursor WHERE tenant_id = ?', resetTenant).c, 0);
  assert.equal(one('SELECT COUNT(*) c FROM sync_cursor WHERE tenant_id = ?', tenant).c, 1);
});

test('a missing order table is skipped with one warning', async () => {
  const from = fake.from.bind(fake); let requests = 0;
  fake.from = (table: string) => {
    const builder = from(table);
    if (table === 'order_events') builder.then = (resolve: any, reject: any) => {
      requests++; return Promise.resolve({ data: null, error: { code: 'PGRST205' } }).then(resolve, reject);
    };
    return builder;
  };
  const warnings: any[] = [], warn = console.warn; console.warn = (...args) => { warnings.push(args); };
  try {
    await sync.pullFromCloud(fake as any, tenant, gid('tenants', tenant), ['order_events']);
    await sync.pullFromCloud(fake as any, tenant, gid('tenants', tenant), ['order_events']);
    assert.equal(requests, 1); assert.equal(warnings.length, 1);
  } finally { console.warn = warn; }
});
