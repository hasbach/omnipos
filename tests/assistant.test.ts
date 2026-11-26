import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenant: number;
let other: number;
let dispatch: typeof import('../server/assistant/tools.js').dispatchTool;
let ask: typeof import('../server/assistant/claude.js').askAssistant;
before(async () => {
  app = await createTestApp();
  tenant = seedTenant(app.db, 'Assistant', 'assistant@example.com');
  other = seedTenant(app.db, 'Other assistant', 'other-assistant@example.com');
  seedProduct(app.db, tenant, { name: 'Own milk', barcode: 'own-milk', price: 3 });
  seedProduct(app.db, other, { name: 'Secret milk', barcode: 'secret-milk', price: 99 });
  dispatch = (await import('../server/assistant/tools.js')).dispatchTool;
  ask = (await import('../server/assistant/claude.js')).askAssistant;
});
after(async () => { await app.close(); });
const reply = (content: any[], stop_reason = 'end_turn') => new Response(JSON.stringify({ content, stop_reason }));

test('fixed tools scope product data to the session tenant and reject injected tenant and SQL', () => {
  const rows = dispatch(tenant, 'product_lookup', { query: 'milk' }) as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Own milk');
  assert.equal(rows[0].price_usd, 3);
  assert.deepEqual(dispatch(tenant, 'product_lookup', { query: 'secret-milk' }), []);
  assert.throws(() => dispatch(tenant, 'product_lookup', { query: 'milk', tenant_id: other }), /assistant_invalid_tool/);
  assert.throws(() => dispatch(tenant, 'sql', { query: 'SELECT * FROM products' }), /assistant_invalid_tool/);
});
test('all tool inputs are validated before reading data', () => {
  for (const [name, input] of [
    ['sales_summary', { from: '2026-02-30', to: '2026-03-01' }],
    ['sales_summary', { from: '2024-01-01', to: '2026-01-01' }],
    ['balances', { type: 'customers', top: 500 }],
    ['balances', { type: 'admin', top: 5 }],
    ['supplier_prices', { days: 3 }],
    ['supplier_prices', { supplier: 'X', days: -1 }],
    ['product_lookup', { query: '' }],
    ['or_metrics', { tenant_id: other }],
  ] as const) assert.throws(() => dispatch(tenant, name, input), /assistant_invalid_tool/);
  assert.deepEqual(dispatch(tenant, 'or_metrics', {}), { available: false, reason: 'OR_LICENSE_REQUIRED' });
});
test('mocked Messages tool loop returns evidence and uses requested answer language', async () => {
  let count = 0;
  const result = await ask(tenant, 'test-key', 'Milk price?', [], 'fr', (async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.match(body.system, /French/);
    if (count++ === 0) return reply([{ type: 'tool_use', id: 't1', name: 'product_lookup', input: { query: 'milk' } }], 'tool_use');
    const evidence = JSON.parse(body.messages.at(-1).content[0].content);
    assert.equal(evidence[0].price_usd, 3);
    assert.equal(evidence.length, 1);
    return reply([{ type: 'text', text: 'Le prix est de 3 USD.' }]);
  }) as typeof fetch);
  assert.equal(result.answer, 'Le prix est de 3 USD.');
  assert.equal(result.tool_calls.length, 1);
  assert.deepEqual(result.tool_calls[0].input, { query: 'milk' });
});
test('six tool rounds are the hard bound, with a final text-only request', async () => {
  let count = 0;
  await assert.rejects(ask(tenant, 'key', 'Milk?', [], 'en', (async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    if (count === 6) assert.equal(body.tool_choice.type, 'none');
    count++;
    return reply([{ type: 'tool_use', id: `t${count}`, name: 'product_lookup', input: { query: 'milk' } }], 'tool_use');
  }) as typeof fetch), /assistant_loop_limit/);
  assert.equal(count, 7);
});
test('no key, offline and provider errors are explicit and never call a real API', async () => {
  await assert.rejects(ask(tenant, '', 'Sales?', [], 'en', (async () => { assert.fail('must not fetch'); }) as typeof fetch), /assistant_no_key/);
  await assert.rejects(ask(tenant, 'key', 'Sales?', [], 'en', (async () => { throw new Error('offline'); }) as typeof fetch), /assistant_needs_internet/);
  await assert.rejects(ask(tenant, 'key', 'Sales?', [], 'en', (async () => new Response('', { status: 500 })) as typeof fetch), /assistant_provider_error/);
  const response = await app.api('POST', '/api/assistant/ask', { tenantId: tenant, body: { question: 'Sales?' } });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'assistant_no_key');
});
test('cashier is forbidden before any API request', async () => {
  const cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Assistant cashier', 'cashier', '1313')").run(tenant).lastInsertRowid);
  const response = await app.api('POST', '/api/assistant/ask', { tenantId: tenant, userId: cashier, body: { question: 'Sales?' } });
  assert.equal(response.status, 403);
});

test('licensed OR metrics do not initialize or write any records', async () => {
  app.db.prepare("UPDATE tenants SET or_license_type = 'lifetime' WHERE id = ?").run(tenant);
  assert.deepEqual(dispatch(tenant, 'or_metrics', {}), { available: false, reason: 'OR_NOT_INITIALIZED' });
  const { ensureOrInitialized } = await import('../server/or/config.js');
  ensureOrInitialized(tenant);
  const before = app.db.prepare('SELECT total_changes() AS n').get().n;
  const metrics = dispatch(tenant, 'or_metrics', {}) as any;
  assert.equal(metrics.available, true);
  assert.equal(typeof metrics.spendable_cash_usd, 'number');
  assert.equal(app.db.prepare('SELECT total_changes() AS n').get().n, before);
  app.db.prepare("UPDATE tenants SET or_license_type = 'none' WHERE id = ?").run(tenant);
});
