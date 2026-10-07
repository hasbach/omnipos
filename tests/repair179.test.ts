// v1.7.9 one-time repair (server/repair179.ts): rows that 1.7.8 re-downloaded from the cloud after a
// local settlement (copies of archived transactions / cash_flow / shifts with NEW global_ids) plus the
// duplicate seeded Admin / USD / Walk-in rows are removed or merged, balances recomputed, the cloud
// copies tombstoned, a backup taken first, and a second run is a no-op.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let repair: typeof import("../server/repair179.js");
let balance: typeof import("../server/balance.js");
let tenantId: number;
let otherTenantId: number;
let productId: number;
let customerId: number;
let keptWalkIn: number;
let dupWalkIn: number;
let keptAdmin: number;
let dupAdmin: number;
let tmpDir: string;
const copiedTx: { id: number; global_id: string }[] = [];
const copiedItems: string[] = [];
const copiedPays: string[] = [];
const copiedCash: string[] = [];
let copiedShift: string;
let genuineSaleId: number;
let balanceAfterSettlement: number;
let otherTenantSaleId: number;

const get = (sql: string, ...p: any[]) => app.db.prepare(sql).get(...p) as any;
const all = (sql: string, ...p: any[]) => app.db.prepare(sql).all(...p) as any[];
const cols = (table: string) => all(`PRAGMA table_info(${table})`).map((c) => c.name as string);
const SKIP = new Set(["id", "global_id", "updated_at", "deleted_at", "last_synced_at"]);

// Insert a copy of an archived row into its live table with a NEW global_id (what the bad pull did).
function copyRow(liveTable: string, row: any, overrides: Record<string, any> = {}): number {
  const live = cols(liveTable).filter((c) => !SKIP.has(c) && c in row);
  const values = live.map((c) => (c in overrides ? overrides[c] : row[c]));
  const r = app.db.prepare(`INSERT INTO ${liveTable} (${live.join(",")}) VALUES (${live.map(() => "?").join(",")})`).run(...values);
  return Number(r.lastInsertRowid);
}

