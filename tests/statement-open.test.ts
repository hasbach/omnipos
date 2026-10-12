// "Unpaid orders" statement: balance payments pay the OLDEST orders first, so what is still owed is
// always the newest debts. The printed total must equal the party's balance exactly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let stmt: typeof import("../server/statement.js");

before(async () => {
  app = await createTestApp();
  stmt = await import("../server/statement.js");
  tenantId = seedTenant(app.db, "Open Items Co", "open-items@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "OI-1", name: "Open Item", price: 25, stock: 500 });
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} != ${b}`);
const balanceOf = (id: number) => (app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(id) as any).balance as number;
const party = async (name: string, type = "customer", balance?: number) =>
  (await app.api("POST", "/api/stakeholders", { tenantId, body: { name, type, ...(balance !== undefined ? { balance } : {}) } })).body.id as number;
const post = async (body: any) => {
  const r = await app.api("POST", "/api/transactions", { tenantId, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
const sale = (cust: number, quantity: number, payments: any[] = []) =>
  post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity }], currency: "USD", exchange_rate: 1, payments });
const collect = async (id: number, amount: number, direction = "collect") => {
  const r = await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: id, amount, currency: "USD", exchange_rate: 1, direction } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const totalsMatch = (o: any, id: number) => {
  const sum = o.previous_balance + o.orders.reduce((s: number, x: any) => s + x.remaining, 0);
  near(sum, -balanceOf(id), "previous + remaining == amount owed");
  near(o.total_due, -balanceOf(id), "total_due == amount owed");
};

test("a balance payment pays the oldest orders first; the crossing order is partial", async () => {
  const c = await party("FIFO Customer");
  await sale(c, 1);            // 25 — fully covered by the collection
  const s2 = await sale(c, 1); // 25 — 5 covered
  const s3 = await sale(c, 1); // 25 — untouched
  await collect(c, 30);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.deepEqual(o.orders.map((x) => x.id), [s2, s3], "oldest first, fully paid order omitted");
  assert.equal(o.orders[0].status, "partial"); near(o.orders[0].paid, 5); near(o.orders[0].remaining, 20);
  assert.equal(o.orders[1].status, "unpaid"); near(o.orders[1].remaining, 25);
  assert.equal(o.orders[1].items[0].name, "Open Item");
  near(o.previous_balance, 0);
});

test("money paid at the time of sale shows as paid on that order", async () => {
  const c = await party("Paid At Sale");
  const s = await sale(c, 2, [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }]);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.equal(o.orders.length, 1);
  assert.equal(o.orders[0].id, s);
  near(o.orders[0].total, 50); near(o.orders[0].paid, 20); near(o.orders[0].remaining, 30);
  assert.equal(o.orders[0].status, "partial");
  assert.equal(o.orders[0].reference.length > 0, true);
});

test("an opening debt is the previous balance", async () => {
  const c = await party("Opening Debt", "customer", -20);
  await sale(c, 1);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  near(o.previous_balance, 20);
  assert.equal(o.orders.length, 1);
});

test("an opening debt older than the orders is paid first by a collection", async () => {
  const c = await party("Opening Paid First", "customer", -20);
  await sale(c, 1);
  await collect(c, 20);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  near(o.previous_balance, 0);
  near(o.orders[0].remaining, 25);
});

test("overpayment: no unpaid orders, credit shown", async () => {
  const c = await party("Overpaid");
  await sale(c, 1);
  await collect(c, 40);
  const o = stmt.buildOpenStatement(tenantId, c)!;
  assert.equal(o.orders.length, 0);
  near(o.total_due, 0);
  near(o.credit, 15);
});

test("a refund reduces what is owed (newest orders stay)", async () => {
  const c = await party("Refunder");
  const s1 = await sale(c, 1);
  const s2 = await sale(c, 1);
  await post({ type: "refund", original_transaction_id: s1, stakeholder_id: c, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] });
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.deepEqual(o.orders.map((x) => x.id), [s2]);
});

test("a refund nets against the order it reverses, not the oldest", async () => {
  const c = await party("Refund Nets Original");
  const s1 = await sale(c, 1);
  const s2 = await sale(c, 1);
  await post({ type: "refund", original_transaction_id: s2, stakeholder_id: c, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] });
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.deepEqual(o.orders.map((x) => x.id), [s1]);
});

test("a partial refund leaves the rest of the reversed order owed", async () => {
  const c = await party("Partial Refund Nets");
  const s1 = await sale(c, 1);
  const s2 = await sale(c, 2); // 50
  await post({ type: "refund", original_transaction_id: s2, stakeholder_id: c, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] }); // 25 back
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.deepEqual(o.orders.map((x) => x.id), [s1, s2]);
  near(o.orders[0].remaining, 25);
  near(o.orders[1].remaining, 25);
});

test("supplier: purchases, partial payment, total equals what we owe", async () => {
  const s = await party("Open Supplier", "supplier");
  const p1 = await post({ type: "purchase", stakeholder_id: s, items: [{ id: productId, quantity: 4, price: 25 }], currency: "USD", exchange_rate: 1, payments: [] }); // 100
  const p2 = await post({ type: "purchase", stakeholder_id: s, items: [{ id: productId, quantity: 2, price: 20 }], currency: "USD", exchange_rate: 1, payments: [] }); // 40
  await collect(s, 70, "pay");
  const o = stmt.buildOpenStatement(tenantId, s)!;
  totalsMatch(o, s);
  assert.deepEqual(o.orders.map((x) => [x.id, x.type, x.status]), [[p1, "purchase", "partial"], [p2, "purchase", "unpaid"]]);
  near(o.orders[0].remaining, 30);
});

test("settled (archived) orders still appear while unpaid", async () => {
  const c = await party("Archived Debtor");
  const s = await sale(c, 2, [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }]); // 30 owed
  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  const o = stmt.buildOpenStatement(tenantId, c)!;
  totalsMatch(o, c);
  assert.equal(o.orders[0].id, s);
  near(o.orders[0].remaining, 30);
  assert.equal(o.orders[0].items.length, 1, "archived items loaded");
});

test("unknown party returns null", () => {
  assert.equal(stmt.buildOpenStatement(tenantId, 999999), null);
});
