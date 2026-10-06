// A customer/supplier can carry its OWN local-currency exchange rate (stakeholders.local_rate) that
// overrides the global one for converting local-currency payments and local-currency purchase
// invoices. The server is the source of truth: the client's exchange_rate is ignored for those.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let sync: any;

const GLOBAL = 89500;

before(async () => {
  app = await createTestApp();
  sync = await import("../server/sync.js");
  tenantId = seedTenant(app.db, "Party Rate Co", "party-rate@example.com");
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', ?, 0)").run(tenantId, GLOBAL);
  productId = seedProduct(app.db, tenantId, { barcode: "PR-1", name: "Widget", price: 10, stock: 1000 });
});
after(async () => { await app.close(); });

const mkParty = async (name: string, type: "customer" | "supplier", extra: any = {}) => {
  const r = await app.api("POST", "/api/stakeholders", { tenantId, body: { name, type, ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
const balanceOf = (id: number) => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(id) as any).balance as number;
const paymentsOf = (txId: number) => app.db.prepare("SELECT * FROM payments WHERE transaction_id = ? ORDER BY id").all(txId) as any[];
const txOf = (id: number) => app.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as any;
const walkInId = () => (app.db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'").get(tenantId) as any).id as number;

test("party rate is stored, returned, validated, and cleared", async () => {
  const id = await mkParty("Rate Customer", "customer", { local_rate: 90000 });
  const list = await app.api("GET", "/api/stakeholders", { tenantId });
  assert.equal(list.body.find((s: any) => s.id === id).local_rate, 90000);

  for (const bad of ["abc", 0, -5, "-1"]) {
    const r = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Bad " + bad, type: "customer", local_rate: bad } });
    assert.equal(r.status, 400, String(bad));
    assert.equal(r.body.code, "INVALID_RATE");
    assert.equal(r.body.field, "local_rate");
    const u = await app.api("PUT", `/api/stakeholders/${id}`, { tenantId, body: { name: "Rate Customer", type: "customer", local_rate: bad } });
    assert.equal(u.status, 400);
    assert.equal(u.body.code, "INVALID_RATE");
  }
  const still = app.db.prepare("SELECT local_rate FROM stakeholders WHERE id = ?").get(id) as any;
  assert.equal(still.local_rate, 90000, "a rejected update changes nothing");

  // omitted = untouched; a numeric string is accepted; null / '' clears
  await app.api("PUT", `/api/stakeholders/${id}`, { tenantId, body: { name: "Rate Customer 2", type: "customer" } });
  assert.equal((app.db.prepare("SELECT local_rate FROM stakeholders WHERE id = ?").get(id) as any).local_rate, 90000);
  await app.api("PUT", `/api/stakeholders/${id}`, { tenantId, body: { name: "Rate Customer 2", type: "customer", local_rate: "91,000" } });
  assert.equal((app.db.prepare("SELECT local_rate FROM stakeholders WHERE id = ?").get(id) as any).local_rate, 91000);
  for (const clear of [null, ""]) {
    await app.api("PUT", `/api/stakeholders/${id}`, { tenantId, body: { name: "Rate Customer 2", type: "customer", local_rate: 95000 } });
    await app.api("PUT", `/api/stakeholders/${id}`, { tenantId, body: { name: "Rate Customer 2", type: "customer", local_rate: clear } });
    assert.equal((app.db.prepare("SELECT local_rate FROM stakeholders WHERE id = ?").get(id) as any).local_rate, null);
  }
});

test("effectiveLocalRate: party override, global fallback, null for USD-only", async () => {
  const { effectiveLocalRate } = await import("../server/localCurrency.js");
  const id = await mkParty("Eff Customer", "customer", { local_rate: 90000 });
  const plain = await mkParty("Eff Plain", "customer");
  assert.deepEqual({ ...effectiveLocalRate(tenantId, id) }, { code: "LBP", symbol: "LL", rate: 90000, source: "party" });
  assert.equal(effectiveLocalRate(tenantId, plain)!.source, "global");
  assert.equal(effectiveLocalRate(tenantId, plain)!.rate, GLOBAL);
  assert.equal(effectiveLocalRate(tenantId, null)!.rate, GLOBAL);
  const usdOnly = seedTenant(app.db, "USD Only PR", "usd-only-pr@example.com");
  assert.equal(effectiveLocalRate(usdOnly, null), null);
});

test("credit sale for a customer @90,000 paid in LL: payment uses the party rate, $10 paid, balance correct", async () => {
  const cust = await mkParty("Cust 90k", "customer", { local_rate: 90000 });
  // Total $25, paid 900,000 LL (= $10 at 90,000) -- the client wrongly sends the global rate.
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2.5 }], currency: "USD", exchange_rate: 1,
      payments: [{ amount: 900000, method: "cash", currency: "LBP", exchange_rate: GLOBAL }],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const pays = paymentsOf(sale.body.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].exchange_rate, 90000, "client-sent rate overridden by the party rate");
  assert.equal(pays[0].amount / pays[0].exchange_rate, 10);
  assert.equal(txOf(sale.body.id).local_rate, 90000, "tx.local_rate = the party's effective rate");
  assert.ok(Math.abs(balanceOf(cust) - -15) < 1e-6, `owes 25 - 10 = 15, got ${balanceOf(cust)}`);
});

test("walk-in sale paid in LL uses the global rate; USD payments and lowercase currency codes behave", async () => {
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale", stakeholder_id: walkInId(), items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
      payments: [
        { amount: 447500, method: "cash", currency: "lbp", exchange_rate: 12345 },
        { amount: 5, method: "cash", currency: "USD", exchange_rate: 1 },
      ],
    },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const pays = paymentsOf(sale.body.id);
  assert.equal(pays[0].exchange_rate, GLOBAL);
  assert.equal(pays[1].exchange_rate, 1, "USD payment untouched");
  assert.equal(txOf(sale.body.id).local_rate, GLOBAL);
  assert.equal(balanceOf(walkInId()), 0, "5 + 447500/89500 = 10 -> fully paid");
});

