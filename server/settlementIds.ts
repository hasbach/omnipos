// Settlement copies live transactions / transaction_items / payments into their archived twins with
// their ids intact, so a live row whose id already exists in the archive makes the INSERT fail.
//
// In normal operation that cannot happen: live ids come from AUTOINCREMENT, archived transaction ids
// are all former live ids, and archive-only item/payment rows reserve their id in the live sequence
// (reserveSharedId in invoiceEdit.ts). It only happens on a database whose sqlite_sequence was reset
// or restored below the archive at some point. This repairs that case — and ONLY for the settling
// tenant's own live rows that actually collide. (It used to shift every tenant's live ids by a blanket
// offset whenever MIN(live id) <= MAX(archived id), which fired whenever another tenant simply had
// older live sales, and died with "FOREIGN KEY constraint failed" on the parent-id update.)
import { db } from "./db.js";

type LiveTable = "transactions" | "transaction_items" | "payments";

function highWater(liveTable: LiveTable, archivedTable: string): number {
  const seq = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(liveTable) as any)?.seq || 0;
  const maxLive = (db.prepare(`SELECT IFNULL(MAX(id), 0) as m FROM ${liveTable}`).get() as any).m;
  const maxArch = (db.prepare(`SELECT IFNULL(MAX(id), 0) as m FROM ${archivedTable}`).get() as any).m;
  return Math.max(seq, maxLive, maxArch);
}

// Move the live table's AUTOINCREMENT past everything either table has used, so ids handed out after
// this settlement can never collide with the archive again.
function advanceSequence(liveTable: LiveTable, archivedTable: string) {
  const next = highWater(liveTable, archivedTable);
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(liveTable) as any;
  if (row) { if (row.seq < next) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(next, liveTable); }
  else if (next > 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(liveTable, next);
}

/** Must run inside the settlement's db.transaction(), before the rows are copied to the archive. */
export function resolveArchiveIdCollisions(tenantId: number) {
  const txCollisions = (db.prepare(
    "SELECT id FROM transactions WHERE tenant_id = ? AND id IN (SELECT id FROM archived_transactions) ORDER BY id"
  ).all(tenantId) as any[]).map(r => r.id as number);

  if (txCollisions.length > 0) {
    // transaction_items / payments reference transactions(id) with no ON UPDATE CASCADE; defer the
    // check to COMMIT so the parent and its children can be renumbered one statement at a time.
    // (defer_foreign_keys switches itself back off when the transaction ends.)
    db.pragma("defer_foreign_keys = ON");
    let next = highWater("transactions", "archived_transactions");
    const moveTx = db.prepare("UPDATE transactions SET id = ? WHERE id = ? AND tenant_id = ?");
    const moveItems = db.prepare("UPDATE transaction_items SET transaction_id = ? WHERE transaction_id = ?");
    const movePayments = db.prepare("UPDATE payments SET transaction_id = ? WHERE transaction_id = ?");
    // A live refund pointing at this id means the LIVE sale (findOriginalSale checks live first).
    const moveRefundLinks = db.prepare("UPDATE transactions SET original_transaction_id = ? WHERE tenant_id = ? AND original_transaction_id = ?");
    const moveEdits = db.prepare("UPDATE transaction_edits SET transaction_id = ? WHERE tenant_id = ? AND archived = 0 AND transaction_id = ?");
    for (const oldId of txCollisions) {
      const newId = ++next;
      moveTx.run(newId, oldId, tenantId);
      moveItems.run(newId, oldId);
      movePayments.run(newId, oldId);
      moveRefundLinks.run(newId, tenantId, oldId);
      moveEdits.run(newId, tenantId, oldId);
    }
  }

  const itemCollisions = db.prepare(`
    SELECT ti.id, ti.transaction_id FROM transaction_items ti
    JOIN transactions t ON t.id = ti.transaction_id
    WHERE t.tenant_id = ? AND ti.id IN (SELECT id FROM archived_transaction_items)
    ORDER BY ti.id
  `).all(tenantId) as any[];
  if (itemCollisions.length > 0) {
    let next = highWater("transaction_items", "archived_transaction_items");
    const moveItem = db.prepare("UPDATE transaction_items SET id = ? WHERE id = ?");
    // Refund lines name the original sale line they return; only refunds of THIS (live) sale mean it.
    const moveRefundLines = db.prepare(`
      UPDATE transaction_items SET original_item_id = ?
      WHERE original_item_id = ? AND transaction_id IN (SELECT id FROM transactions WHERE tenant_id = ? AND type = 'refund' AND original_transaction_id = ?)
    `);
    for (const item of itemCollisions) {
      const newId = ++next;
      moveItem.run(newId, item.id);
      moveRefundLines.run(newId, item.id, tenantId, item.transaction_id);
    }
  }

  const paymentCollisions = (db.prepare(`
    SELECT p.id FROM payments p
    JOIN transactions t ON t.id = p.transaction_id
    WHERE t.tenant_id = ? AND p.id IN (SELECT id FROM archived_payments)
    ORDER BY p.id
  `).all(tenantId) as any[]).map(r => r.id as number);
  if (paymentCollisions.length > 0) {
    let next = highWater("payments", "archived_payments");
    const movePayment = db.prepare("UPDATE payments SET id = ? WHERE id = ?");
    for (const oldId of paymentCollisions) movePayment.run(++next, oldId);
  }

  advanceSequence("transactions", "archived_transactions");
  advanceSequence("transaction_items", "archived_transaction_items");
  advanceSequence("payments", "archived_payments");
}
