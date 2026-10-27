import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';
import { makeFakeSupabase } from './helpers/fakeSupabase.js';
let app: Awaited<ReturnType<typeof createTestApp>>;
let session: typeof import('../server/session.js');
let cloud: typeof import('../server/cloudCall.js');
let tenant: number, other: number, store: number, product: number, admin: number, cashier: number;
let fake: ReturnType<typeof makeFakeSupabase>;
const notices: any[] = [];
const one = (sql: string, ...args: any[]) => app.db.prepare(sql).get(...args) as any;
function order(state = 'submitted', extra: any = {}, owner = tenant) {
  const id = Number(app.db.prepare(`INSERT INTO orders (tenant_id, store_id, number, state, customer_name, customer_phone, fulfilment, submitted_at, expires_at)
    VALUES (?, ?, 1042, ?, 'Ada Lovelace', '+96171123456', 'pickup', '2026-10-01T12:00:00Z', '2099-01-01T00:00:00Z')`).run(owner, store, state).lastInsertRowid);
  for (const [k, v] of Object.entries(extra)) app.db.prepare(`UPDATE orders SET ${k} = ? WHERE id = ?`).run(v, id);
  app.db.prepare(`INSERT INTO order_lines (tenant_id, order_id, product_id, line_no, unit_key, product_name, ordered_qty) VALUES (?, ?, ?, 1, 'base', 'Widget', 3)`).run(owner, id, product);
  return id;
}
function cloudOrder(id: number, state: string) {
  const o = one('SELECT * FROM orders WHERE id = ?', id);
  return { ...o, tenant_id: one('SELECT global_id FROM tenants WHERE id = ?', tenant).global_id, store_id: one('SELECT global_id FROM stores WHERE id = ?', store).global_id, state, updated_at: '2026-10-20T12:00:00.000Z' };
}
const request = (method: string, url: string, body?: any, userId = admin, tenantId = tenant) => app.api(method, url, { tenantId, userId, body });
before(async () => {
  app = await createTestApp({ broadcast: (data, tenantId) => notices.push({ data, tenantId }) });
  session = await import('../server/session.js'); cloud = await import('../server/cloudCall.js');
  tenant = seedTenant(app.db, 'Orders', 'orders@example.com'); other = seedTenant(app.db, 'Other', 'other@example.com');
  admin = one("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'", tenant).id;
  cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Cashier', 'cashier')").run(tenant).lastInsertRowid);
  store = Number(app.db.prepare("INSERT INTO stores (tenant_id, name, default_language, settings) VALUES (?, 'Shop', 'en', ?)").run(tenant, JSON.stringify({ pickup_note: 'Side door' })).lastInsertRowid);
  product = seedProduct(app.db, tenant, { barcode: 'ORD', name: 'Widget', price: 5, stock: 12 });
});
after(async () => { cloud.__setRpcCaller(null); session.__resetSessionStateForTests(); await app.close(); });
beforeEach(async () => {
  for (const table of ['order_events', 'order_lines', 'orders']) app.db.prepare(`DELETE FROM ${table}`).run();
  notices.length = 0; fake = makeFakeSupabase(); session.__setClientFactory(() => fake as any);
  await session.setActiveSession(tenant, one('SELECT global_id FROM tenants WHERE id = ?', tenant).global_id, 'orders@example.com', { access_token: 'test', refresh_token: 'test' });
  cloud.__setRpcCaller(null);
});

test('blocked phones list, add and remove use the store global id and cloud normalization', async () => {
  const rows = [{ phone: '+96171123456', note: 'W-1042', created_at: '2026-10-20T12:00:00Z' }];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  cloud.__setRpcCaller(async (name, args) => {
    calls.push({ name, args });
    return { data: { ok: true, code: 'ok', rows, phone: '+96171123456' }, error: null };
  });
  const url = `/api/commerce/stores/${store}/blocked-phones`;
  const listed = await request('GET', url);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { rows });
  const added = await request('POST', url, { phone: '71 123 456', note: 'W-1042' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body, { phone: '+96171123456' });
  const removed = await request('DELETE', url + '/%2B96171123456');
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });
  const globalId = one('SELECT global_id FROM stores WHERE id = ?', store).global_id;
  assert.deepEqual(calls, [
    { name: 'order_blocked_phones', args: { p_store: globalId } },
    { name: 'order_block_phone', args: { p_store: globalId, p_phone: '71 123 456', p_note: 'W-1042' } },
    { name: 'order_unblock_phone', args: { p_store: globalId, p_phone: '+96171123456' } },
  ]);
});