test("refund keeps the ORIGINAL sale's rate even after the party rate changed", async () => {
  const cust = await mkParty("Cust refund", "customer", { local_rate: 90000 });
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
      payments: [{ amount: 900000, method: "cash", currency: "LBP", exchange_rate: 1 }] },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(paymentsOf(sale.body.id)[0].exchange_rate, 90000);

  await app.api("PUT", `/api/stakeholders/${cust}`, { tenantId, body: { name: "Cust refund", type: "customer", local_rate: 95000 } });
  const refund = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "refund", original_transaction_id: sale.body.id, stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "LBP", exchange_rate: 90000,
      payments: [{ amount: 900000, method: "cash", currency: "LBP", exchange_rate: 90000 }] },
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(paymentsOf(refund.body.id)[0].exchange_rate, 90000, "not the newer 95,000");
  assert.equal(txOf(refund.body.id).exchange_rate, 90000);
  assert.ok(Math.abs(balanceOf(cust)) < 1e-6, `sale paid, refund paid back -> 0, got ${balanceOf(cust)}`);
});

test("balance payment uses the party rate for LL, the global rate for others, ignores the client's rate", async () => {
  const cust = await mkParty("Cust owes", "customer", { local_rate: 90000, balance: -20 });
  const r = await app.api("POST", "/api/balance-payment", {
    tenantId, body: { stakeholder_id: cust, amount: 900000, currency: "LBP", exchange_rate: GLOBAL, direction: "collect" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Math.abs(balanceOf(cust) - -10) < 1e-6, `owed 20, paid $10 -> -10, got ${balanceOf(cust)}`);
  const cf = app.db.prepare("SELECT * FROM cash_flow WHERE tenant_id = ? AND counterparty = 'Cust owes'").get(tenantId) as any;
  assert.equal(cf.exchange_rate, 90000);
  assert.equal(cf.amount, 900000);

  const sup = await mkParty("Supplier 90k", "supplier", { local_rate: 90000, balance: -30 });
  const r2 = await app.api("POST", "/api/balance-payment", {
    tenantId, body: { stakeholder_id: sup, amount: 900000, currency: "LBP", exchange_rate: 1, direction: "pay" },
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.ok(Math.abs(balanceOf(sup) - -20) < 1e-6, `got ${balanceOf(sup)}`);

  const plain = await mkParty("Cust global", "customer", { balance: -20 });
  await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: plain, amount: 895000, currency: "LBP", exchange_rate: 1, direction: "collect" } });
  assert.ok(Math.abs(balanceOf(plain) - -10) < 1e-6, "party without override uses the global rate");
  const usd = await mkParty("Cust usd", "customer", { local_rate: 90000, balance: -20 });
  await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: usd, amount: 5, currency: "USD", exchange_rate: 1, direction: "collect" } });
  assert.ok(Math.abs(balanceOf(usd) - -15) < 1e-6, "USD untouched");
});

