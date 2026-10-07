// Customer / supplier statement: the last running balance must equal stakeholders.balance (app sign
// convention: negative = Due), including balance collections, opening balances, manual edits,
// non-money payments, refunds, settlement-archived invoices and legacy (pre-log) cash_flow collections.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Statement Co", "statement-co@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "ST-1", name: "Stmt Item", price: 25, stock: 500 });
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} != ${b}`);
const balanceOf = (id: number) => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(id) as any).balance as number;
const statement = async (id: number) => (await app.api("GET", `/api/reports/customer-statement/${id}`, { tenantId })).body as any[];
const closes = (rows: any[], id: number) => {
  assert.ok(rows.length > 0);
  near(rows[rows.length - 1].balance, balanceOf(id), "closing balance == stakeholder balance");
};
const post = async (body: any) => {
  const r = await app.api("POST", "/api/transactions", { tenantId, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};

test("customer: opening, credit sale, LBP payment, credit-method sale, refund, collection, manual edit", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Stmt Customer", type: "customer", balance: -20 } })).body.id;

  await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [] }); // -50
  const s2 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 895000, method: "cash", currency: "LBP", exchange_rate: 89500 }] }); // -25 +10
  const s3 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 25, method: "credit", currency: "USD", exchange_rate: 1 }] }); // -25, credit pays nothing
  await post({ type: "refund", original_transaction_id: s2, stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] }); // +25 -10
  const col = await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: cust, amount: 268500, currency: "LBP", exchange_rate: 89500, direction: "collect" } }); // +3
  assert.equal(col.status, 200, JSON.stringify(col.body));

  let rows = await statement(cust);
  closes(rows, cust);
  near(rows[rows.length - 1].balance, -20 - 50 - 15 - 25 + 15 + 3, "expected closing before manual edit");

  const op = rows.find((r) => r.type === "opening");
  assert.ok(op, "opening row");
  assert.equal(rows[0].type, "opening");
  near(op.effect, -20);
  near(op.debit, 20); // customer: more owed => debit
  near(op.balance, -20);

  const pay = rows.find((r) => r.type === "payment" && r.reference === `Pay for #${s2}`);
  assert.ok(pay);
  near(pay.effect, 10); near(pay.credit, 10);
  assert.equal(pay.currency, "LBP"); near(pay.amount_original, 895000); near(pay.exchange_rate, 89500);

  const onAcct = rows.find((r) => r.type === "on_account" && r.reference === `Pay for #${s3}`);
  assert.ok(onAcct, "credit-method payment shown informationally");
  near(onAcct.effect, 0); near(onAcct.debit, 0); near(onAcct.credit, 0);

  const refundRow = rows.find((r) => r.type === "refund");
  assert.ok(refundRow); near(refundRow.effect, 25); near(refundRow.credit, 25);
  const refundPay = rows.find((r) => r.type === "refund_payment");
  assert.ok(refundPay); near(refundPay.effect, -10); near(refundPay.debit, 10);

  const bc = rows.find((r) => r.type === "balance_collection");
  assert.ok(bc); near(bc.effect, 3); near(bc.credit, 3);
  assert.equal(bc.currency, "LBP"); near(bc.amount_original, 268500);

  // Manual balance edit via PUT
  const put = await app.api("PUT", `/api/stakeholders/${cust}`, { tenantId, body: { name: "Stmt Customer", type: "customer", balance: -7 } });
  assert.equal(put.status, 200);
  near(balanceOf(cust), -7);
  rows = await statement(cust);
  closes(rows, cust);
  const edit = rows.find((r) => r.type === "manual_edit");
  assert.ok(edit); near(edit.effect, -7 - (-20 - 50 - 15 - 25 + 15 + 3));
});

