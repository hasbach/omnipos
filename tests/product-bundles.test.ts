// Product bundles (docs/superpowers/specs/2026-11-26-product-bundles-design.md): a product flagged as
// a bundle sells as a set of existing products. INVARIANT under test: a sold bundle is stored as one
// transaction_items row per component (its share of the bundle price, its own cost and stock), so
// stock, COGS and every report keep reading ordinary component lines.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createTestApp, seedTenant } from "./helpers/testApp.js";
import { buildReceiptBuffer } from "../server/printing/receipt.js";
import * as server from "../server/pricing.js";
import * as client from "../src/lib/pricing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let otherTenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Bundle Co", "bundle-co@example.com");
  otherTenantId = seedTenant(app.db, "Bundle Other Co", "bundle-other@example.com");
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-6, `${msg} ${a} != ${b}`);
const stockOf = (id: number) => (app.db.prepare("SELECT stock FROM products WHERE id = ?").get(id) as any).stock as number;
const cash = (amount: number) => [{ amount, method: "cash", currency: "USD", exchange_rate: 1 }];
const itemRows = (txId: number) => app.db.prepare("SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id").all(txId) as any[];
const setSetting = (key: string, value: string) => {
  app.db.prepare("DELETE FROM settings WHERE tenant_id = ? AND key = ?").run(tenantId, key);
  app.db.prepare("INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)").run(tenantId, key, value);
};
function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().split("T")[0];
}

