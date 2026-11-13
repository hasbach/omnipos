// 1.11 POS fixes:
//  - a fixed discount typed in the local currency (stored as unrounded USD) comes to exactly that amount;
//  - a customer's standing (loyalty) discount: stored on the customer, and a cashier without the
//    discount right may apply exactly it (and nothing else);
//  - a purchase cost keyed in the local currency converts back to the same whole local amount;
//  - POS product photos: one local copy per product, downloaded once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;
let walkIn: number;
let cashier: number;

const RATE = 89500;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Fixes Co", "fixes-1-11@example.com");
  app.db.prepare("INSERT INTO currencies (tenant_id, code, symbol, rate, is_default) VALUES (?, 'LBP', 'LL', ?, 0)").run(tenantId, RATE);
  walkIn = (app.db.prepare("SELECT id FROM stakeholders WHERE tenant_id = ? AND name = 'Walk-in Customer'").get(tenantId) as any).id;
  cashier = Number(app.db.prepare("INSERT INTO users (tenant_id, name, role, pin) VALUES (?, 'Cara', 'cashier', '1111')").run(tenantId).lastInsertRowid);
});
after(async () => { await app.close(); });

let n = 0;
const mkProduct = (price: number, price_lbp: number | null) => {
  const id = seedProduct(app.db, tenantId, { barcode: `FX-${++n}`, name: `P${n}`, price, stock: 1000 });
  if (price_lbp != null) app.db.prepare("UPDATE products SET price_lbp = ? WHERE id = ?").run(price_lbp, id);
  return id;
};
const txOf = (id: number) => app.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as any;
const lbpCash = (amount: number) => ({ amount, method: "cash", currency: "LBP", exchange_rate: RATE });

test("a 5,000 LL line discount and a 10,000 LL sale discount are exact on an LBP-priced sale", async () => {
  const p = mkProduct(1, 100000);
  const r = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "sale", stakeholder_id: walkIn, currency: "USD", exchange_rate: 1, price_currency: "LBP",
      // what the POS sends: value = typed LL / rate, unrounded
      items: [{ id: p, quantity: 2, discount: { type: "fixed", value: 5000 / RATE, currency: "LBP", amount: 5000 } }],
      discount: { type: "fixed", value: 10000 / RATE, currency: "LBP", amount: 10000 },
      payments: [lbpCash(185000)],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 2 x 100,000 - 5,000 - 10,000 = 185,000 LL exactly (a $0.05 / $0.11 entry would be 4,475 / 9,845 LL)
  // (total_amount is stored to 6 decimals of USD, i.e. within 0.05 LL)
  near(txOf(r.body.id).total_amount * RATE, 185000, 0.05);
});

test("customer standing discount: saved, validated, and usable by a cashier without the discount right", async () => {
  const bad = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Bad", type: "customer", discount_percent: 150 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_DISCOUNT");

  const c = await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Loyal", type: "customer", discount_percent: 10 } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const custId = c.body.id as number;
  const list = await app.api("GET", "/api/stakeholders", { tenantId });
  assert.equal(list.body.find((s: any) => s.id === custId).discount_percent, 10);

  const p = mkProduct(10, null);
  const body = (stakeholder_id: number, value: number) => ({
    type: "sale", stakeholder_id, currency: "USD", exchange_rate: 1,
    items: [{ id: p, quantity: 1 }], discount: { type: "percentage", value },
    payments: [{ amount: 10 * (1 - value / 100), method: "cash", currency: "USD", exchange_rate: 1 }],
  });
  const as = { tenantId, userId: cashier };
  // exactly the customer's own discount: allowed
  const ok = await app.api("POST", "/api/transactions", { ...as, body: body(custId, 10) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  near(txOf(ok.body.id).total_amount, 9);
  // a different percentage, or the same one for another customer: still needs pos.discount
  assert.equal((await app.api("POST", "/api/transactions", { ...as, body: body(custId, 20) })).status, 403);
  assert.equal((await app.api("POST", "/api/transactions", { ...as, body: body(walkIn, 10) })).status, 403);

  // an edit that does not mention the discount keeps it; an empty value clears it
  const put = (extra: any) => app.api("PUT", `/api/stakeholders/${custId}`, { tenantId, body: { name: "Loyal", type: "customer", ...extra } });
  assert.equal((await put({})).status, 200);
  assert.equal((app.db.prepare("SELECT discount_percent FROM stakeholders WHERE id = ?").get(custId) as any).discount_percent, 10);
  assert.equal((await put({ discount_percent: "" })).status, 200);
  assert.equal((app.db.prepare("SELECT discount_percent FROM stakeholders WHERE id = ?").get(custId) as any).discount_percent, null);
});

test("a purchase cost of 195,000 LL converts back to 195,000 LL (not 195,003 / 194,450)", async () => {
  const p = mkProduct(3, null);
  app.db.prepare("UPDATE products SET stock = 0, cost = NULL WHERE id = ?").run(p);
  const supplier = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Supp", type: "supplier" } })).body.id as number;
  const r = await app.api("POST", "/api/transactions", {
    tenantId,
    body: {
      type: "purchase", stakeholder_id: supplier, currency: "LBP", exchange_rate: RATE,
      items: [{ id: p, quantity: 12, price: 195000 / RATE }],
      payments: [],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = app.db.prepare("SELECT cost, cost_lbp FROM products WHERE id = ?").get(p) as any;
  assert.equal(Math.round(row.cost * RATE), 195000);
  assert.equal(row.cost_lbp, 195000);
});

test("POS product photo: image_url on the product, downloaded once, then served from the local copy", async () => {
  const { __setProductImageFetcher, productImageCacheDir } = await import("../server/posImages.js");
  const p = mkProduct(2, null);
  const other = mkProduct(2, null);
  const storeId = Number(app.db.prepare("INSERT INTO stores (tenant_id, name, slug) VALUES (?, 'Shop', 'shop-fx')").run(tenantId).lastInsertRowid);
  app.db.prepare("INSERT INTO store_listings (tenant_id, store_id, product_id, published, images) VALUES (?, ?, ?, 1, ?)")
    .run(tenantId, storeId, p, JSON.stringify(["t1/l1/a.webp", "t1/l1/b.webp"]));

  const bytes = new Uint8Array(64).fill(7);
  let downloads = 0;
  const urls: string[] = [];
  __setProductImageFetcher(async (url) => { downloads++; urls.push(url); return { ok: true, bytes }; });
  try {
    const products = (await app.api("GET", "/api/products", { tenantId })).body as any[];
    const withPhoto = products.find((x) => x.id === p);
    assert.match(withPhoto.image_url, new RegExp(`^/api/pos/product-image/${p}\\?v=[0-9a-f]{16}$`));
    assert.equal(products.find((x) => x.id === other).image_url, undefined);

    const get = () => fetch(`${app.baseUrl}${withPhoto.image_url}`, { headers: { "x-test-tenant-id": String(tenantId) } });
    const first = await get();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/webp");
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes);
    assert.equal((await get()).status, 200);
    assert.equal(downloads, 1, "the second request is served from the local copy");
    assert.ok(urls[0].endsWith("t1/l1/a.webp"), urls[0]);

    // no photo -> 404; no session -> 401
    assert.equal((await fetch(`${app.baseUrl}/api/pos/product-image/${other}`, { headers: { "x-test-tenant-id": String(tenantId) } })).status, 404);
    assert.equal((await fetch(`${app.baseUrl}/api/pos/product-image/${p}`)).status, 401);
  } finally {
    __setProductImageFetcher(null);
    fs.rmSync(productImageCacheDir, { recursive: true, force: true });
  }
});
