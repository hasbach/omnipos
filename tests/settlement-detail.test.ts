// Settlement detail (docs/plans/2026-09-29-settlement-detail.md): atomic settlement with counted
// cash per currency, the recorded snapshot vs the rebuilt-from-archive breakdown, "changed after
// closing" detection, append-only admin corrections, and the legacy / backfill linking paths.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let seq = 0;

before(async () => {
  app = await createTestApp();
});
after(async () => {
  await app.close();
});

const RATE = 90000;

// A tenant with USD + LBP and one day of trading: three sales, a cash-in and a cash-out.
//   A: 3 x $10 = $30 paid cash USD      B: $10 paid by card      C: $10 paid in cash LBP (900000)
//   cash in $5, cash out $2   =>  cash sales 40, expected 43
async function seedDay(name: string) {
  const n = ++seq;
  const tenantId = seedTenant(app.db, name, `settle-detail-${n}@example.com`);
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', ?, 0)").run(tenantId, RATE);
  const productId = seedProduct(app.db, tenantId, { barcode: `SD-${n}`, name: "Widget", price: 10, stock: 1000 });
  const sell = async (qty: number, payments: any[]) => {
    const r = await app.api("POST", "/api/transactions", {
      tenantId,
      body: { type: "sale", items: [{ id: productId, quantity: qty }], currency: "USD", exchange_rate: 1, payments },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  const a = await sell(3, [{ amount: 30, method: "cash", currency: "USD", exchange_rate: 1 }]);
  const b = await sell(1, [{ amount: 10, method: "card", currency: "USD", exchange_rate: 1 }]);
  const c = await sell(1, [{ amount: 10 * RATE, method: "cash", currency: "LBP", exchange_rate: RATE }]);
  assert.equal((await app.api("POST", "/api/cash-flow", { tenantId, body: { type: "in", amount: 5, currency: "USD", exchange_rate: 1, reason: "float" } })).status, 200);
  assert.equal((await app.api("POST", "/api/cash-flow", { tenantId, body: { type: "out", amount: 2, currency: "USD", exchange_rate: 1, reason: "supplies" } })).status, 200);
  const userId = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? LIMIT 1").get(tenantId) as any).id;
  return { tenantId, productId, userId, a, b, c };
}

const COUNTED = [
  { currency: "USD", amount: 40, rate: 1 },
  { currency: "LBP", amount: 900000, rate: RATE },
];

async function settleDay(day: Awaited<ReturnType<typeof seedDay>>, counted = COUNTED) {
  const r = await app.api("POST", "/api/tenant/settlement", {
    tenantId: day.tenantId,
    body: { user_id: day.userId, counted, notes: "end of day" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.report_id as number;
}

test("atomic settlement writes the report with snapshot + counted per currency and links the archived rows", async () => {
  const day = await seedDay("Atomic Settle Co");
  const reportId = await settleDay(day);
  assert.ok(reportId > 0, "settlement returns the new report id");

  const report = app.db.prepare("SELECT * FROM daily_reports WHERE id = ?").get(reportId) as any;
  assert.equal(report.tenant_id, day.tenantId);
  assert.equal(report.user_id, day.userId);
  assert.equal(report.opening_balance, 0);
  assert.equal(report.total_sales, 40, "total_sales stays the CASH sales, as before");
  assert.equal(report.total_cash_in, 5);
  assert.equal(report.total_cash_out, 2);
  assert.equal(report.closing_balance, 43);
  assert.equal(report.actual_balance, 50, "40 USD + 900000 LBP / 90000");
  assert.equal(report.difference, 7);
  assert.equal(report.notes, "end of day");
  assert.ok(report.settled_at && report.period_start);
  assert.deepEqual(JSON.parse(report.counted_json), COUNTED);

  const snap = JSON.parse(report.snapshot_json);
  assert.equal(snap.sales.count, 3);
  assert.equal(snap.sales.total, 50);
  assert.deepEqual(snap.sales.by_method, { cash: 40, card: 10, credit: 0, store_credit: 0 });
  assert.deepEqual(snap.sales.cash_by_currency, { USD: 30, LBP: 900000 });
  assert.equal(snap.cash_in.total, 5);
  assert.deepEqual(snap.cash_out.by_currency, { USD: 2 });
  assert.equal(snap.register.expected, 43);

  const txRows = app.db.prepare("SELECT settlement_id FROM archived_transactions WHERE tenant_id = ?").all(day.tenantId) as any[];
  assert.equal(txRows.length, 3);
  assert.ok(txRows.every((r) => r.settlement_id === reportId), "every archived invoice points at the settlement");
  const cfRows = app.db.prepare("SELECT settlement_id FROM archived_cash_flow WHERE tenant_id = ?").all(day.tenantId) as any[];
  assert.equal(cfRows.length, 2);
  assert.ok(cfRows.every((r) => r.settlement_id === reportId));
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM transactions WHERE tenant_id = ?").get(day.tenantId) as any).c, 0);

  // Validation happens before anything is touched.
  const bad = await app.api("POST", "/api/tenant/settlement", {
    tenantId: day.tenantId,
    body: { counted: [{ currency: "USD", amount: -1, rate: 1 }] },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "SETTLEMENT_COUNTED_INVALID");
  assert.equal(bad.body.field, "counted.0.amount");
});

test("detail endpoint: recorded equals rebuilt for an untouched day", async () => {
  const day = await seedDay("Untouched Day Co");
  const reportId = await settleDay(day);

  const res = await app.api("GET", `/api/settlements/${reportId}`, { tenantId: day.tenantId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body;
  assert.equal(d.report.id, reportId);
  assert.equal(d.report.user_name, "Admin");
  assert.equal(d.report.effective_actual, 50);
  assert.equal(d.report.effective_expected, 43);
  assert.equal(d.report.effective_difference, 7);
  assert.equal(d.report.corrections_count, 0);
  assert.equal(d.report.changed_after_close, false);
  assert.equal(d.recorded.legacy, false);
  assert.ok(d.rebuilt, "rebuilt from the archived rows");
  for (const path of [["sales", "total"], ["sales", "count"], ["refunds", "total"], ["purchases", "total"], ["register", "expected"], ["register", "cash_sales"], ["cash_in", "total"], ["cash_out", "total"]]) {
    const pick = (o: any) => path.reduce((x, k) => x[k], o);
    assert.equal(pick(d.rebuilt), pick(d.recorded), path.join("."));
  }
  assert.deepEqual(d.rebuilt.sales.by_method, d.recorded.sales.by_method);
  assert.deepEqual(d.rebuilt.sales.cash_by_currency, d.recorded.sales.cash_by_currency);
  assert.equal(d.changes.changed, false);
  assert.deepEqual(d.changes.diffs, []);
  assert.deepEqual(d.changes.edited_invoices, []);
  assert.deepEqual(d.changes.late_payments, []);
  assert.deepEqual(d.counted.map((c: any) => [c.currency, c.amount, c.rate, c.amount_usd]), [["USD", 40, 1, 40], ["LBP", 900000, RATE, 10]]);
  assert.equal(d.corrected_counted, null);
  assert.deepEqual(d.corrections, []);

  const missing = await app.api("GET", "/api/settlements/999999", { tenantId: day.tenantId });
  assert.equal(missing.status, 404);
  const otherTenant = seedTenant(app.db, "Other Tenant", `settle-other-${++seq}@example.com`);
  assert.equal((await app.api("GET", `/api/settlements/${reportId}`, { tenantId: otherTenant })).status, 404);
});

test("editing a settled invoice flags the settlement as changed, lists the edit, and keeps the late payment out of the rebuild", async () => {
  const day = await seedDay("Changed After Close Co");
  const reportId = await settleDay(day);

  const detail = await app.api("GET", `/api/transactions/${day.a}`, { tenantId: day.tenantId });
  const keepId = detail.body.payments[0].id;
  // Qty 3 -> 5 ($50) and a further $20 cash payment taken after closing.
  const edit = await app.api("PUT", `/api/transactions/${day.a}`, {
    tenantId: day.tenantId,
    body: {
      items: [{ product_id: day.productId, quantity: 5, unit_price: 10 }],
      payments: [{ id: keepId }, { amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }],
      reason: "customer bought two more",
    },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  // The edit happened within the settlement's own second in this test; a real one comes later.
  app.db.prepare("UPDATE archived_payments SET created_at = datetime(created_at, '+30 seconds') WHERE transaction_id = ? AND id != ?").run(day.a, keepId);

  const d = (await app.api("GET", `/api/settlements/${reportId}`, { tenantId: day.tenantId })).body;
  assert.equal(d.changes.changed, true);
  assert.equal(d.report.changed_after_close, true);
  const salesDiff = d.changes.diffs.find((x: any) => x.path === "sales.total");
  assert.deepEqual(salesDiff, { path: "sales.total", recorded: 50, rebuilt: 70 });
  assert.equal(d.changes.diffs.some((x: any) => x.path === "sales.by_method.cash"), false, "the late $20 is not in the rebuild");
  assert.equal(d.rebuilt.register.expected, 43, "late payment excluded from the register rebuild");
  assert.equal(d.recorded.sales.total, 50, "the recorded snapshot never changes");

  assert.equal(d.changes.edited_invoices.length, 1);
  assert.equal(d.changes.edited_invoices[0].transaction_id, day.a);
  assert.equal(d.changes.edited_invoices[0].reason, "customer bought two more");
  assert.equal(d.changes.edited_invoices[0].before_total, 30);
  assert.equal(d.changes.edited_invoices[0].after_total, 50);
  assert.equal(d.changes.edited_invoices[0].user_name, "Admin");
  assert.equal(d.changes.late_payments.length, 1);
  assert.equal(d.changes.late_payments[0].transaction_id, day.a);
  assert.equal(d.changes.late_payments[0].amount_usd, 20);
  assert.equal(d.changes.late_payments[0].method, "cash");

  const list = (await app.api("GET", "/api/reports/daily", { tenantId: day.tenantId })).body;
  const row = list.find((r: any) => r.id === reportId);
  assert.equal(row.changed_after_close, true);
  assert.equal(row.effective_actual, 50);
  assert.equal(row.corrections_count, 0);
  assert.equal(row.user_name, "Admin");
});

test("corrections: reason, kind and PIN are enforced; originals are kept; effective figures and the next opening follow", async () => {
  const day = await seedDay("Corrections Co");
  const reportId = await settleDay(day);
  const url = `/api/settlements/${reportId}/corrections`;
  const post = (body: any) => app.api("POST", url, { tenantId: day.tenantId, body });
  const fixUsd = (amount: number) => ({ kind: "counted", counted: [{ currency: "USD", amount, rate: 1 }, { currency: "LBP", amount: 900000, rate: RATE }] });

  const noReason = await post({ ...fixUsd(45), admin_pin: "0000", reason: "  " });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, "CORRECTION_REASON_REQUIRED");
  assert.equal(noReason.body.field, "reason");
  const shortReason = await post({ ...fixUsd(45), admin_pin: "0000", reason: "x" });
  assert.equal(shortReason.body.code, "CORRECTION_REASON_REQUIRED");

  const badKind = await post({ kind: "nope", admin_pin: "0000", reason: "because" });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.body.code, "CORRECTION_KIND_INVALID");

  const wrongPin = await post({ ...fixUsd(45), admin_pin: "9999", reason: "recount" });
  assert.equal(wrongPin.status, 403);
  assert.equal(wrongPin.body.code, "CORRECTION_PIN_INVALID");
  assert.equal(wrongPin.body.field, "admin_pin");

  app.db.prepare("INSERT INTO users (tenant_id, name, pin, role) VALUES (?, 'Cashier', '1111', 'staff')").run(day.tenantId);
  const staffPin = await post({ ...fixUsd(45), admin_pin: "1111", reason: "recount" });
  assert.equal(staffPin.status, 403, "a staff PIN is not an admin PIN");
  assert.equal(staffPin.body.code, "CORRECTION_PIN_INVALID");

  const badAmount = await post({ kind: "counted", counted: [{ currency: "USD", amount: "abc", rate: 1 }], admin_pin: "0000", reason: "recount" });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.code, "CORRECTION_AMOUNT_INVALID");
  assert.equal(badAmount.body.field, "counted.0.amount");
  const badAdj = await post({ kind: "adjustment", amount: 0, currency: "USD", rate: 1, admin_pin: "0000", reason: "recount" });
  assert.equal(badAdj.body.code, "CORRECTION_AMOUNT_INVALID");
  assert.equal(badAdj.body.field, "amount");

  assert.equal((await app.api("POST", "/api/settlements/999999/corrections", { tenantId: day.tenantId, body: { ...fixUsd(45), admin_pin: "0000", reason: "recount" } })).status, 404);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM settlement_corrections").get() as any).c >= 0, true);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM settlement_corrections WHERE report_id = ?").get(reportId) as any).c, 0, "nothing was written by the rejected attempts");

  // Counted-cash fix: USD 40 -> 45 (LBP unchanged => only one correction row).
  const fix = await post({ ...fixUsd(45), admin_pin: "0000", reason: "recounted the drawer" });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  assert.equal(fix.body.corrections.length, 1);
  assert.equal(fix.body.effective_actual, 55);
  assert.equal(fix.body.effective_expected, 43);
  assert.equal(fix.body.effective_difference, 12);

  // Adjustment: -3 USD (money that left the drawer and was missed) lowers the expected cash.
  const adj = await post({ kind: "adjustment", amount: -3, currency: "USD", rate: 1, admin_pin: "0000", reason: "unrecorded payout" });
  assert.equal(adj.status, 200, JSON.stringify(adj.body));
  assert.equal(adj.body.effective_expected, 40);
  assert.equal(adj.body.effective_actual, 55);
  assert.equal(adj.body.effective_difference, 15);

  const row = app.db.prepare("SELECT * FROM daily_reports WHERE id = ?").get(reportId) as any;
  assert.equal(row.actual_balance, 50, "original actual is never modified");
  assert.equal(row.closing_balance, 43);
  assert.equal(row.difference, 7);
  assert.deepEqual(JSON.parse(row.counted_json), COUNTED);
  assert.equal(row.corrected_actual_balance, 55);
  assert.equal(row.adjustments_total, -3);

  const d = (await app.api("GET", `/api/settlements/${reportId}`, { tenantId: day.tenantId })).body;
  assert.equal(d.corrections.length, 2);
  assert.deepEqual(
    d.corrections.map((c: any) => [c.kind, c.currency, c.old_value, c.new_value, c.amount_usd, c.user_name, c.reason]),
    [["counted", "USD", 40, 45, 5, "Admin", "recounted the drawer"], ["adjustment", "USD", 0, -3, -3, "Admin", "unrecorded payout"]],
  );
  assert.deepEqual(d.counted.map((c: any) => c.amount), [40, 900000], "original count still reported");
  assert.deepEqual(d.corrected_counted.map((c: any) => [c.currency, c.amount, c.amount_usd]), [["USD", 45, 45], ["LBP", 900000, 10]]);
  assert.equal(d.report.actual_balance, 50);
  assert.equal(d.report.effective_actual, 55);
  assert.equal(d.report.effective_expected, 40);
  assert.equal(d.report.effective_difference, 15);
  assert.equal(d.report.corrections_count, 2);
  assert.equal(d.changes.changed, false, "corrections are not 'changed after closing'");

  const list = (await app.api("GET", "/api/reports/daily", { tenantId: day.tenantId })).body.find((r: any) => r.id === reportId);
  assert.equal(list.effective_actual, 55);
  assert.equal(list.effective_expected, 40);
  assert.equal(list.corrections_count, 2);

  // The report is the latest close => the open register opens with the CORRECTED count.
  const summary = (await app.api("GET", "/api/cash-flow/summary", { tenantId: day.tenantId })).body;
  assert.equal(summary.openingBalance, 55);

  // A second correction of the same currency: old value is the current effective count.
  const again = await post({ ...fixUsd(46), admin_pin: "0000", reason: "found a note" });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.corrections.map((c: any) => [c.old_value, c.new_value, c.amount_usd]), [[45, 46, 1]]);
  assert.equal(again.body.effective_actual, 56);
  const noChange = await post({ ...fixUsd(46), admin_pin: "0000", reason: "same again" });
  assert.equal(noChange.status, 400);
  assert.equal(noChange.body.code, "CORRECTION_AMOUNT_INVALID");
});

test("correcting an OLDER settlement does not move the current opening balance", async () => {
  const day = await seedDay("Older Correction Co");
  const first = await settleDay(day);
  // A later close (Cash Out) with a later timestamp than the settlement report.
  app.db.prepare("UPDATE daily_reports SET created_at = datetime(created_at, '-1 hour') WHERE id = ?").run(first);
  app.db.prepare(
    `INSERT INTO cashier_shifts (tenant_id, user_id, date, opening_balance, cash_sales, cash_refunds, cash_purchases, cash_in, cash_out, expected_cash, actual_cash, difference, notes)
     VALUES (?, ?, date('now'), 0, 0, 0, 0, 0, 0, 0, 12, 0, '')`
  ).run(day.tenantId, day.userId);
  const fix = await app.api("POST", `/api/settlements/${first}/corrections`, {
    tenantId: day.tenantId,
    body: { kind: "counted", counted: [{ currency: "USD", amount: 41, rate: 1 }], admin_pin: "0000", reason: "recount" },
  });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  const summary = (await app.api("GET", "/api/cash-flow/summary", { tenantId: day.tenantId })).body;
  assert.equal(summary.openingBalance, 12, "the newer Cash Out is still the latest close");
});

test("legacy flow: report posted first, settlement without a body, still links the rows", async () => {
  const day = await seedDay("Legacy Flow Co");
  const posted = await app.api("POST", "/api/reports/daily", {
    tenantId: day.tenantId,
    body: {
      user_id: day.userId, opening_balance: 0, total_sales: 40, total_purchases: 0, total_cash_in: 5, total_cash_out: 2,
      closing_balance: 43, actual_balance: 50, notes: "old client [Breakdown: 40 USD, 900000 LBP]",
    },
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const reportId = Number(posted.body.id);

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId: day.tenantId });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  assert.equal(settle.body.report_id, reportId, "the recent unsettled report is the one completed");

  const rows = app.db.prepare("SELECT settlement_id FROM archived_transactions WHERE tenant_id = ?").all(day.tenantId) as any[];
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.settlement_id === reportId));
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM archived_cash_flow WHERE tenant_id = ? AND settlement_id = ?").get(day.tenantId, reportId) as any).c, 2);
  const report = app.db.prepare("SELECT * FROM daily_reports WHERE id = ?").get(reportId) as any;
  assert.ok(report.settled_at);
  assert.ok(report.period_start);

  const d = (await app.api("GET", `/api/settlements/${reportId}`, { tenantId: day.tenantId })).body;
  assert.ok(d.rebuilt);
  assert.equal(d.rebuilt.sales.total, 50);
  assert.deepEqual(d.counted.map((c: any) => [c.currency, c.amount]), [["USD", 40], ["LBP", 900000]], "counted parsed from the notes breakdown");
  assert.equal(d.changes.changed, false);

  // A second body-less settlement with no fresh report links nothing and must not steal the first.
  const again = await app.api("POST", "/api/tenant/settlement", { tenantId: day.tenantId });
  assert.equal(again.status, 200);
  assert.equal(again.body.report_id, null);
});

test("legacy report without a snapshot still opens: recorded is flagged legacy and nothing crashes", async () => {
  const tenantId = seedTenant(app.db, "Pure Legacy Co", `pure-legacy-${++seq}@example.com`);
  const userId = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ?").get(tenantId) as any).id;
  const id = Number(app.db.prepare(
    `INSERT INTO daily_reports (tenant_id, user_id, date, opening_balance, total_sales, total_purchases, total_cash_in, total_cash_out, closing_balance, actual_balance, difference, notes, created_at)
     VALUES (?, ?, '2026-01-01', 10, 100, 20, 0, 0, 90, 85, -5, 'no breakdown here', '2026-01-01 20:00:00')`
  ).run(tenantId, userId).lastInsertRowid);
  const d = (await app.api("GET", `/api/settlements/${id}`, { tenantId })).body;
  assert.equal(d.recorded.legacy, true);
  assert.equal(d.recorded.register.expected, 90);
  assert.equal(d.recorded.register.cash_sales, 100);
  assert.equal(d.rebuilt, null);
  assert.deepEqual(d.counted, [{ currency: "USD", amount: 85, rate: 1, amount_usd: 85 }]);
  assert.equal(d.changes.changed, false);
  assert.equal(d.report.effective_difference, -5);
});

test("backfill migration links pre-existing archived rows to the report written just before them", async () => {
  const { runSettlementLinkBackfill } = await import("../server/db.js");
  const tenantId = seedTenant(app.db, "Backfill Co", `backfill-${++seq}@example.com`);
  const userId = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ?").get(tenantId) as any).id;
  const report = (createdAt: string) => Number(app.db.prepare(
    `INSERT INTO daily_reports (tenant_id, user_id, date, closing_balance, actual_balance, created_at) VALUES (?, ?, '2026-01-01', 10, 10, ?)`
  ).run(tenantId, userId, createdAt).lastInsertRowid);
  const archTx = (id: number, archivedAt: string) => app.db.prepare(
    `INSERT INTO archived_transactions (id, tenant_id, type, total_amount, currency, exchange_rate, created_at, archived_at) VALUES (?, ?, 'sale', 10, 'USD', 1, ?, ?)`
  ).run(id, tenantId, archivedAt, archivedAt);
  const archCash = (id: number, archivedAt: string) => app.db.prepare(
    `INSERT INTO archived_cash_flow (id, tenant_id, type, amount, currency, exchange_rate, reason, created_at, archived_at) VALUES (?, ?, 'in', 5, 'USD', 1, 'x', ?, ?)`
  ).run(id, tenantId, archivedAt, archivedAt);

  const r1 = report("2026-01-01 20:00:00");
  const r2 = report("2026-01-02 20:00:00");
  archTx(9001001, "2026-01-01 20:00:03"); archCash(9001001, "2026-01-01 20:00:03");
  archTx(9001002, "2026-01-02 20:00:04");
  archTx(9001003, "2026-03-05 09:00:00"); // no report anywhere near it

  app.db.prepare("DELETE FROM _migrations WHERE name = 'settlement_link_backfill_v1'").run();
  runSettlementLinkBackfill();

  const link = (id: number) => (app.db.prepare("SELECT settlement_id FROM archived_transactions WHERE id = ?").get(id) as any).settlement_id;
  assert.equal(link(9001001), r1);
  assert.equal(link(9001002), r2);
  assert.equal(link(9001003), null, "rows with no matching report stay unlinked");
  assert.equal((app.db.prepare("SELECT settlement_id FROM archived_cash_flow WHERE id = 9001001").get() as any).settlement_id, r1);
  const s1 = app.db.prepare("SELECT settled_at FROM daily_reports WHERE id = ?").get(r1) as any;
  assert.equal(s1.settled_at, "2026-01-01 20:00:03");
  const d = (await app.api("GET", `/api/settlements/${r1}`, { tenantId })).body;
  assert.ok(d.rebuilt, "a backfilled report can be rebuilt");
  assert.equal(d.rebuilt.sales.count, 1);

  // The hand-made high ids would trip the settlement's id-offset guard for every later test in this
  // shared database, so leave nothing behind.
  app.db.prepare("DELETE FROM archived_transactions WHERE tenant_id = ?").run(tenantId);
  app.db.prepare("DELETE FROM archived_cash_flow WHERE tenant_id = ?").run(tenantId);
});

test("/api/cash-flow/summary numbers are unchanged by the refactor", async () => {
  const day = await seedDay("Summary Parity Co");
  const s = (await app.api("GET", "/api/cash-flow/summary", { tenantId: day.tenantId })).body;
  assert.deepEqual(s, {
    openingBalance: 0, totalSales: 40, totalRefunds: 0, totalPurchases: 0, totalIn: 5, totalOut: 2, expectedBalance: 43,
  });
  // ...and it equals what settlement will snapshot as the register.
  const reportId = await settleDay(day);
  const snap = JSON.parse((app.db.prepare("SELECT snapshot_json FROM daily_reports WHERE id = ?").get(reportId) as any).snapshot_json);
  assert.equal(snap.register.expected, s.expectedBalance);
  const after = (await app.api("GET", "/api/cash-flow/summary", { tenantId: day.tenantId })).body;
  assert.equal(after.openingBalance, 50, "next register opens with the counted cash");
  assert.equal(after.expectedBalance, 50);
});
