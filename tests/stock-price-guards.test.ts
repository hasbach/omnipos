// Stock / price guards and disabled products (docs/plans/2026-09-29-stock-and-price-guards.md).
// Every guard is a tenant setting whose DEFAULT reproduces the old behaviour, so each rule is tested
// both off (default) and on.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Guards Co", "guards-co@example.com");
});
after(async () => { await app.close(); });

const setSetting = (key: string, value: string) =>
  app.db.prepare("INSERT OR REPLACE INTO settings (tenant_id, key, value) VALUES (?, ?, ?)").run(tenantId, key, value);
const stockOf = (id: number) => (app.db.prepare("SELECT stock FROM products WHERE id = ?").get(id) as any).stock as number;
const cartonOf = (productId: number) => (app.db.prepare("SELECT id FROM product_units WHERE product_id = ?").get(productId) as any).id as number;

let seq = 0;
async function makeProduct(opts: { price?: number; cost?: number; stock?: number; units?: any[]; extra?: Record<string, any> } = {}) {
  seq++;
  const res = await app.api("POST", "/api/products", { tenantId, body: {
    name: `Guard Product ${seq}`, price: opts.price ?? 10, cost: opts.cost, stock: opts.stock ?? 10, category: "general", currency: "USD", unit: "pcs",
    barcodes: [`GRD-${seq}`], units: opts.units, ...(opts.extra || {}),
  } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id: res.body.id as number, barcode: `GRD-${seq}` };
}
const sale = (items: any[], extra: Record<string, any> = {}) => app.api("POST", "/api/transactions", { tenantId, body: {
  type: "sale", items, currency: "USD", exchange_rate: 1, payments: [], ...extra } });
const purchase = (items: any[]) => app.api("POST", "/api/transactions", { tenantId, body: {
  type: "purchase", items, currency: "USD", exchange_rate: 1, payments: [] } });

test("defaults: below-cost sale and overselling still work", async () => {
  const p = await makeProduct({ price: 10, cost: 6, stock: 2 });
  const r = await sale([{ id: p.id, quantity: 5, unit_price: 1 }], { source: "backoffice" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(stockOf(p.id), -3);
});

test("allow_below_cost = 0: BELOW_COST with field and per-unit cost; line discount counts; refunds/purchases unaffected", async () => {
  setSetting("allow_below_cost", "0");
  try {
    const p = await makeProduct({ price: 10, cost: 6, stock: 100 });
    const low = await sale([{ id: p.id, quantity: 1, unit_price: 5 }], { source: "backoffice" });
    assert.equal(low.status, 400);
    assert.equal(low.body.code, "BELOW_COST");
    assert.equal(low.body.field, "items.0.unit_price");
    assert.equal(low.body.cost, 6);
    // Exactly at cost is fine.
    assert.equal((await sale([{ id: p.id, quantity: 1, unit_price: 6 }], { source: "backoffice" })).status, 200);
    // Catalog price with a line discount that pushes it below cost (10 - 50% = 5 < 6).
    const disc = await sale([{ id: p.id, quantity: 1 }, { id: p.id, quantity: 1, discount: { type: "percentage", value: 50 } }]);
    assert.equal(disc.status, 400);
    assert.equal(disc.body.code, "BELOW_COST");
    assert.equal(disc.body.field, "items.1.unit_price");
    // A small discount staying above cost passes.
    assert.equal((await sale([{ id: p.id, quantity: 1, discount: { type: "percentage", value: 10 } }])).status, 200);
    // Purchases are never checked.
    assert.equal((await purchase([{ id: p.id, quantity: 1, price: 1 }])).status, 200);
    // Product without a cost is never blocked.
    const nc = await makeProduct({ price: 10, stock: 5 });
    assert.equal((await sale([{ id: nc.id, quantity: 1, unit_price: 0.5 }], { source: "backoffice" })).status, 200);
  } finally { setSetting("allow_below_cost", "1"); }
});

test("allow_below_cost = 0 with units: cost extra is per unit of the line's UoM", async () => {
  setSetting("allow_below_cost", "0");
  try {
    const p = await makeProduct({ price: 1, cost: 0.5, stock: 100, units: [{ name: "Carton", factor: 24, price: 20 }] });
    const carton = cartonOf(p.id);
    // 24 pcs cost 12 per carton; carton at 20 is fine, typed 10 is below cost.
    assert.equal((await sale([{ id: p.id, quantity: 1, uom_id: carton }])).status, 200);
    const bad = await sale([{ id: p.id, quantity: 1, uom_id: carton, unit_price: 10 }], { source: "backoffice" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "BELOW_COST");
    assert.equal(bad.body.cost, 12);
  } finally { setSetting("allow_below_cost", "1"); }
});

test("allow_negative_stock = 0: POST sale INSUFFICIENT_STOCK 409, units summed across lines", async () => {
  setSetting("allow_negative_stock", "0");
  try {
    const p = await makeProduct({ price: 10, stock: 40, units: [{ name: "Carton", factor: 24, price: 200 }] });
    const carton = cartonOf(p.id);
    const over = await sale([{ id: p.id, quantity: 2, uom_id: carton }]); // 48 pcs vs 40
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.code, "INSUFFICIENT_STOCK");
    assert.equal(over.body.field, "items.0.quantity");
    assert.equal(over.body.available, 40);
    assert.equal(over.body.product_id, p.id);
    assert.equal(stockOf(p.id), 40, "nothing was saved");
    // Split across two lines: 24 + 20 = 44 > 40; field points at the first line of the product.
    const split = await sale([{ id: p.id, quantity: 1, uom_id: carton }, { id: p.id, quantity: 20 }]);
    assert.equal(split.status, 409);
    assert.equal(split.body.field, "items.0.quantity");
    // Exactly the stock is allowed (down to 0).
    assert.equal((await sale([{ id: p.id, quantity: 1, uom_id: carton }, { id: p.id, quantity: 16 }])).status, 200);
    assert.equal(stockOf(p.id), 0);
    assert.equal((await sale([{ id: p.id, quantity: 1 }])).status, 409);
    // Untracked products are never blocked.
    const svc = await makeProduct({ price: 10, stock: 0, extra: { track_inventory: 0 } });
    assert.equal((await sale([{ id: svc.id, quantity: 3 }])).status, 200);
  } finally { setSetting("allow_negative_stock", "1"); }
});

test("allow_negative_stock = 0: purchases and refunds are never blocked", async () => {
  setSetting("allow_negative_stock", "0");
  try {
    const p = await makeProduct({ price: 10, cost: 1, stock: 5 });
    const s = await sale([{ id: p.id, quantity: 5 }]);
    assert.equal(s.status, 200);
    assert.equal((await purchase([{ id: p.id, quantity: 3, price: 1 }])).status, 200);
    const refund = await app.api("POST", "/api/transactions", { tenantId, body: {
      type: "refund", original_transaction_id: s.body.id, items: [{ id: p.id, quantity: 2 }], currency: "USD", exchange_rate: 1, payments: [] } });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    assert.equal(stockOf(p.id), 5);
  } finally { setSetting("allow_negative_stock", "1"); }
});

test("allow_negative_stock = 0: invoice edit beyond stock is rejected; an edit that doesn't worsen a negative product passes", async () => {
  const p = await makeProduct({ price: 10, stock: 10 });
  const s = await sale([{ id: p.id, quantity: 5 }]);
  assert.equal(s.status, 200);
  assert.equal(stockOf(p.id), 5);
  setSetting("allow_negative_stock", "0");
  try {
    const edit = (qty: number) => app.api("PUT", `/api/transactions/${s.body.id}`, { tenantId, body: { items: [{ product_id: p.id, quantity: qty }] } });
    const bad = await edit(20); // needs 15 more, only 5 on hand
    assert.equal(bad.status, 409, JSON.stringify(bad.body));
    assert.equal(bad.body.code, "INSUFFICIENT_STOCK");
    assert.equal(bad.body.field, "items.0.quantity");
    assert.equal(bad.body.available, 5);
    assert.equal(stockOf(p.id), 5);
    // Up to exactly the stock is fine.
    assert.equal((await edit(10)).status, 200);
    assert.equal(stockOf(p.id), 0);

    // Make the product negative behind the guard's back, then edit without worsening it.
    app.db.prepare("UPDATE products SET stock = -3 WHERE id = ?").run(p.id);
    assert.equal((await edit(10)).status, 200, "unchanged qty does not worsen stock");
    assert.equal((await edit(8)).status, 200, "reducing qty improves stock");
    assert.equal(stockOf(p.id), -1);
    assert.equal((await edit(9)).status, 409, "increasing qty worsens an already-negative product");
  } finally { setSetting("allow_negative_stock", "1"); }
});

test("allow_negative_stock = 0: purchase edit / delete that removes stock below zero is rejected", async () => {
  const p = await makeProduct({ price: 10, cost: 1, stock: 0 });
  const pu = await purchase([{ id: p.id, quantity: 10, price: 1 }]);
  assert.equal(pu.status, 200);
  assert.equal((await sale([{ id: p.id, quantity: 8 }])).status, 200);
  assert.equal(stockOf(p.id), 2);
  setSetting("allow_negative_stock", "0");
  try {
    const shrink = await app.api("PUT", `/api/transactions/${pu.body.id}`, { tenantId, body: { items: [{ product_id: p.id, quantity: 5, unit_price: 1 }] } });
    assert.equal(shrink.status, 409, JSON.stringify(shrink.body));
    assert.equal(shrink.body.code, "INSUFFICIENT_STOCK");
    assert.equal(shrink.body.field, "items.0.quantity");
    const del = await app.api("DELETE", `/api/transactions/${pu.body.id}`, { tenantId });
    assert.equal(del.status, 409, JSON.stringify(del.body));
    assert.equal(del.body.code, "INSUFFICIENT_STOCK");
    assert.equal(stockOf(p.id), 2, "nothing changed");
    // Growing a purchase is fine.
    assert.equal((await app.api("PUT", `/api/transactions/${pu.body.id}`, { tenantId, body: { items: [{ product_id: p.id, quantity: 20, unit_price: 1 }] } })).status, 200);
  } finally { setSetting("allow_negative_stock", "1"); }
  // Guard off: deleting the purchase is allowed again (stock goes negative, as before).
  assert.equal((await app.api("DELETE", `/api/transactions/${pu.body.id}`, { tenantId })).status, 200);
  assert.equal(stockOf(p.id), -8);
});

test("allow_below_cost = 0: an invoice edit that pushes a sale line below cost is rejected", async () => {
  const p = await makeProduct({ price: 10, cost: 6, stock: 50 });
  const s = await sale([{ id: p.id, quantity: 1 }]);
  assert.equal(s.status, 200);
  setSetting("allow_below_cost", "0");
  try {
    const bad = await app.api("PUT", `/api/transactions/${s.body.id}`, { tenantId, body: { items: [{ product_id: p.id, quantity: 1, unit_price: 5 }] } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, "BELOW_COST");
    assert.equal(bad.body.field, "items.0.unit_price");
    assert.equal(bad.body.cost, 6);
    assert.equal((await app.api("PUT", `/api/transactions/${s.body.id}`, { tenantId, body: { items: [{ product_id: p.id, quantity: 1, unit_price: 7 }] } })).status, 200);
  } finally { setSetting("allow_below_cost", "1"); }
});

test("stock adjust: rejects a negative target only when allow_negative_stock = 0", async () => {
  const p = await makeProduct({ stock: 5 });
  setSetting("allow_negative_stock", "0");
  try {
    const bad = await app.api("POST", "/api/stock/adjust", { tenantId, body: { product_id: p.id, new_qty: -2 } });
    assert.equal(bad.status, 409, JSON.stringify(bad.body));
    assert.equal(bad.body.code, "INSUFFICIENT_STOCK");
    assert.equal(bad.body.field, "new_qty");
    const badDelta = await app.api("POST", "/api/stock/adjust", { tenantId, body: { product_id: p.id, delta: -6 } });
    assert.equal(badDelta.status, 409);
    assert.equal(badDelta.body.field, "delta");
    assert.equal(stockOf(p.id), 5);
    assert.equal((await app.api("POST", "/api/stock/adjust", { tenantId, body: { product_id: p.id, new_qty: 0 } })).status, 200);
  } finally { setSetting("allow_negative_stock", "1"); }
  assert.equal((await app.api("POST", "/api/stock/adjust", { tenantId, body: { product_id: p.id, new_qty: -2 } })).status, 200);
  assert.equal(stockOf(p.id), -2);
});

const productBody = (p: { barcode: string }, extra: Record<string, any> = {}) =>
  ({ name: "Disabled One", price: 10, cost: 1, category: "general", currency: "USD", unit: "pcs", barcodes: [p.barcode], ...extra });

test("disabled product: sale rejected, lookup 404, purchase/refund/edit keep working, list still returns it with active", async () => {
  const p = await makeProduct({ price: 10, cost: 1, stock: 20 });
  const first = await sale([{ id: p.id, quantity: 2 }]);
  assert.equal(first.status, 200);

  const upd = await app.api("PUT", `/api/products/${p.id}`, { tenantId, body: productBody(p, { active: 0 }) });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const list = (await app.api("GET", "/api/products", { tenantId })).body as any[];
  assert.equal(list.find((x) => x.id === p.id).active, 0);

  const blocked = await sale([{ id: p.id, quantity: 1 }]);
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, "PRODUCT_DISABLED");
  assert.equal(blocked.body.field, "items.0.id");

  const lookup = await app.api("GET", `/api/products/${p.barcode}`, { tenantId });
  assert.equal(lookup.status, 404);
  assert.equal(lookup.body.code, "PRODUCT_DISABLED");
  assert.equal(lookup.body.product_id, p.id);
  assert.equal(lookup.body.name, "Disabled One");

  assert.equal((await purchase([{ id: p.id, quantity: 5, price: 1 }])).status, 200);
  // Existing invoice lines of a now-disabled product can still be edited and refunded.
  assert.equal((await app.api("PUT", `/api/transactions/${first.body.id}`, { tenantId, body: { items: [{ product_id: p.id, quantity: 3 }] } })).status, 200);
  const refund = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "refund", original_transaction_id: first.body.id, items: [{ id: p.id, quantity: 1 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  // ...but a disabled product can't be ADDED to a sale by an edit.
  const other = await makeProduct({ price: 5, stock: 5 });
  const s2 = await sale([{ id: other.id, quantity: 1 }]);
  const add = await app.api("PUT", `/api/transactions/${s2.body.id}`, { tenantId, body: { items: [{ product_id: other.id, quantity: 1 }, { product_id: p.id, quantity: 1 }] } });
  assert.equal(add.status, 400);
  assert.equal(add.body.code, "PRODUCT_DISABLED");

  // PUT without `active` leaves it disabled; re-enabling restores selling and lookup.
  await app.api("PUT", `/api/products/${p.id}`, { tenantId, body: productBody(p) });
  assert.equal((await app.api("GET", `/api/products/${p.barcode}`, { tenantId })).status, 404);
  await app.api("PUT", `/api/products/${p.id}`, { tenantId, body: productBody(p, { active: 1 }) });
  assert.equal((await app.api("GET", `/api/products/${p.barcode}`, { tenantId })).status, 200);
  assert.equal((await sale([{ id: p.id, quantity: 1 }])).status, 200);
});

test("POST /api/products accepts active; new products default to active", async () => {
  const off = await makeProduct({ extra: { active: 0 } });
  const on = await makeProduct();
  const list = (await app.api("GET", "/api/products", { tenantId })).body as any[];
  assert.equal(list.find((x) => x.id === off.id).active, 0);
  assert.equal(list.find((x) => x.id === on.id).active, 1);
});

test("importer: active column (yes/no words), applied on create and on update only when present; invalid -> INVALID_VALUE", async () => {
  const imp = (rows: any[]) => app.api("POST", "/api/import/products", { tenantId, body: { mode: "upsert", dry_run: false, rows } });
  const activeOf = (barcode: string) => (app.db.prepare("SELECT active FROM products WHERE barcode = ? AND tenant_id = ?").get(barcode, tenantId) as any).active;
  const res = await imp([
    { name: "Imp Off", barcode: "GIMP-1", price: "1", active: "no" },
    { name: "Imp On", barcode: "GIMP-2", price: "1", active: "yes" },
    { name: "Imp Ar", barcode: "GIMP-3", price: "1", active: "لا" },
    { name: "Imp Fr", barcode: "GIMP-4", price: "1", active: "non" },
    { name: "Imp None", barcode: "GIMP-5", price: "1" },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => activeOf(`GIMP-${i}`)), [0, 1, 0, 0, 1]);
  // Update without the column leaves it alone; with it, changes it.
  assert.equal((await imp([{ barcode: "GIMP-1", price: "2" }])).status, 200);
  assert.equal(activeOf("GIMP-1"), 0);
  assert.equal((await imp([{ barcode: "GIMP-1", active: "true" }])).status, 200);
  assert.equal(activeOf("GIMP-1"), 1);
  assert.equal((await imp([{ barcode: "GIMP-2", active: "0" }])).status, 200);
  assert.equal(activeOf("GIMP-2"), 0);
  const bad = await imp([{ name: "Imp Bad", barcode: "GIMP-6", price: "1", active: "maybe" }]);
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors[0].code, "INVALID_VALUE");
  assert.equal(bad.body.errors[0].field, "active");
});

test("settings round-trip: the three new keys are stored and returned as-is", async () => {
  const save = await app.api("POST", "/api/settings", { tenantId, body: { allow_below_cost: "0", allow_negative_stock: "0", hide_out_of_stock: "1" } });
  assert.equal(save.status, 200);
  const got = (await app.api("GET", "/api/settings", { tenantId })).body;
  assert.equal(got.allow_below_cost, "0");
  assert.equal(got.allow_negative_stock, "0");
  assert.equal(got.hide_out_of_stock, "1");
  await app.api("POST", "/api/settings", { tenantId, body: { allow_below_cost: "1", allow_negative_stock: "1", hide_out_of_stock: "0" } });
  assert.equal((await app.api("GET", "/api/settings", { tenantId })).body.allow_negative_stock, "1");
});
