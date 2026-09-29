// Cash-flow categories + counterparty, one-time backfill, admin edit (live AND settled rows) with a
// mandatory reason and an audit trail, and the analytics endpoint (totals, top-ups, loans, filters).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

const add = (body: any) => app.api("POST", "/api/cash-flow", { tenantId, body: { currency: "USD", exchange_rate: 1, ...body } });
const analytics = async (qs = "") => (await app.api("GET", `/api/cash-flow/analytics${qs}`, { tenantId })).body;
const setDate = (reason: string, created: string) =>
  app.db.prepare("UPDATE cash_flow SET created_at = ? WHERE tenant_id = ? AND reason = ?").run(created, tenantId, reason);

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Cash Flow Cat Co", "cash-flow-cat@example.com");
});
after(async () => { await app.close(); });

test("categories: stored, defaulted to other, validated", async () => {
  assert.equal((await add({ type: "in", amount: 500, category: "top_up", reason: "float 1" })).status, 200);
  assert.equal((await add({ type: "in", amount: 700, category: "top_up", reason: "float 2" })).status, 200);
  assert.equal((await add({ type: "in", amount: 1000, category: "loan_in", counterparty: "  Ali  ", reason: "loan from Ali" })).status, 200);
  assert.equal((await add({ type: "out", amount: 400, category: "loan_repayment", counterparty: "Ali", reason: "repay Ali" })).status, 200);
  assert.equal((await add({ type: "out", amount: 50, category: "expense", reason: "cleaning" })).status, 200);
  assert.equal((await add({ type: "out", amount: 20, reason: "no category" })).status, 200);
  // 89,000 LBP at 89,000/USD = $1
  assert.equal((await add({ type: "out", amount: 89000, currency: "LBP", exchange_rate: 89000, category: "expense", reason: "lbp coffee" })).status, 200);

  const list = (await app.api("GET", "/api/cash-flow", { tenantId })).body as any[];
  const byReason = (r: string) => list.find((x) => x.reason === r);
  assert.equal(byReason("loan from Ali").counterparty, "Ali", "counterparty is trimmed");
  assert.equal(byReason("no category").category, "other");

  const bad = await add({ type: "in", amount: 5, category: "nonsense", reason: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "CASHFLOW_CATEGORY_INVALID");
  const mismatch = await add({ type: "out", amount: 5, category: "top_up", reason: "x" });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.code, "CASHFLOW_CATEGORY_TYPE_MISMATCH");
  assert.equal((await add({ type: "in", amount: 0, reason: "x" })).body.code, "CASHFLOW_AMOUNT_INVALID");
});

test("balance payments are categorised automatically", async () => {
  const cust = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Cust Co', 'customer')").run(tenantId).lastInsertRowid);
  const sup = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Sup Co', 'supplier')").run(tenantId).lastInsertRowid);
  assert.equal((await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: cust, amount: 30, currency: "USD", exchange_rate: 1, direction: "collect" } })).status, 200);
  assert.equal((await app.api("POST", "/api/balance-payment", { tenantId, body: { stakeholder_id: sup, amount: 40, currency: "USD", exchange_rate: 1, direction: "pay" } })).status, 200);
  const rows = app.db.prepare("SELECT reason, category, counterparty FROM cash_flow WHERE tenant_id = ?").all(tenantId) as any[];
  assert.equal(rows.find((r) => r.reason === "Balance collection from Cust Co").category, "customer_collection");
  const pay = rows.find((r) => r.reason === "Payment to supplier Sup Co");
  assert.equal(pay.category, "supplier_payment");
  assert.equal(pay.counterparty, "Sup Co");
  // Drop them so the exact-number analytics tests below stay simple.
  app.db.prepare("DELETE FROM cash_flow WHERE tenant_id = ? AND (reason LIKE 'Balance%' OR reason LIKE 'Payment to supplier%')").run(tenantId);
});

