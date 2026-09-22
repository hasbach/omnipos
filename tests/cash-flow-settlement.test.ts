// Regression tests for two bugs reported against the live "Salloum Connect" register:
//
// 1. Settlement used to `DELETE FROM cash_flow` with no archive anywhere (unlike transactions,
//    which move to archived_transactions first) — every itemized cash movement and its reason
//    was permanently and silently destroyed at every End-of-Day settlement. Now it archives to
//    archived_cash_flow first, same pattern as transactions.
//
// 2. The "Opening Balance" shown in /api/cash-flow/summary only ever read the most recent
//    `daily_reports` row (written only by the rare, admin-only "Complete Settlement"). The
//    routine, everyday "Cash Out" action writes to `cashier_shifts` instead and never fed the
//    opening balance — so a shop that cashes out daily but rarely runs a full settlement always
//    saw a $0 opening balance, never the cash actually counted the day before.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Cash Flow Test Co", "cash-flow-test@example.com");
});

after(async () => {
  await app.close();
});

test("a cash-flow entry is archived, not lost, when settlement runs", async () => {
  const add = await app.api("POST", "/api/cash-flow", {
    tenantId,
    body: { type: "out", amount: 40, currency: "USD", exchange_rate: 1, reason: "Petty cash for supplies" },
  });
  assert.equal(add.status, 200, JSON.stringify(add.body));

  const before = await app.api("GET", "/api/cash-flow", { tenantId });
  assert.equal(before.body.length, 1, "entry should be visible before settlement");
  assert.equal(before.body[0].reason, "Petty cash for supplies");

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));

  const afterEntries = await app.api("GET", "/api/cash-flow", { tenantId });
  assert.equal(afterEntries.body.length, 0, "cash_flow should be cleared for the new day after settlement");

  const archived = app.db
    .prepare("SELECT * FROM archived_cash_flow WHERE tenant_id = ?")
    .all(tenantId) as any[];
  assert.equal(archived.length, 1, "the settled entry must survive in archived_cash_flow");
  assert.equal(archived[0].reason, "Petty cash for supplies");
  assert.equal(archived[0].amount, 40);
  assert.equal(archived[0].type, "out");
});

test("opening balance carries forward from yesterday's Cash Out, not just from Complete Settlement", async () => {
  const freshTenantId = seedTenant(app.db, "Cashout Carry Co", "cashout-carry-test@example.com");
  const userId = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ?").get(freshTenantId) as any).id;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Simulate yesterday's ordinary end-of-shift Cash Out (writes cashier_shifts, never touches
  // daily_reports) counting $87.50 actually in the drawer.
  app.db
    .prepare(
      `INSERT INTO cashier_shifts
       (tenant_id, user_id, date, opening_balance, cash_sales, cash_refunds, cash_purchases, cash_in, cash_out, expected_cash, actual_cash, difference, notes)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, 0, '')`
    )
    .run(freshTenantId, userId, yesterday, 87.5);

  const summary = await app.api("GET", "/api/cash-flow/summary", { tenantId: freshTenantId });
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(
    summary.body.openingBalance,
    87.5,
    "opening balance must carry forward from the last Cash Out even without a Complete Settlement"
  );
});

test("the register stays open across a midnight rollover instead of silently resetting", async () => {
  // Regression for a live bug: /api/cash-flow and /api/cash-flow/summary used to scope every sum
  // to `date(created_at, 'localtime') = today`, so cash movements made before local midnight
  // vanished from the register's view the instant the calendar day rolled over — even though
  // nothing was ever actually closed/settled. The register must instead stay open until the owner
  // explicitly closes it (Cash Out or Complete Settlement), no matter how many days that takes.
  const freshTenantId = seedTenant(app.db, "Multi-Day Open Co", "multi-day-open-test@example.com");

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  app.db
    .prepare(
      "INSERT INTO cash_flow (tenant_id, type, amount, currency, exchange_rate, reason, created_at) VALUES (?, 'in', 40, 'USD', 1, 'Owner float top-up', ?)"
    )
    .run(freshTenantId, threeDaysAgo);

  const entries = await app.api("GET", "/api/cash-flow", { tenantId: freshTenantId });
  assert.equal(entries.status, 200, JSON.stringify(entries.body));
  assert.equal(entries.body.length, 1, "a 3-day-old, never-closed entry must still show in the register's movements list");

  const summary = await app.api("GET", "/api/cash-flow/summary", { tenantId: freshTenantId });
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.totalIn, 40, "a 3-day-old, never-closed entry must still count toward the register's totals");
  assert.equal(summary.body.expectedBalance, 40, "expected balance must include cash from before the most recent midnight");
});
