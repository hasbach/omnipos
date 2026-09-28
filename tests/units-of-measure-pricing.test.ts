// Pure unit tests for the units-of-measure pricing in server/pricing.ts: per-unit tier chains (USD and
// LBP), and the generalized greedy pack/carton break for base-piece lines (with the legacy
// package_price fallback). No DB needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { uomUnitPrice, uomUnitPriceLbp, saleLineUnitPrice, lineTotal } from "../server/pricing.js";

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);

const product = { price: 0.25, price_wholesale: 0.2, price_super_wholesale: 0.18 };
const carton = { factor: 24, price: 5, price_wholesale: 4.5, price_super_wholesale: 4 };

test("uomUnitPrice: retail is the unit's own price", () => {
  assert.equal(uomUnitPrice(product, carton, "retail"), 5);
});

test("uomUnitPrice: unit tier -> product tier x factor -> unit retail", () => {
  assert.equal(uomUnitPrice(product, carton, "wholesale"), 4.5, "unit wholesale wins");
  assert.equal(uomUnitPrice(product, carton, "super_wholesale"), 4, "unit super-wholesale wins");

  const noUnitTiers = { factor: 24, price: 5 };
  near(uomUnitPrice(product, noUnitTiers, "wholesale"), 0.2 * 24, "product wholesale x factor");
  near(uomUnitPrice(product, noUnitTiers, "super_wholesale"), 0.18 * 24, "product super x factor");

  const noSuper = { price: 0.25, price_wholesale: 0.2 };
  near(uomUnitPrice(noSuper, noUnitTiers, "super_wholesale"), 0.2 * 24, "super -> product wholesale x factor");
  // unit wholesale outranks the product's wholesale for super-wholesale when there is no super anywhere
  near(uomUnitPrice(noSuper, { factor: 24, price: 5, price_wholesale: 4.5 }, "super_wholesale"), 4.5);

  assert.equal(uomUnitPrice({ price: 0.25 }, noUnitTiers, "wholesale"), 5, "nothing configured -> unit retail");
  assert.equal(uomUnitPrice({ price: 0.25 }, { factor: 24, price: 5, price_wholesale: 0, price_super_wholesale: null }, "super_wholesale"), 5, "0/null mean not set");
});

test("uomUnitPriceLbp: same chain on the LBP columns, each step falling back to USD x rate", () => {
  const rate = 90000;
  const p = { price: 0.25, price_wholesale: 0.2, price_wholesale_lbp: 18000, price_super_wholesale: 0.18 };
  const u = { factor: 24, price: 5, price_lbp: 460000, price_wholesale: 4.5 };
  assert.equal(uomUnitPriceLbp(p, u, "retail", rate), 460000, "retail LBP column");
  assert.equal(uomUnitPriceLbp(p, { factor: 24, price: 5 }, "retail", rate), 5 * rate, "no LBP column -> USD x rate");
  // wholesale: unit has only a USD wholesale -> USD x rate wins before the product's LBP x factor
  assert.equal(uomUnitPriceLbp(p, u, "wholesale", rate), 4.5 * rate);
  // no unit wholesale at all -> product wholesale LBP x factor
  assert.equal(uomUnitPriceLbp(p, { factor: 24, price: 5 }, "wholesale", rate), 18000 * 24);
  // super: unit super missing, product super has USD only -> USD x factor x rate
  near(uomUnitPriceLbp(p, { factor: 24, price: 5 }, "super_wholesale", rate), 0.18 * 24 * rate);
  // super with nothing but a product wholesale LBP
  assert.equal(uomUnitPriceLbp({ price: 0.25, price_wholesale_lbp: 18000 }, { factor: 24, price: 5 }, "super_wholesale", rate), 18000 * 24);
});

test("saleLineUnitPrice: greedy break over units, largest factor first", () => {
  const p = { price: 0.2 };
  const units = [{ factor: 6, price: 1.1 }, { factor: 24, price: 4 }];
  // 31 pcs = 1 carton (4.00) + 1 pack (1.10) + 1 piece (0.20)
  near(saleLineUnitPrice(p, "retail", 31, units) * 31, 4 + 1.1 + 0.2);
  // 12 pcs = 2 packs
  near(saleLineUnitPrice(p, "retail", 12, units) * 12, 2.2);
  // 5 pcs = below every unit -> plain piece price
  near(saleLineUnitPrice(p, "retail", 5, units), 0.2);
  // 48 pcs = 2 cartons
  near(saleLineUnitPrice(p, "retail", 48, units) * 48, 8);
});

test("saleLineUnitPrice: only whole-number factors take part; a real tier price stays flat", () => {
  const p = { price: 1, price_wholesale: 0.9 };
  const units = [{ factor: 1.5, price: 1.2 }, { factor: 10, price: 8 }];
  near(saleLineUnitPrice({ price: 1 }, "retail", 12, units) * 12, 8 + 2 * 1, "1.5 ignored, 1 x10 + 2 pcs");
  assert.equal(saleLineUnitPrice(p, "wholesale", 12, units), 0.9, "wholesale is flat");
});

test("saleLineUnitPrice: legacy package_price is the fallback when there are no units", () => {
  const legacy = { price: 10, package_price: 45, units_per_package: 6 };
  near(saleLineUnitPrice(legacy, "retail", 8) * 8, 45 + 20, "no units arg");
  near(saleLineUnitPrice(legacy, "retail", 8, []) * 8, 45 + 20, "empty units");
  // real units win over the legacy columns
  near(saleLineUnitPrice(legacy, "retail", 8, [{ factor: 4, price: 30 }]) * 8, 60, "2 x 4-pack");
});

test("lineTotal on a unit line matches per-piece math", () => {
  // 2 cartons at 4.00, 10% off = 7.20; the same as 48 pcs at 4/24 with 10% off
  near(lineTotal(4, 2, { type: "percentage", value: 10 }), 7.2);
  near(lineTotal(4 / 24, 48, { type: "percentage", value: 10 }), 7.2);
  near(lineTotal(4, 2, { type: "fixed", value: 1 }), 7);
});
