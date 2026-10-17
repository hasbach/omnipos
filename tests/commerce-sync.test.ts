// Commerce foundation, Slice A — stores / store_listings sync like products
// (specs/001-commerce-domain-foundation, research R10): pushed with FK ids translated to global
// UUIDs, pulled on the cold schedule, and skipped cleanly while the cloud migration isn't applied.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let sync: typeof import("../server/sync.js");

before(async () => {
  app = await createTestApp();
  sync = await import("../server/sync.js");
});
after(async () => { await app.close(); });

function seedStoreWithListing(label: string) {
  const tenantId = seedTenant(app.db, `Sync Store ${label}`, `syncstore-${label}-${Date.now()}@example.com`);
  const productId = seedProduct(app.db, tenantId, { barcode: `SS-${label}`, name: "Juice", price: 2 });
  const storeId = Number(app.db.prepare("INSERT INTO stores (tenant_id, name) VALUES (?, 'Shop')").run(tenantId).lastInsertRowid);
  const listingId = Number(app.db.prepare("INSERT INTO store_listings (tenant_id, store_id, product_id, published) VALUES (?, ?, ?, 1)")
    .run(tenantId, storeId, productId).lastInsertRowid);
  return { tenantId, productId, storeId, listingId };
}

// Minimal Supabase stand-in: records upserts per table; tables in `missing` answer like PostgREST
// does for a table that doesn't exist yet.
function fakeClient(missing: Set<string>) {
  const upserts: Record<string, any[]> = {};
  return {
    upserts,
    client: {
      from(table: string) {
        return {
          async upsert(payload: any) {
            if (missing.has(table)) return { error: { code: "PGRST205", message: `no table ${table}` } };
            (upserts[table] ||= []).push(...(Array.isArray(payload) ? payload : [payload]));
            return { error: null };
          },
        };
      },
    } as any,
  };
}

test("stores and store_listings are pull tables on the cold schedule, after products", () => {
  assert.ok(sync.COLD_PULL_TABLES.includes("stores"));
  assert.ok(sync.COLD_PULL_TABLES.includes("store_listings"));
  assert.ok(!sync.HOT_PULL_TABLES.includes("stores"));
});

test("push: new store and listing are pending, then pushed with global ids for tenant, store and product", async () => {
  const s = seedStoreWithListing("push");
  const pending = sync.countPendingPush(s.tenantId);
  assert.equal(pending.stores, 1);
  assert.equal(pending.store_listings, 1);

  const fake = fakeClient(new Set());
  await sync.pushToCloud(fake.client, s.tenantId);

  const gid = (t: string, id: number) => (app.db.prepare(`SELECT global_id FROM ${t} WHERE id = ?`).get(id) as any).global_id;
  const store = fake.upserts.stores?.find((r) => r.local_id === s.storeId);
  assert.ok(store, "store pushed");
  assert.equal(store.tenant_id, gid("tenants", s.tenantId));
  const listing = fake.upserts.store_listings?.find((r) => r.local_id === s.listingId);
  assert.ok(listing, "listing pushed");
  assert.equal(listing.store_id, gid("stores", s.storeId));
  assert.equal(listing.product_id, gid("products", s.productId));
  assert.equal(listing.tenant_id, gid("tenants", s.tenantId));

  const after = sync.countPendingPush(s.tenantId);
  assert.equal(after.stores, undefined);
  assert.equal(after.store_listings, undefined);
});

// Runs last: the "cloud has no such table" memory is module-wide until restart (by design).
test("push before the cloud migration: commerce tables are skipped, rows stay pending, products still push", async () => {
  const s = seedStoreWithListing("missing");
  const fake = fakeClient(new Set(["stores", "store_listings"]));
  await sync.pushToCloud(fake.client, s.tenantId);

  assert.ok(fake.upserts.products?.some((r) => r.local_id === s.productId), "products still pushed");
  const pending = sync.countPendingPush(s.tenantId);
  assert.equal(pending.stores, 1, "store stays pending until the cloud table exists");
  assert.equal(pending.store_listings, 1);
});
