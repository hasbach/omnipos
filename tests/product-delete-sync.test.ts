import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let sync: typeof import("../server/sync.js");
let tenant: number;
const GID = "eeeeeeee-0000-4000-8000-000000000001";
const STAMP = "2026-10-01T10:00:00.000Z";
let cloud: any[] = [];
type Request = { table: string; op: string; values?: any; ids?: string[] };
let requests: Request[] = [];
let writeError: any = null;

// One short cloud page; record writes so a product hard delete cannot pass unnoticed.
function makeFake() {
  return {
    from(table: string) {
      const req: Request = { table, op: "select" };
      const q: any = {
        select() { return q; }, eq() { return q; }, gte() { return q; }, gt() { return q; },
        or() { return q; }, order() { return q; }, limit() { return q; },
        in(_col: string, ids: string[]) { req.ids = ids; return q; },
        update(values: any) { req.op = "update"; req.values = values; return q; },
        delete() { req.op = "delete"; return q; },
        then(resolve: any, reject: any) {
          requests.push(req);
          return Promise.resolve(req.op === "select"
            ? { data: table === "products" ? cloud.map(r => ({ ...r, synced_at: r.updated_at })) : [], error: null }
            : { error: writeError }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
const one = (sql: string, ...args: any[]) => app.db.prepare(sql).get(...args) as any;
const tombstone = (gid: string) => one("SELECT * FROM sync_tombstones WHERE table_name = 'products' AND global_id = ?", gid);
let serial = 0;
function product() {
  const id = seedProduct(app.db, tenant, { barcode: `DELETE-${++serial}`, name: "Widget", price: 7 });
  const gid = one("SELECT global_id FROM products WHERE id = ?", id).global_id;
  const listing = Number(app.db.prepare("INSERT INTO store_listings (tenant_id, store_id, product_id, published, last_synced_at) VALUES (?, 1, ?, 1, '2000-01-01')").run(tenant, id).lastInsertRowid);
  const unit = Number(app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price) VALUES (?, ?, 'Each', 1, 7)").run(tenant, id).lastInsertRowid);
  app.db.prepare("INSERT INTO product_barcodes (product_id, barcode) VALUES (?, ?)").run(id, `EXTRA-${serial}`);
  return { id, gid, listing, unit };
}
function assertRemoved(p: ReturnType<typeof product>) {
  assert.equal(one("SELECT id FROM products WHERE id = ?", p.id), undefined);
  // The listing stays live (shown as "product deleted"); the cloud hides it via products.deleted_at.
  assert.equal(one("SELECT deleted_at FROM store_listings WHERE id = ?", p.listing).deleted_at, null);
  assert.ok(one("SELECT deleted_at FROM product_units WHERE id = ?", p.unit).deleted_at);
  assert.equal(one("SELECT COUNT(*) c FROM product_barcodes WHERE product_id = ?", p.id).c, 0);
}
before(async () => {
  app = await createTestApp();
  sync = await import("../server/sync.js");
  tenant = seedTenant(app.db, "Delete Co", "delete@example.com");
  app.db.prepare("UPDATE tenants SET global_id = ? WHERE id = ?").run(GID, tenant);
  sync.ensureTombstoneTable();
});
after(async () => { await app.close(); });
beforeEach(() => {
  cloud = []; requests = []; writeError = null;
  sync.clearSyncCursors(); sync.resetSyncedAtProbe();
});

test("DELETE product queues a tombstone, soft-deletes its units and keeps its listings", async () => {
  const p = product();
  const response = await app.api("DELETE", `/api/products/${p.id}`, { tenantId: tenant });
  assert.equal(response.status, 200);
  assertRemoved(p);
  assert.equal(tombstone(p.gid).cloud_purged_at, null);
  const again = await app.api("DELETE", `/api/products/${p.id}`, { tenantId: tenant });
  assert.equal(again.status, 200);
});

test("product tombstones update the cloud and remain pending on failure", async () => {
  const p = product();
  await app.api("DELETE", `/api/products/${p.id}`, { tenantId: tenant });
  writeError = { message: "offline" };
  await sync.purgeTombstonedFromCloud(makeFake() as any, tenant);
  assert.equal(tombstone(p.gid).cloud_purged_at, null);
  writeError = null; requests = [];
  await sync.purgeTombstonedFromCloud(makeFake() as any, tenant);
  const writes = requests.filter(r => r.table === "products");
  assert.ok(writes.length);
  assert.ok(writes.every(r => r.op === "update"));
  const update = writes.find(r => r.ids?.includes(p.gid))!;
  assert.ok(update);
  assert.ok(Number.isFinite(Date.parse(update.values.deleted_at)));
  assert.equal(update.values.updated_at, update.values.deleted_at);
  assert.ok(tombstone(p.gid).cloud_purged_at);
});

test("a pulled deletion wins over a pending edit and cannot resurrect", async () => {
  const p = product();
  assert.equal(one("SELECT last_synced_at FROM products WHERE id = ?", p.id).last_synced_at, null);
  cloud = [{ global_id: p.gid, tenant_id: GID, name: "Widget", price: 7, updated_at: STAMP, deleted_at: STAMP }];
  await sync.pullFromCloud(makeFake() as any, tenant, GID, ["products"]);
  assertRemoved(p);
  assert.ok(tombstone(p.gid).cloud_purged_at);
  sync.clearSyncCursors();
  await sync.pullFromCloud(makeFake() as any, tenant, GID, ["products"]);
  assert.equal(one("SELECT id FROM products WHERE global_id = ?", p.gid), undefined);
  // A stale live copy is also blocked by the retained tombstone.
  delete cloud[0].deleted_at;
  sync.clearSyncCursors();
  await sync.pullFromCloud(makeFake() as any, tenant, GID, ["products"]);
  assert.equal(one("SELECT id FROM products WHERE global_id = ?", p.gid), undefined);
});

test("a deleted cloud product never held locally is not inserted", async () => {
  const gid = "eeeeeeee-0000-4000-8000-000000000099";
  cloud = [{ global_id: gid, tenant_id: GID, name: "Gone", price: 1, updated_at: STAMP, deleted_at: STAMP }];
  await sync.pullFromCloud(makeFake() as any, tenant, GID, ["products"]);
  assert.equal(one("SELECT id FROM products WHERE global_id = ?", gid), undefined);
});
