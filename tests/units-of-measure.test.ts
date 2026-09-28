// Units of measure (docs/plans/2026-09-28-units-of-measure.md): a product is stocked in base pieces
// and sold / bought / refunded in packs and cartons with their own barcodes and prices.
// INVARIANT under test: transaction_items.quantity is in BASE PIECES and unit_price / unit_cost are per
// piece, so stock, WAC and reports keep working unchanged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";
import { buildReceiptBuffer } from "../server/printing/receipt.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let otherTenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "UoM Co", "uom-co@example.com");
  otherTenantId = seedTenant(app.db, "UoM Other Co", "uom-other@example.com");
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-6, `${msg} ${a} != ${b}`);
const nearCost = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-3, `${msg} ${a} != ${b}`);
const stockOf = (id: number) => (app.db.prepare("SELECT stock FROM products WHERE id = ?").get(id) as any).stock as number;
const costOf = (id: number) => (app.db.prepare("SELECT cost FROM products WHERE id = ?").get(id) as any).cost as number;
const cash = (amount: number) => [{ amount, method: "cash", currency: "USD", exchange_rate: 1 }];

let seq = 0;
/** Creates a product through the API (so units go through the real validation/save path). */
async function makeProduct(opts: { name?: string; price: number; stock?: number; cost?: number; barcodes?: string[]; units?: any[]; extra?: Record<string, any> } ) {
  seq++;
  const res = await app.api("POST", "/api/products", { tenantId, body: {
    name: opts.name ?? `UoM Product ${seq}`, price: opts.price, cost: opts.cost, stock: opts.stock ?? 100, category: "general", currency: "USD", unit: "pcs",
    barcodes: opts.barcodes ?? [`UOM-P${seq}`], units: opts.units, ...(opts.extra || {}),
  } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const list = (await app.api("GET", "/api/products", { tenantId })).body as any[];
  return list.find((p) => p.id === res.body.id);
}
const unitOf = (p: any, name: string) => p.units.find((u: any) => u.name === name);

const sale = (items: any[], extra: Record<string, any> = {}) => app.api("POST", "/api/transactions", { tenantId, body: {
  type: "sale", items, currency: "USD", exchange_rate: 1, payments: [], ...extra } });
const itemRows = (txId: number) => app.db.prepare("SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id").all(txId) as any[];

// ---------------------------------------------------------------------------------------------
// Products: units CRUD, validation, barcode uniqueness
// ---------------------------------------------------------------------------------------------

test("product units: create, list ordered, update in place, soft-delete, legacy columns mirrored", async () => {
  const p = await makeProduct({ price: 0.25, units: [
    { name: "Carton", factor: 24, price: 5, barcode: "UOM-CARTON-1" },
    { name: "Pack", factor: 6, price: 1.4, barcode: "UOM-PACK-1", price_lbp: 126000 },
  ] });
  // Sorted by sort_order (payload order), each row has an id and the full price columns.
  assert.deepEqual(p.units.map((u: any) => u.name), ["Carton", "Pack"]);
  assert.equal(p.units[0].factor, 24);
  assert.equal(p.units[1].price_lbp, 126000);
  // Legacy columns mirror the smallest-factor unit for older devices/the cloud.
  assert.equal(p.units_per_package, 6);
  assert.equal(p.package_price, 1.4);
  // The synced table got its metadata (global_id / updated_at) from the sync block.
  const row = app.db.prepare("SELECT global_id, updated_at, deleted_at FROM product_units WHERE id = ?").get(p.units[0].id) as any;
  assert.ok(row.global_id && row.updated_at && row.deleted_at === null);

  // Update in place: same id, new price; drop the pack; keep the product's other fields.
  const carton = unitOf(p, "Carton");
  const put = await app.api("PUT", `/api/products/${p.id}`, { tenantId, body: {
    name: p.name, price: p.price, category: "general", currency: "USD", unit: "pcs", barcodes: p.barcodes,
    units: [{ id: carton.id, name: "Carton", factor: 24, price: 4.8, barcode: "UOM-CARTON-1" }] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const after1 = (await app.api("GET", "/api/products", { tenantId })).body.find((x: any) => x.id === p.id);
  assert.equal(after1.units.length, 1);
  assert.equal(after1.units[0].id, carton.id, "the same row is updated, so its sync global_id is stable");
  assert.equal(after1.units[0].price, 4.8);
  assert.equal(after1.units_per_package, 24);
  const gone = app.db.prepare("SELECT deleted_at FROM product_units WHERE id = ?").get(unitOf(p, "Pack").id) as any;
  assert.ok(gone.deleted_at, "removed unit is soft-deleted, not hard-deleted");

  // PUT without `units` leaves them untouched; an explicit empty array removes them all and clears the legacy columns.
  await app.api("PUT", `/api/products/${p.id}`, { tenantId, body: { name: "Renamed", price: p.price, category: "general", currency: "USD", unit: "pcs", barcodes: p.barcodes } });
  assert.equal((await app.api("GET", "/api/products", { tenantId })).body.find((x: any) => x.id === p.id).units.length, 1);
  await app.api("PUT", `/api/products/${p.id}`, { tenantId, body: { name: "Renamed", price: p.price, category: "general", currency: "USD", unit: "pcs", barcodes: p.barcodes, units: [] } });
  const cleared = (await app.api("GET", "/api/products", { tenantId })).body.find((x: any) => x.id === p.id);
  assert.equal(cleared.units.length, 0);
  assert.equal(cleared.package_price, null);
  assert.equal(cleared.units_per_package, 1);
});

test("product units: validation codes and statuses", async () => {
  const base = { name: "Validation Product", price: 1, stock: 0, category: "general", currency: "USD", unit: "pcs" };
  const post = (units: any[], barcodes: string[] = []) => app.api("POST", "/api/products", { tenantId, body: { ...base, barcodes, units } });
  const before = (app.db.prepare("SELECT COUNT(*) c FROM products WHERE tenant_id = ?").get(tenantId) as any).c;

  let r = await post([{ name: "  ", factor: 6, price: 1 }]);
  assert.equal(r.status, 400); assert.equal(r.body.code, "UOM_NAME_REQUIRED"); assert.equal(r.body.field, "units.0.name");
  r = await post([{ name: "Pack", factor: 1, price: 1 }]);
  assert.equal(r.status, 400); assert.equal(r.body.code, "UOM_FACTOR_INVALID"); assert.equal(r.body.field, "units.0.factor");
  r = await post([{ name: "Pack", factor: "abc", price: 1 }]);
  assert.equal(r.body.code, "UOM_FACTOR_INVALID");
  r = await post([{ name: "Pack", factor: 6, price: 0 }]);
  assert.equal(r.status, 400); assert.equal(r.body.code, "UOM_PRICE_REQUIRED"); assert.equal(r.body.field, "units.0.price");
  r = await post([{ name: "Pack", factor: 6, price: 1 }, { name: "Six", factor: 6, price: 2 }]);
  assert.equal(r.status, 400); assert.equal(r.body.code, "UOM_FACTOR_DUPLICATE"); assert.equal(r.body.field, "units.1.factor");
  r = await post([{ name: "Pack", factor: 6, price: 1, barcode: "DUP-IN-PAYLOAD" }, { name: "Box", factor: 12, price: 2, barcode: "DUP-IN-PAYLOAD" }]);
  assert.equal(r.status, 409); assert.equal(r.body.code, "BARCODE_TAKEN"); assert.equal(r.body.field, "units.1.barcode");
  r = await post([{ name: "Pack", factor: 6, price: 1, barcode: "SAME-AS-OWN" }], ["SAME-AS-OWN"]);
  assert.equal(r.status, 409); assert.equal(r.body.field, "units.0.barcode");
  r = await post([], ["TWICE", "TWICE"]);
  assert.equal(r.status, 409); assert.equal(r.body.field, "barcodes");

  // Nothing was created by any failed attempt (the whole create is one transaction).
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM products WHERE tenant_id = ?").get(tenantId) as any).c, before);
});

test("barcode collisions across products, extra barcodes and units -> 409 and nothing changes", async () => {
  const a = await makeProduct({ price: 2, barcodes: ["COL-A", "COL-A-EXTRA"], units: [{ name: "Pack", factor: 6, price: 10, barcode: "COL-A-PACK" }] });

  // A new product cannot take another product's primary, extra or unit barcode.
  for (const [bc, expectedField] of [["COL-A", "barcodes"], ["COL-A-EXTRA", "barcodes"], ["COL-A-PACK", "barcodes"]] as const) {
    const r = await app.api("POST", "/api/products", { tenantId, body: { name: "Thief", price: 1, stock: 0, category: "general", currency: "USD", unit: "pcs", barcodes: [bc] } });
    assert.equal(r.status, 409, `${bc}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, "BARCODE_TAKEN"); assert.equal(r.body.field, expectedField);
  }
  // ...and a unit barcode cannot collide with a product barcode either.
  const b = await makeProduct({ price: 3, barcodes: ["COL-B"] });
  const bUnits = [{ name: "Box", factor: 10, price: 25, barcode: "COL-A-EXTRA" }];
  const put = await app.api("PUT", `/api/products/${b.id}`, { tenantId, body: { name: b.name, price: 3, category: "general", currency: "USD", unit: "pcs", barcodes: ["COL-B"], units: bUnits } });
  assert.equal(put.status, 409, JSON.stringify(put.body));
  assert.equal(put.body.code, "BARCODE_TAKEN"); assert.equal(put.body.field, "units.0.barcode");
  const bAfter = (await app.api("GET", "/api/products", { tenantId })).body.find((x: any) => x.id === b.id);
  assert.equal(bAfter.units.length, 0, "failed PUT changed nothing");
  assert.deepEqual(bAfter.barcodes, ["COL-B"]);

  // A product can keep its own barcodes and unit barcodes when re-saved.
  const same = await app.api("PUT", `/api/products/${a.id}`, { tenantId, body: { name: a.name, price: 2, category: "general", currency: "USD", unit: "pcs", barcodes: a.barcodes,
    units: [{ id: a.units[0].id, name: "Pack", factor: 6, price: 10, barcode: "COL-A-PACK" }] } });
  assert.equal(same.status, 200, JSON.stringify(same.body));

  // Another tenant is not blocked by (or able to see) this tenant's unit barcode.
  const other = await app.api("POST", "/api/products", { tenantId: otherTenantId, body: { name: "Other", price: 1, stock: 0, category: "general", currency: "USD", unit: "pcs", barcodes: [], units: [{ name: "Pack", factor: 6, price: 5, barcode: "COL-A-PACK" }] } });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  // A soft-deleted unit releases its barcode.
  await app.api("PUT", `/api/products/${a.id}`, { tenantId, body: { name: a.name, price: 2, category: "general", currency: "USD", unit: "pcs", barcodes: a.barcodes, units: [] } });
  const reuse = await makeProduct({ price: 1, barcodes: ["COL-A-PACK"] });
  assert.ok(reuse.id);
});

test("deleting a product soft-deletes its units", async () => {
  const p = await makeProduct({ price: 1, units: [{ name: "Pack", factor: 6, price: 5, barcode: "DEL-PACK" }] });
  await app.api("DELETE", `/api/products/${p.id}`, { tenantId });
  const row = app.db.prepare("SELECT deleted_at FROM product_units WHERE product_id = ?").get(p.id) as any;
  assert.ok(row.deleted_at);
  assert.equal((await app.api("GET", "/api/products/DEL-PACK", { tenantId })).status, 404);
});

test("lookup by a unit barcode returns the product, its units and matched_uom_id", async () => {
  const p = await makeProduct({ price: 0.5, barcodes: ["LK-1", "LK-1-X"], units: [
    { name: "Pack", factor: 6, price: 2.5, barcode: "LK-PACK" }, { name: "Carton", factor: 24, price: 9, barcode: "LK-CARTON" }] });
  const viaUnit = await app.api("GET", "/api/products/LK-CARTON", { tenantId });
  assert.equal(viaUnit.status, 200);
  assert.equal(viaUnit.body.id, p.id);
  assert.equal(viaUnit.body.matched_uom_id, unitOf(p, "Carton").id);
  assert.equal(viaUnit.body.units.length, 2);
  for (const bc of ["LK-1", "LK-1-X"]) {
    const r = await app.api("GET", `/api/products/${bc}`, { tenantId });
    assert.equal(r.body.id, p.id); assert.equal(r.body.matched_uom_id, null); assert.equal(r.body.units.length, 2);
  }
  // Name lookups still work and report no matched unit.
  assert.equal((await app.api("GET", `/api/products/${encodeURIComponent(p.name)}`, { tenantId })).body.matched_uom_id, null);
  // Another tenant can't resolve this tenant's unit barcode.
  assert.equal((await app.api("GET", "/api/products/LK-CARTON", { tenantId: otherTenantId })).status, 404);
  // The export carries units too.
  const exp = (await app.api("GET", "/api/products/export", { tenantId })).body.find((x: any) => x.id === p.id);
  assert.equal(exp.units.length, 2);
});

// ---------------------------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------------------------

test("selling 2 cartons: stock -48, quantity in pieces, unit_price per piece, snapshot columns", async () => {
  const p = await makeProduct({ price: 0.25, cost: 0.1, stock: 200, units: [{ name: "Carton", factor: 24, price: 4.8, barcode: "S-CARTON" }] });
  const carton = unitOf(p, "Carton");
  const res = await sale([{ id: p.id, quantity: 2, uom_id: carton.id }], { payments: cash(9.6) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(stockOf(p.id), 200 - 48);
  const [row] = itemRows(res.body.id);
  assert.equal(row.quantity, 48);
  near(row.unit_price, 4.8 / 24);
  near(row.unit_cost, 0.1);
  assert.equal(row.uom_id, carton.id); assert.equal(row.uom_name, "Carton"); assert.equal(row.uom_factor, 24); assert.equal(row.uom_qty, 2);
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(res.body.id) as any).total_amount, 9.6);

  // The detail exposes display fields in the line's own unit.
  const detail = (await app.api("GET", `/api/transactions/${res.body.id}`, { tenantId })).body;
  assert.equal(detail.items[0].display_qty, 2);
  near(detail.items[0].display_unit_price, 4.8);
  assert.equal(detail.items[0].quantity, 48);
  // A base-piece line has display fields equal to its stored ones.
  const pcs = await sale([{ id: p.id, quantity: 3 }]);
  const d2 = (await app.api("GET", `/api/transactions/${pcs.body.id}`, { tenantId })).body;
  assert.equal(d2.items[0].display_qty, 3);
  assert.equal(d2.items[0].uom_id, null);

  // A per-line discount applies to the unit line total: 2 cartons - 10% = 8.64.
  const disc = await sale([{ id: p.id, quantity: 2, uom_id: carton.id, discount: { type: "percentage", value: 10 } }]);
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(disc.body.id) as any).total_amount, 8.64);
});

test("a unit that isn't this product's (or doesn't exist) is rejected with UOM_INVALID", async () => {
  const a = await makeProduct({ price: 1, units: [{ name: "Pack", factor: 6, price: 5 }] });
  const b = await makeProduct({ price: 1, units: [{ name: "Pack", factor: 6, price: 5 }] });
  const stockBefore = stockOf(b.id);
  const r = await sale([{ id: b.id, quantity: 1, uom_id: a.units[0].id }]);
  assert.equal(r.status, 400); assert.equal(r.body.code, "UOM_INVALID"); assert.equal(r.body.field, "items.0.uom_id");
  assert.equal((await sale([{ id: b.id, quantity: 1, uom_id: 999999 }])).body.code, "UOM_INVALID");
  assert.equal(stockOf(b.id), stockBefore);
  // A soft-deleted unit is invalid too.
  app.db.prepare("UPDATE product_units SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(b.units[0].id);
  assert.equal((await sale([{ id: b.id, quantity: 1, uom_id: b.units[0].id }])).body.code, "UOM_INVALID");
});

test("price levels: unit tier, then product tier x factor, then unit retail; disabled -> retail", async () => {
  const p = await makeProduct({ price: 0.25, stock: 500, extra: { price_wholesale: 0.2, price_super_wholesale: 0.15 }, units: [
    { name: "Pack", factor: 6, price: 1.4, price_wholesale: 1.1 },         // wholesale = unit tier; super falls to unit wholesale? (no: super -> product super x6 first)
    { name: "Carton", factor: 24, price: 5, price_wholesale: 4, price_super_wholesale: 3.2 } ] });
  const pack = unitOf(p, "Pack"), carton = unitOf(p, "Carton");
  const total = async (item: any, level?: string) => {
    const r = await sale([item], level ? { price_level: level } : {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r.body.id) as any).total_amount as number;
  };
  near(await total({ id: p.id, quantity: 1, uom_id: carton.id }, "retail"), 5);
  near(await total({ id: p.id, quantity: 1, uom_id: carton.id }, "wholesale"), 4, "unit wholesale");
  near(await total({ id: p.id, quantity: 1, uom_id: carton.id }, "super_wholesale"), 3.2, "unit super wholesale");
  near(await total({ id: p.id, quantity: 1, uom_id: pack.id }, "wholesale"), 1.1, "pack wholesale");
  near(await total({ id: p.id, quantity: 1, uom_id: pack.id }, "super_wholesale"), 0.15 * 6, "pack: product super x factor beats unit wholesale");
  // A product without unit tiers falls back to the product tier x factor.
  const q = await makeProduct({ price: 0.25, stock: 500, extra: { price_wholesale: 0.2 }, units: [{ name: "Pack", factor: 6, price: 1.4 }] });
  near(await total({ id: q.id, quantity: 2, uom_id: q.units[0].id }, "wholesale"), 2 * 0.2 * 6, "product wholesale x factor");
  // ...and to the unit's retail when there is no tier anywhere.
  const r = await makeProduct({ price: 0.25, stock: 500, units: [{ name: "Pack", factor: 6, price: 1.4 }] });
  near(await total({ id: r.id, quantity: 1, uom_id: r.units[0].id }, "super_wholesale"), 1.4);

  // Price levels switched off tenant-wide: always retail.
  await app.api("POST", "/api/settings", { tenantId, body: { enable_price_levels: "0" } });
  near(await total({ id: p.id, quantity: 1, uom_id: carton.id }, "super_wholesale"), 5, "levels disabled -> retail");
  await app.api("POST", "/api/settings", { tenantId, body: { enable_price_levels: "1" } });
});

test("min_price is enforced per piece for unit lines; a typed override is per unit", async () => {
  const p = await makeProduct({ price: 0.25, stock: 500, extra: { min_price: 0.2 }, units: [{ name: "Carton", factor: 24, price: 4, barcode: "MIN-CARTON" }] });
  const carton = p.units[0];
  await app.api("POST", "/api/settings", { tenantId, body: { enforce_min_price: "1", allow_price_override: "1" } });
  // 4 / 24 = 0.1667 per piece is below the 0.2 minimum.
  const low = await sale([{ id: p.id, quantity: 1, uom_id: carton.id }]);
  assert.equal(low.status, 400, JSON.stringify(low.body));
  assert.equal(low.body.field, "items.0.unit_price");
  // Override PER UNIT: 5.00 per carton = 0.2083 per piece, above the minimum.
  const ok = await sale([{ id: p.id, quantity: 2, uom_id: carton.id, unit_price: 5 }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(ok.body.id) as any).total_amount, 10);
  near(itemRows(ok.body.id)[0].unit_price, 5 / 24);
  await app.api("POST", "/api/settings", { tenantId, body: { enforce_min_price: "0", allow_price_override: "0" } });
});

test("base-piece lines get the generalized automatic pack/carton break", async () => {
  const p = await makeProduct({ price: 0.2, stock: 500, units: [{ name: "Pack", factor: 6, price: 1.1 }, { name: "Carton", factor: 24, price: 4 }] });
  // 31 pcs = 1 carton + 1 pack + 1 piece
  const r = await sale([{ id: p.id, quantity: 31 }]);
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r.body.id) as any).total_amount, 4 + 1.1 + 0.2);
  const [row] = itemRows(r.body.id);
  assert.equal(row.quantity, 31); assert.equal(row.uom_id, null);
  near(row.unit_price * 31, 5.3);
  // Legacy fallback: a product with only package_price / units_per_package (no unit rows).
  const legacyId = seedProduct(app.db, tenantId, { barcode: "LEG-BRK", name: "Legacy Pack Product", price: 10, stock: 100 });
  app.db.prepare("UPDATE products SET package_price = 45, units_per_package = 6 WHERE id = ?").run(legacyId);
  const l = await sale([{ id: legacyId, quantity: 8 }]);
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(l.body.id) as any).total_amount, 45 + 20);
});

test("legacy package migration creates a Pack unit once and keeps the legacy columns", async () => {
  const { runUomFromPackageMigration } = await import("../server/db.js");
  const withPkg = seedProduct(app.db, tenantId, { barcode: "MIG-1", name: "Migrate Me", price: 1 });
  app.db.prepare("UPDATE products SET package_price = 5, package_price_lbp = 450000, units_per_package = 6 WHERE id = ?").run(withPkg);
  const alreadyHas = seedProduct(app.db, tenantId, { barcode: "MIG-2", name: "Has Units", price: 1 });
  app.db.prepare("UPDATE products SET package_price = 7, units_per_package = 12 WHERE id = ?").run(alreadyHas);
  app.db.prepare("INSERT INTO product_units (tenant_id, product_id, name, factor, price) VALUES (?, ?, 'Box', 12, 6.5)").run(tenantId, alreadyHas);
  const noPkg = seedProduct(app.db, tenantId, { barcode: "MIG-3", name: "No Package", price: 1 });

  app.db.prepare("DELETE FROM _migrations WHERE name = 'uom_from_package_v1'").run();
  runUomFromPackageMigration();
  const units = (id: number) => app.db.prepare("SELECT * FROM product_units WHERE product_id = ? AND deleted_at IS NULL").all(id) as any[];
  assert.equal(units(withPkg).length, 1);
  assert.equal(units(withPkg)[0].name, "Pack"); assert.equal(units(withPkg)[0].factor, 6);
  assert.equal(units(withPkg)[0].price, 5); assert.equal(units(withPkg)[0].price_lbp, 450000);
  assert.equal(units(alreadyHas).length, 1, "a product that already has units is left alone");
  assert.equal(units(alreadyHas)[0].name, "Box");
  assert.equal(units(noPkg).length, 0);
  assert.equal((app.db.prepare("SELECT package_price FROM products WHERE id = ?").get(withPkg) as any).package_price, 5, "legacy columns kept");
  runUomFromPackageMigration(); // guarded: a second run is a no-op
  assert.equal(units(withPkg).length, 1);
});

// ---------------------------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------------------------

test("purchasing 3 cartons at 20.00: stock +72 and WAC on the per-piece cost", async () => {
  const p = await makeProduct({ price: 1.2, stock: 0, units: [{ name: "Carton", factor: 24, price: 24 }] });
  const carton = p.units[0];
  const r = await app.api("POST", "/api/transactions", { tenantId, body: { type: "purchase", items: [{ id: p.id, quantity: 3, price: 20, uom_id: carton.id }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(stockOf(p.id), 72);
  nearCost(costOf(p.id), 20 / 24, "cost per piece"); // WAC is stored rounded to 4 decimals
  const [row] = itemRows(r.body.id);
  assert.equal(row.quantity, 72); near(row.unit_price, 20 / 24); near(row.unit_cost, 20 / 24);
  assert.equal(row.uom_qty, 3); assert.equal(row.uom_name, "Carton");
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r.body.id) as any).total_amount, 60);

  // A second purchase blends into the existing cost: 72 pcs @ 20/24 + 24 pcs @ 1.00.
  const r2 = await app.api("POST", "/api/transactions", { tenantId, body: { type: "purchase", items: [{ id: p.id, quantity: 24, price: 1 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(r2.status, 200);
  nearCost(costOf(p.id), (72 * (20 / 24) + 24 * 1) / 96);
  // Purchase detail carries display fields.
  const detail = (await app.api("GET", `/api/purchases/${r.body.id}`, { tenantId })).body;
  assert.equal(detail.items[0].display_qty, 3); near(detail.items[0].display_unit_price, 20);
  // Deleting the purchase reverses stock in pieces.
  const del = await app.api("DELETE", `/api/transactions/${r2.body.id}`, { tenantId });
  assert.equal(del.status, 200);
  assert.equal(stockOf(p.id), 72);
});

// ---------------------------------------------------------------------------------------------
// Refunds — per original line
// ---------------------------------------------------------------------------------------------

async function pcsAndCartonSale() {
  // 5 loose pieces (0.25 each = 1.25) AND 1 carton (4.00) of the same product on one invoice.
  const p = await makeProduct({ price: 0.25, cost: 0.1, stock: 500, units: [{ name: "Carton", factor: 24, price: 4 }] });
  const carton = p.units[0];
  const s = await sale([{ id: p.id, quantity: 5 }, { id: p.id, quantity: 1, uom_id: carton.id }], { payments: cash(5.25) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { p, carton, saleId: s.body.id as number };
}
const refund = (saleId: number, items: any[]) => app.api("POST", "/api/transactions", { tenantId, body: {
  type: "refund", original_transaction_id: saleId, items, currency: "USD", exchange_rate: 1, payments: [] } });

test("refund is per original line: a product sold as pieces AND a carton no longer collides", async () => {
  const { p, saleId } = await pcsAndCartonSale();
  assert.equal(stockOf(p.id), 500 - 5 - 24);

  const info = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body;
  assert.equal(info.lines.length, 2, "one entry per original line, not per product");
  const [piecesLine, cartonLine] = info.lines;
  assert.equal(piecesLine.uom_id, null); assert.equal(piecesLine.uom_factor, 1);
  assert.equal(piecesLine.sold_qty, 5); near(piecesLine.unit_price, 0.25); near(piecesLine.unit_refund, 0.25);
  assert.equal(cartonLine.uom_name, "Carton"); assert.equal(cartonLine.uom_factor, 24);
  assert.equal(cartonLine.sold_qty, 1); near(cartonLine.unit_price, 4); near(cartonLine.unit_refund, 4);
  assert.notEqual(piecesLine.item_id, cartonLine.item_id);
  assert.equal(cartonLine.product_id, p.id); assert.ok(cartonLine.product_name && "barcode" in cartonLine);

  // Refund the carton line: 4.00 back, +24 pieces, the pieces line untouched.
  const r1 = await refund(saleId, [{ id: p.id, quantity: 1, original_item_id: cartonLine.item_id }]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r1.body.id) as any).total_amount, 4);
  assert.equal(stockOf(p.id), 500 - 5);
  const rr = itemRows(r1.body.id)[0];
  assert.equal(rr.quantity, 24); assert.equal(rr.uom_qty, 1); assert.equal(rr.uom_name, "Carton"); assert.equal(rr.original_item_id, cartonLine.item_id);
  near(rr.unit_price, 4 / 24); near(rr.unit_cost, 0.1);

  const after1 = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body.lines;
  assert.equal(after1[1].remaining_qty, 0); assert.equal(after1[1].refunded_qty, 1);
  assert.equal(after1[0].remaining_qty, 5, "the pieces line is unaffected by the carton refund");

  // The carton line can't be refunded twice; the pieces line still can (in pieces).
  const again = await refund(saleId, [{ id: p.id, quantity: 1, original_item_id: cartonLine.item_id }]);
  assert.equal(again.status, 400); assert.equal(again.body.field, "items.0.quantity");
  const r2 = await refund(saleId, [{ id: p.id, quantity: 2, original_item_id: piecesLine.item_id }]);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r2.body.id) as any).total_amount, 0.5);
  const tooMany = await refund(saleId, [{ id: p.id, quantity: 4, original_item_id: piecesLine.item_id }]);
  assert.equal(tooMany.status, 400);
  // An original_item_id from another sale (or a wrong product) is rejected.
  const wrongLine = await refund(saleId, [{ id: p.id, quantity: 1, original_item_id: 987654 }]);
  assert.equal(wrongLine.status, 400);
});

test("a legacy refund without original_item_id (pieces) still works and is allocated to the product's lines in order", async () => {
  const { p, saleId } = await pcsAndCartonSale();
  // Old client: quantity in pieces, no original_item_id. 3 pieces land on the first line (the 5 loose pieces).
  const r1 = await refund(saleId, [{ id: p.id, quantity: 3 }]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r1.body.id) as any).total_amount, 0.75);
  assert.equal(stockOf(p.id), 500 - 29 + 3);
  let lines = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body.lines;
  assert.equal(lines[0].remaining_qty, 2);
  assert.equal(lines[1].remaining_qty, 1, "the carton line is intact");
  // 26 pieces = the 2 remaining loose pieces + the whole carton (24): spans both lines.
  const r2 = await refund(saleId, [{ id: p.id, quantity: 26 }]);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r2.body.id) as any).total_amount, 0.5 + 4);
  const rows = itemRows(r2.body.id);
  assert.equal(rows.length, 2, "one row per original line touched");
  assert.deepEqual(rows.map((r) => r.quantity), [2, 24]);
  lines = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body.lines;
  assert.equal(lines[0].remaining_qty, 0); assert.equal(lines[1].remaining_qty, 0);
  // Nothing left.
  assert.equal((await refund(saleId, [{ id: p.id, quantity: 1 }])).status, 400);
  assert.equal(stockOf(p.id), 500);
});

// ---------------------------------------------------------------------------------------------
// Invoice edit
// ---------------------------------------------------------------------------------------------

test("editing a carton line: quantity change moves stock by pieces; totals and snapshot follow", async () => {
  const p = await makeProduct({ price: 0.25, cost: 0.1, stock: 500, units: [{ name: "Carton", factor: 24, price: 4 }] });
  const carton = p.units[0];
  const s = await sale([{ id: p.id, quantity: 2, uom_id: carton.id }], { payments: cash(8) });
  assert.equal(stockOf(p.id), 500 - 48);

  const edit = await app.api("PUT", `/api/transactions/${s.body.id}`, { tenantId, body: {
    items: [{ product_id: p.id, uom_id: carton.id, quantity: 3, unit_price: 4 }] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(stockOf(p.id), 500 - 72, "3 cartons = 72 pieces out");
  const [row] = itemRows(s.body.id);
  assert.equal(row.quantity, 72); near(row.unit_price, 4 / 24); assert.equal(row.uom_qty, 3); assert.equal(row.uom_id, carton.id); assert.equal(row.uom_name, "Carton");
  near(row.unit_cost, 0.1, "old unit_cost kept for the same product + unit");
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(s.body.id) as any).total_amount, 12);
  // The response re-renders the same shape as GET, with display fields.
  const detail = (await app.api("GET", `/api/transactions/${s.body.id}`, { tenantId })).body;
  assert.equal(detail.items[0].display_qty, 3); near(detail.items[0].display_unit_price, 4);

  // Switch the line to loose pieces (no uom_id): 10 pieces at 0.25.
  const toPieces = await app.api("PUT", `/api/transactions/${s.body.id}`, { tenantId, body: { items: [{ product_id: p.id, quantity: 10, unit_price: 0.25 }] } });
  assert.equal(toPieces.status, 200, JSON.stringify(toPieces.body));
  assert.equal(stockOf(p.id), 500 - 10);
  assert.equal(itemRows(s.body.id)[0].uom_id, null);
  // A unit that isn't the product's is rejected.
  const bad = await app.api("PUT", `/api/transactions/${s.body.id}`, { tenantId, body: { items: [{ product_id: p.id, uom_id: 123456, quantity: 1, unit_price: 4 }] } });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, "UOM_INVALID");
});

test("editing a sale keeps its refunds attached to the right line and enforces the refund floor in pieces", async () => {
  const { p, carton, saleId } = await pcsAndCartonSale();
  const lines = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body.lines;
  const r = await refund(saleId, [{ id: p.id, quantity: 1, original_item_id: lines[1].item_id }]);
  assert.equal(r.status, 200);
  // Edit: the carton line goes from 1 to 3 cartons. Line ids are replaced, but the refund follows.
  const edit = await app.api("PUT", `/api/transactions/${saleId}`, { tenantId, body: { items: [
    { product_id: p.id, quantity: 5, unit_price: 0.25 }, { product_id: p.id, uom_id: carton.id, quantity: 3, unit_price: 4 }] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const after1 = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body.lines;
  assert.equal(after1[1].sold_qty, 3); assert.equal(after1[1].refunded_qty, 1); assert.equal(after1[1].remaining_qty, 2);
  assert.equal(after1[0].refunded_qty, 0);
  // Dropping below what was refunded (24 pieces) is rejected.
  const tooLow = await app.api("PUT", `/api/transactions/${saleId}`, { tenantId, body: { items: [{ product_id: p.id, quantity: 10, unit_price: 0.25 }] } });
  assert.equal(tooLow.status, 400);
});

// ---------------------------------------------------------------------------------------------
// Settlement + archived refunds
// ---------------------------------------------------------------------------------------------

test("settlement copies the uom columns to the archive, and an archived carton line can still be refunded", async () => {
  const { p, carton, saleId } = await pcsAndCartonSale();
  const settle = await app.api("POST", "/api/tenant/settlement", { tenantId, body: {} });
  assert.equal(settle.status, 200, JSON.stringify(settle.body));
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM transaction_items WHERE transaction_id = ?").get(saleId) as any).c, 0);
  const archived = app.db.prepare("SELECT * FROM archived_transaction_items WHERE transaction_id = ? ORDER BY id").all(saleId) as any[];
  assert.equal(archived.length, 2);
  assert.equal(archived[0].uom_id, null);
  assert.equal(archived[1].uom_id, carton.id); assert.equal(archived[1].uom_name, "Carton"); assert.equal(archived[1].uom_factor, 24); assert.equal(archived[1].uom_qty, 1);
  assert.equal(archived[1].quantity, 24);

  // The archived sale is viewable with display fields and refundable per line.
  const detail = (await app.api("GET", `/api/transactions/${saleId}`, { tenantId })).body;
  assert.equal(detail.archived, 1);
  assert.equal(detail.items[1].display_qty, 1); near(detail.items[1].display_unit_price, 4);
  const info = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body;
  assert.equal(info.transaction.archived, 1);
  assert.equal(info.lines.length, 2);
  assert.equal(info.lines[1].item_id, archived[1].id);
  const stockBefore = stockOf(p.id);
  const r = await refund(saleId, [{ id: p.id, quantity: 1, original_item_id: archived[1].id }]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(stockOf(p.id), stockBefore + 24);
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r.body.id) as any).total_amount, 4);
  const again = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body.lines;
  assert.equal(again[1].remaining_qty, 0);
  assert.equal(again[0].remaining_qty, 5);

  // Editing an archived carton line works too and keeps the snapshot.
  const edit = await app.api("PUT", `/api/transactions/${saleId}`, { tenantId, body: { items: [
    { product_id: p.id, quantity: 5, unit_price: 0.25 }, { product_id: p.id, uom_id: carton.id, quantity: 2, unit_price: 4 }] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const archived2 = app.db.prepare("SELECT * FROM archived_transaction_items WHERE transaction_id = ? ORDER BY id").all(saleId) as any[];
  assert.equal(archived2[1].quantity, 48); assert.equal(archived2[1].uom_qty, 2); assert.equal(archived2[1].uom_name, "Carton");
  // The refund taken earlier (live refund row) followed the carton line to its new id.
  const st = (await app.api("GET", `/api/transactions/${saleId}/refundable`, { tenantId })).body.lines;
  assert.equal(st[1].refunded_qty, 1);
});

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

test("receipt prints the unit name and quantity in the line's unit", () => {
  const buf = buildReceiptBuffer({
    storeName: "Acme", language: "en",
    transaction: {
      id: 1, total_amount: 9.6, payments: [{ method: "cash", amount: 9.6, currency: "USD" }],
      items: [
        { name: "Water 0.5L", price: 0.2, quantity: 48, uom_id: 7, uom_name: "Carton", uom_factor: 24, uom_qty: 2 },
        { name: "Gum", price: 0.5, quantity: 3 },
      ],
    },
  } as any);
  const text = buf.toString("latin1");
  assert.ok(text.includes("Water 0.5L - Carton x24"), "unit line shows the unit name");
  assert.ok(text.includes("9.60"), "line total is qty x unit price");
  assert.ok(text.includes("Gum"), "base-unit lines are unchanged");
  assert.ok(!text.includes("Gum -"), "no unit suffix on base lines");
});

// ---------------------------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------------------------

test("import: package_price / units_per_package upsert a Pack unit; package_barcode sets its barcode", async () => {
  const imp = (rows: any[], mode = "upsert") => app.api("POST", "/api/import/products", { tenantId, body: { mode, dry_run: false, rows } });
  const res = await imp([{ name: "Imported Juice", barcode: "IMP-J1", price: "1", package_price: "5", units_per_package: "6", package_barcode: "IMP-J1-PACK" }]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const prod = app.db.prepare("SELECT id, package_price, units_per_package FROM products WHERE barcode = 'IMP-J1'").get() as any;
  assert.equal(prod.package_price, 5); assert.equal(prod.units_per_package, 6);
  const unit = app.db.prepare("SELECT * FROM product_units WHERE product_id = ? AND deleted_at IS NULL").all(prod.id) as any[];
  assert.equal(unit.length, 1);
  assert.equal(unit[0].name, "Pack"); assert.equal(unit[0].factor, 6); assert.equal(unit[0].price, 5); assert.equal(unit[0].barcode, "IMP-J1-PACK");
  // Resolves by scanning the pack barcode.
  assert.equal((await app.api("GET", "/api/products/IMP-J1-PACK", { tenantId })).body.matched_uom_id, unit[0].id);

  // Re-import with a new pack price: the same unit is updated (matched by factor), not duplicated.
  const again = await imp([{ barcode: "IMP-J1", package_price: "5.5", units_per_package: "6" }]);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const units2 = app.db.prepare("SELECT * FROM product_units WHERE product_id = ? AND deleted_at IS NULL").all(prod.id) as any[];
  assert.equal(units2.length, 1); assert.equal(units2[0].price, 5.5); assert.equal(units2[0].barcode, "IMP-J1-PACK", "barcode untouched when the column is absent");

  // Barcode conflicts: pack barcode used by another product's barcode / unit; duplicated in the file.
  const clash = await imp([{ name: "Other Juice", barcode: "IMP-J2", price: "1", package_price: "5", units_per_package: "6", package_barcode: "IMP-J1" }]);
  assert.equal(clash.status, 422);
  assert.equal(clash.body.errors[0].code, "BARCODE_TAKEN"); assert.equal(clash.body.errors[0].field, "package_barcode");
  const clash2 = await imp([{ name: "Other Juice", barcode: "IMP-J2", price: "1", package_price: "5", units_per_package: "6", package_barcode: "IMP-J1-PACK" }]);
  assert.equal(clash2.status, 422); assert.equal(clash2.body.errors[0].code, "BARCODE_TAKEN");
  const clash3 = await imp([{ name: "Product As Pack", barcode: "IMP-J1-PACK", price: "1" }]);
  assert.equal(clash3.status, 422); assert.equal(clash3.body.errors[0].code, "BARCODE_TAKEN");
  const dupFile = await imp([
    { name: "F1", barcode: "IMP-F1", price: "1", package_price: "5", units_per_package: "6", package_barcode: "IMP-DUP" },
    { name: "F2", barcode: "IMP-F2", price: "1", package_price: "5", units_per_package: "6", package_barcode: "IMP-DUP" }]);
  assert.equal(dupFile.status, 422); assert.equal(dupFile.body.errors[0].code, "DUPLICATE_IN_FILE"); assert.equal(dupFile.body.errors[0].field, "package_barcode");
  // A pack barcode without a usable package price / units is an error.
  const noPack = await imp([{ name: "F3", barcode: "IMP-F3", price: "1", package_barcode: "IMP-NOPACK" }]);
  assert.equal(noPack.status, 422); assert.equal(noPack.body.errors[0].code, "MISSING_REQUIRED");
});
