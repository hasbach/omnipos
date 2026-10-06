// The tenant's local-currency rate is frozen on each transaction at creation (server-side), survives
// rate changes, invoice edits and settlement, and prints on the receipt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";
import { buildReceiptBuffer } from "../server/printing/receipt.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let toCloudRecord: any, dropUnknownLocalColumns: any;

before(async () => {
  app = await createTestApp();
  ({ toCloudRecord, dropUnknownLocalColumns } = await import("../server/sync.js"));
  tenantId = seedTenant(app.db, "Local Rate Co", "local-rate@example.com");
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', 89500, 0)").run(tenantId);
  productId = seedProduct(app.db, tenantId, { barcode: "LR-1", name: "Widget", price: 12.5, stock: 100 });
});
after(async () => { await app.close(); });

const txRow = (id: number, table = "transactions") =>
  app.db.prepare(`SELECT local_rate, local_currency FROM ${table} WHERE id = ?`).get(id) as any;

test("a sale stores the local rate; later rate changes and invoice edits do not alter it", async () => {
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
      payments: [{ amount: 12.5, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const id = sale.body.id;
  assert.deepEqual({ ...txRow(id) }, { local_rate: 89500, local_currency: "LBP" });

  app.db.prepare("UPDATE currencies SET rate = 100000 WHERE tenant_id = ? AND code = 'LBP'").run(tenantId);
  assert.equal(txRow(id).local_rate, 89500, "changing the currency rate must not touch past sales");

  const detail = await app.api("GET", `/api/transactions/${id}`, { tenantId });
  const edit = await app.api("PUT", `/api/transactions/${id}`, {
    tenantId,
    body: { items: [{ product_id: productId, quantity: 2, unit_price: 12.5 }], payments: [{ id: detail.body.payments[0].id }] },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual({ ...txRow(id) }, { local_rate: 89500, local_currency: "LBP" }, "editing an invoice keeps the stored rate");

  assert.equal(detail.body.local_rate, 89500, "GET /api/transactions/:id exposes local_rate");
  assert.equal(detail.body.local_currency, "LBP");

  // a new sale picks up the new rate
  const sale2 = await app.api("POST", "/api/transactions", {
    tenantId, body: { type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] },
  });
  assert.equal(txRow(sale2.body.id).local_rate, 100000);
  app.db.prepare("UPDATE currencies SET rate = 89500 WHERE tenant_id = ? AND code = 'LBP'").run(tenantId);
});

test("a USD-only tenant stores NULL; purchases and settle-balance tickets are covered too", async () => {
  const usdOnly = seedTenant(app.db, "USD Only Co", "usd-only-lr@example.com");
  const p = seedProduct(app.db, usdOnly, { barcode: "LR-U", name: "U", price: 5, stock: 10 });
  const s = await app.api("POST", "/api/transactions", {
    tenantId: usdOnly, body: { type: "sale", items: [{ id: p, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] },
  });
  assert.deepEqual({ ...txRow(s.body.id) }, { local_rate: null, local_currency: null });

  const purchase = await app.api("POST", "/api/transactions", {
    tenantId, body: { type: "purchase", items: [{ id: productId, quantity: 1, price: 5 }], currency: "USD", exchange_rate: 1, payments: [] },
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  assert.equal(txRow(purchase.body.id).local_rate, 89500);

  const cust = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Debtor", type: "customer" } });
  const settle = await app.api("POST", "/api/stakeholders/settle-balance", {
    tenantId, body: { stakeholder_id: cust.body.id, amount: 1, method: "cash", currency: "USD", exchange_rate: 1 },
  });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  const ticket = app.db.prepare("SELECT local_rate, local_currency FROM transactions WHERE tenant_id = ? AND stakeholder_id = ? AND total_amount = 0").get(tenantId, cust.body.id) as any;
  assert.deepEqual({ ...ticket }, { local_rate: 89500, local_currency: "LBP" });
});

test("settlement keeps local_rate on the archived transaction and daily-sales exposes it", async () => {
  const t = seedTenant(app.db, "Settle LR Co", "settle-lr@example.com");
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LB', 'LL', 90000, 1)").run(t);
  const p = seedProduct(app.db, t, { barcode: "LR-S", name: "S", price: 10, stock: 10 });
  const s = await app.api("POST", "/api/transactions", {
    tenantId: t, body: { type: "sale", items: [{ id: p, quantity: 1 }], currency: "USD", exchange_rate: 1,
      payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] },
  });
  const userId = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? LIMIT 1").get(t) as any).id;
  const r = await app.api("POST", "/api/tenant/settlement", {
    tenantId: t, body: { user_id: userId, counted: [{ currency: "USD", amount: 10, rate: 1 }], notes: "" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(app.db.prepare("SELECT 1 FROM transactions WHERE id = ?").get(s.body.id), undefined, "moved out of live table");
  assert.deepEqual({ ...txRow(s.body.id, "archived_transactions") }, { local_rate: 90000, local_currency: "LB" });
  const detail = await app.api("GET", `/api/transactions/${s.body.id}`, { tenantId: t });
  assert.equal(detail.body.local_rate, 90000);
  const daily = await app.api("GET", "/api/reports/daily-sales", { tenantId: t });
  const rows = Array.isArray(daily.body) ? daily.body : (daily.body.transactions || []);
  const row = rows.find((x: any) => x.id === s.body.id);
  assert.equal(row?.local_rate, 90000, "archived rows in daily-sales carry local_rate");
});

test("push payloads keep the optional cloud columns (sync strips them adaptively); balance_baseline stays local-only", () => {
  const rec = { id: 7, last_synced_at: null, global_id: "g", total_amount: 5, local_rate: 89500, local_currency: "LBP" };
  const out = toCloudRecord("transactions", rec);
  assert.equal(out.local_rate, 89500);
  assert.equal(out.local_currency, "LBP");
  assert.equal(out.local_id, 7);
  assert.equal(out.total_amount, 5);
  assert.ok(!("id" in out) && !("last_synced_at" in out));
  assert.ok(!("balance_baseline" in toCloudRecord("stakeholders", { id: 1, balance_baseline: 3, name: "x" })));
});

test("pull drops cloud columns the local table does not have", () => {
  const out = dropUnknownLocalColumns("transactions", { global_id: "g", total_amount: 5, brand_new_cloud_column: 1, another: "x" });
  assert.deepEqual(out, { global_id: "g", total_amount: 5 });
});

test("receipt prints the local-currency total from the stored rate, only for sale/refund", () => {
  const text = (type: string, extra: any = {}) => buildReceiptBuffer({
    localCurrency: { code: "LBP", symbol: "LL", rate: 100000 },
    transaction: { id: 1, type, total_amount: 12.5, items: [{ name: "W", quantity: 1, price: 12.5 }], local_rate: 89500, local_currency: "LBP", ...extra },
  }).toString("latin1");
  const sale = text("sale");
  assert.ok(sale.includes("Total LL"), sale);
  assert.ok(sale.includes("1,118,750"), "12.5 x 89,500 = 1,118,750 (stored rate, not the current 100,000)");
  assert.ok(text("refund").includes("1,118,750"));
  assert.ok(!text("purchase").includes("Total LL"));
  const legacy = text("sale", { local_rate: null, local_currency: null });
  assert.ok(legacy.includes("1,250,000"), "falls back to the current rate for old rows");
  const noLocal = buildReceiptBuffer({ transaction: { id: 2, total_amount: 5, items: [{ name: "W", quantity: 1, price: 5 }] } }).toString("latin1");
  assert.ok(!noLocal.includes("Total LL"), "USD-only tenant: no local line");
});
