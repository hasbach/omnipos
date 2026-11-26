import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { matchLine, normalizeName } from '../server/purchaseScan/match.js';
import { scanInvoice, PURCHASE_SCAN_MODEL, parseInvoiceResponse } from '../server/purchaseScan/claude.js';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

const products = [{ id: 1, name: 'Whole milk', barcode: '123' }, { id: 2, name: 'White bread', barcodes: ['456'] }];
test('barcode has priority over memory and names, including extra barcodes', () => {
  assert.equal(matchLine({ name: 'White bread', barcode: '123' }, products, { 'white bread': 2 })[0].product_id, 1);
  assert.equal(matchLine({ name: 'Unknown', barcode: '456' }, products)[0].product_id, 2);
});
test('remembered supplier name has priority over fuzzy name', () => {
  assert.equal(matchLine({ name: 'whole milk' }, products, { 'whole milk': 2 })[0].reason, 'memory');
  assert.equal(matchLine({ name: 'whole milk' }, products, { 'whole milk': 2 })[0].product_id, 2);
});
test('Arabic variants, tashkeel, tatweel and whitespace normalize consistently', () => {
  assert.equal(normalizeName('  أَلـبَان  إبرة آية على  '), 'البان ابره ايه علي');
  assert.equal(matchLine({ name: 'أَلـبَان' }, [{ id: 3, name: 'البان' }])[0].score, 1);
});
test('weak and empty names do not cross the matching threshold', () => {
  assert.deepEqual(matchLine({ name: 'Coffee' }, products), []);
  assert.deepEqual(matchLine({ name: '' }, products), []);
  assert.deepEqual(matchLine({ name: 'milk chocolate' }, products), []);
  assert.equal(matchLine({ name: 'whole milk fresh' }, products)[0].product_id, 1);
});
const invoice = { supplier_name: 'Supplier', invoice_number: 'S-12', invoice_date: '2026-11-27', currency: 'LBP', total: 179000, lines: [{ name: 'Whole milk', barcode: '123', quantity: 2, unit_price: 89500 }] };
const response = { content: [{ type: 'tool_use', name: 'record_invoice', input: invoice }] };
test('mocked Claude image and PDF requests force the tool and parse the invoice', async () => {
  for (const media of ['image/jpeg', 'application/pdf']) {
    const result = await scanInvoice('secret', media, 'YQ==', (async (url, options) => {
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      const body = JSON.parse(options!.body as string);
      assert.equal(body.model, PURCHASE_SCAN_MODEL);
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'record_invoice' });
      assert.equal(body.messages[0].content[0].type, media === 'application/pdf' ? 'document' : 'image');
      assert.equal((options!.headers as any)['x-api-key'], 'secret');
      return new Response(JSON.stringify(response));
    }) as typeof fetch);
    assert.deepEqual(result, invoice);
  }
});
test('invalid structured output, missing key, oversized file, network and provider errors are explicit', async () => {
  assert.throws(() => parseInvoiceResponse({ content: [] }), /scan_invalid_response/);
  assert.throws(() => parseInvoiceResponse({ content: [{ type: 'tool_use', name: 'record_invoice', input: { ...invoice, lines: [{ name: 'bad', quantity: -1, unit_price: 1 }] } }] }), /scan_invalid_response/);
  await assert.rejects(scanInvoice('', 'image/jpeg', 'YQ=='), /scan_no_key/);
  await assert.rejects(scanInvoice('key', 'text/plain', 'YQ=='), /scan_invalid_file/);
  await assert.rejects(scanInvoice('key', 'image/jpeg', Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')), /scan_too_large/);
  await assert.rejects(scanInvoice('key', 'image/jpeg', 'YQ==', (async () => { throw new Error('offline'); }) as typeof fetch), /scan_needs_internet/);
  await assert.rejects(scanInvoice('key', 'image/jpeg', 'YQ==', (async () => new Response('', { status: 401 })) as typeof fetch), /scan_key_rejected/);
});
let app: Awaited<ReturnType<typeof createTestApp>>;
let tenant: number;
let otherTenant: number;
let product: number;
let supplier: number;
before(async () => {
  app = await createTestApp();
  tenant = seedTenant(app.db, 'Scan', 'scan@example.com');
  otherTenant = seedTenant(app.db, 'Other scan', 'other-scan@example.com');
  product = seedProduct(app.db, tenant, { barcode: '123', name: 'Whole milk', price: 1 });
  supplier = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Supplier', 'supplier')").run(tenant).lastInsertRowid);
});
after(async () => { await app.close(); });
test('API key returns only status and is absent from synced settings', async () => {
  assert.equal((await app.api('POST', '/api/purchase-scan/key', { tenantId: tenant, body: { key: 'local-secret' } })).status, 200);
  assert.deepEqual((await app.api('GET', '/api/purchase-scan/key', { tenantId: tenant })).body, { set: true });
  assert.deepEqual((await app.api('GET', '/api/purchase-scan/key', { tenantId: otherTenant })).body, { set: false });
  assert.ok(!JSON.stringify((await app.api('GET', '/api/settings', { tenantId: tenant })).body).includes('local-secret'));
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'anthropic_api_key'").get().n, 0);
});
test('confirmed mappings persist, update in place and reject cross-tenant products atomically', async () => {
  const { saveMappings } = await import('../server/purchaseScan/routes.js');
  saveMappings(tenant, supplier, [{ name: 'أَلـبَان', product_id: product }]);
  saveMappings(tenant, supplier, [{ name: 'البان', product_id: product }]);
  const rows = app.db.prepare('SELECT * FROM supplier_item_mappings WHERE tenant_id = ?').all(tenant);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].normalized_item_name, 'البان');
  assert.equal(rows[0].product_id, product);
  assert.ok(rows[0].updated_at);
  const foreign = seedProduct(app.db, otherTenant, { barcode: 'other', name: 'Other', price: 1 });
  assert.throws(() => saveMappings(tenant, supplier, [{ name: 'new', product_id: foreign }]), /scan_invalid_mapping/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM supplier_item_mappings WHERE tenant_id = ?').get(tenant).n, 1);
});
test('scan endpoint parses mocked Claude output and returns matches without creating a transaction', async () => {
  await app.api('POST', '/api/purchase-scan/key', { tenantId: tenant, body: { key: 'local-secret' } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url, options) => String(url) === 'https://api.anthropic.com/v1/messages'
    ? new Response(JSON.stringify(response)) : originalFetch(url, options)) as typeof fetch;
  try {
    const res = await app.api('POST', '/api/purchase-scan', { tenantId: tenant, body: { media_type: 'image/jpeg', data: 'YQ==' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.supplier_id, supplier);
    assert.equal(res.body.lines[0].candidates[0].product_id, product);
    assert.equal(res.body.total, invoice.total);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE tenant_id = ?').get(tenant).n, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('cashiers cannot scan or modify the API key', async () => {
  const userId = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Cashier', 'cashier')").run(tenant).lastInsertRowid);
  assert.equal((await app.api('POST', '/api/purchase-scan', { tenantId: tenant, userId, body: {} })).status, 403);
  assert.equal((await app.api('POST', '/api/purchase-scan/key', { tenantId: tenant, userId, body: { key: 'bad' } })).status, 403);
});
test('confirmed USD pack prices save through the normal purchase path with supplier reference and stock', async () => {
  const unit = Number(app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price) VALUES (?, ?, 'Box', 12, 12)").run(tenant, product).lastInsertRowid);
  const stockBefore = app.db.prepare('SELECT stock FROM products WHERE id = ?').get(product).stock;
  // A reviewed LBP box price of 1,074,000 at 89,500 LBP/USD becomes $12 per box.
  const result = await app.api('POST', '/api/transactions', { tenantId: tenant, body: {
    type: 'purchase', stakeholder_id: supplier, currency: 'USD', exchange_rate: 1, source: 'backoffice',
    reference: 'PHOTO-12', notes: 'Supplier invoice date: 2026-11-20', payments: [],
    items: [{ id: product, uom_id: unit, quantity: 2, price: 1074000 / 89500, unit_price: 1074000 / 89500 }],
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const tx = app.db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.body.id);
  assert.equal(tx.stakeholder_id, supplier);
  assert.equal(tx.reference, 'PHOTO-12');
  assert.equal(tx.notes, 'Supplier invoice date: 2026-11-20');
  assert.equal(tx.total_amount, 24);
  const line = app.db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').get(tx.id);
  assert.equal(line.quantity, 24);
  assert.equal(line.unit_price, 1, 'stored price is USD per base piece');
  assert.equal(app.db.prepare('SELECT stock FROM products WHERE id = ?').get(product).stock, stockBefore + 24);
});
