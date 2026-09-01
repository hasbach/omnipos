// Regression test for Bug 3 from the audit: receipts printed "OmniPOS" instead of the tenant's
// own business name, because settings.store_name was never seeded and the fallback was a
// hardcoded vendor string. Covers both halves of the fix: the server resolving a real business
// name per tenant (with no cross-tenant leakage), and the actual printed receipt bytes containing
// that name instead of "OmniPOS".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";
import { buildReceiptBuffer } from "../server/printing/receipt.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantA: number;
let tenantB: number;

before(async () => {
  app = await createTestApp();
  tenantA = seedTenant(app.db, "Acme Hardware", "acme@example.com");
  tenantB = seedTenant(app.db, "Beta Traders", "beta@example.com");
});

after(async () => {
  await app.close();
});

test("a tenant who never configured Store Name still gets their own business name, not OmniPOS", async () => {
  const settingsA = await app.api("GET", "/api/settings", { tenantId: tenantA });
  assert.equal(settingsA.status, 200);
  assert.equal(settingsA.body.store_name, "Acme Hardware");
  assert.notEqual(settingsA.body.store_name, "OmniPOS");
});

test("the fallback business name is scoped per tenant — no cross-tenant leakage", async () => {
  const settingsB = await app.api("GET", "/api/settings", { tenantId: tenantB });
  assert.equal(settingsB.status, 200);
  assert.equal(settingsB.body.store_name, "Beta Traders");
});

test("an explicitly-saved Store Name overrides the tenant-name fallback", async () => {
  const save = await app.api("POST", "/api/settings", { tenantId: tenantA, body: { store_name: "Acme Hardware & Supply Co." } });
  assert.equal(save.status, 200);
  const settings = await app.api("GET", "/api/settings", { tenantId: tenantA });
  assert.equal(settings.body.store_name, "Acme Hardware & Supply Co.");
});

test("the printed ESC/POS receipt itself contains the business name, never the hardcoded OmniPOS fallback", () => {
  const buffer = buildReceiptBuffer({
    storeName: "Acme Hardware",
    transaction: {
      id: 1,
      total_amount: 10,
      items: [{ name: "Widget", quantity: 1, price: 10 }],
    },
  });
  const text = buffer.toString("latin1");
  assert.ok(text.includes("Acme Hardware"), "receipt did not contain the business's name");
  assert.ok(!text.includes("OmniPOS"), "receipt still contains the hardcoded vendor name");
});

test("even with no store name at all, the ESC/POS fallback never says OmniPOS", () => {
  const buffer = buildReceiptBuffer({
    transaction: { id: 2, total_amount: 5, items: [{ name: "Item", quantity: 1, price: 5 }] },
  });
  const text = buffer.toString("latin1");
  assert.ok(!text.includes("OmniPOS"), "the last-resort fallback regressed back to the vendor name");
});
