// balance_before / balance_after on POST and PUT /api/transactions, stakeholder_balance /
// balance_effect on GET /api/transactions/:id, and the receipt's previous/this/new balance lines
// (docs/plans/2026-09-28-store-credit-and-levels.md section 2).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant, seedProduct } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Balance Display Co", "balance-display-co@example.com");
});
after(async () => { await app.close(); });

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// Same GS v 0 raster scanning as tests/receipt-arabic-address.test.ts, for the bilingual balance
// labels (which contain Arabic and so print as images, not plain text — see server/printing/escpos.ts).
const RASTER = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
function rasterImageCount(buf: Buffer): number {
  let count = 0;
  for (let i = buf.indexOf(RASTER); i !== -1; i = buf.indexOf(RASTER, i + 1)) {
    const widthBytes = buf[i + 4] | (buf[i + 5] << 8);
    const height = buf[i + 6] | (buf[i + 7] << 8);
    count++;
    i += 7 + widthBytes * height;
  }
  return count;
}
function textOnly(buf: Buffer): string {
  let out = "";
  let from = 0;
  for (let i = buf.indexOf(RASTER); i !== -1; i = buf.indexOf(RASTER, from)) {
    out += buf.subarray(from, i).toString("latin1");
    const widthBytes = buf[i + 4] | (buf[i + 5] << 8);
    const height = buf[i + 6] | (buf[i + 7] << 8);
    from = i + 8 + widthBytes * height;
  }
  return out + buf.subarray(from).toString("latin1");
}

test("POST /api/transactions returns balance_before/balance_after for a partially-paid sale", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BB-1", name: "Item", price: 25, stock: 20 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Balance Customer", type: "customer" } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 10, method: "cash", currency: "USD", exchange_rate: 1 }], // $15 owed
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  near(sale.body.balance_before, 0, "brand-new customer starts at 0");
  near(sale.body.balance_after, -15, "owes $15 after this sale");
});

test("POST /api/transactions returns null balance_before/balance_after with no stakeholder at all", async () => {
  // A dedicated, otherwise-empty tenant: with zero stakeholder rows, tenantStakeholderId's Walk-in
  // fallback (server/routes.ts) has nothing to resolve to, so resolvedStakeholderId is genuinely null.
  const noStakeholderTenant = seedTenant(app.db, "No Stakeholder Co", "no-stakeholder-co@example.com");
  app.db.prepare("DELETE FROM stakeholders WHERE tenant_id = ?").run(noStakeholderTenant);
  const productId = seedProduct(app.db, noStakeholderTenant, { barcode: "BB-2", name: "No Customer Item", price: 5, stock: 20 });

  const sale = await app.api("POST", "/api/transactions", { tenantId: noStakeholderTenant, body: {
    type: "sale", items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 5, method: "cash", currency: "USD", exchange_rate: 1 }],
  } });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.balance_before, null);
  assert.equal(sale.body.balance_after, null);
});

test("GET /api/transactions/:id exposes stakeholder_balance and balance_effect", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BB-3", name: "Detail Item", price: 40, stock: 20 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Detail Customer", type: "customer" } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 15, method: "cash", currency: "USD", exchange_rate: 1 }], // $25 owed
  } });
  assert.equal(sale.status, 200);

  const detail = await app.api("GET", `/api/transactions/${sale.body.id}`, { tenantId });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  near(detail.body.stakeholder_balance, -25, "current balance");
  near(detail.body.balance_effect, -25, "this sale's own effect on the balance");
});

test("PUT /api/transactions/:id returns balance_before (pre-edit) and balance_after (post-edit)", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BB-4", name: "Editable Item", price: 10, stock: 20 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Edit Balance Customer", type: "customer" } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [], // fully unpaid, owes $10
  } });
  assert.equal(sale.status, 200);

  const edit = await app.api("PUT", `/api/transactions/${sale.body.id}`, { tenantId, body: {
    stakeholder_id: cust,
    items: [{ product_id: productId, quantity: 3, unit_price: 10 }], // now $30
    payments: [],
  } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  near(edit.body.balance_before, -10, "balance before this edit");
  near(edit.body.balance_after, -30, "balance after this edit");
});

test("the printed receipt includes previous/this/new balance lines for a non-Walk-in customer", async () => {
  const productId = seedProduct(app.db, tenantId, { barcode: "BB-5", name: "Receipt Item", price: 50, stock: 20 });
  const cust = (await app.api("POST", "/api/stakeholders", { tenantId, body: { name: "Receipt Customer", type: "customer" } })).body.id;

  const sale = await app.api("POST", "/api/transactions", { tenantId, body: {
    type: "sale", stakeholder_id: cust, items: [{ id: productId, quantity: 1 }], currency: "USD", exchange_rate: 1,
    payments: [{ amount: 20, method: "cash", currency: "USD", exchange_rate: 1 }], // $30 owed
  } });
  assert.equal(sale.status, 200);

  // buildReceiptBuffer is exercised directly (network printing has no real printer in tests) —
  // reuse the exact same data shape /api/print/receipt builds. The balance labels are bilingual
  // (English + Arabic, per the spec), which routes the WHOLE kv() line through the same
  // image-rasterization path as an Arabic customer address (see receipt-arabic-address.test.ts) —
  // so, like that test, this checks for the three extra raster images rather than literal text.
  const { buildReceiptBuffer } = await import("../server/printing/receipt.js");
  const withoutBalance = buildReceiptBuffer({
    storeName: "Test Store",
    transaction: { id: sale.body.id, items: [{ name: "Receipt Item", price: 50, quantity: 1 }], total_amount: 50 },
  });
  const withBalance = buildReceiptBuffer({
    storeName: "Test Store",
    transaction: {
      id: sale.body.id,
      items: [{ name: "Receipt Item", price: 50, quantity: 1 }],
      total_amount: 50,
      stakeholder_name: "Receipt Customer",
      stakeholder_balance: -30,
      balance_effect: -30,
      payments: [{ method: "cash", amount: 20, currency: "USD" }],
    },
  });
  assert.equal(rasterImageCount(withoutBalance), 0, "no balance data -> no images");
  assert.equal(rasterImageCount(withBalance), 3, "Previous/This/New balance -> one raster image per line");
  assert.ok(!textOnly(withBalance).includes("?"), "Arabic balance labels were mangled into '?'");
});

test("the receipt omits the balance block for Walk-in Customer", async () => {
  const { buildReceiptBuffer } = await import("../server/printing/receipt.js");
  const buf = buildReceiptBuffer({
    storeName: "Test Store",
    transaction: {
      id: 1,
      items: [{ name: "Item", price: 5, quantity: 1 }],
      total_amount: 5,
      stakeholder_name: "Walk-in Customer",
      stakeholder_balance: 0,
      balance_effect: 0,
      payments: [{ method: "cash", amount: 5, currency: "USD" }],
    },
  });
  assert.equal(rasterImageCount(buf), 0, "Walk-in should never show a balance block");
});
