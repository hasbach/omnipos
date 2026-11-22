import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EscPos } from '../server/printing/escpos.js';
import { buildReceiptBuffer } from '../server/printing/receipt.js';
import { buildThermalReportBuffer } from '../server/printing/xreport.js';
import { createTestApp, seedTenant, seedProduct } from './helpers/testApp.js';

let app: Awaited<ReturnType<typeof createTestApp>>;

before(async () => {
  app = await createTestApp();
});
after(async () => {
  await app.close();
});

// ---- Point 4A: Arabic text-mode kv() & labeled() spacing ----
test('EscPos Arabic text-mode kv() puts spaces between Arabic label and value', () => {
  const p = new EscPos(32, { codepage: 22, encoding: 'cp864' });
  p.kv('الإجمالي', '$10.00');
  const buf = p.toBuffer();
  const str = buf.toString('latin1');
  const idxReset = str.indexOf('\x1bt\x00');
  const idxVal = str.indexOf('$10.00');
  assert.ok(idxReset >= 0, 'expected ESC t 0 after Arabic label');
  assert.ok(idxVal > idxReset, 'expected value after Arabic label');
  const between = str.slice(idxReset + 3, idxVal);
  assert.ok(between.length >= 4 && /^ +$/.test(between), `expected spaces between label and value, got: ${JSON.stringify(between)}`);
});

// ---- Point 4B: Thermal X-report builder (image & text Arabic modes) & route ----
test('buildThermalReportBuffer renders X-report lines in both image and text Arabic modes', () => {
  const lines = [
    { kind: 'center' as const, text: 'متجر السلام', bold: true },
    { kind: 'section' as const, text: 'تقرير نهاية اليوم' },
    { kind: 'kv' as const, label: 'الإجمالي', value: '$125.00', bold: true },
    { kind: 'hr' as const },
  ];
  const imgBuf = buildThermalReportBuffer({ lines, paperWidth: 80, arabic: null });
  assert.ok(imgBuf.length > 20, 'image-mode X-report buffer should not be empty');
  assert.ok(imgBuf.includes(Buffer.from([0x1D, 0x56])), 'should end with cut command');

  const txtBuf = buildThermalReportBuffer({ lines, paperWidth: 80, arabic: { codepage: 22, encoding: 'cp864' } });
  assert.ok(txtBuf.toString('latin1').includes('$125.00'), 'text-mode X-report should contain value');
});

test('POST /api/print/xreport returns 404 no_receipt_printer when none configured', async () => {
  const tenantId = seedTenant(app.db, 'No Printer Co', 'noprinter@example.com');
  const r = await app.api('POST', '/api/print/xreport', {
    tenantId,
    body: { lines: [{ kind: 'center', text: 'END OF DAY' }] },
  });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'no_receipt_printer');
});

// ---- Point 5 & 6: Receipt shows both #ID and T1-0005, and respects showBalance / showPayments toggles ----
test('buildReceiptBuffer prints both #ID and terminal sequence, and honors showBalance/showPayments flags', () => {
  const tx = {
    id: 42,
    terminal_id: 'T1',
    terminal_sequence: 5,
    stakeholder_name: 'Alice',
    stakeholder_balance: -50,
    balance_effect: -20,
    total_amount: 20,
    items: [{ name: 'Burger', price: 10, quantity: 2 }],
    payments: [{ method: 'cash', amount: 20, currency: 'USD' }],
  };

  const full = buildReceiptBuffer({ storeName: 'Test Diner', transaction: tx }).toString('latin1');
  assert.ok(full.includes('#42 (T1-0005)'), `expected #42 (T1-0005) in receipt, got:\n${full}`);
  assert.ok(full.includes('20.00 USD'), 'expected payment line when showPayments is default');
  assert.ok(full.includes('Previous Balance'), 'expected Previous Balance when showBalance is default');

  const simple = buildReceiptBuffer({
    storeName: 'Test Diner',
    transaction: tx,
    showBalance: false,
    showPayments: false,
  }).toString('latin1');
  assert.ok(simple.includes('#42 (T1-0005)'), 'receipt number should still be present');
  assert.ok(!simple.includes('20.00 USD'), 'payment line should be hidden when showPayments=false');
  assert.ok(!simple.includes('Previous Balance'), 'balance block should be hidden when showBalance=false');
  assert.ok(!simple.includes('New Balance'), 'new balance should be hidden when showBalance=false');
});

