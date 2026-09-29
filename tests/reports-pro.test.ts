// Regression/coverage tests for the professional reporting API (server/reports.ts) added in the
// 1.2.0 upgrade (see docs/plans/2026-09-28-pro-upgrade.md). Exercises: line-discount + global
// discount allocation reconciling across summary/by-product/by-category, COGS from a unit_cost
// snapshot (not the product's current cost), archived-vs-live union after a settlement, foreign
// currency payments, credit sales/receivables/payables, purchases, cash flow, aging buckets and
// trend gap-filling.
//
// POST /api/transactions does not yet snapshot transaction_items.unit_cost itself (that's a
// concurrent change per the plan) — these tests set it directly via the db handle after each sale/
// refund so COGS math is deterministic regardless of later cost changes on the product row.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let productA: number; // price 10, cost snapshot 4, category Drinks
let productB: number; // price 20, cost snapshot 8, category Snacks
let productC: number; // low-stock / slow-mover product, price 5, cost 2, stock 3, reorder_point 10
let walkInId: number;
let customerX: number; // credit sale, current-bucket receivable
let customerZ: number; // backdated 45-day-old credit sale, d31_60-bucket receivable
let supplierY: number;

let sale1Id: number; // archived after settlement: A x5, 10% line discount, 5% global discount, cash USD
let sale2Id: number; // archived after settlement: B x2, no discount, cash paid in LBP
let sale3Id: number; // live: A x3 to customerX, credit (unpaid)
let refundId: number; // live: refund of 2 units of A from (now-archived) sale1
let purchaseId: number; // live: A x20 @ $6 from supplierY, partially paid

function isoNow(): string {
  return new Date().toISOString().replace("T", " ").split(".")[0];
}

function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
}

function localDaysAgo(n: number): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000 - n * 86400000).toISOString().split("T")[0];
}

