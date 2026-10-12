// Statement building blocks + "Account activity" mode (From–To ledger with local-midnight days).
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
  tenantId = seedTenant(app.db, "Activity Co", "activity-co@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "AC-1", name: "Act Item", price: 25, stock: 500 });
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 0.005, `${msg}: ${a} != ${b}`);
const post = async (body: any) => {
  const r = await app.api("POST", "/api/transactions", { tenantId, body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
};
// A local wall-clock moment as the UTC stamp SQLite stores (works in any test-machine time zone).
const utcStamp = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
const backdate = (txId: number, d: Date) => {
  app.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run(utcStamp(d), txId);
  app.db.prepare("UPDATE payments SET created_at = ? WHERE transaction_id = ?").run(utcStamp(d), txId);
};

test("ledger rows carry tx_id / archived / method and items load with units", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Rows Customer", type: "customer" } })).body.id;
  const s1 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] });
  const rows = stmt.buildStatement(tenantId, cust);
  const inv = rows.find((r: any) => r.type === "sale");
  assert.equal(inv.tx_id, s1);
  assert.equal(inv.archived, 0);
  const pay = rows.find((r: any) => r.type === "payment");
  assert.equal(pay.tx_id, s1);
  assert.equal(pay.method, "cash");

  const items = stmt.loadStatementItems(s1, false);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Act Item");
  assert.equal(items[0].unit, null);
  near(items[0].qty, 2); near(items[0].unit_price, 25); near(items[0].line_total, 50);
});

test("local date helpers convert stored UTC stamps to local days", () => {
  const d = new Date(2026, 0, 15, 0, 30); // 15 Jan 2026 00:30 local
  assert.equal(stmt.localDateOf(utcStamp(d)), "2026-01-15");
  assert.equal(stmt.localDateOf(d.toISOString()), "2026-01-15");
  assert.equal(stmt.localStampLabel(utcStamp(d)), "15/01/2026 00:30");
});

test("activity: opening before From, rows inside the local-day range, closing at To", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Range Customer", type: "customer" } })).body.id;
  const before1 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] }); // -25
  const inRange = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] }); // -50 +10
  const after1 = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] }); // -25
  backdate(before1, new Date(2026, 0, 14, 23, 50)); // 14 Jan, 23:50 local — before From
  backdate(inRange, new Date(2026, 0, 15, 0, 30));  // 15 Jan, 00:30 local — first minutes of From
  backdate(after1, new Date(2026, 0, 16, 0, 30));   // 16 Jan, 00:30 local — after To

  const a = stmt.buildActivityStatement(tenantId, cust, "2026-01-15", "2026-01-15");
  near(a.opening, -25, "opening");
  assert.deepEqual(a.rows.map((r) => r.type), ["sale", "payment"]);
  assert.equal(a.rows[0].tx_id, inRange);
  assert.equal(a.rows[0].items?.length, 1);
  near(a.rows[0].items![0].qty, 2);
  assert.equal(a.rows[1].method, "cash");
  near(a.closing, -65, "closing");
  near(a.opening + a.rows.reduce((s, r) => s + r.effect, 0), a.closing, "opening + movements == closing");
  near(a.total_debit, 50); near(a.total_credit, 10);
});

test("activity: an empty range keeps opening == closing", async () => {
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Quiet Customer", type: "customer" } })).body.id;
  const s = await post({ type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] });
  backdate(s, new Date(2026, 0, 10, 12, 0));
  const a = stmt.buildActivityStatement(tenantId, cust, "2026-02-01", "2026-02-28");
  assert.equal(a.rows.filter((r) => r.type === "sale").length, 0);
  near(a.opening, -25); near(a.closing, -25);
});