test("settle-balance uses the party rate for an LL payment", async () => {
  const cust = await mkParty("Cust settle", "customer", { local_rate: 90000, balance: -20 });
  const r = await app.api("POST", "/api/stakeholders/settle-balance", {
    tenantId, body: { stakeholder_id: cust, amount: 900000, method: "cash", currency: "LBP", exchange_rate: GLOBAL },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pay = paymentsOf(r.body.id)[0];
  assert.equal(pay.exchange_rate, 90000);
  assert.equal(txOf(r.body.id).local_rate, 90000);
  assert.ok(Math.abs(balanceOf(cust) - -10) < 1e-6, `got ${balanceOf(cust)}`);
});

test("a purchase entered in the local currency uses the supplier's rate (line prices stay USD)", async () => {
  const sup = await mkParty("Supplier A", "supplier", { local_rate: 90000 });
  const purchase = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "purchase", stakeholder_id: sup, items: [{ id: productId, quantity: 10, price: 4 }], currency: "LBP", exchange_rate: GLOBAL,
      payments: [{ amount: 900000, method: "cash", currency: "LBP", exchange_rate: GLOBAL }] },
  });
  assert.equal(purchase.status, 200, JSON.stringify(purchase.body));
  const tx = txOf(purchase.body.id);
  assert.equal(tx.currency, "LBP");
  assert.equal(tx.exchange_rate, 90000);
  assert.equal(tx.local_rate, 90000);
  assert.equal(tx.total_amount, 40, "totals are USD: 10 x $4");
  assert.equal(paymentsOf(purchase.body.id)[0].exchange_rate, 90000);
  assert.ok(Math.abs(balanceOf(sup) - -30) < 1e-6, `owe 40 - 10 = 30, got ${balanceOf(sup)}`);

  // a USD purchase keeps its USD rate; a supplier without an override gets the global rate
  const usd = await app.api("POST", "/api/transactions", {
    tenantId, body: { type: "purchase", stakeholder_id: sup, items: [{ id: productId, quantity: 1, price: 4 }], currency: "USD", exchange_rate: 1, payments: [] },
  });
  assert.equal(txOf(usd.body.id).exchange_rate, 1);
  const supB = await mkParty("Supplier B", "supplier");
  const b = await app.api("POST", "/api/transactions", {
    tenantId, body: { type: "purchase", stakeholder_id: supB, items: [{ id: productId, quantity: 1, price: 4 }], currency: "LBP", exchange_rate: 1, payments: [] },
  });
  assert.equal(txOf(b.body.id).exchange_rate, GLOBAL);
});

