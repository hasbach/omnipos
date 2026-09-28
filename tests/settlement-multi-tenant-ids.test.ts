// Regression test: End-of-Day settlement used to run an id-offset step over EVERY tenant's live
// transactions ("UPDATE transactions SET id = id + ?") whenever MIN(live id) <= MAX(archived id).
// Once one business had settled, any other business with older live sales tripped it, and the
// parent-id update died with "FOREIGN KEY constraint failed" (HTTP 500) — that business could never
// settle again. Settlement must only ever touch the settling tenant's own rows, and only renumber
// ids that genuinely collide with the archive (a legacy sequence-reset database).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantA: number;
let tenantB: number;
let productA: number;
let productB: number;
let firstSaleB: number; // B's sale archived by the first test

before(async () => {
  app = await createTestApp();
  tenantA = seedTenant(app.db, "Business A", "settle-a@example.com");
  tenantB = seedTenant(app.db, "Business B", "settle-b@example.com");
  productA = seedProduct(app.db, tenantA, { barcode: "SET-A", name: "A Product", price: 10 });
  productB = seedProduct(app.db, tenantB, { barcode: "SET-B", name: "B Product", price: 5 });
});

after(async () => {
  await app.close();
});

async function sale(tenantId: number, productId: number, price: number) {
  const res = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
      payments: [{ amount: price, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as number;
}

async function settle(tenantId: number) {
  const res = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

function archivedSnapshot(tenantId: number) {
  return {
    tx: app.db.prepare("SELECT * FROM archived_transactions WHERE tenant_id = ? ORDER BY id").all(tenantId),
    items: app.db.prepare("SELECT * FROM archived_transaction_items WHERE transaction_id IN (SELECT id FROM archived_transactions WHERE tenant_id = ?) ORDER BY id").all(tenantId),
    payments: app.db.prepare("SELECT * FROM archived_payments WHERE transaction_id IN (SELECT id FROM archived_transactions WHERE tenant_id = ?) ORDER BY id").all(tenantId),
  };
}

test("B settles after A: B's older live sales are archived as-is and A's archive is untouched", async () => {
  const saleB = firstSaleB = await sale(tenantB, productB, 5); // older live sale, lower id
  const saleA = await sale(tenantA, productA, 10);
  assert.ok(saleB < saleA);

  await settle(tenantA); // A now has archived rows with ids above B's live ones
  const aBefore = archivedSnapshot(tenantA);
  assert.equal(aBefore.tx.length, 1);

  await settle(tenantB); // used to fail: FOREIGN KEY constraint failed

  const archivedB = app.db.prepare("SELECT id FROM archived_transactions WHERE tenant_id = ?").all(tenantB) as any[];
  assert.deepEqual(archivedB.map(r => r.id), [saleB], "B's sale should be archived with its original id (no collision)");
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM archived_transaction_items WHERE transaction_id = ?").get(saleB) as any).c, 1);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM archived_payments WHERE transaction_id = ?").get(saleB) as any).c, 1);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM transactions").get() as any).c, 0);
  assert.deepEqual(archivedSnapshot(tenantA), aBefore, "A's archived data changed when B settled");
});

test("after a legacy sequence reset, B's colliding ids are renumbered with every reference kept", async () => {
  await sale(tenantA, productA, 10);
  await sale(tenantA, productA, 10);
  await settle(tenantA);
  const aBefore = archivedSnapshot(tenantA);

  // Simulate an old database whose AUTOINCREMENT counters were reset below the archive: B's next
  // rows get ids that A's archived rows already hold.
  const aTx = (aBefore.tx as any[]).map(r => r.id);
  const aItems = (aBefore.items as any[]).map(r => r.id);
  const aPays = (aBefore.payments as any[]).map(r => r.id);
  app.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'transactions'").run(aTx[aTx.length - 2] - 1);
  app.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'transaction_items'").run(aItems[aItems.length - 2] - 1);
  app.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'payments'").run(aPays[aPays.length - 2] - 1);

  const saleB = await sale(tenantB, productB, 5);
  assert.ok(aTx.includes(saleB), "setup: B's sale id should collide with an archived id of A");
  const refund = await app.api("POST", "/api/transactions", {
    tenantId: tenantB,
    body: {
      type: "refund", original_transaction_id: saleB, items: [{ id: productB, quantity: 1 }],
      currency: "USD", exchange_rate: 1, payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }],
    },
  });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const saleItemId = (app.db.prepare("SELECT id FROM transaction_items WHERE transaction_id = ?").get(saleB) as any).id;
  assert.ok(aItems.includes(saleItemId), "setup: B's sale line id should collide with an archived line of A");

  await settle(tenantB);

  assert.deepEqual(archivedSnapshot(tenantA), aBefore, "A's archived data changed when B settled");

  const bTx = (app.db.prepare("SELECT * FROM archived_transactions WHERE tenant_id = ? ORDER BY id").all(tenantB) as any[])
    .filter(t => t.id !== firstSaleB);
  const bSale = bTx.find(t => t.type === "sale");
  const bRefund = bTx.find(t => t.type === "refund");
  assert.ok(bSale && bRefund, "B's sale and refund should both be archived");
  assert.ok(!aTx.includes(bSale.id) && !aTx.includes(bRefund.id), "B's archived ids must not reuse A's");
  assert.equal(bRefund.original_transaction_id, bSale.id, "refund must still point at its (renumbered) sale");

  const saleItems = app.db.prepare("SELECT * FROM archived_transaction_items WHERE transaction_id = ?").all(bSale.id) as any[];
  const refundItems = app.db.prepare("SELECT * FROM archived_transaction_items WHERE transaction_id = ?").all(bRefund.id) as any[];
  assert.equal(saleItems.length, 1);
  assert.equal(refundItems.length, 1);
  assert.equal(refundItems[0].original_item_id, saleItems[0].id, "refund line must still point at its sale line");
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM archived_payments WHERE transaction_id = ?").get(bSale.id) as any).c, 1);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM archived_payments WHERE transaction_id = ?").get(bRefund.id) as any).c, 1);

  // The counters were moved past the archive, so new live rows can't collide again.
  const next = await sale(tenantB, productB, 5);
  const maxArchived = (app.db.prepare("SELECT MAX(id) m FROM archived_transactions").get() as any).m;
  assert.ok(next > maxArchived, `next live id ${next} should be above the archive (${maxArchived})`);
  await settle(tenantB);
});