test('blocked phones validate inputs before cloud calls', async () => {
  let calls = 0;
  cloud.__setRpcCaller(async () => {
    calls++;
    return { data: { ok: true }, error: null };
  });
  const url = `/api/commerce/stores/${store}/blocked-phones`;
  for (const phone of ['', '   ', 'x'.repeat(41), null, 123]) {
    const r = await request('POST', url, { phone });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'ORDER_PHONE_INVALID');
    assert.equal(r.body.field, 'phone');
  }
  for (const note of ['x'.repeat(121), null, 12]) {
    const r = await request('POST', url, { phone: '+96171123456', note });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'ORDER_PHONE_INVALID');
    assert.equal(r.body.field, 'note');
  }
  assert.equal((await request('DELETE', url + '/' + 'x'.repeat(41))).status, 400);
  assert.equal(calls, 0);
});

test('blocked phones enforce permissions, tenant scope and online session for every method', async () => {
  let calls = 0;
  cloud.__setRpcCaller(async () => {
    calls++;
    return { data: { ok: true }, error: null };
  });
  const foreign = Number(app.db.prepare("INSERT INTO stores (tenant_id, name) VALUES (?, 'Foreign')").run(other).lastInsertRowid);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const suffix = '/blocked-phones' + (method === 'DELETE' ? '/%2B96171123456' : '');
    const body = method === 'POST' ? { phone: '+96171123456' } : undefined;
    assert.equal((await request(method, `/api/commerce/stores/${store}${suffix}`, body, cashier)).status, 403);
    const foreignResult = await request(method, `/api/commerce/stores/${foreign}${suffix}`, body);
    assert.equal(foreignResult.status, 404);
    assert.equal(foreignResult.body.code, 'STORE_NOT_FOUND');
  }
  assert.equal(calls, 0);
  session.clearActiveSession();
  for (const method of ['GET', 'POST', 'DELETE']) {
    const url = `/api/commerce/stores/${store}/blocked-phones` + (method === 'DELETE' ? '/%2B96171123456' : '');
    const r = await request(method, url, method === 'POST' ? { phone: '+96171123456' } : undefined);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'ORDER_NEEDS_ONLINE');
  }
  assert.equal(calls, 0);
});

