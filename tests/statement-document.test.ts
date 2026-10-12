// Statement document (JSON) + HTML rendering: localized labels, Arabic RTL, totals, validation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productId: number;
let cust: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Doc Co", "doc-co@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "DC-1", name: "مياه", price: 25, stock: 500 });
  cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "محمد الحسن", type: "customer", address: "بيروت – الحمرا" } })).body.id;
  const r = await app.api("POST", "/api/transactions", { tenantId, body: { type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
after(async () => { await app.close(); });

const setLanguage = (lang: string) => {
  app.db.prepare("DELETE FROM settings WHERE tenant_id = ? AND key = 'language'").run(tenantId);
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'language', ?)").run(tenantId, lang);
};

test("JSON document: open mode with party, labels and totals", async () => {
  setLanguage("en");
  const r = await app.api("GET", `/api/reports/statement/${cust}?mode=open`, { tenantId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const doc = r.body;
  assert.equal(doc.mode, "open");
  assert.equal(doc.party.name, "محمد الحسن");
  assert.equal(doc.party.address, "بيروت – الحمرا");
  assert.equal(doc.business.language, "en");
  assert.equal(doc.labels.totalDue, "Total due");
  assert.equal(doc.open.orders.length, 1);
  assert.ok(Math.abs(doc.open.total_due - 40) < 0.005);
});

test("JSON document: activity mode needs a valid range", async () => {
  const bad = await app.api("GET", `/api/reports/statement/${cust}?mode=activity&from=2026-02-01`, { tenantId });
  assert.equal(bad.status, 400);
  const ok = await app.api("GET", `/api/reports/statement/${cust}?mode=activity&from=2000-01-01&to=2100-01-01`, { tenantId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const pay = ok.body.activity.rows.find((x: any) => x.type === "payment");
  assert.equal(pay.label, "Payment (Cash)");
});

test("unknown party is 404", async () => {
  const r = await app.api("GET", `/api/reports/statement/999999?mode=open`, { tenantId });
  assert.equal(r.status, 404);
});

test("HTML: Arabic store renders RTL with Arabic labels and the party name", async () => {
  setLanguage("ar");
  const r = await app.api("GET", `/api/reports/statement/${cust}/html?mode=open&format=a4`, { tenantId });
  assert.equal(r.status, 200);
  const html = String(r.body);
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes("محمد الحسن"));
  assert.ok(html.includes("مياه"));
  assert.ok(html.includes("المبلغ المستحق"));
  assert.ok(html.includes("$40.00"));
  setLanguage("en");
});

test("HTML: receipt format and escaping", async () => {
  const name = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "<b>X</b>", type: "customer" } })).body.id;
  const r = await app.api("GET", `/api/reports/statement/${name}/html?mode=open&format=receipt`, { tenantId });
  const html = String(r.body);
  assert.ok(html.includes('class="receipt"'));
  assert.ok(html.includes("&lt;b&gt;X&lt;/b&gt;"));
  assert.ok(!html.includes("<b>X</b>"));
});

test("HTML: activity A4 keeps product line totals in the description cell, not under Debit/Credit", async () => {
  setLanguage("en");
  const r = await app.api("GET", `/api/reports/statement/${cust}/html?mode=activity&from=2000-01-01&to=2100-01-01`, { tenantId });
  assert.equal(r.status, 200);
  const html = String(r.body);
  const row = html.match(/<tr class="items">([\s\S]*?)<\/tr>/);
  assert.ok(row, "an item row is rendered");
  const cells = [...row![1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].trim());
  assert.equal(cells.length, 6, "one cell per column");
  const filled = cells.filter((c) => c !== "");
  assert.equal(filled.length, 1, "exactly one non-empty cell");
  assert.equal(cells.indexOf(filled[0]), 2, "the description column");
  assert.ok(filled[0].includes("مياه") && filled[0].includes("50.00"), filled[0]);
});
