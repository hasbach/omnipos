// Shared drawer, two cashier shifts, then the End-of-Day Settlement (live incident 2026-09-29/30):
//   1. A cashier's Cash Out compared the counted WHOLE drawer with only that cashier's own sales and
//      cash movements, so one shift showed +101 and the next -102 while the drawer was ~balanced.
//   2. The settlement report covered only the minutes since the last Cash Out, so the day's manual
//      cash in/out showed $0 and its Expected just echoed the last cashier's count.
// Now: Cash Out = whole drawer since the last close; Settlement = whole day since the last settlement.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
before(async () => {
  app = await createTestApp();
});
after(async () => {
  await app.close();
});

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 0.005, `${msg ?? ""} expected ${b}, got ${a}`);

async function replayDay() {
  const tenantId = seedTenant(app.db, "Shared Drawer Co", "shared-drawer@example.com");
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ?").get(tenantId) as any).id;
  const addUser = (name: string) => Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, ?, 'cashier')").run(tenantId, name).lastInsertRowid);
  const ahmad = addUser("ahmad");
  const abed = addUser("Abed");
  const productId = seedProduct(app.db, tenantId, { barcode: "SHARED-1", name: "Item", price: 10, stock: 1000 });

  // Timestamps are pinned: created_at has one-second resolution and the window is `created_at > close`.
  const stamp = (table: string, id: number, at: string) => app.db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(at, id);
  const sell = async (userId: number, qty: number, at: string) => {
    const r = await app.api("POST", "/api/transactions", {
      tenantId,
      body: { type: "sale", user_id: userId, items: [{ id: productId, quantity: qty }], currency: "USD", exchange_rate: 1, payments: [{ amount: qty * 10, method: "cash", currency: "USD", exchange_rate: 1 }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    stamp("transactions", r.body.id, at);
    app.db.prepare("UPDATE payments SET created_at = ? WHERE transaction_id = ?").run(at, r.body.id);
  };
  const move = async (userId: number, type: "in" | "out", amount: number, at: string) => {
    const r = await app.api("POST", "/api/cash-flow", { tenantId, body: { user_id: userId, type, amount, currency: "USD", exchange_rate: 1, reason: `${type} ${amount}` } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = (app.db.prepare("SELECT MAX(id) as id FROM cash_flow WHERE tenant_id = ?").get(tenantId) as any).id;
    stamp("cash_flow", id, at);
  };
  const cashOut = async (userId: number, counted: number, at: string) => {
    const r = await app.api("POST", "/api/tenant/cashout", { tenantId, body: { user_id: userId, opening_balance: 999, actual_cash: counted } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = (app.db.prepare("SELECT MAX(id) as id FROM cashier_shifts WHERE tenant_id = ?").get(tenantId) as any).id;
    stamp("cashier_shifts", id, at);
    return r.body.shift;
  };

  // Previous day's settlement left $10 in the drawer.
  const prev = await app.api("POST", "/api/tenant/settlement", { tenantId, body: { user_id: admin, counted: [{ currency: "USD", amount: 10, rate: 1 }], notes: "" } });
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  app.db.prepare("UPDATE daily_reports SET created_at = '2020-01-01 06:00:00', settled_at = '2020-01-01 06:00:00' WHERE id = ?").run(prev.body.report_id);

  // Morning: Abed and ahmad both sell from the same drawer; the admin borrows 60 and pays a 35 expense.
  await sell(abed, 5, "2020-01-01 08:00:00");   // +50
  await sell(ahmad, 2, "2020-01-01 09:00:00");  // +20
  await move(admin, "in", 60, "2020-01-01 10:00:00");
  await move(admin, "out", 35, "2020-01-01 11:00:00");
  // Drawer now: 10 + 50 + 20 + 60 - 35 = 105. ahmad counts it all.
  const ahmadShift = await cashOut(ahmad, 105, "2020-01-01 14:00:00");

  // Evening: Abed sells 30, the admin pays a supplier 25 in cash. Drawer: 105 + 30 - 25 = 110.
  await sell(abed, 3, "2020-01-01 15:00:00");
  await move(admin, "out", 25, "2020-01-01 16:00:00");
  const abedShift = await cashOut(abed, 110, "2020-01-01 23:00:00");

  return { tenantId, admin, ahmadShift, abedShift };
}

let day: Awaited<ReturnType<typeof replayDay>>;

test("Cash Out reconciles the whole shared drawer, not just the cashier's own movements", async () => {
  day = await replayDay();
  // Old code: ahmad expected 10 + 20 = 30 (+75 "over"); Abed 105 + 30 = 135 (-25 "short").
  close(day.ahmadShift.expected_cash, 105, "ahmad expected");
  close(day.ahmadShift.difference, 0, "ahmad difference");
  close(day.ahmadShift.opening_balance, 10, "ahmad opening is the server's last close, not the client's 999");
  close(day.abedShift.opening_balance, 105, "Abed opens with ahmad's count");
  close(day.abedShift.expected_cash, 110, "Abed expected includes the admin's supplier payment");
  close(day.abedShift.difference, 0, "Abed difference");

  const log = app.db.prepare("SELECT details FROM user_logs WHERE tenant_id = ? AND action = 'Cashier Cash Out' ORDER BY id DESC LIMIT 1").get(day.tenantId) as any;
  assert.match(log.details, /Actual: 110\.00,/, "the logged count is rounded");

  const shifts = (await app.api("GET", "/api/tenant/cashier-shifts", { tenantId: day.tenantId })).body as any[];
  assert.equal(shifts.length, 2, "every shift of the open day is listed, whatever its calendar date");
});

test("register summary: shift scope since the last Cash Out, day scope since the last settlement", async () => {
  const shift = (await app.api("GET", "/api/cash-flow/summary", { tenantId: day.tenantId })).body;
  close(shift.openingBalance, 110);
  close(shift.expectedBalance, 110);
  close(shift.totalIn, 0);

  const whole = (await app.api("GET", "/api/cash-flow/summary?scope=day", { tenantId: day.tenantId })).body;
  assert.equal(whole.scope, "day");
  close(whole.openingBalance, 10);
  close(whole.totalSales, 100);
  close(whole.totalIn, 60);
  close(whole.totalOut, 60);
  close(whole.expectedBalance, 110);

  assert.equal((await app.api("GET", "/api/cash-flow", { tenantId: day.tenantId })).body.length, 0, "no movements this shift");
  assert.equal((await app.api("GET", "/api/cash-flow?scope=day", { tenantId: day.tenantId })).body.length, 3, "all of today's movements");
});

test("the settlement report covers the whole day, cash in/out included", async () => {
  const r = await app.api("POST", "/api/tenant/settlement", { tenantId: day.tenantId, body: { user_id: day.admin, counted: [{ currency: "USD", amount: 110, rate: 1 }], notes: "" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const report = app.db.prepare("SELECT * FROM daily_reports WHERE id = ?").get(r.body.report_id) as any;
  close(report.opening_balance, 10);
  close(report.total_sales, 100);
  close(report.total_cash_in, 60);
  close(report.total_cash_out, 60);
  close(report.closing_balance, 110);
  close(report.difference, 0);
  assert.equal(report.period_start, "2020-01-01 06:00:00", "the day starts at the previous settlement");

  const detail = (await app.api("GET", `/api/settlements/${r.body.report_id}`, { tenantId: day.tenantId })).body;
  close(detail.recorded.cash_in.total, 60);
  close(detail.recorded.cash_out.total, 60);
  assert.equal(detail.recorded.shifts.length, 2);
  assert.equal(detail.changes.window_widened, false);
  assert.equal(detail.changes.changed, false);

  // Next day opens with the settlement's count.
  close((await app.api("GET", "/api/cash-flow/summary?scope=day", { tenantId: day.tenantId })).body.openingBalance, 110);
  close((await app.api("GET", "/api/cash-flow/summary", { tenantId: day.tenantId })).body.openingBalance, 110);
});

test("a settlement recorded the old way (since the last Cash Out) is rebuilt over the whole day", async () => {
  const id = (app.db.prepare("SELECT MAX(id) as id FROM daily_reports WHERE tenant_id = ?").get(day.tenantId) as any).id;
  // Rewrite the report as pre-fix code recorded it: window since Abed's cash-out, opening = his count.
  const snap = JSON.parse((app.db.prepare("SELECT snapshot_json FROM daily_reports WHERE id = ?").get(id) as any).snapshot_json);
  snap.period_start = "2020-01-01 23:00:00";
  snap.register = { opening: 110, cash_sales: 0, cash_refunds: 0, cash_purchases: 0, cash_in: 0, cash_out: 0, expected: 110 };
  snap.cash_in = { total: 0, by_currency: {}, count: 0 };
  snap.cash_out = { total: 0, by_currency: {}, count: 0 };
  app.db.prepare("UPDATE daily_reports SET period_start = ?, opening_balance = 110, total_sales = 0, total_cash_in = 0, total_cash_out = 0, snapshot_json = ? WHERE id = ?")
    .run(snap.period_start, JSON.stringify(snap), id);

  const detail = (await app.api("GET", `/api/settlements/${id}`, { tenantId: day.tenantId })).body;
  assert.equal(detail.changes.window_widened, true);
  assert.equal(detail.changes.changed, false, "a narrower recorded window is not 'changed after closing'");
  close(detail.rebuilt.register.opening, 10, "rebuilt opening = previous settlement's count");
  close(detail.rebuilt.register.cash_in, 60);
  close(detail.rebuilt.register.cash_out, 60);
  close(detail.rebuilt.register.expected, 110);
  close(detail.rebuilt.cash_in.total, 60);

  const list = (await app.api("GET", "/api/reports/daily", { tenantId: day.tenantId })).body as any[];
  assert.equal(list.find((r) => r.id === id).window_widened, true);
});