test('blocked phones map cloud refusals and transport failures', async () => {
  const url = `/api/commerce/stores/${store}/blocked-phones`;
  for (const [code, status, mapped] of [
    ['invalid', 400, 'ORDER_PHONE_INVALID'],
    ['not_owner', 404, 'STORE_NOT_FOUND'],
    ['unexpected', 502, 'ORDER_CLOUD_FAILED'],
  ] as const) {
    cloud.__setRpcCaller(async () => ({ data: { ok: false, code }, error: null }));
    const r = await request('POST', url, { phone: '+96171123456' });
    assert.equal(r.status, status);
    assert.equal(r.body.code, mapped);
    if (code === 'invalid') assert.equal(r.body.field, 'phone');
  }
  cloud.__setRpcCaller(async () => ({ data: null, error: new Error('Cloud failed') }));
  const failed = await request('GET', url);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'ORDER_CLOUD_FAILED');
  cloud.__setRpcCaller(async () => { throw new Error('Disconnected'); });
  const offline = await request('GET', url);
  assert.equal(offline.status, 503);
  assert.equal(offline.body.code, 'ORDER_NEEDS_ONLINE');
});
test('list sorting, effective-state filters, search, dates and summary', async () => {
  const late = order('submitted', { submitted_at: '2026-10-03T12:00:00Z' });
  const early = order('submitted'); const ready = order('ready', { submitted_at: '2026-10-05T12:00:00Z' });
  const expired = order('submitted', { expires_at: '2000-01-01T00:00:00Z' }); order('confirmed', {}, other);
  const list = (await request('GET', '/api/orders')).body;
  assert.deepEqual(list.rows.map((o: any) => o.id), [early, late, ready, expired]);
  assert.equal(list.online, true); assert.equal(list.rows[0].number, 'W-1042'); assert.equal(list.rows[0].line_count, 1);
  for (const q of ['1042', 'ada', '71123456']) assert.equal((await request('GET', `/api/orders?q=${q}`)).body.rows.length, 4);
  assert.equal((await request('GET', '/api/orders?q=nobody')).body.rows.length, 0);
  assert.deepEqual((await request('GET', '/api/orders?state=expired')).body.rows.map((o: any) => o.id), [expired]);
  assert.equal((await request('GET', `/api/orders?store=${store}&from=2026-10-03&to=2026-10-05`)).body.rows.length, 2);
  assert.equal((await request('GET', '/api/orders?store=99999')).body.rows.length, 0);
  assert.deepEqual((await request('GET', '/api/orders/summary')).body, { submitted: 2, open: 3 });
});
test('detail resolves stock, units, customer, history, store, phone and action availability', async () => {
  const id = order();
  app.db.prepare("INSERT INTO order_events (tenant_id, order_id, kind) VALUES (?, ?, 'submitted')").run(tenant, id);
  app.db.prepare("INSERT INTO stakeholders (tenant_id, type, name, phone) VALUES (?, 'customer', 'Ada', '71 123 456')").run(tenant);
  let r = await request('GET', `/api/orders/${id}`); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lines[0].local_product.stock, 12); assert.equal(r.body.lines[0].local_unit, 'base');
  assert.equal(r.body.events.length, 1); assert.equal(r.body.matched_customer.name, 'Ada'); assert.equal(r.body.customer_wa_digits, '96171123456');
  assert.deepEqual(r.body.store, { id: store, name: 'Shop', default_language: 'en', pickup_note: 'Side door' });
  assert.equal(r.body.actions.accept, true); assert.equal(r.body.actions.ready, false);
  r = await request('GET', `/api/orders/${id}`, undefined, cashier); assert.equal(r.body.actions.accept, false);
  session.clearActiveSession(); r = await request('GET', `/api/orders/${id}`); assert.equal(r.body.online, false); assert.ok(Object.values(r.body.actions).every(x => !x));
});
test('permissions and tenant isolation apply to every route', async () => {
  const id = order(); const b = order('submitted', {}, other);
  assert.equal((await request('GET', `/api/orders/${id}`, undefined, cashier)).status, 200);
  for (const action of ['accept', 'reject', 'ready', 'cancel']) {
    assert.equal((await request('POST', `/api/orders/${id}/${action}`, {}, cashier)).status, 403);
    assert.equal((await request('POST', `/api/orders/${b}/${action}`, {})).status, 404);
  }
  assert.equal((await request('GET', `/api/orders/${b}`)).status, 404);
  const denied = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'No access', 'unknown')").run(tenant).lastInsertRowid);
  for (const url of ['/api/orders', '/api/orders/summary', `/api/orders/${id}`]) assert.equal((await request('GET', url, undefined, denied)).status, 403);
});
for (const [action, from, to] of [['accept', 'submitted', 'confirmed'], ['reject', 'submitted', 'rejected'], ['ready', 'confirmed', 'ready'], ['cancel', 'ready', 'cancelled']]) test(`${action} sends owner arguments and applies synced rows without fetching`, async () => {
  const id = order(from); const o = cloudOrder(id, to);
  const l = one('SELECT * FROM order_lines WHERE order_id = ?', id);
  // Shaped like the cloud's reply: _order_lines_json strips tenant_id from the lines.
  const { tenant_id: _tenant, ...line } = l;
  const returned = { ...line, order_id: o.global_id, product_id: one('SELECT global_id FROM products WHERE id = ?', product).global_id, confirmed_qty: 2, updated_at: o.updated_at };
  let args: any, fn: any;
  cloud.__setRpcCaller(async (name, value) => { fn = name; args = value; return { data: { ok: true, order: o, lines: [returned] }, error: null }; });
  const r = await request('POST', `/api/orders/${id}/${action}`, { expected_state: from, lines: [{ line_no: 1, confirmed_qty: 2, reason: 'other' }], reason: 'Customer asked', terminalId: 'register-2' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.order.state, to); assert.equal(r.body.lines[0].product_id, product);
  assert.equal(r.body.lines[0].confirmed_qty, 2, 'the reply lines are applied now, not at the next pull');
  assert.equal(r.body.order.last_synced_at, r.body.order.updated_at); assert.equal(r.body.lines[0].last_synced_at, r.body.lines[0].updated_at);
  assert.equal(fn, action === 'cancel' ? 'order_cancel_by_shop' : `order_${action}`); assert.equal(args.p_order, o.global_id); assert.equal(args.p_expected_state, from);
  assert.deepEqual(args.p_actor, { name: 'Admin', terminal: 'register-2' }); assert.equal(fake.calls().length, 0);
  assert.deepEqual(notices, [{ tenantId: tenant, data: { type: 'ORDERS_UPDATED', newSubmitted: 0, changed: 1 } }]);
});
test('invalid bodies are rejected before RPC and leave mirrors unchanged', async () => {
  const id = order(); let calls = 0; cloud.__setRpcCaller(async () => { calls++; return { data: null, error: null }; });
  const cases: any[] = [
    ['accept', { lines: [{ line_no: 1, confirmed_qty: 4 }] }, 'ORDER_CONFIRM_EXCEEDS', 'lines[0]'],
    ['accept', { lines: [{ line_no: 1, confirmed_qty: -1 }] }, 'ORDER_CONFIRM_EXCEEDS', 'lines[0]'],
    ['accept', { lines: [{ line_no: 1, confirmed_qty: 2 }] }, 'ORDER_REASON_REQUIRED', 'lines[0]'],
    ['accept', { lines: [{ line_no: 1, confirmed_qty: 0, reason: 'other' }] }, 'ORDER_ALL_ZERO', undefined],
    ['accept', { lines: [{ line_no: 1, confirmed_qty: 3 }, { line_no: 1, confirmed_qty: 3 }] }, 'ORDER_CONFIRM_EXCEEDS', 'lines[1]'],
    ['reject', { reason: '' }, 'ORDER_REASON_REQUIRED', 'reason'], ['cancel', { reason: 'x'.repeat(301) }, 'ORDER_REASON_REQUIRED', 'reason'],
  ];
  for (const [action, body, code, field] of cases) {
    const r = await request('POST', `/api/orders/${id}/${action}`, { expected_state: 'submitted', ...body });
    assert.equal(r.status, 400); assert.equal(r.body.code, code); assert.equal(r.body.field, field);
  }
  assert.equal(calls, 0); assert.equal(one('SELECT state FROM orders WHERE id = ?', id).state, 'submitted');
});
test('RPC refusal and transport mappings, including handled mirror refresh', async () => {
  const id = order('confirmed');
  for (const [code, status, mapped] of [ ['handled', 409, 'ORDER_ALREADY_HANDLED'], ['expired', 409, 'ORDER_EXPIRED'], ['invalid_transition', 409, 'ORDER_INVALID_TRANSITION'], ['confirm_exceeds', 400, 'ORDER_CONFIRM_EXCEEDS'], ['reason_required', 400, 'ORDER_REASON_REQUIRED'], ['all_zero', 400, 'ORDER_ALL_ZERO'], ['not_found', 404, 'ORDER_NOT_FOUND'], ['unexpected', 502, 'ORDER_CLOUD_FAILED'] ] as const) {
    cloud.__setRpcCaller(async () => ({ data: { ok: false, code, order: cloudOrder(id, 'ready'), lines: [] }, error: null }));
    const r = await request('POST', `/api/orders/${id}/ready`, { expected_state: 'confirmed' }); assert.equal(r.status, status); assert.equal(r.body.code, mapped);
    if (code === 'handled') { assert.equal(r.body.state, 'ready'); assert.equal(one('SELECT state FROM orders WHERE id = ?', id).state, 'ready'); }
  }
  for (const rpc of [async () => { throw new Error('network'); }, async () => ({ data: null, error: { message: 'failed' } })]) {
    cloud.__setRpcCaller(rpc); const r = await request('POST', `/api/orders/${id}/ready`, { expected_state: 'confirmed' }); assert.ok([503, 502].includes(r.status));
  }
  session.clearActiveSession(); assert.equal((await request('POST', `/api/orders/${id}/ready`, { expected_state: 'confirmed' })).body.code, 'ORDER_NEEDS_ONLINE');
});

test('a timed out owner call returns ORDER_NEEDS_ONLINE without changing the mirror', async () => {
  const id = order('confirmed');
  cloud.__setRpcCaller(() => new Promise(() => {}));
  const r = await request('POST', `/api/orders/${id}/ready`, { expected_state: 'confirmed' });
  assert.equal(r.status, 503); assert.equal(r.body.code, 'ORDER_NEEDS_ONLINE');
  assert.equal(one('SELECT state FROM orders WHERE id = ?', id).state, 'confirmed');
});

test('details resolve live units, missing products and completion actions on live/archived sales', async () => {
  const id = order('confirmed');
  const unit = Number(app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price) VALUES (?, ?, 'Pack', 6, 25)").run(tenant, product).lastInsertRowid);
  const key = one('SELECT global_id FROM product_units WHERE id = ?', unit).global_id;
  app.db.prepare('UPDATE order_lines SET unit_key = ? WHERE order_id = ?').run(key, id);
  let r = await request('GET', `/api/orders/${id}`, undefined, cashier);
  assert.deepEqual(r.body.lines[0].local_unit, { id: unit, name: 'Pack', factor: 6 });
  assert.equal(r.body.actions.complete, true);
  app.db.prepare('UPDATE order_lines SET product_id = NULL WHERE order_id = ?').run(id);
  r = await request('GET', `/api/orders/${id}`); assert.equal(r.body.lines[0].local_product, null); assert.equal(r.body.lines[0].local_unit, null);
  const globalId = one('SELECT global_id FROM orders WHERE id = ?', id).global_id;
  for (const table of ['transactions', 'archived_transactions']) {
    const saleId = Number(app.db.prepare(`INSERT INTO ${table} (tenant_id, type, total_amount, currency, exchange_rate, order_global_id) VALUES (?, 'sale', 12, 'USD', 1, ?)`).run(tenant, globalId).lastInsertRowid);
    r = await request('GET', `/api/orders/${id}`); assert.equal(r.body.sale.id, saleId); assert.equal(r.body.actions.complete, false);
    app.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(saleId);
  }
});
