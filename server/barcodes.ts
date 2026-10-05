import { db } from './db.js';

// A product's EXTRA barcodes (product_barcodes) are soft-deleted, like product_units, so a removal
// syncs to the cloud and stays recoverable there. A barcode the product keeps keeps its row (and so
// its global_id): the old delete-and-reinsert gave every save fresh global_ids, the cloud still held
// the previous rows with the same barcodes, and every push failed on the barcode — retried forever.
//
// Must run inside the caller's db.transaction. `barcodes` is the product's extra barcodes (primary
// barcode excluded). A barcode that is live on ANOTHER product is skipped — callers validate first
// (assertBarcodesFree) or deliberately ignore such duplicates (bulk import).
export function setExtraBarcodes(tenantId: number, productId: number, barcodes: string[]) {
  const wanted = [...new Set(barcodes.map((b) => String(b ?? '').trim()).filter(Boolean))];

  db.prepare(
    "UPDATE product_barcodes SET deleted_at = CURRENT_TIMESTAMP WHERE product_id = ? AND deleted_at IS NULL AND barcode NOT IN (SELECT value FROM json_each(?))"
  ).run(productId, JSON.stringify(wanted));

  // barcode is UNIQUE across the local database, so at most one row (live or soft-deleted) holds it.
  const holder = db.prepare(
    "SELECT pb.id, pb.product_id, pb.deleted_at, p.tenant_id FROM product_barcodes pb LEFT JOIN products p ON p.id = pb.product_id WHERE pb.barcode = ?"
  );
  const revive = db.prepare("UPDATE product_barcodes SET product_id = ?, deleted_at = NULL WHERE id = ?");
  const insert = db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)");
  const purge = db.prepare("DELETE FROM product_barcodes WHERE id = ?");

  for (const bc of wanted) {
    const row = holder.get(bc) as any;
    if (!row) { insert.run(productId, bc); continue; }
    if (row.product_id === productId) { if (row.deleted_at) revive.run(productId, row.id); continue; }
    if (!row.deleted_at) continue; // live on another product
    if (row.tenant_id === tenantId) {
      // Soft-deleted in this tenant: move the row here, so the cloud row is updated (same global_id).
      revive.run(productId, row.id);
    } else {
      // Soft-deleted row of another tenant (or of a product deleted locally): its cloud copy isn't
      // ours to update, so free the barcode locally and start a fresh row.
      purge.run(row.id);
      insert.run(productId, bc);
    }
  }
}
