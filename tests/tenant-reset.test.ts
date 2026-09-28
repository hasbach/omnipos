// Tenant data reset (docs/plans/2026-09-29-tenant-data-reset.md). The point of most of these tests
// is ISOLATION: tenant A is reset, tenant B (seeded identically) must be byte-for-byte untouched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import Database from "better-sqlite3";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let n = 0;

before(async () => { app = await createTestApp(); });
after(async () => { await app.close(); });

// Every table a reset can touch, with how to count a tenant's rows in it.
const COUNTS: Record<string, string> = {
  products: "SELECT COUNT(*) c FROM products WHERE tenant_id = @t",
  product_barcodes: "SELECT COUNT(*) c FROM product_barcodes WHERE product_id IN (SELECT id FROM products WHERE tenant_id = @t)",
  product_units: "SELECT COUNT(*) c FROM product_units WHERE tenant_id = @t",
  stakeholders: "SELECT COUNT(*) c FROM stakeholders WHERE tenant_id = @t",
  transactions: "SELECT COUNT(*) c FROM transactions WHERE tenant_id = @t",
  transaction_items: "SELECT COUNT(*) c FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = @t)",
  payments: "SELECT COUNT(*) c FROM payments WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = @t)",
  archived_transactions: "SELECT COUNT(*) c FROM archived_transactions WHERE tenant_id = @t",
  archived_transaction_items: "SELECT COUNT(*) c FROM archived_transaction_items WHERE transaction_id IN (SELECT id FROM archived_transactions WHERE tenant_id = @t)",
  archived_payments: "SELECT COUNT(*) c FROM archived_payments WHERE transaction_id IN (SELECT id FROM archived_transactions WHERE tenant_id = @t)",
  cash_flow: "SELECT COUNT(*) c FROM cash_flow WHERE tenant_id = @t",
  archived_cash_flow: "SELECT COUNT(*) c FROM archived_cash_flow WHERE tenant_id = @t",
  daily_reports: "SELECT COUNT(*) c FROM daily_reports WHERE tenant_id = @t",
  yearly_reports: "SELECT COUNT(*) c FROM yearly_reports WHERE tenant_id = @t",
  cashier_shifts: "SELECT COUNT(*) c FROM cashier_shifts WHERE tenant_id = @t",
  transaction_edits: "SELECT COUNT(*) c FROM transaction_edits WHERE tenant_id = @t",
  stock_adjustments: "SELECT COUNT(*) c FROM stock_adjustments WHERE tenant_id = @t",
  users: "SELECT COUNT(*) c FROM users WHERE tenant_id = @t",
  currencies: "SELECT COUNT(*) c FROM currencies WHERE tenant_id = @t",
  settings: "SELECT COUNT(*) c FROM settings WHERE tenant_id = @t",
  stock_sum: "SELECT IFNULL(SUM(stock),0) c FROM products WHERE tenant_id = @t",
  balance_sum: "SELECT IFNULL(SUM(ABS(balance)),0) + IFNULL(SUM(ABS(balance_baseline)),0) c FROM stakeholders WHERE tenant_id = @t",
};
function snapshot(t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, sql] of Object.entries(COUNTS)) out[k] = (app.db.prepare(sql).get({ t }) as any).c;
  return out;
}

const TX_TABLES = ["transactions", "transaction_items", "payments", "archived_transactions", "archived_transaction_items", "archived_payments",
  "cash_flow", "archived_cash_flow", "daily_reports", "yearly_reports", "cashier_shifts", "transaction_edits", "stock_adjustments"];
const PRODUCT_TABLES = ["products", "product_barcodes", "product_units"];

