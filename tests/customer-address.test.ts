// Customers carry an optional address, set when adding them and editable later from the POS.
// Editing contact details must not disturb the derived balance: the POS edit form sends no
// `balance`, and the PUT only treats a sent balance as a manual override.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, seedTenant } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let tenantId: number;

before(async () => {
  app = await createTestApp();
  tenantId = seedTenant(app.db, "Address Test Co", "address-test@example.com");
});

after(async () => {
  await app.close();
});

const find = async (id: number) =>
  ((await app.api("GET", "/api/stakeholders", { tenantId })).body as any[]).find(s => s.id === id);

test("a new customer is saved with its address", async () => {
  const res = await app.api("POST", "/api/stakeholders", {
    tenantId,
    body: { name: "Rami", phone: "70123456", email: "", address: "Hamra St, Beirut", type: "customer", balance: 0 },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const saved = await find(Number(res.body.id));
  assert.equal(saved.address, "Hamra St, Beirut");
});

test("an existing customer without an address can have one added, balance untouched", async () => {
  const res = await app.api("POST", "/api/stakeholders", {
    tenantId,
    body: { name: "Nour", phone: "71000000", type: "customer", balance: -25 },
  });
  const id = Number(res.body.id);
  assert.equal((await find(id)).address, null);

  const edit = await app.api("PUT", `/api/stakeholders/${id}`, {
    tenantId,
    body: { name: "Nour H.", phone: "71000001", email: "nour@example.com", address: "Jounieh", type: "customer" },
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));

  const updated = await find(id);
  assert.equal(updated.name, "Nour H.");
  assert.equal(updated.phone, "71000001");
  assert.equal(updated.address, "Jounieh");
  assert.equal(updated.balance, -25, "editing contact details must not change the balance");
});