test("supplier: purchases, cash payment and supplier payment; debit/credit sides", async () => {
  const sup = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Stmt Supplier", type: "supplier" } })).body.id;
  const p1 = await post({ type: "purchase", stakeholder_id: sup, items: [{ id: productId, quantity: 4, price: 25 }], currency: "USD", exchange_rate: 1, payments: [] }); // -100
  const p2 = await post({ type: "purchase", stakeholder_id: sup, items: [{ id: productId, quantity: 2, price: 20 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 40, method: "cash", currency: "USD", exchange_rate: 1 }] }); // -40 +40
  const pay = await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: sup, amount: 30, currency: "USD", exchange_rate: 1, direction: "pay" } });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));

  const rows = await statement(sup);
  closes(rows, sup);
  near(balanceOf(sup), -70);
  const inv1 = rows.find((r) => r.type === "purchase" && r.reference === `#${p1}`);
  assert.ok(inv1); near(inv1.credit, 100); near(inv1.debit, 0); near(inv1.effect, -100);
  const cash = rows.find((r) => r.type === "payment" && r.reference === `Pay for #${p2}`);
  assert.ok(cash); near(cash.debit, 40); near(cash.credit, 0);
  const sp = rows.find((r) => r.type === "supplier_payment");
  assert.ok(sp); near(sp.debit, 30); near(sp.effect, 30);
});

test("settlement archives invoices but the statement still lists them and closes at the balance", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Settle Customer", type: "customer" } })).body.id;
  const s1 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }] }); // -30
  const col = await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: cust, amount: 5, currency: "USD", exchange_rate: 1, direction: "collect" } });
  assert.equal(col.status, 200);
  const before = balanceOf(cust);
  near(before, -25);

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM transactions WHERE id = ?").get(s1) as any).c, 0, "invoice archived");
  near(balanceOf(cust), before, "settlement keeps the balance");

  const rows = await statement(cust);
  closes(rows, cust);
  assert.ok(rows.find((r) => r.type === "sale" && r.reference === `#${s1}`), "archived invoice listed");
  assert.ok(rows.find((r) => r.type === "payment" && r.reference === `Pay for #${s1}`), "archived payment listed");
  assert.ok(rows.find((r) => r.type === "balance_collection"), "collection listed");
});

test("legacy collection recorded only in cash_flow before the balance log appears as a balance_collection row", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Legacy Customer", type: "customer" } })).body.id;
  await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [] }); // -50, first log row = now

  // Simulate a pre-log collection of 1,790,000 LBP @ 89,500 = $20: baseline moved, only cash_flow remembers it.
  app.db.prepare("INSERT INTO cash_flow (tenant_id, type, amount, currency, exchange_rate, reason, category, counterparty, created_at) VALUES (?, 'in', 1790000, 'LBP', 89500, ?, 'customer_collection', 'Legacy Customer', '2020-01-01 10:00:00')")
    .run(tenantId, "Balance collection from Legacy Customer");
  app.db.prepare("UPDATE stakeholders SET balance_baseline = balance_baseline + 20, balance = balance + 20 WHERE id = ?").run(cust);
  near(balanceOf(cust), -30);

  const rows = await statement(cust);
  closes(rows, cust);
  const legacy = rows.find((r) => r.type === "balance_collection");
  assert.ok(legacy, "legacy collection present");
  near(legacy.effect, 20); near(legacy.credit, 20);
  assert.equal(legacy.currency, "LBP"); near(legacy.amount_original, 1790000);
  assert.equal(rows.find((r) => r.type === "opening"), undefined, "fully explained, no reconciling row");
});

test("an LBP-paid invoice short by a sub-cent residue nets to 0 on the statement (no opening-adjustment line)", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Tolerance Customer", type: "customer" } })).body.id;
  // $25 = 2,237,500 LBP @ 89,500; paying 2,237,000 leaves 500 LBP = $0.0056 short - inside PAID_TOLERANCE_USD,
  // so balance.ts books it as exactly settled.
  const sale = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 2237000, method: "cash", currency: "LBP", exchange_rate: 89500 }] });
  assert.equal(balanceOf(cust), 0, "tolerance: no residue on the balance");

  const rows = await statement(cust);
  assert.equal(rows.find((r) => r.type === "opening"), undefined, "no reconciling opening line");
  const pay = rows.find((r) => r.type === "payment" && r.reference === `Pay for #${sale}`);
  assert.ok(pay, "payment row listed");
  assert.equal(pay.currency, "LBP");
  assert.equal(pay.amount_original, 2237000);
  assert.equal(pay.exchange_rate, 89500);
  assert.equal(pay.effect, 25, "last payment carries the residue so the invoice nets to exactly 0");
  assert.ok(Math.abs(rows[rows.length - 1].balance - balanceOf(cust)) < 1e-9, "closes at the stakeholder balance");
});
