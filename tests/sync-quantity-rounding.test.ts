// The cloud rejected products whose stock carried floating-point noise (1.8000000000000016,
// -6.1e-30) because the columns were INTEGER; they are NUMERIC now and the push rounds the noise away.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./helpers/testApp.js";

let app: Awaited<ReturnType<typeof createTestApp>>;
let cleanQuantity: (v: any) => any;

before(async () => {
  app = await createTestApp(); // loads server/db.js against a throwaway database first
  ({ cleanQuantity } = await import("../server/sync.js"));
});
after(async () => { await app.close(); });

test("push rounds floating-point noise out of quantities and keeps real fractions", () => {
  assert.equal(cleanQuantity(1.8000000000000016), 1.8);
  assert.equal(cleanQuantity(0.03600000000000014), 0.036);
  assert.equal(cleanQuantity(2.220446049250313e-15), 0);
  assert.ok(Object.is(cleanQuantity(-6.1136720154628415e-30), 0), "no negative zero");
  assert.equal(cleanQuantity(2.75), 2.75);
  assert.equal(cleanQuantity(12), 12);
  assert.equal(cleanQuantity(null), null);
});