const today = localToday();

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Reports Pro Co", "reports-pro@example.com");

  productA = Number(app.db.prepare(
    "INSERT INTO products (tenant_id, barcode, name, price, cost, stock, category, track_inventory, reorder_point) VALUES (?, 'PA-1', 'Cola 330ml', 10, 4, 100, 'Drinks', 1, 5)"
  ).run(tenantId).lastInsertRowid);
  productB = Number(app.db.prepare(
    "INSERT INTO products (tenant_id, barcode, name, price, cost, stock, category, track_inventory, reorder_point) VALUES (?, 'PB-1', 'Chips Bag', 20, 8, 50, 'Snacks', 1, 0)"
  ).run(tenantId).lastInsertRowid);
  productC = Number(app.db.prepare(
    "INSERT INTO products (tenant_id, barcode, name, price, cost, stock, category, track_inventory, reorder_point) VALUES (?, 'PC-1', 'Slow Widget', 5, 2, 3, 'Misc', 1, 10)"
  ).run(tenantId).lastInsertRowid);

  walkInId = Number((app.db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'").get(tenantId) as any).id);
  customerX = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Customer X', 'customer')").run(tenantId).lastInsertRowid);
  customerZ = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Customer Z', 'customer')").run(tenantId).lastInsertRowid);
  supplierY = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Supplier Y', 'supplier')").run(tenantId).lastInsertRowid);

  // --- Sale 1: A x5, 10% line discount, 5% global discount, paid in full (cash USD). ---
  // list 10*5=50 -> line disc 10% -> 45 -> global disc 5% of 45 = 2.25 -> total 42.75
  const s1 = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productA, quantity: 5, discount: { type: "percentage", value: 10 } }],
      discount: { type: "percentage", value: 5 },
      currency: "USD", exchange_rate: 1,
      payments: [{ amount: 42.75, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  sale1Id = s1.body.id;
  app.db.prepare("UPDATE transaction_items SET unit_cost = 4 WHERE transaction_id = ?").run(sale1Id);

  // --- Sale 2: B x2, no discount, paid in LBP (exchange_rate 90000) -> $40 collected. ---
  const s2 = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale",
      items: [{ id: productB, quantity: 2 }],
      currency: "USD", exchange_rate: 1,
      payments: [{ amount: 3600000, method: "cash", currency: "LBP", exchange_rate: 90000 }],
    },
  });
  assert.equal(s2.status, 200, JSON.stringify(s2.body));
  sale2Id = s2.body.id;
  app.db.prepare("UPDATE transaction_items SET unit_cost = 8 WHERE transaction_id = ?").run(sale2Id);

  // Settle: archives sale1 + sale2 (and their items/payments) into the archived_* tables.
  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));

  // --- Sale 3: A x3 to Customer X, on credit (unpaid) -> receivable of $30. ---
  const s3 = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customerX,
      type: "sale",
      items: [{ id: productA, quantity: 3 }],
      currency: "USD", exchange_rate: 1,
      payments: [{ amount: 30, method: "credit", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(s3.status, 200, JSON.stringify(s3.body));
  sale3Id = s3.body.id;
  app.db.prepare("UPDATE transaction_items SET unit_cost = 4 WHERE transaction_id = ?").run(sale3Id);

  // --- Refund: 2 units of A from the now-archived sale1 (10% line discount carries over). ---
  // 10*2=20 -> 10% line disc -> 18 -> sale1 also had a 5% invoice discount -> the refund pays back 17.10
  const r1 = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "refund",
      original_transaction_id: sale1Id,
      items: [{ id: productA, quantity: 2 }],
      currency: "USD", exchange_rate: 1,
      payments: [{ amount: 17.1, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  refundId = r1.body.id;
  app.db.prepare("UPDATE transaction_items SET unit_cost = 4 WHERE transaction_id = ?").run(refundId);

  // --- Purchase: A x20 @ $6 from Supplier Y, $100 paid of $120 -> payable of $20. ---
  const p1 = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: supplierY,
      type: "purchase",
      items: [{ id: productA, quantity: 20, price: 6 }],
      currency: "USD", exchange_rate: 1,
      payments: [{ amount: 100, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  purchaseId = p1.body.id;

  // A debt-payment ticket: type='sale', total_amount 0, no line items — must be excluded from
  // sale_count/avg_ticket, per the plan, but still counted as a transaction.
  app.db.prepare(
    "INSERT INTO transactions (tenant_id, stakeholder_id, user_id, type, total_amount, currency, exchange_rate, status, created_at) VALUES (?, ?, NULL, 'sale', 0, 'USD', 1, 'completed', ?)"
  ).run(tenantId, walkInId, isoNow());

  // Customer Z: a 45-day-old unpaid credit sale (A x1, no discount) for the aging report's
  // 31-60-day bucket. Backdated after creation so balance math (unaffected by created_at) still
  // ran against "now" at insert time.
  const sz = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      stakeholder_id: customerZ,
      type: "sale",
      items: [{ id: productA, quantity: 1 }],
      currency: "USD", exchange_rate: 1,
      payments: [{ amount: 10, method: "credit", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(sz.status, 200, JSON.stringify(sz.body));
  const backdated = new Date(Date.now() - 45 * 86400000).toISOString().replace("T", " ").split(".")[0];
  app.db.prepare("UPDATE transactions SET created_at = ? WHERE id = ?").run(backdated, sz.body.id);

  // Manual cash register movements: $50 in, $30 out (rent), $40 out (a supplier payment — must be
  // excluded from profit-and-loss expenses, since supplier payments are not expenses).
  await app.api("POST", "/api/cash-flow", { tenantId, body: { type: "in", amount: 50, currency: "USD", exchange_rate: 1, reason: "Owner deposit" } });
  await app.api("POST", "/api/cash-flow", { tenantId, body: { type: "out", amount: 30, currency: "USD", exchange_rate: 1, reason: "Rent" } });
  await app.api("POST", "/api/cash-flow", { tenantId, body: { type: "out", amount: 40, currency: "USD", exchange_rate: 1, reason: "Payment to supplier Y invoice #1" } });
});

after(async () => {
  await app.close();
});

function approx(actual: number, expected: number, msg: string, eps = 0.02) {
  assert.ok(Math.abs(actual - expected) < eps, `${msg}: expected ~${expected}, got ${actual}`);
}

test("summary reconciles sales, refunds, cogs, discounts, cash, receivables/payables, inventory", async () => {
  const res = await app.api("GET", `/api/reports/summary?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body;

  approx(s.sales, 112.75, "sales"); // 42.75 + 40 + 30
  approx(s.refunds, 17.1, "refunds");
  approx(s.net_sales, 95.65, "net_sales");
  approx(s.discounts, 7.25, "discounts"); // only sale1's line+global discount
  approx(s.cogs, 40, "cogs"); // (20+16+12) - 8
  approx(s.gross_profit, 55.65, "gross_profit");
  approx(s.margin_pct, (55.65 / 95.65) * 100, "margin_pct");
  approx(s.purchases, 120, "purchases");
  approx(s.cash_in, 50, "cash_in");
  approx(s.cash_out, 70, "cash_out"); // 30 rent + 40 supplier payment
  assert.equal(s.tx_count, 6, "tx_count: sale1, sale2, sale3, refund, purchase, debt-ticket");
  assert.equal(s.sale_count, 3, "sale_count excludes the debt-payment ticket");
  approx(s.avg_ticket, 112.75 / 3, "avg_ticket");
  approx(s.collected, 82.75, "collected"); // 42.75 + 40 (credit sale excluded)
  approx(s.receivables, 40, "receivables"); // customerX 30 + customerZ 10
  approx(s.payables, 20, "payables");
  // Product A's cost is blended by the purchase's weighted-average-cost update (94 units @ $4 +
  // 20 units @ $6 = $496 total basis over 114 units = $4.350877/unit), then a further unit sells
  // (customerZ's backdated credit sale) leaving 113 units @ that same blended cost.
  approx(s.inventory_value_cost, 881.65, "inventory_value_cost"); // A:113*(496/114)=491.65, B:48*8=384, C:3*2=6
  approx(s.inventory_value_retail, 2105, "inventory_value_retail"); // A:113*10=1130, B:48*20=960, C:3*5=15
  assert.equal(s.low_stock_count, 1, "low_stock_count: only product C");
});

test("by-product reconciles with summary net_sales/cogs and nets refunds", async () => {
  const res = await app.api("GET", `/api/reports/by-product?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];

  const a = rows.find((r) => r.product_id === productA);
  const b = rows.find((r) => r.product_id === productB);
  assert.ok(a && b, "both products present");

  approx(a.qty, 6, "product A net qty (5 + 3 - 2)");
  approx(a.revenue, 55.65, "product A revenue"); // 42.75 + 30 - 17.10
  approx(a.cogs, 24, "product A cogs"); // 20 + 12 - 8
  approx(a.profit, 31.65, "product A profit");

  approx(b.qty, 2, "product B qty");
  approx(b.revenue, 40, "product B revenue");
  approx(b.cogs, 16, "product B cogs");

  const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const totalCogs = rows.reduce((sum, r) => sum + r.cogs, 0);
  approx(totalRevenue, 95.65, "sum(by-product.revenue) reconciles with summary.net_sales");
  approx(totalCogs, 40, "sum(by-product.cogs) reconciles with summary.cogs");

  // sort + limit
  const limited = await app.api("GET", `/api/reports/by-product?from=${today}&to=${today}&sort=qty&limit=1`, { tenantId });
  assert.equal(limited.body.length, 1);
});

test("by-category shares sum to 100% and reconciles with by-product", async () => {
  const res = await app.api("GET", `/api/reports/by-category?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];
  const drinks = rows.find((r) => r.category === "Drinks");
  const snacks = rows.find((r) => r.category === "Snacks");
  assert.ok(drinks && snacks);
  approx(drinks.revenue, 55.65, "Drinks revenue");
  approx(snacks.revenue, 40, "Snacks revenue");
  const totalShare = rows.reduce((sum, r) => sum + r.share_pct, 0);
  approx(totalShare, 100, "share_pct sums to 100", 0.1);
});

test("daily-sales-by-category matches by-category and splits it per cashier", async () => {
  const res = await app.api("GET", `/api/reports/daily-sales-by-category?date=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { categories, cashiers } = res.body as any;
  const drinks = categories.find((r: any) => r.category === "Drinks");
  const snacks = categories.find((r: any) => r.category === "Snacks");
  approx(drinks.revenue, 55.65, "Drinks revenue (same basis as by-category)");
  approx(snacks.revenue, 40, "Snacks revenue");
  assert.ok(cashiers.length >= 1);
  // Every cashier's categories add up to the overall figure, per category and in total.
  for (const cat of categories) {
    const sum = cashiers.reduce((s: number, c: any) => s + (c.categories.find((r: any) => r.category === cat.category)?.revenue || 0), 0);
    approx(sum, cat.revenue, `per-cashier sum for ${cat.category}`);
  }
  approx(cashiers.reduce((s: number, c: any) => s + c.revenue, 0), categories.reduce((s: number, r: any) => s + r.revenue, 0), "cashier totals");
});

test("by-customer: invoices, revenue/profit net of refunds, paid (excludes credit), balance", async () => {
  const res = await app.api("GET", `/api/reports/by-customer?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];

  const walkin = rows.find((r) => r.stakeholder_id === walkInId);
  const custX = rows.find((r) => r.stakeholder_id === customerX);
  assert.ok(walkin && custX);

  assert.equal(walkin.invoices, 2, "walk-in: sale1 + sale2 (refund not counted as an invoice)");
  approx(walkin.revenue, 65.65, "walk-in revenue net of refund"); // 42.75 + 40 - 17.10
  approx(walkin.paid, 82.75, "walk-in paid");
  approx(walkin.balance, 0, "walk-in balance");

  assert.equal(custX.invoices, 1);
  approx(custX.revenue, 30, "customer X revenue");
  approx(custX.paid, 0, "customer X paid nothing (credit)");
  approx(custX.balance, -30, "customer X balance");
});

test("by-cashier aggregates invoices/revenue/refunds per user", async () => {
  const res = await app.api("GET", `/api/reports/by-cashier?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];
  assert.equal(rows.length, 1, "single admin user attributed to every transaction");
  const admin = rows[0];
  assert.equal(admin.invoices, 3);
  approx(admin.revenue, 112.75, "admin revenue");
  approx(admin.refunds, 17.1, "admin refunds");
  approx(admin.avg_ticket, 112.75 / 3, "admin avg_ticket");
});

test("by-payment-method breaks out currency and kind (sale/refund/purchase)", async () => {
  const res = await app.api("GET", `/api/reports/by-payment-method?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];

  const saleUsd = rows.find((r) => r.kind === "sale" && r.currency === "USD" && r.method === "cash");
  const saleLbp = rows.find((r) => r.kind === "sale" && r.currency === "LBP");
  const saleCredit = rows.find((r) => r.kind === "sale" && r.method === "credit");
  const refundRow = rows.find((r) => r.kind === "refund");
  const purchaseRow = rows.find((r) => r.kind === "purchase");

  assert.ok(saleUsd && saleLbp && saleCredit && refundRow && purchaseRow, JSON.stringify(rows));
  approx(saleUsd.amount_usd, 42.75, "sale cash USD");
  approx(saleLbp.amount_usd, 40, "sale cash LBP converted to USD");
  approx(saleCredit.amount_usd, 30, "sale credit");
  approx(refundRow.amount_usd, 17.1, "refund payment");
  approx(purchaseRow.amount_usd, 100, "purchase payment");
});

test("by-supplier aggregates purchases, paid and balance", async () => {
  const res = await app.api("GET", `/api/reports/by-supplier?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];
  const supplier = rows.find((r) => r.stakeholder_id === supplierY);
  assert.ok(supplier);
  assert.equal(supplier.purchases, 1);
  approx(supplier.amount, 120, "supplier amount");
  approx(supplier.paid, 100, "supplier paid");
  approx(supplier.balance, -20, "supplier balance");
});

test("inventory-valuation totals and low-stock/slow-movers", async () => {
  const val = await app.api("GET", "/api/reports/inventory-valuation", { tenantId });
  assert.equal(val.status, 200, JSON.stringify(val.body));
  approx(val.body.totals.value_cost, 881.65, "inventory totals value_cost");
  approx(val.body.totals.value_retail, 2105, "inventory totals value_retail");
  const rowA = val.body.rows.find((r: any) => r.product_id === productA);
  assert.equal(rowA.stock, 113, "product A stock: 100-5-3+2+20-1 (customerZ's sale)");

  const low = await app.api("GET", "/api/reports/low-stock", { tenantId });
  assert.equal(low.status, 200, JSON.stringify(low.body));
  assert.equal(low.body.length, 1);
  assert.equal(low.body[0].product_id, productC);
  approx(low.body[0].suggested_order, 17, "suggested_order = reorder_point*2 - stock");

  const slow = await app.api("GET", "/api/reports/slow-movers?days=30", { tenantId });
  assert.equal(slow.status, 200, JSON.stringify(slow.body));
  const slowC = slow.body.find((r: any) => r.product_id === productC);
  assert.ok(slowC, "product C listed as a slow mover");
  assert.equal(slowC.qty_sold, 0);
  assert.equal(slowC.last_sold_at, null);
  assert.equal(slow.body[0].product_id, productC, "lowest qty_sold sorted first");
});

test("aging buckets customer debt by invoice age, including a backdated invoice", async () => {
  const res = await app.api("GET", "/api/reports/aging?type=customer", { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];

  const custX = rows.find((r) => r.stakeholder_id === customerX);
  const custZ = rows.find((r) => r.stakeholder_id === customerZ);
  assert.ok(custX && custZ, JSON.stringify(rows));

  approx(custX.balance, -30, "customer X balance");
  approx(custX.current, 30, "customer X: today's invoice is in 'current'");
  approx(custX.d31_60, 0, "customer X d31_60");

  approx(custZ.balance, -10, "customer Z balance");
  approx(custZ.current, 0, "customer Z current");
  approx(custZ.d31_60, 10, "customer Z: 45-day-old invoice falls in 31-60");
  assert.equal(custZ.oldest_invoice_at.slice(0, 7), localDaysAgo(45).slice(0, 7)); // sanity: same year-month
});

test("aging buckets supplier payables", async () => {
  const res = await app.api("GET", "/api/reports/aging?type=supplier", { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const supplier = (res.body as any[]).find((r) => r.stakeholder_id === supplierY);
  assert.ok(supplier);
  approx(supplier.balance, -20, "supplier balance");
  approx(supplier.current, 20, "supplier current");
});

test("profit-and-loss excludes supplier payments from expenses", async () => {
  const res = await app.api("GET", `/api/reports/profit-and-loss?from=${today}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const pl = res.body;
  approx(pl.revenue, 95.65, "P&L revenue");
  approx(pl.cogs, 40, "P&L cogs");
  approx(pl.gross_profit, 55.65, "P&L gross_profit");
  approx(pl.expenses, 30, "P&L expenses exclude the supplier payment");
  approx(pl.net_profit, 25.65, "P&L net_profit");
});

test("sales-trend fills empty periods with zeros and reconciles the populated day", async () => {
  const from = localDaysAgo(3);
  const res = await app.api("GET", `/api/reports/sales-trend?group=day&from=${from}&to=${today}`, { tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body as any[];
  assert.equal(rows.length, 4, "4 continuous days from-to inclusive");

  const emptyDays = rows.filter((r) => r.period !== today);
  for (const d of emptyDays) {
    assert.equal(d.sales, 0);
    assert.equal(d.refunds, 0);
    assert.equal(d.count, 0);
  }

  const todayRow = rows.find((r) => r.period === today);
  assert.ok(todayRow);
  approx(todayRow.sales, 112.75, "trend today sales");
  approx(todayRow.refunds, 17.1, "trend today refunds");
  approx(todayRow.net, 95.65, "trend today net");
  approx(todayRow.cogs, 40, "trend today cogs");
  approx(todayRow.profit, 55.65, "trend today profit");
  assert.equal(todayRow.count, 3, "trend today sale count");

  // Ascending order.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].period > rows[i - 1].period);
  }
});
