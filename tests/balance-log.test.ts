// stakeholder_balance_log (additive changelog) + the customer statement's payment-currency fix.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Balance Log Co", "balance-log-co@example.com");
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

test("balance log records sale, LBP partial payment and balance collection as a consistent chain", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BL-1", name: "Log Item", price: 25, stock: 50 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Log Customer", type: "customer" } })).body.id;

  // $50 sale entirely on credit
  const s1 = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [],
  } });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));

  // $25 sale paid 895,000 LBP at 89,500 = $10 -> $15 owed on it
  const s2 = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 895000, method: "cash", currency: "LBP", exchange_rate: 89500 }],
  } });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));

  // collect $5 against the balance
  const col = await app.api("POST", "/api/balance-payment", { tenantId, body: {
    stakeholder_id: cust, amount: 5, currency: "USD", exchange_rate: 1, direction: "collect",
  } });
  assert.equal(col.status, 200, JSON.stringify(col.body));

  const log = (await app.api("GET", `/api/stakeholders/${cust}/balance-log`, { tenantId })).body as any[];
  assert.equal(log.length, 3, JSON.stringify(log));
  const asc = [...log].reverse();
  assert.deepEqual(asc.map((r) => r.source), ["sale", "sale", "balance_collection"]);
  assert.equal(asc[0].reference_id, s1.body.id);
  near(asc[0].delta, -50, "first sale");
  near(asc[1].delta, -15, "second sale net of LBP payment");
  near(asc[2].delta, 5, "collection");
  near(asc[0].balance_before, 0);
  for (let i = 1; i < asc.length; i++) near(asc[i].balance_before, asc[i - 1].balance_after, `chain ${i}`);
  near(asc[2].balance_after, -60, "final balance");
  const st = app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(cust) as any;
  near(st.balance, asc[2].balance_after, "log matches stakeholder balance");

  // Statement: the LBP payment is credited in USD and carries its original amount/currency.
  const stmt = (await app.api("GET", `/api/reports/customer-statement/${cust}`, { tenantId })).body as any[];
  const pay = stmt.find((r) => r.type === "payment");
  assert.ok(pay, "payment row present");
  near(pay.credit, 10, "credit is USD (amount / exchange_rate)");
  assert.equal(pay.currency, "LBP");
  near(pay.amount_original, 895000);
  near(pay.exchange_rate, 89500);
});