test("backfill labels old automatic rows by reason prefix and leaves manual rows alone", async () => {
  const { backfillCashFlowCategories } = await import("../server/db.js");
  const live = (type: string, reason: string) =>
    app.db.prepare("INSERT INTO cash_flow (tenant_id, type, amount, currency, exchange_rate, reason) VALUES (?, ?, 1, 'USD', 1, ?)").run(tenantId, type, reason);
  live("in", "Balance collection from Old Customer");
  live("out", "Payment to supplier Old Supplier");
  live("in", "Payment on invoice #12");
  live("out", "Payment on invoice #13");
  live("in", "Owner deposit");
  app.db.prepare("INSERT INTO archived_cash_flow (id, tenant_id, type, amount, currency, exchange_rate, reason) VALUES (900001, ?, 'in', 1, 'USD', 1, 'Balance collection from Archived Customer')").run(tenantId);
  backfillCashFlowCategories();
  const cat = (table: string, reason: string) => (app.db.prepare(`SELECT category FROM ${table} WHERE tenant_id = ? AND reason = ?`).get(tenantId, reason) as any).category;
  assert.equal(cat("cash_flow", "Balance collection from Old Customer"), "customer_collection");
  assert.equal(cat("cash_flow", "Payment to supplier Old Supplier"), "supplier_payment");
  assert.equal(cat("cash_flow", "Payment on invoice #12"), "customer_collection");
  assert.equal(cat("cash_flow", "Payment on invoice #13"), "supplier_payment");
  assert.equal(cat("cash_flow", "Owner deposit"), null, "manual rows are not guessed");
  assert.equal(cat("archived_cash_flow", "Balance collection from Archived Customer"), "customer_collection");
  app.db.prepare("DELETE FROM cash_flow WHERE tenant_id = ? AND reason IN ('Balance collection from Old Customer','Payment to supplier Old Supplier','Payment on invoice #12','Payment on invoice #13','Owner deposit')").run(tenantId);
  app.db.prepare("DELETE FROM archived_cash_flow WHERE tenant_id = ?").run(tenantId);
});

test("analytics: totals, top-ups, categories, loans, LBP conversion", async () => {
  const a = await analytics();
  // in: 500 + 700 + 1000 = 2200 ; out: 400 + 50 + 20 + 1 = 471
  assert.equal(a.totals.in, 2200);
  assert.equal(a.totals.out, 471);
  assert.equal(a.totals.net, 1729);
  const topUp = a.by_category.find((c: any) => c.category === "top_up");
  assert.deepEqual([topUp.count, topUp.total, topUp.type], [2, 1200, "in"]);
  const expense = a.by_category.find((c: any) => c.category === "expense");
  assert.equal(expense.count, 2);
  assert.equal(expense.total, 51);
  assert.equal(a.by_category.find((c: any) => c.category === "other").total, 20);
  assert.deepEqual(a.by_counterparty, [{ counterparty: "Ali", borrowed: 1000, repaid: 400, outstanding: 600 }]);
  assert.equal(a.rows.length, 7);
  assert.ok(a.rows.every((r: any) => r.archived === false && r.edited === false));
  assert.equal(a.by_day.reduce((s: number, d: any) => s + d.in, 0), 2200);
});

test("analytics filters: type, category, text, counterparty, date range", async () => {
  assert.equal((await analytics("?type=out")).rows.length, 4);
  assert.equal((await analytics("?category=top_up")).totals.in, 1200);
  assert.equal((await analytics("?category=other")).rows.length, 1);
  assert.equal((await analytics("?q=cleaning")).rows.length, 1);
  assert.equal((await analytics("?q=ali")).rows.length, 2, "text search also matches the counterparty");
  assert.equal((await analytics("?counterparty=ali")).rows.length, 2);
  assert.equal((await analytics("?q=100%25")).rows.length, 0, "LIKE wildcards are escaped");

  setDate("float 1", "2026-01-10 12:00:00");
  setDate("loan from Ali", "2026-01-10 12:00:00");
  setDate("repay Ali", "2026-02-10 12:00:00");
  const jan = await analytics("?from=2026-01-01&to=2026-01-31");
  assert.equal(jan.rows.length, 2);
  assert.equal(jan.totals.in, 1500);
  // Loans are cumulative up to the end date, ignoring the start: February's repayment of a January
  // loan must show as a partial repayment, not a negative balance.
  const feb = await analytics("?from=2026-02-01&to=2026-02-28");
  assert.deepEqual(feb.by_counterparty, [{ counterparty: "Ali", borrowed: 1000, repaid: 400, outstanding: 600 }]);
  assert.deepEqual(jan.by_counterparty, [{ counterparty: "Ali", borrowed: 1000, repaid: 0, outstanding: 1000 }]);
});

