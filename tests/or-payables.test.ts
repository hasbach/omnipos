import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";
import { openInvoices, agingBuckets, payableReserve, runwayWithPayables, payableBriefing, type OpenInvoice } from "../server/or/payables.js";

const today = "2026-11-27";
const party = { id: 1, name: "Supplier", phone: "12345" };
const invoice = (date: string, amount = 100, terms = 0) => openInvoices(party, {
  orders: [{ id: 1, type: "purchase", date, remaining: amount }], previous_balance: 0,
}, "purchase", terms, today)[0];

test("aging uses invoice age, with exact 30/31/60/61 day boundaries and undated debt separate", () => {
  const rows = [invoice("2026-10-28"), invoice("2026-10-27"), invoice("2026-09-28"), invoice("2026-09-27")];
  rows.push(...openInvoices(party, { orders: [], previous_balance: 25 }, "purchase", 0, today));
  assert.deepEqual(agingBuckets(rows), { days_0_30: 100, days_31_60: 200, days_60_plus: 100, undated: 25, total_usd: 425 });
});

test("payable reserve includes overdue, delivery-day and horizon boundary, excludes later invoices", () => {
  const rows = [invoice("2026-11-01", 10), invoice(today, 20), invoice(today, 30, 7), invoice(today, 40, 8)];
  assert.equal(payableReserve(rows, today), 60);
  assert.equal(payableReserve(rows, today, 0), 30);
  assert.equal(payableReserve(rows, today, 8), 100);
});

test("runway charges payables only when due, including a shortfall despite profitable trading", () => {
  assert.equal(runwayWithPayables(100, 10, [invoice(today, 50, 3)], today), 5);
  assert.equal(runwayWithPayables(100, 10, [invoice(today, 500, 20)], today), 10);
  assert.equal(runwayWithPayables(100, -10, [invoice(today, 150, 3)], today), 3);
  assert.equal(runwayWithPayables(100, -10, [invoice(today, 150, 10)], today), null);
  assert.equal(runwayWithPayables(100, 10, [invoice("2026-11-01", 110)], today), 0);
});

test("briefing distinguishes overdue and this week, groups customers with oldest age and phone", () => {
  const overdue = invoice("2026-11-01");
  const due = invoice(today, 20, 7);
  const receivables: OpenInvoice[] = [invoice("2026-10-01", 30), invoice("2026-11-01", 20)];
  const result = payableBriefing([overdue, due, invoice(today, 20, 8)], receivables, today);
  assert.deepEqual(result.overdue, [overdue]);
  assert.deepEqual(result.due_week, [due]);
  assert.deepEqual(result.chase, [{ name: "Supplier", phone: "12345", amount_usd: 50, age_days: 57 }]);
});

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let load: typeof import("../server/or/payablesData.js").loadOpenPayablesReceivables;
before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "OR Payables", "or-payables@example.com");
  ({ loadOpenPayablesReceivables: load } = await import("../server/or/payablesData.js"));
});
after(async () => { await app.close(); });

test("supplier later payments settle FIFO before terms/reserves; customer collections reduce receivables", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "OR-PAY", name: "Item", price: 25, stock: 100 });
  const supplier = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Terms Supplier", type: "supplier" } })).body.id;
  const customer = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Credit Customer", type: "customer", phone: "555" } })).body.id;
  app.db.prepare("INSERT INTO or_supplier_profiles (tenant_id, supplier_id, payment_terms_days) VALUES (?, ?, 14)").run(tenantId, supplier);
  const purchases: number[] = [];
  for (const date of ["2026-10-01 12:00:00", "2026-11-20 12:00:00"]) {
    const result = await app.api("POST", "/api/transactions", { tenantId, body: {
      type: "purchase", stakeholder_id: supplier, items: [{ id: productId, quantity: 1, price: 100 }],
      currency: "USD", exchange_rate: 1, payments: [],
    } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    purchases.push(result.body.id);
    app.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run(date, result.body.id);
  }
  const payment = await app.api("POST", "/api/balance-payment", { tenantId, body: {
    stakeholder_id: supplier, amount: 125, currency: "USD", exchange_rate: 1, direction: "pay",
  } });
  assert.equal(payment.status, 200, JSON.stringify(payment.body));
  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: customer, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const collection = await app.api("POST", "/api/balance-payment", { tenantId, body: {
    stakeholder_id: customer, amount: 20, currency: "USD", exchange_rate: 1, direction: "collect",
  } });
  assert.equal(collection.status, 200, JSON.stringify(collection.body));
  const snapshot = load(tenantId, today);
  assert.equal(snapshot.payables.length, 1);
  assert.equal(snapshot.payables[0].invoice_id, purchases[1]);
  assert.equal(snapshot.payables[0].amount_usd, 75);
  assert.equal(snapshot.payables[0].due_date, "2026-12-04");
  assert.equal(payableReserve(snapshot.payables, today), 75);
  assert.equal(snapshot.receivable_aging.total_usd, 30);
  assert.equal(snapshot.briefing.chase[0].phone, "555");
  const { computeSpendableCash } = await import("../server/or/spendableCash.js");
  const { ensureOrInitialized } = await import("../server/or/config.js");
  ensureOrInitialized(tenantId);
  app.db.prepare("UPDATE or_tenant_config SET payables_reserve_days = 7 WHERE tenant_id = ?").run(tenantId);
  const cash = computeSpendableCash(tenantId, today);
  assert.equal(cash.payables_reserve_usd, 75);
  assert.equal(cash.free_spendable_cash_usd, Math.round((cash.total_liquid_cash_usd - cash.min_drawer_float_usd - cash.locked_opex_reserve_usd - cash.active_po_locks_usd - 75) * 100) / 100);
  const otherTenant = seedTenant(app.db, "Other OR", "other-or-payables@example.com");
  assert.equal(load(otherTenant, today).payables.length, 0);
  app.db.prepare("UPDATE tenants SET or_license_type = 'lifetime' WHERE id = ?").run(tenantId);
  const terms = await app.api("PUT", `/api/or/suppliers/${supplier}/terms`, { tenantId, body: { payment_terms_days: 0 } });
  assert.equal(terms.status, 200, JSON.stringify(terms.body));
  assert.equal(load(tenantId, today).payables[0].due_date, "2026-11-20");
  const invalid = await app.api("PUT", `/api/or/suppliers/${supplier}/terms`, { tenantId, body: { payment_terms_days: -1 } });
  assert.equal(invalid.status, 400);
  const config = await app.api("PUT", "/api/or/config", { tenantId, body: { payables_reserve_days: 21 } });
  assert.equal(config.status, 200, JSON.stringify(config.body));
  assert.equal(config.body.payables_reserve_days, 21);
  const briefing = await app.api("GET", "/api/or/briefing", { tenantId });
  assert.equal(briefing.status, 200, JSON.stringify(briefing.body));
  assert.equal(briefing.body.settlements.payable_aging.total_usd, 75);
  assert.equal(briefing.body.settlements.receivable_aging.total_usd, 30);
});