before(async () => {
  app = await createTestApp();
  repair = await import("../server/repair179.js");
  balance = await import("../server/balance.js");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omnipos-repair-"));
  tenantId = seedTenant(app.db, "Repair Co", "repair-co@example.com");
  otherTenantId = seedTenant(app.db, "Bystander Co", "repair-bystander@example.com");
  productId = seedProduct(app.db, tenantId, { barcode: "RP-1", name: "Repair Item", price: 10, stock: 100 });
  const otherProduct = seedProduct(app.db, otherTenantId, { barcode: "RP-2", name: "Other Item", price: 5, stock: 100 });
  keptWalkIn = get("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'", tenantId).id;
  keptAdmin = get("SELECT id FROM users WHERE tenant_id = ? AND name = 'Admin'", tenantId).id;

  customerId = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Credit Customer", type: "customer" } })).body.id;
  const post = async (body: any, t = tenantId) => {
    const r = await app.api("POST", "/api/transactions", { tenantId: t, body });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id as number;
  };
  await post({ type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] });
  await post({ type: "sale", stakeholder_id: customerId, items: [{ id: productId, quantity: 2 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }] }); // owes 15
  await app.api("POST", "/api/cash-flow", { tenantId, body: { type: "out", amount: 7, currency: "USD", exchange_rate: 1, reason: "Repair petty cash" } });
  // The bystander tenant has a live (unsettled) sale that must never be touched.
  otherTenantSaleId = await post({ type: "sale", items: [{ id: otherProduct, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }] }, otherTenantId);

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: { user_id: keptAdmin, counted: [{ currency: "USD", amount: 10, rate: 1 }], notes: "" } });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  balanceAfterSettlement = get("SELECT balance FROM stakeholders WHERE id = ?", customerId).balance;
  assert.equal(balanceAfterSettlement, -15);
  assert.equal(get("SELECT COUNT(*) c FROM transactions WHERE tenant_id = ?", tenantId).c, 0);

  // --- simulate the 1.7.8 pull: copies of every archived row land in the live tables ---
  for (const a of all("SELECT * FROM archived_transactions WHERE tenant_id = ? ORDER BY id", tenantId)) {
    const newId = copyRow("transactions", a);
    copiedTx.push({ id: newId, global_id: get("SELECT global_id FROM transactions WHERE id = ?", newId).global_id });
    for (const it of all("SELECT * FROM archived_transaction_items WHERE transaction_id = ?", a.id)) {
      const iid = copyRow("transaction_items", it, { transaction_id: newId });
      copiedItems.push(get("SELECT global_id FROM transaction_items WHERE id = ?", iid).global_id);
    }
    for (const p of all("SELECT * FROM archived_payments WHERE transaction_id = ?", a.id)) {
      const pid = copyRow("payments", p, { transaction_id: newId });
      copiedPays.push(get("SELECT global_id FROM payments WHERE id = ?", pid).global_id);
    }
  }
  assert.equal(copiedTx.length, 2);
  for (const c of all("SELECT * FROM archived_cash_flow WHERE tenant_id = ?", tenantId)) {
    const cid = copyRow("cash_flow", c);
    copiedCash.push(get("SELECT global_id FROM cash_flow WHERE id = ?", cid).global_id);
  }
  assert.equal(copiedCash.length, 1);
  const shiftId = Number(app.db.prepare(
    `INSERT INTO cashier_shifts (tenant_id, user_id, date, opening_balance, actual_cash, created_at)
     VALUES (?, ?, '2020-01-01', 0, 1, (SELECT datetime(MAX(created_at), '-1 hour') FROM daily_reports WHERE tenant_id = ?))`
  ).run(tenantId, keptAdmin, tenantId).lastInsertRowid);
  copiedShift = get("SELECT global_id FROM cashier_shifts WHERE id = ?", shiftId).global_id;

  // --- duplicates from the other PC's test login ---
  dupAdmin = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role) VALUES (?, 'Admin', 'admin')").run(tenantId).lastInsertRowid);
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'usd', '$', 1, 0)").run(tenantId);
  dupWalkIn = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Walk-in Customer', 'customer')").run(tenantId).lastInsertRowid);
  // A genuine post-settlement sale by the dup Admin to the dup Walk-in.
  genuineSaleId = await post({ type: "sale", stakeholder_id: dupWalkIn, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }] });
  app.db.prepare("UPDATE transactions SET user_id = ? WHERE id = ?").run(dupAdmin, genuineSaleId);
  app.db.prepare("INSERT INTO user_logs (tenant_id, user_id, action, details) VALUES (?, ?, 'x', 'y')").run(tenantId, dupAdmin);

  // The bad state: balance double-counted.
  balance.recomputeAllBalances(tenantId);
  assert.equal(get("SELECT balance FROM stakeholders WHERE id = ?", customerId).balance, -30);
});

