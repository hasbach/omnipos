import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, seedTenant } from './helpers/testApp.js';
import { makeFakeSupabase } from './helpers/fakeSupabase.js';

let app: Awaited<ReturnType<typeof createTestApp>>;
let cloud: typeof import('../server/cloudCall.js');
let session: typeof import('../server/session.js');
let fake: ReturnType<typeof makeFakeSupabase>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  cloud = await import('../server/cloudCall.js');
  session = await import('../server/session.js');
  tenantId = seedTenant(app.db, 'Cloud calls', 'cloud-calls@example.com');
});
beforeEach(async () => {
  session.__resetSessionStateForTests();
  cloud.__setRpcCaller(null);
  fake = makeFakeSupabase();
  session.__setClientFactory(() => fake as any);
  await session.setActiveSession(tenantId, 'aaaaaaaa-0000-4000-8000-000000000001', 'cloud-calls@example.com', {
    access_token: 'test-access', refresh_token: 'test-refresh',
  });
});
after(async () => {
  cloud.__setRpcCaller(null);
  session.__resetSessionStateForTests();
  session.__setClientFactory();
  await app.close();
});

test('RPC success returns its value and records arguments', async () => {
  fake.onRpc('order_ready', () => ({ code: 'ready' }));
  assert.deepEqual(await cloud.callRpc(tenantId, 'order_ready', { p_order: 'order' }), { ok: true, value: { code: 'ready' } });
  assert.deepEqual(fake.calls(), [{ name: 'order_ready', args: { p_order: 'order' } }]);
});
test('RPC error is failed', async () => {
  const error = { message: 'refused' };
  fake.onRpc('order_ready', () => ({ error }));
  assert.deepEqual(await cloud.callRpc(tenantId, 'order_ready', {}), { ok: false, reason: 'failed', error });
});
test('thrown network error is offline', async () => {
  const error = new Error('network');
  fake.onRpc('order_ready', () => { throw error; });
  assert.deepEqual(await cloud.callRpc(tenantId, 'order_ready', {}), { ok: false, reason: 'offline', error });
});
test('a hanging RPC is offline after its timeout', async () => {
  fake.onRpc('order_ready', () => new Promise(() => {}));
  const start = Date.now();
  const result = await cloud.callRpc(tenantId, 'order_ready', {}, { timeoutMs: 50 });
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.reason, 'offline');
    assert.ok(result.error instanceof cloud.CloudTimeoutError);
  }
  assert.ok(Date.now() - start >= 40);
});
test('another tenant cannot borrow the active session', async () => {
  assert.deepEqual(await cloud.callRpc(tenantId + 1, 'order_ready', {}), { ok: false, reason: 'offline' });
  assert.deepEqual(fake.calls(), []);
});
test('no session is offline', async () => {
  session.__resetSessionStateForTests();
  assert.deepEqual(await cloud.callRpc(tenantId, 'order_ready', {}), { ok: false, reason: 'offline' });
  assert.deepEqual(fake.calls(), []);
});
test('RPC caller seam can be replaced and restored', async () => {
  cloud.__setRpcCaller(async () => ({ data: 'seam', error: null }));
  assert.deepEqual(await cloud.callRpc(tenantId, 'order_ready', {}), { ok: true, value: 'seam' });
  cloud.__setRpcCaller(null);
  fake.onRpc('order_ready', () => 'client');
  assert.deepEqual(await cloud.callRpc(tenantId, 'order_ready', {}), { ok: true, value: 'client' });
});
