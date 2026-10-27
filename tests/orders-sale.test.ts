import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';
import { makeFakeSupabase } from './helpers/fakeSupabase.js';
let app: Awaited<ReturnType<typeof createTestApp>>;
let session: typeof import('../server/session.js');
let cloud: typeof import('../server/cloudCall.js');
let tenant: number, product: number, store: number, orderId: number;
let calls: Array<{ fn: string; args: any }>;
const one = (sql: string, ...args: any[]) => app.db.prepare(sql).get(...args) as any;
const gid = (table: string, id: number) => one('SELECT global_id FROM ' + table + ' WHERE id = ?', id).global_id;
const request = (method: string, url: string, body?: any, userId?: number) => app.api(method, url, { tenantId: tenant, body, userId });
const cart = (extra = {}) => ({ items: [{ id: product, quantity: 2, unit_price: 5 }], currency: 'USD', exchange_rate: 1,
  payments: [{ amount: 10, currency: 'USD', exchange_rate: 1, method: 'cash' }], ...extra });
function cloudOrder(state = 'completed') {
  const row = one('SELECT * FROM orders WHERE id = ?', orderId);
  // A cloud reply is newer than the local mirror row, so applying it replaces the row.
  return { ...row, tenant_id: gid('tenants', tenant), store_id: gid('stores', store), state, updated_at: '2099-01-01T00:00:00.000Z' };
}
function noSale() {
  assert.equal(one('SELECT COUNT(*) n FROM transactions WHERE tenant_id = ?', tenant).n, 0);
  assert.equal(one('SELECT stock FROM products WHERE id = ?', product).stock, 100);
}
before(async () => {
  app = await createTestApp();
  session = await import('../server/session.js');
  cloud = await import('../server/cloudCall.js');
});
after(async () => { cloud.__setRpcCaller(null); session.__resetSessionStateForTests(); await app.close(); });
beforeEach(async () => {
  tenant = seedTenant(app.db, 'Order sale', 'sale-' + Math.random() + '@example.com');
  product = seedProduct(app.db, tenant, { barcode: 'ORDER', name: 'Widget', price: 9 });
  store = Number(app.db.prepare("INSERT INTO stores (tenant_id, name) VALUES (?, 'Online')").run(tenant).lastInsertRowid);
  orderId = Number(app.db.prepare("INSERT INTO orders (tenant_id, store_id, number, state, customer_phone, expires_at) VALUES (?, ?, 1042, 'confirmed', '+96170123456', '2099-01-01')").run(tenant, store).lastInsertRowid);
  app.db.prepare("INSERT INTO order_lines (tenant_id, order_id, line_no, product_id, product_name, unit_key, unit_factor, ordered_qty, confirmed_qty, unit_price_usd) VALUES (?, ?, 1, ?, 'Widget', 'base', 1, 2, 2, 5)").run(tenant, orderId, product);
  app.db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'allow_price_override', '0')").run(tenant);
  session.__setClientFactory(() => makeFakeSupabase() as any);
  await session.setActiveSession(tenant, gid('tenants', tenant), 'test@example.com', { access_token: 'test', refresh_token: 'test' });
  calls = [];
  cloud.__setRpcCaller(async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'order_complete') noSale();
    return { data: { ok: true, order: cloudOrder(), lines: [] }, error: null };
  });
});
test('sale draft resolves units, removed units, missing products and customer ambiguity', async () => {
  const unit = Number(app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price) VALUES (?, ?, 'Pack', 6, 30)").run(tenant, product).lastInsertRowid);
  app.db.prepare('UPDATE order_lines SET unit_key = ?, unit_factor = 6, unit_price_usd = 30 WHERE order_id = ?').run(gid('product_units', unit), orderId);
  const customer = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, phone) VALUES (?, 'Match', 'customer', '+961 70 123 456')").run(tenant).lastInsertRowid);
  let draft = await request('GET', '/api/orders/' + orderId + '/sale-draft');
  assert.equal(draft.status, 200); assert.equal(draft.body.stakeholder_id, customer);
  assert.deepEqual(draft.body.lines, [{ product_id: product, uom_id: unit, quantity: 2, unit_price: 30 }]);
  app.db.prepare('UPDATE product_units SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(unit);
  draft = await request('GET', '/api/orders/' + orderId + '/sale-draft');
  assert.deepEqual(draft.body.lines, [{ product_id: product, uom_id: null, quantity: 12, unit_price: 5 }]);
  assert.deepEqual(draft.body.converted, [{ line_no: 1, reason: 'unit_removed' }]);
  const walkin = one("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'", tenant).id;
  app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, phone) VALUES (?, 'Duplicate', 'customer', '+96170123456')").run(tenant);
  assert.equal((await request('GET', '/api/orders/' + orderId + '/sale-draft')).body.stakeholder_id, walkin);
  app.db.prepare("UPDATE stakeholders SET phone = NULL WHERE tenant_id = ?").run(tenant);
  assert.equal((await request('GET', '/api/orders/' + orderId + '/sale-draft')).body.stakeholder_id, walkin);
  app.db.prepare('UPDATE products SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(product);
  draft = await request('GET', '/api/orders/' + orderId + '/sale-draft');
  assert.equal(draft.body.lines.length, 0); assert.equal(draft.body.skipped[0].reason, 'product_deleted');
});
test('draft rejects non-completable states and existing live or archived sales', async () => {
  for (const state of ['submitted', 'rejected']) {
    app.db.prepare('UPDATE orders SET state = ? WHERE id = ?').run(state, orderId);
    assert.equal((await request('GET', '/api/orders/' + orderId + '/sale-draft')).body.code, 'ORDER_NOT_COMPLETABLE');
  }
  app.db.prepare("UPDATE orders SET state = 'confirmed' WHERE id = ?").run(orderId);
  for (const table of ['transactions', 'archived_transactions']) {
    app.db.prepare('INSERT INTO ' + table + ' (tenant_id, type, total_amount, currency, exchange_rate, order_global_id) VALUES (?, ?, 10, \'USD\', 1, ?)').run(tenant, 'sale', gid('orders', orderId));
    assert.equal((await request('GET', '/api/orders/' + orderId + '/sale-draft')).body.code, 'ORDER_ALREADY_COMPLETED');
    assert.equal((await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId) }))).body.code, 'ORDER_ALREADY_COMPLETED');
    app.db.prepare('DELETE FROM ' + table + ' WHERE tenant_id = ?').run(tenant);
  }
  assert.equal(calls.length, 0);
});
for (const mode of ['USD', 'LBP', 'mixed']) test('SC-007 ordinary sale parity: ' + mode, async () => {
  const twin = seedTenant(app.db, 'Twin', 'twin-' + Math.random() + '@example.com');
  const twinProduct = seedProduct(app.db, twin, { barcode: 'TWIN', name: 'Widget', price: 5 });
  for (const owner of [tenant, twin]) app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'L', 90000, 0)").run(owner);
  const payments = mode === 'USD' ? [{ amount: 10, currency: 'USD', exchange_rate: 1, method: 'cash' }]
    : mode === 'LBP' ? [{ amount: 900000, currency: 'LBP', exchange_rate: 90000, method: 'cash' }]
      : [{ amount: 5, currency: 'USD', exchange_rate: 1, method: 'cash' }, { amount: 450000, currency: 'LBP', exchange_rate: 90000, method: 'cash' }];
  const customer = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Customer', 'customer')").run(tenant).lastInsertRowid);
  const twinCustomer = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Customer', 'customer')").run(twin).lastInsertRowid);
  const sale = await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId), payments, stakeholder_id: customer }));
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const plain = await app.api('POST', '/api/transactions', { tenantId: twin, body: cart({ items: [{ id: twinProduct, quantity: 2 }], payments, stakeholder_id: twinCustomer }) });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(calls.length, 1); assert.equal(calls[0].fn, 'order_complete');
  const tx = one('SELECT * FROM transactions WHERE id = ?', sale.body.id);
  assert.equal(calls[0].args.p_sale_global_id, tx.global_id); assert.equal(calls[0].args.p_sale_total_usd, tx.total_amount);
  assert.equal(tx.total_amount, one('SELECT total_amount FROM transactions WHERE id = ?', plain.body.id).total_amount);
  assert.equal(sale.body.balance_after, plain.body.balance_after);
  assert.equal(one('SELECT balance FROM stakeholders WHERE id = ?', customer).balance,
    one('SELECT balance FROM stakeholders WHERE id = ?', twinCustomer).balance);
  assert.equal(one('SELECT stock FROM products WHERE id = ?', product).stock, one('SELECT stock FROM products WHERE id = ?', twinProduct).stock);
  for (const [table, columns] of [['transaction_items', 'quantity, unit_price, uom_id, uom_name, uom_factor, uom_qty'], ['payments', 'amount, method, currency, exchange_rate']]) {
    assert.deepEqual(app.db.prepare('SELECT ' + columns + ' FROM ' + table + ' WHERE transaction_id = ? ORDER BY id').all(sale.body.id),
      app.db.prepare('SELECT ' + columns + ' FROM ' + table + ' WHERE transaction_id = ? ORDER BY id').all(plain.body.id));
  }
});
test('offline and handled completion roll back every sale write', async () => {
  session.clearActiveSession();
  assert.equal((await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId) }))).body.code, 'ORDER_NEEDS_ONLINE');
  noSale();
  await session.setActiveSession(tenant, gid('tenants', tenant), 'test@example.com', { access_token: 'test', refresh_token: 'test' });
  cloud.__setRpcCaller(async () => ({ data: { ok: false, code: 'handled', order: cloudOrder(), lines: [] }, error: null }));
  const result = await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId) }));
  assert.equal(result.status, 409); assert.equal(result.body.code, 'ORDER_ALREADY_COMPLETED'); noSale();
  assert.equal(one('SELECT state FROM orders WHERE id = ?', orderId).state, 'completed');
});
test('commit revalidation failure compensates with the same sale id', async () => {
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'allow_negative_stock', '0')").run(tenant);
  cloud.__setRpcCaller(async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'order_complete') app.db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(product);
    return { data: { ok: true, order: cloudOrder(), lines: [] }, error: null };
  });
  const result = await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId) }));
  assert.equal(result.body.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual(calls.map(c => c.fn), ['order_complete', 'order_complete_undo']);
  assert.equal(calls[0].args.p_sale_global_id, calls[1].args.p_sale_global_id);
  assert.equal(one('SELECT COUNT(*) n FROM transactions WHERE tenant_id = ?', tenant).n, 0);
});
test('a timed-out completion is reverted best effort and nothing is written', async () => {
  cloud.__setRpcCaller(async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'order_complete') throw new Error('network dropped after the request was sent');
    return { data: { ok: true, order: cloudOrder('confirmed'), lines: [] }, error: null };
  });
  const result = await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId) }));
  assert.equal(result.status, 503); assert.equal(result.body.code, 'ORDER_NEEDS_ONLINE');
  assert.deepEqual(calls.map(c => c.fn), ['order_complete', 'order_complete_undo']);
  assert.equal(calls[0].args.p_sale_global_id, calls[1].args.p_sale_global_id);
  noSale();
});
test('cashier may use order prices but excess quantities and changed prices require override permission', async () => {
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Cashier', 'cashier')").run(tenant).lastInsertRowid);
  for (const item of [{ id: product, quantity: 3, unit_price: 5 }, { id: product, quantity: 2, unit_price: 6 }]) {
    assert.equal((await request('POST', '/api/transactions', cart({ items: [item], order_global_id: gid('orders', orderId) }), cashier)).status, 403);
  }
  assert.equal((await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId) }), cashier)).status, 200);
});
test('orders.view is required and plain sales never call an RPC', async () => {
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'role_permissions_version', '3')").run(tenant);
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'role_permissions', ?)").run(tenant, JSON.stringify({ cashier: [] }));
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Cashier', 'cashier')").run(tenant).lastInsertRowid);
  assert.equal((await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId) }), cashier)).status, 403);
  assert.equal((await request('POST', '/api/transactions', cart({ items: [{ id: product, quantity: 2 }] }), cashier)).status, 200);
  assert.equal(calls.length, 0);
});