after(async () => {
  await app.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("a failing backup aborts the repair: nothing changed, migration not marked", () => {
  const blocker = path.join(tmpDir, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  assert.throws(() => repair.runRepair179({ backupDir: blocker }));
  assert.equal(get("SELECT COUNT(*) c FROM _migrations WHERE name = ?", repair.REPAIR_179_NAME).c, 0);
  assert.equal(get("SELECT COUNT(*) c FROM transactions WHERE tenant_id = ?", tenantId).c, 3);
  assert.equal(get("SELECT balance FROM stakeholders WHERE id = ?", customerId).balance, -30);
});

test("repair removes the resurrected rows, merges duplicates, restores balances and takes a backup", () => {
  const report = repair.runRepair179({ backupDir: tmpDir });
  assert.ok(report && report.applied);
  assert.ok(report.backup && fs.existsSync(report.backup), "backup file should exist");
  assert.ok(report.report_path && fs.existsSync(report.report_path), "json report should exist");
  assert.deepEqual(report.tenants.map((t) => t.tenant_id), [tenantId], "only the affected tenant is repaired");
  const t = report.tenants[0];
  assert.equal(t.removed_transactions, 2);
  assert.equal(t.removed_cash_flow, 1);
  assert.equal(t.removed_shifts, 1);
  assert.equal(t.merged_users, 1);
  assert.equal(t.merged_currencies, 1);
  assert.equal(t.merged_walk_ins, 1);
  const change = t.balance_changes.find((c) => c.stakeholder_id === customerId);
  assert.deepEqual([change?.before, change?.after], [-30, -15]);

  // live copies gone
  for (const c of copiedTx) assert.equal(get("SELECT COUNT(*) c FROM transactions WHERE id = ?", c.id).c, 0);
  assert.equal(get("SELECT COUNT(*) c FROM cash_flow WHERE tenant_id = ? AND reason = 'Repair petty cash'", tenantId).c, 0);
  assert.equal(get("SELECT COUNT(*) c FROM cashier_shifts WHERE tenant_id = ?", tenantId).c, 0);
  // archive intact
  assert.equal(get("SELECT COUNT(*) c FROM archived_transactions WHERE tenant_id = ?", tenantId).c, 2);

  // tombstones for the cloud delete
  const tomb = (table: string, gid: string) => get("SELECT * FROM sync_tombstones WHERE table_name = ? AND global_id = ?", table, gid);
  for (const c of copiedTx) { const r = tomb("transactions", c.global_id); assert.ok(r && r.cloud_purged_at === null); }
  for (const g of copiedItems) { const r = tomb("transaction_items", g); assert.ok(r && r.cloud_purged_at === null && r.parent_global_id); }
  for (const g of copiedPays) { const r = tomb("payments", g); assert.ok(r && r.cloud_purged_at === null && r.parent_global_id); }
  for (const g of copiedCash) { const r = tomb("cash_flow", g); assert.ok(r && r.cloud_purged_at === null); }
  { const r = tomb("cashier_shifts", copiedShift); assert.ok(r && r.cloud_purged_at === null); }

  // balance back to the value right after settlement
  assert.equal(get("SELECT balance FROM stakeholders WHERE id = ?", customerId).balance, balanceAfterSettlement);

  // duplicates merged
  assert.ok(get("SELECT deleted_at FROM users WHERE id = ?", dupAdmin).deleted_at);
  assert.equal(get("SELECT deleted_at FROM users WHERE id = ?", keptAdmin).deleted_at, null);
  assert.equal(get("SELECT user_id FROM transactions WHERE id = ?", genuineSaleId).user_id, keptAdmin);
  assert.equal(get("SELECT COUNT(*) c FROM user_logs WHERE user_id = ?", dupAdmin).c, 0);
  assert.equal(get("SELECT COUNT(*) c FROM currencies WHERE tenant_id = ? AND deleted_at IS NULL", tenantId).c, 1);
  assert.equal(get("SELECT COUNT(*) c FROM currencies WHERE tenant_id = ? AND deleted_at IS NULL AND is_default = 1", tenantId).c, 1);
  assert.ok(get("SELECT deleted_at FROM stakeholders WHERE id = ?", dupWalkIn).deleted_at);
  assert.equal(get("SELECT deleted_at FROM stakeholders WHERE id = ?", keptWalkIn).deleted_at, null);
  assert.equal(get("SELECT stakeholder_id FROM transactions WHERE id = ?", genuineSaleId).stakeholder_id, keptWalkIn);

  // the genuine post-settlement sale is untouched; so is the other tenant
  const genuine = get("SELECT * FROM transactions WHERE id = ?", genuineSaleId);
  assert.ok(genuine && genuine.total_amount === 10);
  assert.equal(get("SELECT COUNT(*) c FROM payments WHERE transaction_id = ?", genuineSaleId).c, 1);
  assert.equal(get("SELECT COUNT(*) c FROM transaction_items WHERE transaction_id = ?", genuineSaleId).c, 1);
  assert.ok(get("SELECT id FROM transactions WHERE id = ? AND tenant_id = ?", otherTenantSaleId, otherTenantId));

  // marked done
  assert.equal(get("SELECT COUNT(*) c FROM _migrations WHERE name = ?", repair.REPAIR_179_NAME).c, 1);
});

test("a second run is a no-op", () => {
  const before = fs.readdirSync(tmpDir).length;
  const txBefore = get("SELECT COUNT(*) c FROM transactions").c;
  assert.equal(repair.runRepair179({ backupDir: tmpDir }), null);
  assert.equal(fs.readdirSync(tmpDir).length, before, "no new backup");
  assert.equal(get("SELECT COUNT(*) c FROM transactions").c, txBefore);
});
