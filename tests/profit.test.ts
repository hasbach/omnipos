import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProfit, profitCalendar, type ProfitLine, type ProfitOutflow } from "../server/reports/profit.js";

const calendar = profitCalendar(new Date(2026, 10, 15));

function line(transaction_id: number, overrides: Partial<ProfitLine> = {}): ProfitLine {
  return {
    transaction_id, type: "sale", day: "2026-11-03", status: "completed", deleted_at: null, owner: 0,
    quantity: 2, unit_price: 50, unit_cost: 25, product_cost: 90, discount_type: null,
    discount_value: null, tx_discount_type: null, tx_discount_value: null, ...overrides,
  };
}

function outflow(category: string | null, amount: number, overrides: Partial<ProfitOutflow> = {}): ProfitOutflow {
  return { day: "2026-11-03", category, amount, exchange_rate: 1, reason: null, ...overrides };
}

test("real profit uses recorded cost, discounted revenue, returns, and the full margin on an uncosted service", () => {
  const report = computeProfit(calendar, [
    line(1, { discount_type: "fixed", discount_value: 10, tx_discount_type: "percentage", tx_discount_value: 20 }),
    line(1, { quantity: 1, unit_price: 10, unit_cost: 0 }),
    line(2, { quantity: 1, unit_price: 20, unit_cost: null }),
    line(3, { type: "refund", quantity: 1, unit_price: 10, unit_cost: 5 }),
    line(4, { status: "voided" }),
    line(5, { deleted_at: "2026-11-03 12:00:00" }),
  ], [], [], []);

  assert.equal(report.currentMonth.revenue, 90);
  assert.equal(report.currentMonth.cogs, 45);
  assert.equal(report.currentMonth.grossMargin, 45);
  assert.equal(report.currentMonth.marginPct, 50);
  assert.equal(report.currentMonth.netProfit, 45);
  assert.equal(report.daily.find((day) => day.date === "2026-11-03")?.netProfit, 45);
  assert.equal(report.daily.find((day) => day.date === "2026-11-04")?.revenue, 0);
});

test("expenses are grouped in USD and exclude owner draws, supplier payments and transfers", () => {
  const report = computeProfit(calendar, [line(1), line(2, { owner: 1 })], [
    outflow("expense", 10),
    outflow("expense", 890_000, { exchange_rate: 89_000 }),
    outflow("custom_rent", 5),
    outflow("supplier_payment", 30),
    outflow(null, 30, { reason: "Payment to supplier A" }),
    outflow("owner_withdrawal", 15),
    outflow("transfer", 40),
  ], [{ day: "2026-11-03", amount: 6 }], []);

  assert.equal(report.currentMonth.revenue, 100);
  assert.equal(report.currentMonth.ownerDraws, 71);
  assert.deepEqual(report.currentMonth.expenseCategories, [
    { category: "expense", amount: 20 },
    { category: "custom_rent", amount: 5 },
  ]);
  assert.equal(report.currentMonth.expenses, 25);
  assert.equal(report.currentMonth.netProfit, 25);
});

test("break-even uses fixed obligations first, then prior-month expenses and the current month's day count", () => {
  const sales = [line(1), line(2, { day: "2026-10-31" })];
  const costs = [outflow("expense", 600, { day: "2026-10-31" }), outflow("expense", 9)];
  const fixed = computeProfit(calendar, sales, costs, [], [
    { amount_usd: 150, frequency: "monthly" },
    { amount_usd: 84, frequency: "yearly" },
    { amount_usd: 7, frequency: "weekly" },
    { amount_usd: 1, frequency: "daily" },
  ]);
  assert.equal(fixed.dailySalesTarget, (150 + 7 + 30 + 30) / 0.5 / 30);
  assert.equal(fixed.previousMonth.netProfit, -550);
  assert.equal(fixed.currentMonth.netProfit, 41);
  assert.equal(computeProfit(calendar, sales, costs, [], []).dailySalesTarget, 40);
  assert.equal(computeProfit(calendar, [], costs, [], []).dailySalesTarget, null);
});

test("the report calendar includes the full previous month and current days through today", () => {
  const leapFebruary = profitCalendar(new Date(2024, 1, 1));
  assert.equal(leapFebruary.daysInCurrentMonth, 29);
  assert.equal(leapFebruary.days[0], "2024-01-01");
  assert.equal(leapFebruary.days.length, 32);
  assert.equal(leapFebruary.days[31], "2024-02-01");
  assert.equal(profitCalendar(new Date(2026, 0, 1)).previousMonth, "2025-12");
});

test("the profit endpoint excludes voided and soft-deleted rows and keeps totals after settlement", async () => {
  const { createTestApp, seedProduct, seedTenant } = await import("./helpers/testApp.js");
  const app = await createTestApp();
  try {
    const tenantId = seedTenant(app.db, "Profit Co", "profit@example.com");
    const otherTenantId = seedTenant(app.db, "Other Co", "other-profit@example.com");
    const productId = seedProduct(app.db, tenantId, { barcode: "PROFIT-1", name: "Widget", price: 25 });
    const insertSale = app.db.prepare(`
      INSERT INTO transactions (tenant_id, type, total_amount, currency, exchange_rate, status, deleted_at)
      VALUES (?, 'sale', 50, 'USD', 1, ?, ?)
    `);
    const insertItem = app.db.prepare(`
      INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, unit_cost)
      VALUES (?, ?, 2, 25, 10)
    `);
    for (const [status, deletedAt] of [["completed", null], ["voided", null], ["completed", "2026-01-01"]]) {
      insertItem.run(insertSale.run(tenantId, status, deletedAt).lastInsertRowid, productId);
    }
    const insertCash = app.db.prepare(`
      INSERT INTO cash_flow (tenant_id, type, amount, category, deleted_at)
      VALUES (?, 'out', ?, 'expense', ?)
    `);
    insertCash.run(tenantId, 5, null);
    insertCash.run(tenantId, 100, "2026-01-01");
    insertCash.run(otherTenantId, 100, null);

    const before = await app.api("GET", "/api/reports/profit", { tenantId });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.currentMonth.revenue, 50);
    assert.equal(before.body.currentMonth.cogs, 20);
    assert.equal(before.body.currentMonth.expenses, 5);
    assert.equal(before.body.currentMonth.netProfit, 25);

    // Settlement archives rows without their deleted_at marker today (tracked separately), so only
    // live rows go through it here: drop the soft-deleted fixtures first.
    app.db.prepare("DELETE FROM transaction_items WHERE transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ? AND deleted_at IS NOT NULL)").run(tenantId);
    app.db.prepare("DELETE FROM transactions WHERE tenant_id = ? AND deleted_at IS NOT NULL").run(tenantId);
    app.db.prepare("DELETE FROM cash_flow WHERE tenant_id = ? AND deleted_at IS NOT NULL").run(tenantId);
    const settlement = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
    assert.equal(settlement.status, 200, JSON.stringify(settlement.body));
    const after = await app.api("GET", "/api/reports/profit", { tenantId });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual(after.body.currentMonth, before.body.currentMonth);
  } finally {
    await app.close();
  }
});
