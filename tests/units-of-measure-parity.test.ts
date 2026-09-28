// The POS shows prices computed by src/lib/pricing.ts; the server charges what server/pricing.ts
// computes. They must agree for every unit, tier and quantity, or the cashier sees one total and
// the invoice records another.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as server from "../server/pricing.js";
import * as client from "../src/lib/pricing.js";

const products: any[] = [
  { price: 0.2, price_lbp: 18000, cost: 0.1 },
  { price: 0.2, price_wholesale: 0.17, price_wholesale_lbp: 15000, price_super_wholesale: 0.15, cost: 0.1 },
  { price: 0.2, price_wholesale: 0.17, cost: 0.1, package_price: 2.2, package_price_lbp: 197000, units_per_package: 12 },
  { price: 1.5, package_price: 8, units_per_package: 6 },
];
const unitSets: any[][] = [
  [],
  [{ factor: 6, price: 1.1 }, { factor: 24, price: 4, price_wholesale: 3.6, price_super_wholesale_lbp: 300000 }],
  [{ factor: 12, price: 2.2, price_lbp: 196000, price_wholesale: 2.0, price_wholesale_lbp: 179000 }],
  [{ factor: 2.5, price: 0.45 }, { factor: 10, price: 1.8 }],
];
const levels = ["retail", "wholesale", "super_wholesale"] as const;
const close = (a: number, b: number, msg: string) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: server ${a} vs client ${b}`);

test("server and client pricing agree for units, tiers and the automatic pack break", () => {
  for (const [pi, p] of products.entries()) {
    for (const [ui, units] of unitSets.entries()) {
      for (const level of levels) {
        for (const u of units) {
          close(server.uomUnitPrice(p, u, level), client.uomUnitPrice(p, u, level), `uom p${pi} u${ui} ${level} f${u.factor}`);
          close(server.uomUnitPriceLbp(p, u, level, 89500), client.uomUnitPriceLbp(p, u, level, 89500), `uomLbp p${pi} u${ui} ${level} f${u.factor}`);
        }
        for (const qty of [1, 5, 6, 11, 12, 13, 24, 30, 31, 49, 2.5]) {
          close(server.saleLineUnitPrice(p, level, qty, units), client.saleLineUnitPrice(p, level, qty, units), `line p${pi} u${ui} ${level} q${qty}`);
          close(server.saleLineUnitPrice(p, level, qty), client.saleLineUnitPrice(p, level, qty), `line(no units) p${pi} ${level} q${qty}`);
        }
      }
    }
  }
});
