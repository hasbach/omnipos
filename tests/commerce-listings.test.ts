// Commerce foundation, Slice A — US5 listings (specs/001-commerce-domain-foundation, data-model.md):
// a listing references a product, derives price / units / stock / availability from it at read time,
// validates its channel fields, bulk-publishes all-or-nothing and never exposes cost.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let commerce: typeof import("../server/commerce.js");
let n = 0;

before(async () => {
  app = await createTestApp();
  commerce = await import("../server/commerce.js");
  commerce.__setSlugClaimer(async () => ({ ok: true, code: "ok" }));
});
after(async () => { commerce.__setSlugClaimer(); await app.close(); });

const FORBIDDEN = ["cost", "cost_lbp", "min_price", "price_wholesale", "price_wholesale_lbp", "price_super_wholesale", "price_super_wholesale_lbp"];

function assertNoForbidden(body: any, where: string) {
  const json = JSON.stringify(body);
  for (const k of FORBIDDEN) assert.ok(!json.includes(`"${k}"`), `${where} exposes ${k}`);
}

function product(t: number, opts: any = {}) {
  return Number(app.db.prepare(
    `INSERT INTO products (tenant_id, barcode, name, price, price_lbp, cost, min_price, price_wholesale, stock, reorder_point, track_inventory, category, active)
     VALUES (@t, @barcode, @name, @price, @price_lbp, 0.8, 1.1, 1.3, @stock, @reorder_point, @track, @category, @active)`
  ).run({
    t, barcode: opts.barcode ?? `B${n}-${Math.random().toString(36).slice(2, 8)}`, name: opts.name ?? "Cola", price: opts.price ?? 1.5,
    price_lbp: opts.price_lbp ?? null, stock: opts.stock ?? 20, reorder_point: opts.reorder_point ?? 0, track: opts.track ?? 1,
    category: opts.category ?? "Drinks", active: opts.active ?? 1,
  }).lastInsertRowid);
}

async function setup() {
  n++;
  const tenantId = seedTenant(app.db, `Listing Shop ${n}`, `listing${n}-${Date.now()}@example.com`);
  const admin = (app.db.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'").get(tenantId) as any).id as number;
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, 'commerce_enabled', '1')").run(tenantId);
  const as = { tenantId, userId: admin };
  const store = (await app.api("POST", "/api/commerce/stores", { ...as, body: { name: "Shop" } })).body;
  return { tenantId, admin, as, store };
}

async function activate(s: any) {
  await app.api("POST", `/api/commerce/stores/${s.store.id}/slug`, { ...s.as, body: { slug: `listing-shop-${n}` } });
  const r = await app.api("POST", `/api/commerce/stores/${s.store.id}/status`, { ...s.as, body: { status: "active" } });
  assert.equal(r.body.status, "active");
}

const put = (s: any, pid: number, body: any) => app.api("PUT", `/api/commerce/stores/${s.store.id}/listings/${pid}`, { ...s.as, body });

