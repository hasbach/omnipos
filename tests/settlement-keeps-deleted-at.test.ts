// Settlement moves every live transactional row into its archived twin by an explicit column list.
// deleted_at was missing from all four lists, so a soft-deleted row would land in the archive as a
// live one. No code path soft-deletes these tables today (voids, edits and settlement hard-delete
// with tombstones), but a soft-deleted row must never come back to life by being archived.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedProduct, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Archive Marker Co", "archive-marker@example.com");
});

after(async () => {
  await app.close();
});

test("settlement keeps deleted_at on archived transactions, items, payments and cash flow", async () => {
  const deletedAt = "2026-11-20 10:00:00";
  const tx = Number(app.db.prepare(
    "INSERT INTO transactions (tenant_id, type, total_amount, currency, exchange_rate, status, deleted_at) VALUES (?, 'sale', 20, 'USD', 1, 'completed', ?)",
  ).run(tenantId, deletedAt).lastInsertRowid);
  const product = seedProduct(app.db, tenantId, { barcode: "ARCHIVE-MARKER", name: "Marker item", price: 10 });
  app.db.prepare("INSERT INTO transaction_items (transaction_id, product_id, quantity, unit_price, deleted_at) VALUES (?, ?, 2, 10, ?)").run(tx, product, deletedAt);
  app.db.prepare("INSERT INTO payments (transaction_id, amount, method, currency, exchange_rate, deleted_at) VALUES (?, 20, 'cash', 'USD', 1, ?)").run(tx, deletedAt);
  app.db.prepare("INSERT INTO cash_flow (tenant_id, type, amount, currency, exchange_rate, reason, deleted_at) VALUES (?, 'out', 5, 'USD', 1, 'Removed entry', ?)").run(tenantId, deletedAt);
  // A live row next to them keeps a NULL marker.
  const live = Number(app.db.prepare(
    "INSERT INTO transactions (tenant_id, type, total_amount, currency, exchange_rate, status) VALUES (?, 'sale', 7, 'USD', 1, 'completed')",
  ).run(tenantId).lastInsertRowid);

  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));

  const marker = (sql: string, ...args: unknown[]) => (app.db.prepare(sql).get(...args) as any)?.deleted_at;
  assert.equal(marker("SELECT deleted_at FROM archived_transactions WHERE id = ?", tx), deletedAt);
  assert.equal(marker("SELECT deleted_at FROM archived_transaction_items WHERE transaction_id = ?", tx), deletedAt);
  assert.equal(marker("SELECT deleted_at FROM archived_payments WHERE transaction_id = ?", tx), deletedAt);
  assert.equal(marker("SELECT deleted_at FROM archived_cash_flow WHERE tenant_id = ? AND reason = 'Removed entry'", tenantId), deletedAt);
  assert.equal(marker("SELECT deleted_at FROM archived_transactions WHERE id = ?", live), null);
});
