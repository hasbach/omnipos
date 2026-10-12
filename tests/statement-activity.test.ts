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