test("a listing references the product: no copied price/stock; title/category fall back to the product", async () => {
  const s = await setup();
  const pid = product(s.tenantId, { name: "Cola 330ml", price: 1.5, price_lbp: 135000 });
  const r = await put(s, pid, { published: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.product_id, pid);
  assert.equal(r.body.published, true);
  assert.equal(r.body.display_title, "Cola 330ml");
  assert.equal(r.body.category, "Drinks");
  assert.equal(r.body.price, 1.5);
  assert.equal(r.body.price_lbp, 135000);
  const row = app.db.prepare("SELECT * FROM store_listings WHERE id = ?").get(r.body.id) as any;
  for (const k of ["price", "price_lbp", "stock", "cost"]) assert.ok(!(k in row), `listing row has ${k}`);
  assertNoForbidden(r.body, "PUT listing");

  const titled = await put(s, pid, { title: "Cola can", store_category: "Soft drinks" });
  assert.equal(titled.body.display_title, "Cola can");
  assert.equal(titled.body.category, "Soft drinks");
  assert.equal(titled.body.published, true, "unsent fields are kept");
});

test("price and unit changes on the product show in the listing without editing it", async () => {
  const s = await setup();
  const pid = product(s.tenantId, { price: 2 });
  const unitId = Number(app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price, price_lbp) VALUES (?, ?, 'Pack', 6, 11, 990000)").run(s.tenantId, pid).lastInsertRowid);
  await put(s, pid, { published: true });
  app.db.prepare("UPDATE products SET price = 2.25 WHERE id = ?").run(pid);
  app.db.prepare("UPDATE product_units SET price = 12 WHERE id = ?").run(unitId);
  const list = await app.api("GET", `/api/commerce/stores/${s.store.id}/listings`, s.as);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  const l = list.body.rows[0];
  assert.equal(l.price, 2.25);
  assert.deepEqual(l.units.map((u: any) => [u.id, u.name, u.factor, u.price, u.price_lbp]), [[unitId, "Pack", 6, 12, 990000]]);
  assertNoForbidden(list.body, "GET listings");

  // orderable_unit_ids narrows the units; a unit of another product is refused.
  const otherPid = product(s.tenantId);
  const otherUnit = Number(app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price) VALUES (?, ?, 'Box', 12, 20)").run(s.tenantId, otherPid).lastInsertRowid);
  const bad = await put(s, pid, { orderable_unit_ids: [otherUnit] });
  assert.equal(bad.body.code, "LISTING_UNIT_INVALID");
  const none = await put(s, pid, { orderable_unit_ids: [] });
  assert.deepEqual(none.body.units, []);
  const all = await put(s, pid, { orderable_unit_ids: null });
  assert.equal(all.body.units.length, 1);
});

test("stock state: not tracked, out, low, in", async () => {
  const s = await setup();
  const cases: [any, string][] = [
    [{ track: 0, stock: 0 }, "in_stock"],
    [{ stock: 0 }, "out_of_stock"],
    [{ stock: -2 }, "out_of_stock"],
    [{ stock: 3, reorder_point: 5 }, "low_stock"],
    [{ stock: 5, reorder_point: 5 }, "low_stock"],
    [{ stock: 6, reorder_point: 5 }, "in_stock"],
    [{ stock: 1, reorder_point: 0 }, "in_stock"],
  ];
  for (const [opts, expected] of cases) {
    const pid = product(s.tenantId, opts);
    const r = await put(s, pid, { published: true });
    assert.equal(r.body.stock_state, expected, JSON.stringify(opts));
  }
});

test("availability: reason order and visible only when everything holds", async () => {
  const s = await setup();
  const pid = product(s.tenantId);
  assert.equal((await put(s, pid, { published: false })).body.unavailable_reason, "not_published");
  assert.equal((await put(s, pid, { published: true })).body.unavailable_reason, "store_not_active");
  await activate(s);
  let l = (await put(s, pid, {})).body;
  assert.equal(l.visible, true);
  assert.equal(l.unavailable_reason, null);

  app.db.prepare("UPDATE products SET active = 0 WHERE id = ?").run(pid);
  assert.equal((await put(s, pid, {})).body.unavailable_reason, "product_disabled");
  app.db.prepare("UPDATE products SET active = 1 WHERE id = ?").run(pid);

  // Commerce off: reads still work and report it.
  app.db.prepare("UPDATE settings SET value = '0' WHERE tenant_id = ? AND key = 'commerce_enabled'").run(s.tenantId);
  l = (await app.api("GET", `/api/commerce/stores/${s.store.id}/listings`, s.as)).body.rows[0];
  assert.equal(l.unavailable_reason, "commerce_off");
  app.db.prepare("UPDATE settings SET value = '1' WHERE tenant_id = ? AND key = 'commerce_enabled'").run(s.tenantId);

  // Product deleted (products are hard-deleted): the listing stays, unavailable, with no product data.
  const del = await app.api("DELETE", `/api/products/${pid}`, s.as);
  assert.equal(del.status, 200, "deleting a listed product still works");
  l = (await app.api("GET", `/api/commerce/stores/${s.store.id}/listings`, s.as)).body.rows[0];
  assert.equal(l.unavailable_reason, "product_deleted");
  assert.equal(l.product, null);
  assert.equal(l.price, null);
});

test("field rules: lengths, min quantity, sort order, published; photos only via the photo routes", async () => {
  const s = await setup();
  const pid = product(s.tenantId);
  const bad = async (body: any, code: string, field: string) => {
    const r = await put(s, pid, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, code, JSON.stringify(body));
    assert.equal(r.body.field, field, JSON.stringify(body));
  };
  await bad({ title: "t".repeat(121) }, "LISTING_FIELD_TOO_LONG", "title");
  await bad({ description: "d".repeat(4001) }, "LISTING_FIELD_TOO_LONG", "description");
  await bad({ store_category: "c".repeat(61) }, "LISTING_FIELD_TOO_LONG", "store_category");
  // 002: photos change only through the photo routes (tests/commerce-photos.test.ts).
  await bad({ images: ["a.webp"] }, "LISTING_FIELD_INVALID", "images");
  await bad({ min_quantity: 0 }, "LISTING_MIN_QTY_INVALID", "min_quantity");
  await bad({ min_quantity: -1 }, "LISTING_MIN_QTY_INVALID", "min_quantity");
  await bad({ sort_order: 1.5 }, "LISTING_FIELD_INVALID", "sort_order");
  await bad({ published: "yes" }, "LISTING_FIELD_INVALID", "published");

  const ok = await put(s, pid, { title: "t".repeat(120), min_quantity: 2.5, sort_order: 3, title_unknown: "ignored" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.images, []);
  assert.equal(ok.body.min_quantity, 2.5);
  assert.equal(ok.body.sort_order, 3);
  const cleared = await put(s, pid, { title: "", min_quantity: null });
  assert.equal(cleared.body.title, null);
  assert.equal(cleared.body.min_quantity, null);
});

test("one live listing per (store, product): PUT updates in place; the DB refuses a second live row", async () => {
  const s = await setup();
  const pid = product(s.tenantId);
  const a = await put(s, pid, { published: true });
  const b = await put(s, pid, { title: "Again" });
  assert.equal(a.body.id, b.body.id);
  assert.throws(
    () => app.db.prepare("INSERT INTO store_listings (tenant_id, store_id, product_id) VALUES (?, ?, ?)").run(s.tenantId, s.store.id, pid),
    /UNIQUE/,
  );
  // After a soft delete a new listing can be created.
  assert.equal((await app.api("DELETE", `/api/commerce/stores/${s.store.id}/listings/${pid}`, s.as)).status, 200);
  const c = await put(s, pid, { published: true });
  assert.notEqual(c.body.id, a.body.id);
  assert.equal((await app.api("DELETE", `/api/commerce/stores/${s.store.id}/listings/999999`, s.as)).body.code, "LISTING_NOT_FOUND");
});

test("publish / unpublish / update are audited separately", async () => {
  const s = await setup();
  const pid = product(s.tenantId);
  await put(s, pid, { published: true, title: "Cola" });
  await put(s, pid, { published: false });
  const actions = (app.db.prepare("SELECT action FROM user_logs WHERE tenant_id = ? AND action LIKE 'listing_%' ORDER BY id").all(s.tenantId) as any[]).map((r) => r.action);
  assert.deepEqual(actions, ["listing_publish", "listing_update", "listing_unpublish"]);
});

test("bulk publish: creates and updates in one call; another tenant's product fails the whole call", async () => {
  const s = await setup();
  const p1 = product(s.tenantId), p2 = product(s.tenantId), p3 = product(s.tenantId);
  await put(s, p1, { published: false });
  const bulk = (body: any) => app.api("POST", `/api/commerce/stores/${s.store.id}/listings/bulk`, { ...s.as, body });
  const r = await bulk({ product_ids: [p1, p2, p3, p3], published: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { created: 2, updated: 1 });
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM store_listings WHERE store_id = ? AND published = 1 AND deleted_at IS NULL").get(s.store.id) as any).c, 3);

  const other = await setup();
  const foreign = product(other.tenantId);
  const mixed = await bulk({ product_ids: [p1, foreign], published: false });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.code, "LISTING_TENANT_MISMATCH");
  assert.equal((app.db.prepare("SELECT published FROM store_listings WHERE store_id = ? AND product_id = ? AND deleted_at IS NULL").get(s.store.id, p1) as any).published, 1, "nothing changed");
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM store_listings WHERE product_id = ?").get(foreign) as any).c, 0);

  assert.equal((await bulk({ product_ids: [], published: true })).body.code, "LISTING_BULK_INVALID");
  assert.equal((await bulk({ product_ids: Array.from({ length: 1001 }, (_, i) => i + 1), published: true })).body.code, "LISTING_BULK_INVALID");
  assert.equal((await bulk({ product_ids: [p1], published: "yes" })).body.code, "LISTING_FIELD_INVALID");
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM user_logs WHERE tenant_id = ? AND action = 'listing_bulk_publish'").get(s.tenantId) as any).c, 1);
});

test("list filters: published, category, search by title or barcode; product card endpoint", async () => {
  const s = await setup();
  const tea = product(s.tenantId, { name: "Green Tea", category: "Hot", barcode: `TEA-${n}` });
  const cola = product(s.tenantId, { name: "Cola", category: "Drinks" });
  await put(s, tea, { published: true });
  await put(s, cola, { published: false });
  const get = (q: string) => app.api("GET", `/api/commerce/stores/${s.store.id}/listings?${q}`, s.as).then((r) => r.body.rows.map((l: any) => l.product_id));
  assert.deepEqual(await get("published=1"), [tea]);
  assert.deepEqual(await get("published=0"), [cola]);
  assert.deepEqual(await get("category=Drinks"), [cola]);
  assert.deepEqual(await get("search=green"), [tea]);
  assert.deepEqual(await get(`search=tea-${n}`), [tea]);

  const card = await app.api("GET", `/api/commerce/products/${tea}/listings`, s.as);
  assert.equal(card.status, 200);
  assert.deepEqual(card.body.map((l: any) => l.store_id), [s.store.id]);
  assertNoForbidden(card.body, "product listings");
  assert.equal((await app.api("GET", "/api/commerce/products/999999/listings", s.as)).body.code, "PRODUCT_NOT_FOUND");
});

test("isolation: another tenant can't see, edit or list into this store, nor list a foreign product", async () => {
  const a = await setup();
  const b = await setup();
  const pa = product(a.tenantId);
  await put(a, pa, { published: true });
  const asB = b.as;
  for (const [m, u, body] of [
    ["GET", `/api/commerce/stores/${a.store.id}/listings`, undefined],
    ["PUT", `/api/commerce/stores/${a.store.id}`, { name: "Mine" }],
    ["POST", `/api/commerce/stores/${a.store.id}/slug`, { slug: "stolen-slug" }],
    ["POST", `/api/commerce/stores/${a.store.id}/status`, { status: "active" }],
    ["PUT", `/api/commerce/stores/${a.store.id}/listings/${pa}`, { published: false }],
    ["POST", `/api/commerce/stores/${a.store.id}/listings/bulk`, { product_ids: [pa], published: false }],
    ["DELETE", `/api/commerce/stores/${a.store.id}/listings/${pa}`, undefined],
    ["DELETE", `/api/commerce/stores/${a.store.id}`, undefined],
  ] as const) {
    const r = await app.api(m, u, { ...asB, body });
    assert.equal(r.status, 404, `${m} ${u}`);
    assert.equal(r.body.code, "STORE_NOT_FOUND", `${m} ${u}`);
  }
  // B's own store, A's product: not found (no hint that it exists).
  const r = await put(b, pa, { published: true });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "PRODUCT_NOT_FOUND");
  assert.equal((await app.api("GET", `/api/commerce/products/${pa}/listings`, asB)).body.code, "PRODUCT_NOT_FOUND");
  assert.deepEqual((await app.api("GET", "/api/commerce/stores", asB)).body.map((x: any) => x.id), [b.store.id]);
  // A's data untouched.
  assert.equal((app.db.prepare("SELECT published FROM store_listings WHERE product_id = ?").get(pa) as any).published, 1);
});

test("allow-list: store and status responses carry no cost, tier price or local tenant id either", async () => {
  const s = await setup();
  const pid = product(s.tenantId);
  await put(s, pid, { published: true });
  for (const [u, where] of [
    ["/api/commerce/status", "status"],
    ["/api/commerce/stores", "stores"],
    [`/api/commerce/stores/${s.store.id}/listings?published=1`, "published listings"],
  ] as const) {
    const r = await app.api("GET", u, s.as);
    assert.equal(r.status, 200, u);
    assertNoForbidden(r.body, where);
    assert.ok(!JSON.stringify(r.body).includes('"tenant_id"'), `${where} exposes tenant_id`);
  }
});

// ---- 003 Slice 1: orderable units as keys ("base" / unit global id) — research R5 -----------------------

function unit(t: number, pid: number, name: string, factor: number, price: number) {
  const id = Number(app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price) VALUES (?, ?, ?, ?, ?)").run(t, pid, name, factor, price).lastInsertRowid);
  const gid = (app.db.prepare("SELECT global_id FROM product_units WHERE id = ?").get(id) as any).global_id as string;
  return { id, gid };
}

test("003 unit keys: base and this product's units by global id; empty, unknown or foreign keys refused", async () => {
  const s = await setup();
  const pid = product(s.tenantId, { price: 2 });
  const pack = unit(s.tenantId, pid, "Pack", 6, 11);
  const carton = unit(s.tenantId, pid, "Carton", 24, 40);
  const other = unit(s.tenantId, product(s.tenantId), "Box", 12, 20);
  const foreignTenant = await setup();
  const foreign = unit(foreignTenant.tenantId, product(foreignTenant.tenantId), "Crate", 12, 20);

  let r = await put(s, pid, { published: true });
  assert.equal(r.body.orderable_unit_keys, null);
  assert.equal(r.body.base_orderable, true);
  assert.deepEqual(r.body.units.map((u: any) => u.key), [pack.gid, carton.gid]);
  assert.deepEqual(r.body.unit_options.map((u: any) => [u.key, u.name, u.factor]), [["base", "pcs", 1], [pack.gid, "Pack", 6], [carton.gid, "Carton", 24]]);
  assert.ok(!("orderable_unit_ids" in r.body), "local ids are no longer exposed");

  r = await put(s, pid, { orderable_unit_keys: [carton.gid] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.orderable_unit_keys, [carton.gid]);
  assert.equal(r.body.base_orderable, false);
  assert.deepEqual(r.body.units.map((u: any) => u.name), ["Carton"]);
  assert.equal((app.db.prepare("SELECT orderable_unit_ids FROM store_listings WHERE id = ?").get(r.body.id) as any).orderable_unit_ids, JSON.stringify([carton.gid]));

  r = await put(s, pid, { orderable_unit_keys: ["base", "base", pack.gid] });
  assert.deepEqual(r.body.orderable_unit_keys, ["base", pack.gid], "duplicates dropped");
  assert.equal(r.body.base_orderable, true);

  for (const keys of [[], ["nope"], [other.gid], [foreign.gid], [pack.id], "base"]) {
    const bad = await put(s, pid, { orderable_unit_keys: keys });
    assert.deepEqual([bad.status, bad.body.code, bad.body.field], [400, "LISTING_UNIT_INVALID", "orderable_unit_keys"], JSON.stringify(keys));
  }
  r = await put(s, pid, { orderable_unit_keys: null });
  assert.equal(r.body.orderable_unit_keys, null);
  assert.equal(r.body.units.length, 2);
});

test("003 unit keys: legacy integer input is converted (base always included, as before)", async () => {
  const s = await setup();
  const pid = product(s.tenantId);
  const pack = unit(s.tenantId, pid, "Pack", 6, 8);
  const r = await put(s, pid, { orderable_unit_ids: [pack.id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.orderable_unit_keys, ["base", pack.gid]);
  const none = await put(s, pid, { orderable_unit_ids: [] });
  assert.deepEqual(none.body.orderable_unit_keys, ["base"], "no units = base only, the old meaning");
});

test("003 startup conversion: integer ids become unit keys once, per tenant, and the rows are pushed", async () => {
  const { convertOrderableUnitIds } = await import("../server/db.js");
  const s = await setup();
  const other = await setup();
  const pid = product(s.tenantId);
  const pack = unit(s.tenantId, pid, "Pack", 6, 8);
  const carton = unit(s.tenantId, pid, "Carton", 24, 30);
  const lid = (await put(s, pid, { published: true })).body.id;
  // Another tenant's unit with the same local id must never be picked up.
  const opid = product(other.tenantId);
  const otherUnit = unit(other.tenantId, opid, "Crate", 12, 20);
  const raw = (v: string | null) => app.db.prepare("UPDATE store_listings SET orderable_unit_ids = ?, updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(v, lid);
  const read = () => app.db.prepare("SELECT orderable_unit_ids, updated_at FROM store_listings WHERE id = ?").get(lid) as any;

  raw(JSON.stringify([carton.id, 999999, otherUnit.id]));
  assert.ok(convertOrderableUnitIds(app.db) >= 1);
  const after = read();
  assert.equal(after.orderable_unit_ids, JSON.stringify(["base", carton.gid]), "unknown and foreign ids dropped");
  assert.notEqual(after.updated_at, "2000-01-01 00:00:00", "updated_at bumped so sync pushes the row");
  assert.equal(convertOrderableUnitIds(app.db), 0, "second run changes nothing");
  assert.equal(read().orderable_unit_ids, JSON.stringify(["base", carton.gid]));

  raw(JSON.stringify([]));
  convertOrderableUnitIds(app.db);
  assert.equal(read().orderable_unit_ids, JSON.stringify(["base"]));
  raw(null);
  convertOrderableUnitIds(app.db);
  assert.equal(read().orderable_unit_ids, null, "NULL (all units) is left alone");
  void pack;
});
