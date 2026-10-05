// Extra barcodes (product_barcodes) are soft-deleted and keep their global_id across saves. The old
// delete-and-reinsert gave every save fresh global_ids while the cloud still held the previous rows
// with the same barcodes, so every push failed on the cloud's UNIQUE(barcode) and retried forever.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Barcode Co", "barcode-co@example.com");
});
after(async () => { await app.close(); });

const body = (name: string, barcodes: string[]) => ({ name, price: 1, stock: 0, category: "general", currency: "USD", unit: "pcs", barcodes });
const rowOf = (barcode: string) => app.db.prepare("SELECT * FROM product_barcodes WHERE barcode = ?").get(barcode) as any;
async function barcodesOf(id: number) {
  const list = (await app.api("GET", "/api/products", { tenantId })).body as any[];
  return list.find((p) => p.id === id).barcodes;
}

test("saving a product keeps kept barcodes' global_ids and soft-deletes removed ones", async () => {
  const created = await app.api("POST", "/api/products", { tenantId, body: body("Soap", ["SD-P", "SD-A", "SD-B"]) });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id;
  const a = rowOf("SD-A");
  const b = rowOf("SD-B");

  const upd = await app.api("PUT", `/api/products/${id}`, { tenantId, body: body("Soap", ["SD-P", "SD-A", "SD-C"]) });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.deepEqual(await barcodesOf(id), ["SD-P", "SD-A", "SD-C"]);
  assert.equal(rowOf("SD-A").global_id, a.global_id, "kept barcode keeps its global_id");
  assert.equal(rowOf("SD-A").deleted_at, null);
  assert.ok(rowOf("SD-B").deleted_at, "removed barcode is soft-deleted, not deleted");
  assert.equal(rowOf("SD-B").global_id, b.global_id);

  // A soft-deleted barcode no longer finds the product.
  assert.equal((await app.api("GET", "/api/products/SD-B", { tenantId })).status, 404);

  // Re-adding it revives the same row.
  await app.api("PUT", `/api/products/${id}`, { tenantId, body: body("Soap", ["SD-P", "SD-A", "SD-B"]) });
  assert.deepEqual(await barcodesOf(id), ["SD-P", "SD-A", "SD-B"]);
  assert.equal(rowOf("SD-B").global_id, b.global_id);
  assert.equal(rowOf("SD-B").deleted_at, null);
  assert.ok(rowOf("SD-C").deleted_at);
});

test("a barcode removed from one product can be reused by another (row moves, same global_id)", async () => {
  const p1 = (await app.api("POST", "/api/products", { tenantId, body: body("Shampoo", ["MV-P1", "MV-X"]) })).body.id;
  const x = rowOf("MV-X");
  await app.api("PUT", `/api/products/${p1}`, { tenantId, body: body("Shampoo", ["MV-P1"]) });

  const created = await app.api("POST", "/api/products", { tenantId, body: body("Conditioner", ["MV-P2", "MV-X"]) });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const p2 = created.body.id;
  assert.deepEqual(await barcodesOf(p2), ["MV-P2", "MV-X"]);
  assert.deepEqual(await barcodesOf(p1), ["MV-P1"]);
  assert.equal(rowOf("MV-X").global_id, x.global_id);
  assert.equal(rowOf("MV-X").product_id, p2);
  assert.equal(rowOf("MV-X").deleted_at, null);
});

test("a barcode live on another product is still rejected", async () => {
  await app.api("POST", "/api/products", { tenantId, body: body("Gel", ["TK-P1", "TK-X"]) });
  const res = await app.api("POST", "/api/products", { tenantId, body: body("Foam", ["TK-P2", "TK-X"]) });
  assert.equal(res.status, 409, JSON.stringify(res.body));
});