test('settlement retains the order link in UNION reads and refunds remain ordinary', async () => {
  const orderGlobalId = gid('orders', orderId);
  const sale = await request('POST', '/api/transactions', cart({ order_global_id: orderGlobalId }));
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const settle = await request('POST', '/api/tenant/settlement', {});
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  assert.equal(one('SELECT order_global_id FROM archived_transactions WHERE id = ? AND tenant_id = ?', sale.body.id, tenant).order_global_id, orderGlobalId);
  const recent = await request('GET', '/api/transactions/recent');
  assert.equal(recent.status, 200);
  assert.ok(recent.body.some((row: any) => row.id === sale.body.id && row.order_global_id === orderGlobalId));
  const duplicate = await request('POST', '/api/transactions', cart({ order_global_id: orderGlobalId }));
  assert.equal(duplicate.body.code, 'ORDER_ALREADY_COMPLETED'); assert.equal(calls.length, 1);
  const refund = await request('POST', '/api/transactions', cart({ type: 'refund', original_transaction_id: sale.body.id,
    items: [{ id: product, quantity: 1 }], payments: [{ amount: 5, currency: 'USD', exchange_rate: 1, method: 'cash' }] }));
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(one('SELECT stock FROM products WHERE id = ?', product).stock, 99);
  assert.equal(calls.length, 1);
});
test('order pricing consumes quantities in request order and leaves unmatched items ordinary', async () => {
  const { orderPricedItems } = await import('../server/orderSale.js');
  const prices = orderPricedItems(tenant, gid('orders', orderId), [
    { id: product, quantity: 1, unit_price: 5 },
    { id: product, quantity: 2, unit_price: 5 },
    { id: product, quantity: 1, unit_price: 5 },
    { id: product, quantity: 1, unit_price: 5 },
  ]);
  assert.deepEqual([...prices.keys()], [0, 2]);
});
test('invalid order types and dry-run validation failures never contact cloud', async () => {
  for (const extra of [{ type: 'refund' }, { type: 'purchase' }, { order_global_id: 42 }]) {
    const result = await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId), ...extra }));
    assert.equal(result.status, 409); assert.equal(result.body.code, 'ORDER_NOT_COMPLETABLE');
  }
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'allow_negative_stock', '0')").run(tenant);
  const result = await request('POST', '/api/transactions', cart({ order_global_id: gid('orders', orderId), items: [{ id: product, quantity: 101 }] }));
  assert.equal(result.body.code, 'INSUFFICIENT_STOCK'); noSale(); assert.equal(calls.length, 0);
});