let seq = 0;
async function makeProduct(opts: { name?: string; price: number; cost?: number; stock?: number; category?: string; track_inventory?: number; extra?: Record<string, any>; tenant?: number }) {
  seq++;
  const res = await app.api("POST", "/api/products", { tenantId: opts.tenant ?? tenantId, body: {
    name: opts.name ?? `Bundle Part ${seq}`, price: opts.price, cost: opts.cost, stock: opts.stock ?? 50,
    category: opts.category ?? "general", currency: "USD", unit: "pcs", barcodes: [`BND-${seq}`],
    track_inventory: opts.track_inventory, ...(opts.extra || {}),
  } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as number;
}
async function makeBundle(name: string, price: number, items: Array<{ component_id: number; quantity: number }>, extra: Record<string, any> = {}) {
  const res = await app.api("POST", "/api/products", { tenantId, body: {
    name, price, category: "Deals", currency: "USD", unit: "pcs", barcodes: [`BND-B-${++seq}`],
    is_bundle: 1, bundle_items: items, stock: 99, ...extra,
  } });
  return res;
}
const productById = async (id: number) => ((await app.api("GET", "/api/products", { tenantId })).body as any[]).find((p) => p.id === id);
const sale = (items: any[], extra: Record<string, any> = {}) => app.api("POST", "/api/transactions", { tenantId, body: {
  type: "sale", items, currency: "USD", exchange_rate: 1, payments: [], ...extra } });

// ---------------------------------------------------------------------------------------------
// Shared math
// ---------------------------------------------------------------------------------------------

test("bundle math section is byte-identical in server/pricing.ts and src/lib/pricing.ts", () => {
  const section = (rel: string) => {
    const text = fs.readFileSync(path.join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf("// BEGIN BUNDLE MATH");
    const end = text.indexOf("// END BUNDLE MATH");
    assert.ok(start > 0 && end > start, `${rel} has the bundle markers`);
    return text.slice(start, end);
  };
  assert.equal(section("server/pricing.ts"), section("src/lib/pricing.ts"));
});

test("bundleShares / allocateBundleAmount split by list price, fall back to quantity, sum exactly", () => {
  const comps = [{ listPrice: 10, quantity: 1 }, { listPrice: 5, quantity: 1 }];
  for (const m of [server, client]) {
    const shares = m.bundleShares(comps);
    near(shares[0], 2 / 3); near(shares[1], 1 / 3);
    const parts = m.allocateBundleAmount(13, comps);
    near(parts[0], 13 * 10 / 15, "13 x 10/15"); near(parts[1], 13 * 5 / 15, "13 x 5/15");
    assert.equal(parts[0] + parts[1], 13, "parts add back to the bundle price exactly");
    // Quantity counts in the list value: 2 x $10 + 1 x $5 -> 20/25 and 5/25.
    const q = m.bundleShares([{ listPrice: 10, quantity: 2 }, { listPrice: 5, quantity: 1 }]);
    near(q[0], 0.8); near(q[1], 0.2);
    // All list prices 0 -> by quantity.
    const z = m.bundleShares([{ listPrice: 0, quantity: 3 }, { listPrice: 0, quantity: 1 }]);
    near(z[0], 0.75); near(z[1], 0.25);
    assert.deepEqual(m.bundleShares([]), []);
    const s = m.bundleSaving(13, comps);
    near(s.listTotal, 15); near(s.saving, 2);
  }
  // Odd splits still sum to exactly 1 / the amount.
  const odd = [{ listPrice: 0.33, quantity: 3 }, { listPrice: 1.07, quantity: 7 }, { listPrice: 9.99, quantity: 1 }];
  assert.equal(server.bundleShares(odd).reduce((a, b) => a + b, 0), 1);
  assert.equal(server.allocateBundleAmount(17.35, odd).reduce((a, b) => a + b, 0), 17.35);
  assert.deepEqual(server.allocateBundleAmount(17.35, odd), client.allocateBundleAmount(17.35, odd));
});

test("groupBundleLines collapses component rows into one display line in place", () => {
  const rows = [
    { quantity: 1, unit_price: 2, name: "Gum" },
    { quantity: 2, unit_price: 26 / 3 / 2 * 2 / 2, name: "A", bundle_id: 9, bundle_name: "Deal", bundle_qty: 2, bundle_line: 1 },
    { quantity: 2, unit_price: 13 / 3, name: "B", bundle_id: 9, bundle_name: "Deal", bundle_qty: 2, bundle_line: 1 },
    { quantity: 1, unit_price: 1, name: "Pen" },
  ];
  rows[1].unit_price = 13 * 2 / 3; // per piece: one bundle holds 1 A
  for (const m of [server, client]) {
    const g = m.groupBundleLines(rows as any);
    assert.deepEqual(g.map((e: any) => e.kind), ["item", "bundle", "item"]);
    const b = g[1] as any;
    assert.equal(b.bundle_name, "Deal");
    assert.equal(b.bundle_qty, 2);
    near(b.unit_price, 13);
    near(b.line_total, 26);
    assert.equal(b.components.length, 2);
  }
});

// ---------------------------------------------------------------------------------------------
// Product editor API
// ---------------------------------------------------------------------------------------------

test("bundle CRUD: create, list with components, update in place, validation codes", async () => {
  const a = await makeProduct({ name: "Shampoo", price: 10, cost: 6 });
  const b = await makeProduct({ name: "Conditioner", price: 5, cost: 2 });
  const res = await makeBundle("Hair duo", 13, [{ component_id: a, quantity: 1 }, { component_id: b, quantity: 1 }]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const bundle = await productById(res.body.id);
  assert.equal(bundle.is_bundle, 1);
  assert.equal(bundle.track_inventory, 0, "a bundle never tracks stock itself");
  assert.equal(bundle.stock, 0);
  assert.deepEqual(bundle.bundle_items.map((i: any) => [i.component_id, i.quantity, i.name]), [[a, 1, "Shampoo"], [b, 1, "Conditioner"]]);
  const row = app.db.prepare("SELECT global_id, updated_at FROM product_bundle_items WHERE id = ?").get(bundle.bundle_items[0].id) as any;
  assert.ok(row.global_id && row.updated_at, "synced table got its sync metadata");

  // Update: change a quantity (same row id), drop one component, add another.
  const c = await makeProduct({ name: "Comb", price: 2 });
  const put = await app.api("PUT", `/api/products/${bundle.id}`, { tenantId, body: {
    name: "Hair duo", price: 13, category: "Deals", currency: "USD", unit: "pcs", barcodes: bundle.barcodes,
    bundle_items: [{ component_id: a, quantity: 2 }, { component_id: c, quantity: 1 }] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const after1 = await productById(bundle.id);
  assert.deepEqual(after1.bundle_items.map((i: any) => [i.component_id, i.quantity]), [[a, 2], [c, 1]]);
  assert.equal(after1.bundle_items[0].id, bundle.bundle_items[0].id, "same row updated in place");
  assert.ok((app.db.prepare("SELECT deleted_at FROM product_bundle_items WHERE id = ?").get(bundle.bundle_items[1].id) as any).deleted_at, "removed component soft-deleted");

  // PUT without bundle_items keeps the list.
  await app.api("PUT", `/api/products/${bundle.id}`, { tenantId, body: { name: "Hair duo!", price: 13, category: "Deals", currency: "USD", unit: "pcs", barcodes: bundle.barcodes } });
  assert.equal((await productById(bundle.id)).bundle_items.length, 2);

  // Validation codes.
  const code = async (items: any, extra: Record<string, any> = {}) => (await makeBundle("Bad", 1, items, extra)).body.code;
  assert.equal(await code([]), "BUNDLE_EMPTY");
  assert.equal(await code([{ component_id: a, quantity: 0 }]), "BUNDLE_QTY_INVALID");
  assert.equal(await code([{ component_id: a, quantity: 1 }, { component_id: a, quantity: 2 }]), "BUNDLE_DUPLICATE_COMPONENT");
  assert.equal(await code([{ component_id: bundle.id, quantity: 1 }]), "BUNDLE_NESTED");
  assert.equal(await code([{ component_id: 999999, quantity: 1 }]), "BUNDLE_COMPONENT_MISSING");
  const foreign = await makeProduct({ price: 1, tenant: otherTenantId });
  assert.equal(await code([{ component_id: foreign, quantity: 1 }]), "BUNDLE_COMPONENT_MISSING", "another tenant's product");
  const self = await app.api("PUT", `/api/products/${bundle.id}`, { tenantId, body: { name: "x", price: 1, category: "Deals", currency: "USD", unit: "pcs", barcodes: bundle.barcodes, bundle_items: [{ component_id: bundle.id, quantity: 1 }] } });
  assert.equal(self.body.code, "BUNDLE_SELF");
  // A component of a bundle can't become a bundle.
  const nest = await app.api("PUT", `/api/products/${a}`, { tenantId, body: { name: "Shampoo", price: 10, category: "general", currency: "USD", unit: "pcs", barcodes: [], is_bundle: 1, bundle_items: [{ component_id: b, quantity: 1 }] } });
  assert.equal(nest.body.code, "BUNDLE_NESTED");

  // Turning the flag off clears the components.
  await app.api("PUT", `/api/products/${bundle.id}`, { tenantId, body: { name: "Hair duo", price: 13, category: "Deals", currency: "USD", unit: "pcs", barcodes: bundle.barcodes, is_bundle: 0 } });
  const plain = await productById(bundle.id);
  assert.equal(plain.is_bundle, 0);
  assert.equal(plain.bundle_items, undefined);
  assert.equal((app.db.prepare("SELECT COUNT(*) c FROM product_bundle_items WHERE bundle_id = ? AND deleted_at IS NULL").get(bundle.id) as any).c, 0);
});

// ---------------------------------------------------------------------------------------------
// Selling
// ---------------------------------------------------------------------------------------------

test("sale: a bundle expands into component lines with allocated price, own cost, component stock", async () => {
  const a = await makeProduct({ name: "Item A", price: 10, cost: 6, stock: 20, category: "Hair" });
  const b = await makeProduct({ name: "Item B", price: 5, cost: 2, stock: 20, category: "Care" });
  const bundleId = (await makeBundle("A+B deal", 13, [{ component_id: a, quantity: 1 }, { component_id: b, quantity: 1 }])).body.id;
  const gum = await makeProduct({ name: "Gum", price: 1, stock: 20 });

  const res = await sale([{ id: gum, quantity: 1 }, { id: bundleId, quantity: 2 }], { payments: cash(27) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const tx = app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(res.body.id) as any;
  near(tx.total_amount, 27, "total = gum + 2 bundles");
  const rows = itemRows(res.body.id);
  assert.deepEqual(rows.map((r) => r.product_id), [gum, a, b], "no row for the bundle product itself");
  const [ra, rb] = rows.slice(1);
  near(ra.quantity, 2); near(rb.quantity, 2);
  near(ra.unit_price, 13 * 10 / 15, "A carries 10/15 of $13 per piece");
  near(rb.unit_price, 13 * 5 / 15, "B carries 5/15 of $13 per piece");
  near(ra.unit_price * ra.quantity + rb.unit_price * rb.quantity, 26, "component lines add up to the bundle line");
  assert.equal(ra.unit_cost, 6); assert.equal(rb.unit_cost, 2);
  for (const r of [ra, rb]) {
    assert.equal(r.bundle_id, bundleId);
    assert.equal(r.bundle_name, "A+B deal");
    assert.equal(r.bundle_qty, 2);
    assert.equal(r.bundle_line, 1);
  }
  assert.equal(rows[0].bundle_line, null);
  assert.equal(stockOf(a), 18); assert.equal(stockOf(b), 18);
  assert.equal(stockOf(bundleId), 0, "bundle stock never moves");

  // Sales by category: the bundle price is split over the components' categories.
  const cat = (await app.api("GET", `/api/reports/by-category?from=${localToday()}&to=${localToday()}`, { tenantId })).body as any[];
  near(cat.find((c) => c.category === "Hair").revenue, 17.33, "Hair = 26 x 10/15");
  near(cat.find((c) => c.category === "Care").revenue, 8.67, "Care = 26 x 5/15");
  assert.equal(cat.find((c) => c.category === "Deals"), undefined, "nothing booked on the bundle's own category");
  const hair = cat.find((c) => c.category === "Hair");
  near(hair.cogs, 12, "COGS from the component's own cost");
});

test("sale: component quantities, line discounts and the same bundle twice in one cart", async () => {
  const a = await makeProduct({ name: "Cup", price: 10, cost: 3, stock: 50 });
  const b = await makeProduct({ name: "Lid", price: 5, cost: 1, stock: 50 });
  const bundleId = (await makeBundle("2 cups + lid", 20, [{ component_id: a, quantity: 2 }, { component_id: b, quantity: 1 }])).body.id;

  const res = await sale([
    { id: bundleId, quantity: 1, discount: { type: "percentage", value: 10 } },
    { id: bundleId, quantity: 2, discount: { type: "fixed", value: 4 } },
  ], { payments: cash(18 + 36) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(res.body.id) as any).total_amount, 54);
  const rows = itemRows(res.body.id);
  assert.equal(rows.length, 4);
  const line1 = rows.filter((r) => r.bundle_line === 1);
  const line2 = rows.filter((r) => r.bundle_line === 2);
  assert.equal(line1.length, 2); assert.equal(line2.length, 2);
  // 2 cups per bundle: share 20/25 of $20 = $16 per bundle -> $8 per cup.
  near(line1[0].quantity, 2); near(line1[0].unit_price, 8);
  near(line1[1].quantity, 1); near(line1[1].unit_price, 4);
  assert.ok(line1.every((r) => r.discount_type === "percentage" && r.discount_value === 10), "percentage copied");
  // Fixed $4 split by share: 3.2 / 0.8.
  near(line2[0].discount_value, 3.2); near(line2[1].discount_value, 0.8);
  const total = (r: any) => (r.discount_type === "percentage" ? r.unit_price * r.quantity * (1 - r.discount_value / 100) : r.unit_price * r.quantity - r.discount_value);
  near(rows.reduce((s, r) => s + total(r), 0), 54, "rows' line totals add up to the transaction");
  assert.equal(stockOf(a), 50 - 6); assert.equal(stockOf(b), 50 - 3);
});

test("sale: stock guards respect each component's track_inventory and allow_negative_stock", async () => {
  const tracked = await makeProduct({ name: "Tracked", price: 4, stock: 1 });
  const service = await makeProduct({ name: "Gift wrap", price: 1, stock: 0, track_inventory: 0 });
  const bundleId = (await makeBundle("Wrapped", 4.5, [{ component_id: tracked, quantity: 1 }, { component_id: service, quantity: 1 }])).body.id;
  setSetting("allow_negative_stock", "0");
  try {
    const short = await sale([{ id: bundleId, quantity: 2 }]);
    assert.equal(short.status, 409, JSON.stringify(short.body));
    assert.equal(short.body.code, "INSUFFICIENT_STOCK");
    assert.equal(short.body.product_id, tracked);
    const ok = await sale([{ id: bundleId, quantity: 1 }], { payments: cash(4.5) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(stockOf(tracked), 0);
    assert.equal(stockOf(service), 0, "an untracked component's stock is not moved");
  } finally {
    setSetting("allow_negative_stock", "1");
  }
  // With negative stock allowed the sale goes through and the tracked component goes below zero.
  const neg = await sale([{ id: bundleId, quantity: 1 }], { payments: cash(4.5) });
  assert.equal(neg.status, 200, JSON.stringify(neg.body));
  assert.equal(stockOf(tracked), -1);
});

test("sale guards: below cost on the whole bundle, missing component, purchase / stock adjust refused", async () => {
  const a = await makeProduct({ name: "Pricey", price: 10, cost: 8, stock: 10 });
  const b = await makeProduct({ name: "Cheap", price: 5, cost: 4, stock: 10 });
  const bundleId = (await makeBundle("Loss leader", 11, [{ component_id: a, quantity: 1 }, { component_id: b, quantity: 1 }])).body.id;
  setSetting("allow_below_cost", "0");
  try {
    const r = await sale([{ id: bundleId, quantity: 1 }]);
    assert.equal(r.body.code, "BELOW_COST", JSON.stringify(r.body));
    near(r.body.cost, 12);
  } finally {
    setSetting("allow_below_cost", "1");
  }
  const purchase = await app.api("POST", "/api/transactions", { tenantId, body: { type: "purchase", items: [{ id: bundleId, quantity: 1, price: 5 }], currency: "USD", exchange_rate: 1, payments: [] } });
  assert.equal(purchase.body.code, "BUNDLE_NOT_PURCHASABLE");
  const adjust = await app.api("POST", "/api/stock/adjust", { tenantId, body: { product_id: bundleId, new_qty: 5, reason: "count" } });
  assert.equal(adjust.body.code, "BUNDLE_NO_STOCK");

  await app.api("DELETE", `/api/products/${b}`, { tenantId });
  const gone = await sale([{ id: bundleId, quantity: 1 }]);
  assert.equal(gone.body.code, "BUNDLE_COMPONENT_MISSING", JSON.stringify(gone.body));
});

test("LBP-priced cart: bundle priced from its LBP price, components carry the USD equivalent", async () => {
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', 90000, 0)").run(tenantId);
  const a = await makeProduct({ name: "Oil", price: 10, stock: 10, extra: { price_lbp: 900000 } });
  const b = await makeProduct({ name: "Vinegar", price: 5, stock: 10, extra: { price_lbp: 450000 } });
  const bundleId = (await makeBundle("Dressing kit", 13, [{ component_id: a, quantity: 1 }, { component_id: b, quantity: 1 }], { price_lbp: 1260000 })).body.id;
  const res = await sale([{ id: bundleId, quantity: 1 }], { price_currency: "LBP", payments: [{ amount: 1260000, method: "cash", currency: "LBP", exchange_rate: 90000 }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(res.body.id) as any).total_amount, 14, "1,260,000 LL at 90,000");
  const rows = itemRows(res.body.id);
  near(rows[0].unit_price + rows[1].unit_price, 14);
  near(rows[0].unit_price, 14 * 10 / 15);
});

// ---------------------------------------------------------------------------------------------
// Refunds, invoice edit, receipts, statements
// ---------------------------------------------------------------------------------------------

test("refund: one of two bundles back, component stock restored, refund rows keep the bundle snapshot", async () => {
  const a = await makeProduct({ name: "Soap", price: 10, cost: 5, stock: 10 });
  const b = await makeProduct({ name: "Sponge", price: 5, cost: 1, stock: 10 });
  const bundleId = (await makeBundle("Bath set", 13, [{ component_id: a, quantity: 1 }, { component_id: b, quantity: 1 }])).body.id;
  const s = await sale([{ id: bundleId, quantity: 2 }], { payments: cash(26) });
  assert.equal(s.status, 200, JSON.stringify(s.body));

  const refundable = (await app.api("GET", `/api/transactions/${s.body.id}/refundable`, { tenantId })).body;
  assert.equal(refundable.lines.length, 2);
  for (const l of refundable.lines) {
    assert.equal(l.bundle_id, bundleId);
    assert.equal(l.bundle_name, "Bath set");
    assert.equal(l.bundle_line, 1);
    near(l.bundle_comp_qty, 1, "pieces of this component per bundle");
  }
  near(refundable.lines.reduce((sum: number, l: any) => sum + l.unit_refund * l.bundle_comp_qty, 0), 13, "one bundle refunds $13");

  const items = refundable.lines.map((l: any) => ({ id: l.product_id, original_item_id: l.item_id, quantity: l.bundle_comp_qty * 1 }));
  const r = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "refund", original_transaction_id: s.body.id, items, currency: "USD", exchange_rate: 1, payments: cash(13) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(r.body.id) as any).total_amount, 13);
  assert.equal(stockOf(a), 9); assert.equal(stockOf(b), 9);
  const rrows = itemRows(r.body.id);
  for (const row of rrows) {
    assert.equal(row.bundle_id, bundleId);
    assert.equal(row.bundle_line, 1);
    near(row.bundle_qty, 1, "one bundle refunded");
  }
  const again = (await app.api("GET", `/api/transactions/${s.body.id}/refundable`, { tenantId })).body;
  assert.ok(again.lines.every((l: any) => Math.abs(l.remaining_qty - 1) < 1e-9));
});

test("invoice edit: a bundle line is re-expanded; quantity change moves component stock; cost kept", async () => {
  const a = await makeProduct({ name: "Pen", price: 10, cost: 4, stock: 10 });
  const b = await makeProduct({ name: "Pad", price: 5, cost: 2, stock: 10 });
  const bundleId = (await makeBundle("Desk set", 13, [{ component_id: a, quantity: 1 }, { component_id: b, quantity: 1 }])).body.id;
  const s = await sale([{ id: bundleId, quantity: 2 }], { payments: cash(26) });
  assert.equal(stockOf(a), 8);
  // The component's cost changes after the sale; the edited invoice keeps the cost it was sold at.
  app.db.prepare("UPDATE products SET cost = 9 WHERE id = ?").run(a);

  const put = await app.api("PUT", `/api/transactions/${s.body.id}`, { tenantId, body: {
    items: [{ product_id: bundleId, quantity: 3, unit_price: 12 }], payments: [] } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  near((app.db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(s.body.id) as any).total_amount, 36);
  const rows = itemRows(s.body.id);
  assert.equal(rows.length, 2);
  near(rows[0].quantity, 3); near(rows[0].unit_price, 12 * 10 / 15);
  assert.equal(rows[0].unit_cost, 4, "cost snapshot kept for the same component");
  assert.ok(rows.every((r) => r.bundle_id === bundleId && r.bundle_qty === 3 && r.bundle_line === 1));
  assert.equal(stockOf(a), 7); assert.equal(stockOf(b), 7);

  const detail = (await app.api("GET", `/api/transactions/${s.body.id}`, { tenantId })).body;
  assert.ok(detail.items.every((i: any) => i.bundle_name === "Desk set"), "detail exposes the snapshot for grouping");
});

test("receipt (ESC/POS) prints one bundle line with its components; statement groups it too", async () => {
  const buf = buildReceiptBuffer({
    storeName: "Acme", language: "en",
    transaction: {
      id: 1, total_amount: 27, payments: [{ method: "cash", amount: 27, currency: "USD" }],
      items: [
        { name: "Gum", price: 1, quantity: 1 },
        { name: "Item A", price: 13 * 10 / 15, quantity: 2, bundle_id: 5, bundle_name: "A+B deal", bundle_qty: 2, bundle_line: 1 },
        { name: "Item B", price: 13 * 5 / 15, quantity: 2, bundle_id: 5, bundle_name: "A+B deal", bundle_qty: 2, bundle_line: 1 },
      ],
    },
  } as any);
  const text = buf.toString("latin1");
  assert.ok(text.includes("A+B deal"), "bundle name printed");
  assert.ok(text.includes("26.00"), "bundle line total");
  assert.ok(text.includes("2 x Item A") && text.includes("2 x Item B"), "components listed");
  assert.ok(!text.includes("17.33"), "component amounts are not printed as separate lines");

  // Statement (open orders): a credit sale to a customer lists the bundle as one line.
  const cust = Number(app.db.prepare("INSERT INTO stakeholders (tenant_id, name, type) VALUES (?, 'Rana', 'customer')").run(tenantId).lastInsertRowid);
  const a = await makeProduct({ name: "Tea", price: 10, stock: 10 });
  const b = await makeProduct({ name: "Mug", price: 5, stock: 10 });
  const bundleId = (await makeBundle("Tea gift", 13, [{ component_id: a, quantity: 2 }, { component_id: b, quantity: 1 }])).body.id;
  const s = await sale([{ id: bundleId, quantity: 1 }], { stakeholder_id: cust });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const doc = (await app.api("GET", `/api/reports/statement/${cust}?mode=open`, { tenantId })).body;
  const items = doc.open.orders[0].items;
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "Tea gift (2 Tea + 1 Mug)");
  assert.equal(items[0].qty, 1);
  near(items[0].line_total, 13);
  assert.deepEqual(items[0].components, [{ name: "Tea", qty: 2 }, { name: "Mug", qty: 1 }]);
});