async function seedBusiness(): Promise<{ t: number; walkIn: number; cust: number; supp: number; p1: number; p2: number }> {
  n++;
  const t = seedTenant(app.db, `Reset Co ${n}`, `reset-${n}@example.com`);
  const walkIn = (app.db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'").get(t) as any).id;
  const p1 = seedProduct(app.db, t, { barcode: `R${n}-A`, name: "Widget", price: 10, stock: 50 });
  const p2 = seedProduct(app.db, t, { barcode: `R${n}-B`, name: "Gadget", price: 4, stock: 30 });
  app.db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)").run(p1, `R${n}-A-ALT`);
  app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, barcode, price) VALUES (?, ?, 'Pack', 6, ?, 55)").run(t, p1, `R${n}-A-PACK`);
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId: t, body: { name: "Debtor", type: "customer" } })).body.id;
  const supp = (await app.api("POST", "/api/stakeholders", { tenantId: t, body: { name: "Supplier", type: "supplier" } })).body.id;

  // unpaid sale -> customer owes; paid sale to walk-in; purchase on credit; refund; manual baseline
  const s1 = await app.api("POST", "/api/transactions", { tenantId: t, body: { type: "sale", stakeholder_id: cust, items: [{ id: p1, quantity: 3 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  const s2 = await app.api("POST", "/api/transactions", { tenantId: t, body: { type: "sale", stakeholder_id: walkIn, items: [{ id: p2, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 8, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  const pu = await app.api("POST", "/api/transactions", { tenantId: t, body: { type: "purchase", stakeholder_id: supp, items: [{ id: p2, quantity: 10, price: 2 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(pu.status, 200, JSON.stringify(pu.body));
  const rf = await app.api("POST", "/api/transactions", { tenantId: t, body: { type: "refund", original_transaction_id: s2.body.id, stakeholder_id: walkIn, items: [{ id: p2, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 4, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(rf.status, 200, JSON.stringify(rf.body));
  await app.api("POST", "/api/cash-flow", { tenantId: t, body: { type: "in", amount: 25, currency: "USD", exchange_rate: 1, reason: "float" } });

  // "settlement": archive what exists so far (banking balances into the baseline, like the real
  // route). Done by hand rather than via POST /api/tenant/settlement because that route's id-offset
  // step is not tenant-scoped and trips a FOREIGN KEY error once a second tenant has older live rows.
  app.db.transaction(() => {
    const ids = "SELECT id FROM transactions WHERE tenant_id = ?";
    app.db.prepare(`INSERT INTO archived_payments (id, transaction_id, amount, method, currency, exchange_rate, created_at) SELECT id, transaction_id, amount, method, currency, exchange_rate, created_at FROM payments WHERE transaction_id IN (${ids})`).run(t);
    app.db.prepare(`INSERT INTO archived_transaction_items (id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value, unit_cost, uom_id, uom_name, uom_factor, uom_qty, original_item_id) SELECT id, transaction_id, product_id, quantity, unit_price, discount_type, discount_value, tax_type, tax_value, unit_cost, uom_id, uom_name, uom_factor, uom_qty, original_item_id FROM transaction_items WHERE transaction_id IN (${ids})`).run(t);
    app.db.prepare("INSERT INTO archived_transactions (id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, original_transaction_id, price_level, notes, reference, edited_at, edit_count, created_at) SELECT id, tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, discount_type, discount_value, tax_type, tax_value, status, terminal_id, terminal_sequence, original_transaction_id, price_level, notes, reference, edited_at, edit_count, created_at FROM transactions WHERE tenant_id = ?").run(t);
    app.db.prepare("UPDATE stakeholders SET balance_baseline = balance WHERE tenant_id = ?").run(t);
    app.db.prepare(`DELETE FROM payments WHERE transaction_id IN (${ids})`).run(t);
    app.db.prepare(`DELETE FROM transaction_items WHERE transaction_id IN (${ids})`).run(t);
    app.db.prepare("DELETE FROM transactions WHERE tenant_id = ?").run(t);
    app.db.prepare("INSERT INTO archived_cash_flow (id, tenant_id, user_id, type, amount, currency, exchange_rate, reason, created_at) SELECT id, tenant_id, user_id, type, amount, currency, exchange_rate, reason, created_at FROM cash_flow WHERE tenant_id = ?").run(t);
    app.db.prepare("DELETE FROM cash_flow WHERE tenant_id = ?").run(t);
  })();

  const s3 = await app.api("POST", "/api/transactions", { tenantId: t, body: { type: "sale", stakeholder_id: cust, items: [{ id: p1, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(s3.status, 200, JSON.stringify(s3.body));
  const s4 = await app.api("POST", "/api/transactions", { tenantId: t, body: { type: "sale", stakeholder_id: walkIn, items: [{ id: p2, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 4, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(s4.status, 200, JSON.stringify(s4.body));
  await app.api("POST", "/api/cash-flow", { tenantId: t, body: { type: "out", amount: 5, currency: "USD", exchange_rate: 1, reason: "tape" } });

  const uid = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ?").get(t) as any).id;
  app.db.prepare("INSERT INTO daily_reports (tenant_id, user_id, date) VALUES (?, ?, '2026-01-01')").run(t, uid);
  app.db.prepare("INSERT INTO yearly_reports (tenant_id, user_id, year) VALUES (?, ?, 2025)").run(t, uid);
  app.db.prepare("INSERT INTO cashier_shifts (tenant_id, user_id, date) VALUES (?, ?, '2026-01-01')").run(t, uid);
  app.db.prepare("INSERT INTO transaction_edits (tenant_id, transaction_id, reason) VALUES (?, ?, 'x')").run(t, s3.body.id);
  await app.api("POST", "/api/stock/adjust", { tenantId: t, body: { product_id: p1, delta: 2, reason: "found" } });
  app.db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, 'store_name', 'Keep Me')").run(t);
  return { t, walkIn, cust, supp, p1, p2 };
}

const reset = (t: number, scopes: string[], over: any = {}) =>
  app.api("POST", "/api/tenant/reset", { tenantId: t, body: { scopes, confirm: "DELETE", admin_pin: "0000", ...over } });

test("seed sanity: both tenants have data in every table", async () => {
  const a = await seedBusiness();
  const s = snapshot(a.t);
  for (const k of [...TX_TABLES, ...PRODUCT_TABLES]) assert.ok(s[k] > 0, `${k} should be seeded`);
  assert.ok(s.balance_sum > 0);
});

test("scope 'transactions': A's history + balances gone, products/parties kept, tenant B untouched", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  const beforeB = snapshot(B.t);
  const beforeA = snapshot(A.t);

  const res = await reset(A.t, ["transactions"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.ok(res.body.deleted.transactions > 0);

  const a = snapshot(A.t);
  for (const k of TX_TABLES) assert.equal(a[k], 0, `A.${k}`);
  assert.equal(a.balance_sum, 0, "all balances and baselines zeroed");
  for (const k of [...PRODUCT_TABLES, "stakeholders", "users", "currencies", "settings", "stock_sum"]) assert.equal(a[k], beforeA[k], `A.${k} kept`);

  assert.deepEqual(snapshot(B.t), beforeB, "tenant B must be untouched");
});

test("scope 'stock': only stock zeroed; history and everything else kept; B untouched", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  const beforeA = snapshot(A.t);
  const beforeB = snapshot(B.t);

  const res = await reset(A.t, ["stock"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const a = snapshot(A.t);
  assert.equal(a.stock_sum, 0);
  assert.deepEqual({ ...a, stock_sum: 0 }, { ...beforeA, stock_sum: 0 }, "nothing else changed");
  assert.deepEqual(snapshot(B.t), beforeB);
});

test("scope 'transactions' + 'products': products/barcodes/units gone, parties kept, B untouched", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  const beforeA = snapshot(A.t);
  const beforeB = snapshot(B.t);

  const res = await reset(A.t, ["transactions", "products"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const a = snapshot(A.t);
  for (const k of [...TX_TABLES, ...PRODUCT_TABLES]) assert.equal(a[k], 0, `A.${k}`);
  assert.equal(a.stakeholders, beforeA.stakeholders);
  assert.deepEqual(snapshot(B.t), beforeB);
  // B's barcodes still resolve through the API
  const lookup = await app.api("GET", "/api/products", { tenantId: B.t });
  assert.equal(lookup.body.length, 2);
});

test("scope 'transactions' + 'parties': customers/suppliers gone, Walk-in survives with balance 0, B untouched", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  const beforeA = snapshot(A.t);
  const beforeB = snapshot(B.t);

  const res = await reset(A.t, ["transactions", "parties"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const left = app.db.prepare("SELECT id, name, balance, balance_baseline FROM stakeholders WHERE tenant_id = ?").all(A.t) as any[];
  assert.equal(left.length, 1);
  assert.equal(left[0].id, A.walkIn);
  assert.equal(left[0].name, "Walk-in Customer");
  assert.equal(left[0].balance, 0);
  assert.equal(left[0].balance_baseline, 0);
  assert.equal(snapshot(A.t).products, beforeA.products, "products kept");
  assert.deepEqual(snapshot(B.t), beforeB);
});

test("everything: all four scopes; users/settings/currencies kept; a new sale works afterwards", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  const beforeA = snapshot(A.t);
  const beforeB = snapshot(B.t);

  const res = await reset(A.t, ["transactions", "stock", "products", "parties"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const a = snapshot(A.t);
  for (const k of [...TX_TABLES, ...PRODUCT_TABLES]) assert.equal(a[k], 0, `A.${k}`);
  assert.equal(a.stakeholders, 1);
  assert.equal(a.users, beforeA.users);
  assert.equal(a.currencies, beforeA.currencies);
  assert.equal(a.settings, beforeA.settings);
  assert.deepEqual(snapshot(B.t), beforeB);

  const log = app.db.prepare("SELECT details FROM user_logs WHERE tenant_id = ? AND action = 'Tenant data reset'").get(A.t) as any;
  assert.match(log.details, /transactions, stock, products, parties/);
  assert.match(log.details, /pos-before-reset-/);

  // the shop keeps working: new product, new sale to the surviving Walk-in
  const pid = seedProduct(app.db, A.t, { barcode: `NEW-${n}`, name: "Fresh", price: 7, stock: 5 });
  const sale = await app.api("POST", "/api/transactions", { tenantId: A.t, body: { type: "sale", stakeholder_id: A.walkIn, items: [{ id: pid, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [{ amount: 14, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(snapshot(A.t).transactions, 1);
  assert.equal((app.db.prepare("SELECT stock FROM products WHERE id = ?").get(pid) as any).stock, 3);
});

test("dependency rule: products or parties without transactions is rejected, nothing deleted", async () => {
  const A = await seedBusiness();
  const before = snapshot(A.t);
  for (const scopes of [["products"], ["parties"], ["stock", "products"], ["parties", "stock"]]) {
    const res = await reset(A.t, scopes);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "RESET_SCOPE_DEPENDENCY");
  }
  assert.deepEqual(snapshot(A.t), before);
});

test("invalid / empty scopes -> RESET_SCOPE_INVALID", async () => {
  const A = await seedBusiness();
  const before = snapshot(A.t);
  for (const scopes of [[], ["users"], ["transactions", "bogus"], "transactions", undefined]) {
    const res = await reset(A.t, scopes as any);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "RESET_SCOPE_INVALID");
  }
  assert.deepEqual(snapshot(A.t), before);
});

test("wrong / missing PIN -> 403 RESET_PIN_INVALID, nothing deleted, no backup; non-admin PIN and other tenant's admin PIN rejected", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  app.db.prepare("UPDATE users SET pin = '4321' WHERE tenant_id = ?").run(B.t);   // B's admin PIN
  app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Cashier', 'staff', '1111')").run(A.t);
  const before = snapshot(A.t);
  const beforeB = snapshot(B.t);

  for (const pin of ["9999", "", undefined, "1111" /* staff */, "4321" /* B's admin */]) {
    const res = await reset(A.t, ["transactions"], { admin_pin: pin });
    assert.equal(res.status, 403, `pin ${pin}`);
    assert.equal(res.body.code, "RESET_PIN_INVALID");
    assert.equal(res.body.field, "admin_pin");
  }
  assert.deepEqual(snapshot(A.t), before);
  assert.deepEqual(snapshot(B.t), beforeB);
});

test("missing / wrong confirm -> RESET_CONFIRM_REQUIRED (field confirm), nothing deleted", async () => {
  const A = await seedBusiness();
  const before = snapshot(A.t);
  for (const confirm of [undefined, "", "delete", "DELETE "]) {
    const res = await reset(A.t, ["transactions"], { confirm });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "RESET_CONFIRM_REQUIRED");
    assert.equal(res.body.field, "confirm");
  }
  assert.deepEqual(snapshot(A.t), before);
});

test("unauthenticated -> 401", async () => {
  const res = await app.api("POST", "/api/tenant/reset", { body: { scopes: ["transactions"], confirm: "DELETE", admin_pin: "0000" } });
  assert.equal(res.status, 401);
});

test("a backup file is created first: exists, opens, and still contains A's pre-reset data", async () => {
  const A = await seedBusiness();
  const before = snapshot(A.t);
  const res = await reset(A.t, ["transactions", "stock", "products", "parties"]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(fs.existsSync(res.body.backup), "backup file exists");
  assert.match(res.body.backup, /backups[\\/]pos-before-reset-\d+-\d{8}-\d{6}\.db$/);

  const bk = new Database(res.body.backup, { readonly: true });
  try {
    for (const k of ["products", "transactions", "archived_transactions", "product_units", "cash_flow"]) {
      const got = (bk.prepare(COUNTS[k].replace(/@t/g, "?")).get(A.t) as any).c;
      assert.equal(got, before[k], `backup has A.${k}`);
    }
    assert.ok(before.transactions > 0 && before.archived_transactions > 0);
  } finally { bk.close(); }
});

test("preview returns tenant-scoped counts and cloud status", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  // give B extra so a cross-tenant leak would show
  for (let i = 0; i < 5; i++) seedProduct(app.db, B.t, { barcode: `EXTRA-${n}-${i}`, name: `x${i}`, price: 1, stock: 10 });
  const res = await app.api("GET", "/api/tenant/reset/preview", { tenantId: A.t });
  assert.equal(res.status, 200);
  const a = snapshot(A.t);
  assert.equal(res.body.products, a.products);
  assert.equal(res.body.transactions, a.transactions + a.archived_transactions);
  assert.equal(res.body.parties, a.stakeholders - 1, "walk-in excluded");
  assert.equal(res.body.stock_units, (app.db.prepare("SELECT SUM(stock) s FROM products WHERE tenant_id = ? AND stock > 0").get(A.t) as any).s);
  assert.deepEqual(res.body.cloud, { connected: false, hasSyncedData: false });
  assert.equal((await app.api("GET", "/api/tenant/reset/preview")).status, 401);
});

test("synced rows + no cloud session -> 409 RESET_NEEDS_CLOUD, nothing deleted, no backup; unsynced-scope reset still allowed", async () => {
  const A = await seedBusiness();
  const B = await seedBusiness();
  app.db.prepare("UPDATE transactions SET last_synced_at = CURRENT_TIMESTAMP WHERE tenant_id = ?").run(A.t);
  const before = snapshot(A.t);
  const beforeB = snapshot(B.t);

  const preview = await app.api("GET", "/api/tenant/reset/preview", { tenantId: A.t });
  assert.deepEqual(preview.body.cloud, { connected: false, hasSyncedData: true });

  const res = await reset(A.t, ["transactions"]);
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, "RESET_NEEDS_CLOUD");
  assert.deepEqual(snapshot(A.t), before);
  assert.deepEqual(snapshot(B.t), beforeB);

  // stock-only reset doesn't need the cloud copy purged (it rides the normal push)
  const stock = await reset(A.t, ["stock"]);
  assert.equal(stock.status, 200, JSON.stringify(stock.body));
});

test("synced parties/products in scope also require the cloud; the Walk-in's own sync flag is ignored", async () => {
  const A = await seedBusiness();
  // only the walk-in is synced -> parties scope does not need the cloud
  app.db.prepare("UPDATE stakeholders SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?").run(A.walkIn);
  const ok = await app.api("GET", "/api/tenant/reset/preview", { tenantId: A.t });
  assert.equal(ok.body.cloud.hasSyncedData, false);

  app.db.prepare("UPDATE product_units SET last_synced_at = CURRENT_TIMESTAMP WHERE tenant_id = ?").run(A.t);
  const res = await reset(A.t, ["transactions", "products"]);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "RESET_NEEDS_CLOUD");
});
