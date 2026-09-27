// Pure unit tests for server/costing.ts — the weighted-average-cost math used by purchase
// receipt (apply) and purchase delete/edit (reverse). No DB needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPurchaseCost, reversePurchaseCost } from "../server/costing.js";

test("applyPurchaseCost: no prior cost basis -> new cost is just the unit cost", () => {
  assert.equal(applyPurchaseCost(0, null, 10, 5), 5);
  assert.equal(applyPurchaseCost(0, 0, 10, 5), 5);
  assert.equal(applyPurchaseCost(-3, 4, 10, 5), 5, "non-positive stock has nothing to average against");
});

test("applyPurchaseCost: blends by quantity on hand", () => {
  // 10 units @ $4 on hand, receiving 10 more @ $6 -> (10*4 + 10*6)/20 = 5
  assert.equal(applyPurchaseCost(10, 4, 10, 6), 5);
  // 20 @ $3 + 5 @ $9 -> (60+45)/25 = 4.2
  assert.equal(applyPurchaseCost(20, 3, 5, 9), 4.2);
});

test("reversePurchaseCost: undoes a purchase line's contribution", () => {
  // Forward: 10 @ $4 + 10 @ $6 -> $5 average, stock becomes 20. Reversing the 10 @ $6 line should
  // recover the original $4.
  const blended = applyPurchaseCost(10, 4, 10, 6);
  const reversed = reversePurchaseCost(20, blended, 10, 6);
  assert.equal(reversed, 4);
});

test("reversePurchaseCost: leaves cost unchanged when nothing sound remains", () => {
  // Removing all remaining stock (remaining <= 0) can't produce a valid average.
  assert.equal(reversePurchaseCost(10, 5, 10, 6), 5, "stock fully consumed by the reversed qty -> unchanged");
  assert.equal(reversePurchaseCost(5, 5, 10, 6), 5, "reversed qty exceeds stock -> unchanged");
});

test("reversePurchaseCost: leaves cost unchanged when the result would be negative", () => {
  // 5 units @ cost 1, remove 3 units at unitCost 100 -> (5*1 - 3*100)/2 is deeply negative
  assert.equal(reversePurchaseCost(5, 1, 3, 100), 1);
});
