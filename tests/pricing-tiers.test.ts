// Pure unit tests for server/pricing.ts — price-tier resolution and the totals math that
// POST/PUT /api/transactions both delegate to. No DB, no test app needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLevel, tierUnitPrice, saleLineUnitPrice, lineTotal, computeTotals } from "../server/pricing.js";

test("normalizeLevel falls back to retail for anything unrecognized", () => {
  assert.equal(normalizeLevel("wholesale"), "wholesale");
  assert.equal(normalizeLevel("super_wholesale"), "super_wholesale");
  assert.equal(normalizeLevel("retail"), "retail");
  assert.equal(normalizeLevel(undefined), "retail");
  assert.equal(normalizeLevel(null), "retail");
  assert.equal(normalizeLevel("bogus"), "retail");
});

test("tierUnitPrice: super_wholesale falls back to wholesale, then retail", () => {
  const full = { price: 10, price_wholesale: 8, price_super_wholesale: 6 };
  assert.equal(tierUnitPrice(full, "super_wholesale"), 6);
  assert.equal(tierUnitPrice(full, "wholesale"), 8);
  assert.equal(tierUnitPrice(full, "retail"), 10);

  const noSuper = { price: 10, price_wholesale: 8, price_super_wholesale: null };
  assert.equal(tierUnitPrice(noSuper, "super_wholesale"), 8, "super_wholesale falls back to wholesale when unset");

  const bare = { price: 10, price_wholesale: 0, price_super_wholesale: 0 };
  assert.equal(tierUnitPrice(bare, "super_wholesale"), 10, "0 means not configured, falls all the way to retail");
  assert.equal(tierUnitPrice(bare, "wholesale"), 10);
});

test("saleLineUnitPrice: a real tier price is flat, ignoring package breaks", () => {
  const product = { price: 10, price_wholesale: 8, package_price: 45, units_per_package: 6 };
  assert.equal(saleLineUnitPrice(product, "wholesale", 12), 8, "tier price should be flat per unit, not package-blended");
});

test("saleLineUnitPrice: retail falls through to package-price blending", () => {
  // 6 units per package at $45/package, retail unit price $10; buying 8 -> 1 package + 2 singles
  const product = { price: 10, package_price: 45, units_per_package: 6 };
  const unit = saleLineUnitPrice(product, "retail", 8);
  const expectedTotal = 45 + 2 * 10; // one package + 2 remainder units
  assert.equal(unit * 8, expectedTotal);
});

test("saleLineUnitPrice: no package price falls straight to retail price", () => {
  const product = { price: 10 };
  assert.equal(saleLineUnitPrice(product, "retail", 3), 10);
});

test("saleLineUnitPrice: wholesale requested but not configured -> retail package logic applies", () => {
  const product = { price: 10, package_price: 45, units_per_package: 6 };
  const unit = saleLineUnitPrice(product, "wholesale", 6);
  assert.equal(unit, 45 / 6, "should blend via package price since no real wholesale tier is set");
});

test("lineTotal: percentage and fixed per-line discounts", () => {
  assert.equal(lineTotal(10, 3, { type: "percentage", value: 20 }), 24);
  assert.equal(lineTotal(10, 2, { type: "fixed", value: 5 }), 15);
  assert.equal(lineTotal(10, 2, { type: "fixed", value: 100 }), 0, "fixed discount floors at 0");
  assert.equal(lineTotal(10, 2, null), 20);
});

test("computeTotals: global discount clamped to subtotal, then tax, floored at 0", () => {
  // subtotal 100, 30% off -> 70, then 10% tax -> 77
  assert.equal(computeTotals([100], { type: "percentage", value: 30 }, { type: "percentage", value: 10 }), 77);

  // fixed discount bigger than subtotal clamps to exactly 0 before tax
  assert.equal(computeTotals([20], { type: "fixed", value: 999 }, null), 0);

  // fixed tax simply adds on top
  assert.equal(computeTotals([50], null, { type: "fixed", value: 5 }), 55);

  // no adjustments -> sum of line totals
  assert.equal(computeTotals([10, 20, 30]), 60);
});

test("a POS checkout that omits `type` is still priced as a sale (tier price, cost snapshot)", async () => {
  const { createTestApp, seedTenant } = await import("./helpers/testApp.js");
  const app = await createTestApp();
  try {
    const tenantId = seedTenant(app.db, "POS No Type Co", "pos-no-type@example.com");
    const productId = Number(app.db.prepare(
      "INSERT INTO products (tenant_id, barcode, name, price, price_super_wholesale, cost, stock, category) VALUES (?, 'NT-1', 'Milk', 1.5, 1.23, 1.05, 50, 'Dairy')"
    ).run(tenantId).lastInsertRowid);
    const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Big Buyer", type: "customer", price_level: "super_wholesale" } })).body.id;
    // Exactly the POS payload shape: no `type`, client item.price = retail.
    const res = await app.api("POST", "/api/transactions", { tenantId, body: {
      stakeholder_id: cust, items: [{ id: productId, quantity: 2, price: 1.5 }], total_amount: 2.46, currency: "USD", exchange_rate: 1,
      price_level: "super_wholesale", payments: [{ amount: 2.46, method: "cash", currency: "USD", exchange_rate: 1 }] } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const tx = app.db.prepare("SELECT type, total_amount FROM transactions WHERE id = ?").get(res.body.id) as any;
    assert.equal(tx.type, "sale");
    assert.ok(Math.abs(tx.total_amount - 2.46) < 1e-9, `total ${tx.total_amount}`);
    const line = app.db.prepare("SELECT unit_price, unit_cost FROM transaction_items WHERE transaction_id = ?").get(res.body.id) as any;
    assert.equal(line.unit_price, 1.23);
    assert.equal(line.unit_cost, 1.05);
    const bal = app.db.prepare("SELECT balance FROM stakeholders WHERE id = ?").get(cust) as any;
    assert.ok(Math.abs(bal.balance) < 1e-9, "fully paid — no phantom debt");
  } finally {
    await app.close();
  }
});