test("invoice edit: a NEW LL payment uses the party's CURRENT rate; old payments and tx.local_rate keep theirs", async () => {
  const cust = await mkParty("Cust edit", "customer", { local_rate: 90000 });
  const sale = await app.api("POST", "/api/transactions", {
    tenantId,
    body: { type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
      payments: [{ amount: 450000, method: "cash", currency: "LBP", exchange_rate: 1 }] },
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const id = sale.body.id;
  const first = paymentsOf(id)[0];
  assert.equal(first.exchange_rate, 90000);

  await app.api("PUT", `/api/stakeholders/${cust}`, { tenantId, body: { name: "Cust edit", type: "customer", local_rate: 100000 } });
  const edit = await app.api("PUT", `/api/transactions/${id}`, {
    tenantId,
    body: {
      items: [{ product_id: productId, quantity: 1, unit_price: 10 }],
      payments: [{ id: first.id }, { amount: 500000, method: "cash", currency: "LBP", exchange_rate: GLOBAL }],
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const pays = paymentsOf(id);
  assert.equal(pays.length, 2);
  assert.equal(pays[0].exchange_rate, 90000, "existing payment keeps its rate");
  assert.equal(pays[1].exchange_rate, 100000, "new payment uses the party's current rate");
  assert.equal(txOf(id).local_rate, 90000, "stored local_rate never changes on edit");
  assert.ok(Math.abs(balanceOf(cust)) < 1e-6, `5 + 5 = 10 paid, got ${balanceOf(cust)}`);
});

test("importer accepts an optional per-party exchange rate", async () => {
  const r = await app.api("POST", "/api/import/customers", {
    tenantId, body: { rows: [{ name: "Imported Rate Co", local_rate: "90000" }, { name: "Imported Bad Rate", exchange_rate: "-3" }], dry_run: false },
  });
  // the bad row is rejected (whole import is 422, nothing written when any row errors is not required here)
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.errors[0].code, "INVALID_RATE");
  const ok = await app.api("POST", "/api/import/customers", { tenantId, body: { rows: [{ name: "Imported Rate Co 2", exchange_rate: "90000" }], dry_run: false } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = app.db.prepare("SELECT local_rate FROM stakeholders WHERE tenant_id = ? AND name = 'Imported Rate Co 2'").get(tenantId) as any;
  assert.equal(row?.local_rate, 90000);
});

// --- sync: adaptive optional cloud columns ---------------------------------------------------

function fakeCloud(opts: { hasStakeholderRate: boolean }) {
  const calls: Array<{ table: string; rows: any[] }> = [];
  const client: any = {
    from(table: string) {
      return {
        upsert: async (rows: any) => {
          const list = Array.isArray(rows) ? rows : [rows];
          calls.push({ table, rows: list.map((r) => ({ ...r })) });
          if (table === "stakeholders" && !opts.hasStakeholderRate && list.some((r) => "local_rate" in r)) {
            return { error: { code: "PGRST204", message: "Could not find the 'local_rate' column of 'stakeholders' in the schema cache" } };
          }
          return { error: null };
        },
      };
    },
  };
  return { client, calls };
}

test("sync: push includes optional columns; PGRST204 strips them and retries; flag + backfill after the cloud migrates", async () => {
  const t = seedTenant(app.db, "Sync Co", "sync-pr@example.com");
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', 89500, 0)").run(t);
  const mk = (name: string, rate: number | null) =>
    Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, local_rate) VALUES (?, ?, 'customer', ?)").run(t, name, rate).lastInsertRowid);
  const syncedId = mk("Synced w rate", 90000);
  const freshId = mk("Fresh no rate", null);
  const stk = (id: number) => app.db.prepare("SELECT last_synced_at, local_rate FROM stakeholders WHERE id = ?").get(id) as any;
  // only the two rows above are unsynced for this tenant's stakeholders (walk-in is too: mark it synced)
  app.db.prepare("UPDATE stakeholders SET last_synced_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND id NOT IN (?, ?)").run(t, syncedId, freshId);
  const flagRow = () => app.db.prepare("SELECT 1 FROM _migrations WHERE name = 'cloud_col_ok:stakeholders.local_rate'").get();
  sync.resetCloudColumnProbe();
  app.db.prepare("DELETE FROM _migrations WHERE name LIKE 'cloud_col_ok:%'").run();

  // 1. cloud WITHOUT the column
  const noCol = fakeCloud({ hasStakeholderRate: false });
  await sync.pushToCloud(noCol.client, t);
  const stkCalls = noCol.calls.filter((c) => c.table === "stakeholders");
  assert.equal(stkCalls.length, 2, "one rejected attempt + one immediate retry (no row-by-row fallback)");
  assert.ok("local_rate" in stkCalls[0].rows[0], "first attempt includes the optional column");
  assert.ok(!("local_rate" in stkCalls[1].rows[0]), "retry strips it");
  assert.ok(!("balance_baseline" in stkCalls[1].rows[0]));
  assert.notEqual(stk(syncedId).last_synced_at, null, "rows still sync without the column");
  assert.equal(flagRow(), undefined, "no flag while the cloud lacks the column");
  assert.equal(stk(syncedId).local_rate, 90000);

  // a later push in the same process keeps stripping, with no failed attempt
  app.db.prepare("UPDATE stakeholders SET name = name || '.', updated_at = datetime('now', '+1 minute') WHERE id = ?").run(freshId);
  const again = fakeCloud({ hasStakeholderRate: false });
  await sync.pushToCloud(again.client, t);
  const againStk = again.calls.filter((c) => c.table === "stakeholders");
  assert.equal(againStk.length, 1);
  assert.ok(!("local_rate" in againStk[0].rows[0]));

  // 2. cloud migrated (re-probe): batch includes the column and succeeds -> flag + backfill
  sync.resetCloudColumnProbe();
  app.db.prepare("UPDATE stakeholders SET last_synced_at = CURRENT_TIMESTAMP WHERE tenant_id = ?").run(t);
  app.db.prepare("UPDATE stakeholders SET updated_at = datetime('now', '+2 minute'), last_synced_at = NULL WHERE id = ?").run(freshId);
  const withCol = fakeCloud({ hasStakeholderRate: true });
  await sync.pushToCloud(withCol.client, t);
  const ok = withCol.calls.filter((c) => c.table === "stakeholders");
  assert.equal(ok.length, 1);
  assert.ok("local_rate" in ok[0].rows[0]);
  assert.ok(flagRow(), "flag persisted after the first accepted push");
  assert.equal(stk(syncedId).last_synced_at, null, "row holding a value is re-marked unsynced (backfill)");
  assert.notEqual(stk(freshId).last_synced_at, null, "row without a value just synced");

  // 3. the backfilled row is pushed with its rate on the next cycle, and the flag doesn't re-trigger
  const next = fakeCloud({ hasStakeholderRate: true });
  await sync.pushToCloud(next.client, t);
  const nextStk = next.calls.filter((c) => c.table === "stakeholders");
  assert.equal(nextStk.length, 1);
  assert.equal(nextStk[0].rows[0].local_rate, 90000);
  assert.notEqual(stk(syncedId).last_synced_at, null);
});

test("sync: Postgres 42703 is parsed as a missing column", () => {
  assert.equal(sync.parseMissingColumn({ code: "42703", message: 'column "local_rate" of relation "stakeholders" does not exist' }), "local_rate");
  assert.equal(sync.parseMissingColumn({ code: "PGRST204", message: "Could not find the 'local_currency' column of 'transactions' in the schema cache" }), "local_currency");
  assert.equal(sync.parseMissingColumn({ code: "23503", message: "fk" }), undefined);
  assert.deepEqual(sync.OPTIONAL_CLOUD_COLUMNS, { stakeholders: ["local_rate"], transactions: ["local_rate", "local_currency"] });
});

test("sync: pulling a stakeholder from a cloud WITHOUT local_rate never nulls the local value", async () => {
  const t = seedTenant(app.db, "Pull Co", "pull-pr@example.com");
  const tenantGlobal = (app.db.prepare("SELECT global_id FROM tenants WHERE id = ?").get(t) as any).global_id;
  const id = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type, local_rate) VALUES (?, 'Pulled', 'customer', 90000)").run(t).lastInsertRowid);
  const gid = (app.db.prepare("SELECT global_id FROM stakeholders WHERE id = ?").get(id) as any).global_id;
  app.db.prepare("UPDATE stakeholders SET last_synced_at = datetime('now', '+1 hour') WHERE id = ?").run(id); // clean: nothing pending a push, so the pull may apply
  const chain = (data: any[]) => {
    const q: any = { select: () => q, gt: () => q, eq: () => q, in: () => q, order: () => q, range: () => q, limit: () => q, gte: () => q, or: () => q, then: (res: any) => res({ data, error: null }) };
    return q;
  };
  const cloudRow = { id: "x", local_id: id, global_id: gid, tenant_id: tenantGlobal, name: "Renamed in cloud", type: "customer", balance: 0, price_level: "retail", updated_at: "2099-01-01T00:00:00Z" };
  const client: any = { from: (table: string) => chain(table === "stakeholders" ? [cloudRow] : []) };
  await sync.pullFromCloud(client, t, tenantGlobal);
  const row = app.db.prepare("SELECT name, local_rate FROM stakeholders WHERE id = ?").get(id) as any;
  assert.equal(row.name, "Renamed in cloud", "the pull applied");
  assert.equal(row.local_rate, 90000, "local_rate survives a pull from a cloud without the column");
});