test('GET /api/transactions/recent searches by terminal receipt number (T1-0001) as well as #id', async () => {
  const tenantId = seedTenant(app.db, 'Receipt Search Co', 'recsearch@example.com');
  const productId = seedProduct(app.db, tenantId, { barcode: 'RS-1', name: 'Coffee', price: 5, stock: 100 });
  const sale = await app.api('POST', '/api/transactions', {
    tenantId,
    body: {
      type: 'sale',
      terminalId: 'POS7',
      items: [{ id: productId, quantity: 1 }],
      currency: 'USD',
      exchange_rate: 1,
      payments: [{ amount: 5, method: 'cash', currency: 'USD', exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200);
  const txId = sale.body.id;

  const byTerm = await app.api('GET', '/api/transactions/recent?q=POS7-0001', { tenantId });
  assert.equal(byTerm.status, 200);
  assert.equal(byTerm.body.length, 1);
  assert.equal(byTerm.body[0].id, txId);

  const byHash = await app.api('GET', `/api/transactions/recent?q=%23${txId}`, { tenantId });
  assert.equal(byHash.status, 200);
  assert.equal(byHash.body.length, 1);
  assert.equal(byHash.body[0].id, txId);
});

// ---- Points 1 & 2: Cash Accounts / Savings, Transfers, Settlement persistence, Atomic Edit, Outflows Report ----
test('Cash Accounts, Drawer -> Savings transfer, paying expenses & purchases from Savings, atomic edit, and Outflows report', async () => {
  const tenantId = seedTenant(app.db, 'Treasury Co', 'treasury@example.com');
  const otherTenant = seedTenant(app.db, 'Other Co', 'other-treasury@example.com');
  const productId = seedProduct(app.db, tenantId, { barcode: 'TR-1', name: 'Flour', price: 10, stock: 50 });
  const supplierId = Number(
    app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, balance) VALUES (?, 'Mill Supplier', 'supplier', 0)").run(tenantId).lastInsertRowid,
  );
  const userId = (app.db.prepare('SELECT id FROM users WHERE tenant_id = ? LIMIT 1').get(tenantId) as any).id;

  // 1. Default Cash Drawer is auto-created and tenant-isolated
  const list1 = await app.api('GET', '/api/cash-accounts', { tenantId });
  assert.equal(list1.status, 200);
  assert.equal(list1.body.length, 1);
  const drawer = list1.body[0];
  assert.equal(drawer.is_default, 1);

  // Create Savings account
  const created = await app.api('POST', '/api/cash-accounts', {
    tenantId,
    body: { name: 'Rent & Electricity Savings', kind: 'savings' },
  });
  assert.equal(created.status, 200);
  const savingsId = created.body.id as number;

  // Other tenant cannot see or use this savings account
  const otherList = await app.api('GET', '/api/cash-accounts', { tenantId: otherTenant });
  assert.equal(otherList.body.length, 1);
  assert.ok(!otherList.body.some((a: any) => a.id === savingsId));

  // 2. Make a $100 cash sale -> Drawer expected = $100
  const sale = await app.api('POST', '/api/transactions', {
    tenantId,
    body: {
      type: 'sale',
      items: [{ id: productId, quantity: 10 }],
      currency: 'USD',
      exchange_rate: 1,
      payments: [{ amount: 100, method: 'cash', currency: 'USD', exchange_rate: 1 }],
    },
  });
  assert.equal(sale.status, 200);

  // 3. Transfer $20 from Cash Drawer -> Savings
  const tr = await app.api('POST', '/api/cash-accounts/transfer', {
    tenantId,
    body: {
      from_account_id: drawer.id,
      to_account_id: savingsId,
      amount: 20,
      currency: 'USD',
      exchange_rate: 1,
      reason: 'Daily rent reserve',
    },
  });
  assert.equal(tr.status, 200);
  const outLegId = tr.body.out_id as number;

  // Drawer expected drops to $80; Savings rises to $20
  const sumAfterTr = await app.api('GET', '/api/cash-flow/summary?scope=day', { tenantId });
  assert.equal(sumAfterTr.body.expectedBalance, 80);
  const accsAfterTr = await app.api('GET', '/api/cash-accounts', { tenantId });
  const sav1 = accsAfterTr.body.find((a: any) => a.id === savingsId);
  assert.equal(sav1.balance_usd, 20);
  assert.equal(sav1.by_currency.USD, 20);

  // Transfer has ZERO P&L and ZERO Outflows impact!
  const outAfterTr = await app.api('GET', '/api/reports/outflows', { tenantId });
  assert.equal(outAfterTr.status, 200);
  assert.equal(outAfterTr.body.totals.total_outflows, 0);

  // 4. Atomic admin edit of the transfer ($20 -> $30): updates BOTH legs!
  const editTr = await app.api('PUT', `/api/cash-flow/${outLegId}`, {
    tenantId,
    body: { amount: 30, edit_reason: 'Cashier typed 20 instead of 30' },
  });
  assert.equal(editTr.status, 200);
  assert.equal(editTr.body.transferSynced, true);

  const sumAfterEdit = await app.api('GET', '/api/cash-flow/summary?scope=day', { tenantId });
  assert.equal(sumAfterEdit.body.expectedBalance, 70);
  const accsAfterEdit = await app.api('GET', '/api/cash-accounts', { tenantId });
  assert.equal(accsAfterEdit.body.find((a: any) => a.id === savingsId).balance_usd, 30);

  // 5. End-of-Day Settlement: Drawer resets to counted ($70), Savings STILL holds $30!
  const settle = await app.api('POST', '/api/tenant/settlement', {
    tenantId,
    body: { user_id: userId, counted: [{ currency: 'USD', amount: 70, rate: 1 }], notes: 'EOD' },
  });
  assert.equal(settle.status, 200);

  const accsAfterSettle = await app.api('GET', '/api/cash-accounts', { tenantId });
  assert.equal(accsAfterSettle.body.find((a: any) => a.id === savingsId).balance_usd, 30);

  // 6. Pay a $12 electricity expense FROM Savings -> Savings drops to $18, Drawer stays at $70!
  const exp = await app.api('POST', '/api/cash-flow', {
    tenantId,
    body: {
      type: 'out',
      amount: 12,
      currency: 'USD',
      exchange_rate: 1,
      category: 'expense',
      reason: 'Electricity bill',
      account_id: savingsId,
    },
  });
  assert.equal(exp.status, 200);

  // 7. Pay a $10 cash purchase FROM Savings -> Savings drops to $8, Drawer STILL $70!
  const purch = await app.api('POST', '/api/transactions', {
    tenantId,
    body: {
      type: 'purchase',
      stakeholder_id: supplierId,
      items: [{ id: productId, quantity: 2, price: 5 }],
      currency: 'USD',
      exchange_rate: 1,
      payments: [{ amount: 10, method: 'cash', currency: 'USD', exchange_rate: 1, account_id: savingsId }],
    },
  });
  assert.equal(purch.status, 200);

  // 8. Also create a $50 CREDIT purchase (unpaid) -> should NOT be counted in total_outflows!
  const creditPurch = await app.api('POST', '/api/transactions', {
    tenantId,
    body: {
      type: 'purchase',
      stakeholder_id: supplierId,
      items: [{ id: productId, quantity: 10, price: 5 }],
      currency: 'USD',
      exchange_rate: 1,
      payments: [{ amount: 50, method: 'credit', currency: 'USD', exchange_rate: 1 }],
    },
  });
  assert.equal(creditPurch.status, 200);

  // Check Drawer is untouched ($70) and Savings is $8 ($30 - $12 - $10)
  const sumFinal = await app.api('GET', '/api/cash-flow/summary?scope=day', { tenantId });
  assert.equal(sumFinal.body.expectedBalance, 70);
  const accsFinal = await app.api('GET', '/api/cash-accounts', { tenantId });
  assert.equal(accsFinal.body.find((a: any) => a.id === savingsId).balance_usd, 8);

  // 9. Outflows report & summary combine the $12 expense + $10 paid purchase = $22 (excluding $50 unpaid credit & $30 transfer!)
  const outReport = await app.api('GET', '/api/reports/outflows', { tenantId });
  assert.equal(outReport.status, 200);
  assert.equal(outReport.body.totals.expenses, 12);
  assert.equal(outReport.body.totals.purchases_paid, 10);
  assert.equal(outReport.body.totals.total_outflows, 22);

  const summaryReport = await app.api('GET', '/api/reports/summary', { tenantId });
  assert.equal(summaryReport.status, 200);
  assert.equal(summaryReport.body.total_outflows, 22);
  assert.equal(summaryReport.body.purchases, 60); // $10 cash + $50 credit invoiced
});