test("edit: reason required, live row edited with an audit trail", async () => {
  const id = (app.db.prepare("SELECT id FROM cash_flow WHERE tenant_id = ? AND reason = 'cleaning'").get(tenantId) as any).id;

  const noReason = await app.api("PUT", `/api/cash-flow/${id}`, { tenantId, body: { amount: 75 } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, "CASHFLOW_EDIT_REASON_REQUIRED");
  assert.equal(noReason.body.field, "edit_reason");
  assert.equal((await app.api("PUT", `/api/cash-flow/${id}`, { tenantId, body: { amount: 75, edit_reason: " " } })).status, 400);
  assert.equal((await app.api("PUT", `/api/cash-flow/${id}`, { tenantId, body: { amount: 50, edit_reason: "no change" } })).body.code, "CASHFLOW_NO_CHANGES");
  assert.equal((await app.api("PUT", `/api/cash-flow/${id}`, { tenantId, body: { category: "top_up", edit_reason: "wrong direction" } })).body.code, "CASHFLOW_CATEGORY_TYPE_MISMATCH");
  assert.equal((await app.api("PUT", `/api/cash-flow/99999`, { tenantId, body: { amount: 1, edit_reason: "missing row" } })).status, 404);

  const ok = await app.api("PUT", `/api/cash-flow/${id}`, { tenantId, body: { amount: 75, reason: "cleaning + soap", edit_reason: "Receipt said 75" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = app.db.prepare("SELECT amount, reason, category FROM cash_flow WHERE id = ?").get(id) as any;
  assert.deepEqual([row.amount, row.reason, row.category], [75, "cleaning + soap", "expense"]);

  const edits = (await app.api("GET", `/api/cash-flow/${id}/edits`, { tenantId })).body;
  assert.equal(edits.length, 1);
  assert.equal(edits[0].edit_reason, "Receipt said 75");
  assert.equal(edits[0].before.amount, 50);
  assert.equal(edits[0].after.amount, 75);
  assert.equal(edits[0].archived, 0);

  const list = (await app.api("GET", "/api/cash-flow", { tenantId })).body as any[];
  assert.equal(list.find((r) => r.id === id).edited, true);
  assert.equal(list.find((r) => r.reason === "float 2").edited, false);
  assert.equal((await analytics("?category=expense")).totals.out, 76);

  // Another tenant can neither see nor edit it.
  const other = seedTenant(app.db, "Other Co", "cash-flow-other@example.com");
  assert.equal((await app.api("PUT", `/api/cash-flow/${id}`, { tenantId: other, body: { amount: 1, edit_reason: "not mine" } })).status, 404);
  assert.equal((await app.api("GET", `/api/cash-flow/${id}/edits`, { tenantId: other })).body.length, 0);
});

test("settled rows keep category/counterparty, appear as archived, and can be edited", async () => {
  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  assert.equal((await app.api("GET", "/api/cash-flow", { tenantId })).body.length, 0);

  const archived = app.db.prepare("SELECT * FROM archived_cash_flow WHERE tenant_id = ? AND reason = 'repay Ali'").get(tenantId) as any;
  assert.equal(archived.category, "loan_repayment");
  assert.equal(archived.counterparty, "Ali");
  const before = await analytics();
  assert.equal(before.rows.length, 7);
  assert.ok(before.rows.every((r: any) => r.archived === true));
  assert.deepEqual(before.by_counterparty, [{ counterparty: "Ali", borrowed: 1000, repaid: 400, outstanding: 600 }]);

  const ok = await app.api("PUT", `/api/cash-flow/${archived.id}`, { tenantId, body: { amount: 500, edit_reason: "Repayment was 500, typed 400" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.archived, true);
  assert.equal((app.db.prepare("SELECT amount FROM archived_cash_flow WHERE id = ?").get(archived.id) as any).amount, 500);

  const edits = (await app.api("GET", `/api/cash-flow/${archived.id}/edits`, { tenantId })).body;
  assert.equal(edits.length, 1);
  assert.equal(edits[0].archived, 1);
  const after = await analytics();
  assert.deepEqual(after.by_counterparty, [{ counterparty: "Ali", borrowed: 1000, repaid: 500, outstanding: 500 }]);
  assert.equal(after.rows.find((r: any) => r.id === archived.id).edited, true);
});
