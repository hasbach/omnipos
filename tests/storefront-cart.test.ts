// storefront/public/cart.js (spec 003 Slice 1): the browser cart, run in node:vm against a tiny DOM and a
// localStorage stub. The script exposes its logic as window.OmniCart; page wiring is checked on fake elements
// built from the real storefront HTML attributes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import vm from "vm";

const SOURCE = fs.readFileSync("storefront/public/cart.js", "utf8");
const CHECKOUT = fs.readFileSync("storefront/public/checkout.js", "utf8");

// ---- a very small DOM -----------------------------------------------------------------------------------

class FakeEl {
  tagName: string;
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  listeners: Record<string, ((ev: any) => void)[]> = {};
  hidden = false;
  textContent = "";
  className = "";
  value = "";
  [k: string]: any;
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  setAttribute(k: string, v: any) {
    this.attrs[k] = String(v);
    if (k === "class") this.className = String(v);
    if (k === "hidden") this.hidden = true;
    if (k === "value") this.value = String(v);
  }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c: FakeEl) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c: FakeEl) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(type: string, fn: (ev: any) => void) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type: string, ev: any = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, ...ev }); }
  get options() { return this.children.filter((c) => c.tagName === "OPTION"); }
  get selectedIndex() { const i = this.options.findIndex((o) => o.value === this.value); return i < 0 ? 0 : i; }
  descendants(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(sel: string) { return this.descendants().filter((e) => sel.split(",").some((s) => matches(e, s.trim()))); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] || null; }
  /** Rendered text: own text plus children's, like the DOM's textContent. */
  get text(): string { return this.textContent + this.children.map((c) => c.text).join(""); }
}

// Supports what cart.js uses: tag, .class, [attr], [attr="v"], combined (e.g. form.sf-order, select[name="unit"]).
function matches(e: FakeEl, sel: string): boolean {
  const m = sel.match(/^([a-z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!m) throw new Error(`selector not supported: ${sel}`);
  if (m[1] && e.tagName !== m[1].toUpperCase()) return false;
  const classes = (e.className || "").split(/\s+/);
  for (const c of (m[2] || "").split(".").filter(Boolean)) if (!classes.includes(c)) return false;
  for (const a of (m[3] || "").match(/\[[^\]]+\]/g) || []) {
    const [, k, v] = a.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)!;
    if (e.getAttribute(k) === null) return false;
    if (v !== undefined && e.getAttribute(k) !== v) return false;
  }
  return true;
}

function memoryStorage(fail = false) {
  const data = new Map<string, string>();
  const guard = () => { if (fail) throw new Error("SecurityError"); };
  return {
    data,
    getItem: (k: string) => { guard(); return data.has(k) ? data.get(k)! : null; },
    setItem: (k: string, v: string) => { guard(); data.set(k, String(v)); },
    removeItem: (k: string) => { guard(); data.delete(k); },
  };
}

const CONFIG = {
  address: "beirut-market", home: "https://beirut-market.myomnipos.com/", cart: "/cart", product: "/p/__ID__",
  placeholder: "/placeholder.svg?v=t", storeName: "Beirut Market", wa: "96170123456",
  local: { show: true, code: "LBP", symbol: "LL", rate: 89500 },
  pickup: { on: true, note: "Back door" }, delivery: { on: true, note: "Hamra only" }, minOrderUsd: 10,
  ui: {
    added_to_cart: "Added", minimum_qty: "{product}: minimum {min} {unit}.", total: "Total", each: "{price} each",
    amount_to_minimum: "Add {price} more to reach the minimum order.", minimum_blocks: "Some products are below their minimum quantity.",
    order_too_long: "Too long — split it.", field_required: "Required.", invalid_phone: "Enter a phone number.",
  },
  msg: {
    msg_new_order: "New order — {store}", msg_total: "Total: {total}", msg_pickup: "Pickup", msg_delivery: "Delivery: {address}",
    msg_name: "Name: {name}", msg_phone: "Phone: {phone}", msg_note: "Note: {note}", msg_prices_confirmed: "Prices to be confirmed by the shop.",
  },
};

interface Page { body: FakeEl; byId: Record<string, FakeEl> }

function run(opts: { storage?: ReturnType<typeof memoryStorage>; config?: any; page?: Page; checkout?: boolean } = {}) {
  const storage = opts.storage || memoryStorage();
  const page = opts.page || { body: new FakeEl("body"), byId: {} };
  const cfgEl = new FakeEl("script");
  cfgEl.textContent = JSON.stringify(opts.config || CONFIG);
  const byId: Record<string, FakeEl> = { "sf-order": cfgEl, ...page.byId };
  const document = {
    body: page.body,
    getElementById: (id: string) => byId[id] || null,
    querySelectorAll: (sel: string) => [...page.body.querySelectorAll(sel), ...Object.values(page.byId).filter((e) => !e.parentNode && sel.split(",").some((s) => matches(e, s.trim())))],
    querySelector: (sel: string) => document.querySelectorAll(sel)[0] || null,
    createElement: (tag: string) => new FakeEl(tag),
    visibilityState: "visible",
    listeners: {} as Record<string, (() => void)[]>,
    addEventListener(type: string, fn: () => void) { (this.listeners[type] ||= []).push(fn); },
  };
  const opened: string[] = [];
  const window: any = { localStorage: storage, addEventListener() {}, open: (url: string) => { opened.push(url); return null; } };
  const ctx = vm.createContext({ window, document, Intl, JSON, Math, Number, String, Object, Array, Date, isFinite, encodeURIComponent, setTimeout: () => 0, clearTimeout: () => {} });
  vm.runInContext(SOURCE, ctx);
  if (opts.checkout) vm.runInContext(CHECKOUT, ctx);
  const returnToPage = () => { for (const fn of document.listeners.visibilitychange || []) fn(); };
  return { cart: window.OmniCart, checkout: window.OmniCheckout, storage, document, page, opened, returnToPage };
}

const item = (over: Partial<any> = {}) => ({
  id: "00000000-0000-4000-8000-000000000001", unit: "base", title: "Whole Milk 1L", img: null, name: "pcs", factor: 1,
  price: 1.5, price_lbp: null, min: null, dec: false, base: "pcs", ...over,
});
const KEY = "sf-cart:v1:beirut-market";
// Objects made inside the vm context have another realm's prototypes; compare them as plain data.
const plain = (o: any) => JSON.parse(JSON.stringify(o));

// ---- cart logic --------------------------------------------------------------------------------------

test("cart: adding merges by listing + unit; saved per store with version 1", () => {
  const { cart, storage } = run();
  assert.equal(cart.add(item(), 2), null);
  assert.equal(cart.add(item(), 1), null);
  assert.equal(cart.add(item({ unit: "u-pack", name: "Pack", factor: 6, price: 8 }), 1), null);
  const saved = JSON.parse(storage.data.get(KEY)!);
  assert.equal(saved.v, 1);
  assert.equal(saved.lines.length, 2);
  assert.equal(saved.lines[0].qty, 3);
  assert.equal(saved.lines[1].unit, "u-pack");
  // Another store on the same origin (path form) keeps its own cart.
  const other = run({ storage, config: { ...CONFIG, address: "other-shop" } });
  assert.equal(other.cart.load().lines.length, 0);
  assert.equal(run({ storage }).cart.load().lines.length, 2, "reloaded from storage");
});

test("cart: quantity rules — positive, ≤ 999, whole unless sold by measure (≤ 3 decimals)", () => {
  const { cart } = run();
  assert.equal(cart.add(item(), 0), "invalid_quantity");
  assert.equal(cart.add(item(), -1), "invalid_quantity");
  assert.equal(cart.add(item(), 1.5), "invalid_quantity");
  assert.equal(cart.add(item(), 1000), "cart_limit_qty");
  assert.equal(cart.add(item(), 999), null);
  assert.equal(cart.add(item(), 1), "cart_limit_qty", "merging past 999 is refused");
  const kg = item({ id: "00000000-0000-4000-8000-000000000002", name: "kg", dec: true, price: 6.5 });
  assert.equal(cart.add(kg, 1.25), null);
  assert.equal(cart.add(kg, 0.0005), "invalid_quantity", "more than 3 decimals");
  assert.equal(cart.load().lines[1].qty, 1.25);
});

test("cart: at most 50 lines", () => {
  const { cart } = run();
  for (let i = 0; i < 50; i++) assert.equal(cart.add(item({ id: `id-${i}` }), 1), null);
  assert.equal(cart.add(item({ id: "id-50" }), 1), "cart_limit_lines");
  assert.equal(cart.add(item({ id: "id-3" }), 1), null, "adding to an existing line still works");
});

test("cart: corrupt or other-version storage is discarded; blocked storage keeps an in-memory cart", () => {
  for (const raw of ["{not json", JSON.stringify({ v: 2, lines: [item()] }), JSON.stringify({ v: 1, lines: [{ id: 1 }] })]) {
    const storage = memoryStorage();
    storage.data.set(KEY, raw);
    assert.equal(run({ storage }).cart.load().lines.length, 0, raw);
  }
  const { cart } = run({ storage: memoryStorage(true) });
  assert.equal(cart.add(item(), 2), null);
  assert.equal(cart.load().lines[0].qty, 2);
  assert.equal(cart.storageOk(), false);
});

test("cart: line and cart amounts in USD and local currency (own local price, else rounded USD × rate)", () => {
  const { cart } = run();
  cart.add(item(), 3); // 1.5 × 3
  cart.add(item({ id: "b", title: "Halloumi", price: 4.5, price_lbp: 400000 }), 2);
  const [milk, halloumi] = cart.load().lines;
  assert.deepEqual(plain(cart.lineAmounts(milk)), { usd: 4.5, local: 402750 }, "round(1.5 × 89,500) × 3");
  assert.deepEqual(plain(cart.lineAmounts(halloumi)), { usd: 9, local: 800000 });
  assert.deepEqual(plain(cart.totals()), { usd: 13.5, local: 1202750, count: 2 });
  assert.equal(cart.fmtUsd(13.5), "$13.50");
  assert.equal(cart.fmtLocal(1202750), "1,202,750 LL");

  const noLocal = run({ config: { ...CONFIG, local: { show: false, code: null, symbol: null, rate: null } } });
  noLocal.cart.add(item(), 1);
  assert.equal(noLocal.cart.totals().local, null);
});

test("cart: listing minimum counts base units across the listing's lines", () => {
  const { cart } = run();
  const bread = item({ id: "bread", title: "Arabic Bread", min: 6 });
  cart.add(bread, 2);
  assert.deepEqual(cart.minimumIssues().map((m: any) => [m.title, m.min, m.have, m.unit]), [["Arabic Bread", 6, 2, "pcs"]]);
  cart.add({ ...bread, unit: "u-pack", name: "Pack of 6", factor: 6 }, 1);
  assert.deepEqual(plain(cart.minimumIssues()), [], "2 pieces + 1 pack of 6 = 8 ≥ 6");
});

// ---- page wiring -------------------------------------------------------------------------------------

function productPage(opts: { units?: { key: string; name: string; factor: number; price: number }[]; title?: string } = {}) {
  const body = new FakeEl("body");
  const form = body.appendChild(new FakeEl("form", {
    class: "sf-order", "data-id": "listing-1", "data-title": opts.title || "Halloumi 250g", "data-img": "", "data-min": "",
    "data-base": "pcs", "data-dec": "0", hidden: "",
  }));
  const select = form.appendChild(new FakeEl("select", { name: "unit" }));
  for (const u of opts.units || [{ key: "base", name: "pcs", factor: 1, price: 4.5 }, { key: "u-pack", name: "Pack of 6", factor: 6, price: 25 }]) {
    select.appendChild(new FakeEl("option", { value: u.key, "data-unit": u.key, "data-name": u.name, "data-factor": String(u.factor), "data-price": String(u.price), "data-price-lbp": "" }));
  }
  select.value = select.options[0].value;
  const qty = form.appendChild(new FakeEl("input", { name: "qty", value: "1" }));
  const status = form.appendChild(new FakeEl("p", { class: "sf-order-status" }));
  const link = body.appendChild(new FakeEl("a", { class: "sf-cart-link", hidden: "" }));
  const badge = link.appendChild(new FakeEl("span", { class: "sf-cart-count", hidden: "" }));
  return { page: { body, byId: {} }, form, select, qty, status, link, badge };
}

test("product page: the hidden form is revealed; submitting adds the chosen unit and updates the badge", () => {
  const p = productPage();
  const { cart } = run({ page: p.page });
  assert.equal(p.form.hidden, false);
  assert.equal(p.link.hidden, false);
  assert.equal(p.badge.hidden, true, "empty cart: no badge");
  p.select.value = "u-pack";
  p.qty.value = "2";
  p.form.dispatch("submit");
  assert.equal(p.status.textContent, "Added");
  const [line] = cart.load().lines;
  assert.deepEqual([line.unit, line.name, line.factor, line.price, line.qty], ["u-pack", "Pack of 6", 6, 25, 2]);
  assert.equal(p.badge.hidden, false);
  assert.equal(p.badge.textContent, "1");
});

test("page data refreshes cart lines: new price applied, a unit no longer offered marked unavailable", () => {
  const storage = memoryStorage();
  const first = run({ storage, page: productPage().page });
  first.cart.add(item({ id: "listing-1", unit: "u-pack", title: "Halloumi 250g", name: "Pack of 6", factor: 6, price: 25 }), 1);
  first.cart.add(item({ id: "listing-1", unit: "base", title: "Halloumi 250g", price: 4.5 }), 1);
  // Next visit: the shop raised the piece price and stopped selling the pack.
  const later = run({ storage, page: productPage({ units: [{ key: "base", name: "pcs", factor: 1, price: 5 }], title: "Halloumi 250 g" }).page });
  const lines = later.cart.load().lines;
  const piece = lines.find((l: any) => l.unit === "base");
  const pack = lines.find((l: any) => l.unit === "u-pack");
  assert.equal(piece.price, 5);
  assert.equal(piece.title, "Halloumi 250 g");
  assert.equal(pack.unavailable, true);
  assert.deepEqual(plain(later.cart.totals()), { usd: 5, local: 447500, count: 1 }, "unavailable lines are left out of totals");
});

test("cart page: lines, total and minimum message drawn from the stored cart; empty state when nothing is left", () => {
  const storage = memoryStorage();
  run({ storage }).cart.add(item({ id: "bread", title: "Arabic Bread", min: 6 }), 2);
  const ids = ["sf-cart-lines", "sf-cart-total", "sf-cart-issues", "sf-cart-empty", "sf-cart-full", "sf-cart-storage-note"];
  const byId = Object.fromEntries(ids.map((id) => [id, new FakeEl(id === "sf-cart-lines" ? "ul" : "div", { id })]));
  const { cart } = run({ storage, page: { body: new FakeEl("body"), byId } });
  assert.equal(byId["sf-cart-lines"].children.length, 1);
  assert.equal(byId["sf-cart-full"].hidden, false);
  assert.equal(byId["sf-cart-empty"].hidden, true);
  assert.equal(byId["sf-cart-total"].text, "Total: $3.00 · 268,500 LL");
  assert.equal(byId["sf-cart-total"].querySelector(".sf-money")!.getAttribute("dir"), "ltr", "amounts isolated left-to-right");
  assert.equal(byId["sf-cart-issues"].children[0].textContent, "Arabic Bread: minimum 6 pcs.");
  assert.equal(byId["sf-cart-storage-note"].hidden, true);
  // Titles are text, never HTML.
  const titleEl = byId["sf-cart-lines"].descendants().find((e) => e.className === "sf-cart-title")!;
  assert.equal(titleEl.textContent, "Arabic Bread");
  assert.equal(titleEl.href, "/p/bread");
  cart.remove("bread", "base");
  assert.equal(byId["sf-cart-lines"].children.length, 0);
  assert.equal(byId["sf-cart-empty"].hidden, false);
  assert.equal(byId["sf-cart-full"].hidden, true);
});

test("cart.js never talks to the network", () => {
  assert.doesNotMatch(SOURCE, /fetch\(|XMLHttpRequest|sendBeacon|navigator\.|document\.cookie/);
});

// ---- checkout (US2) ------------------------------------------------------------------------------------

function checkoutPage(methods: ("pickup" | "delivery")[] = ["pickup", "delivery"]) {
  const form = new FakeEl("form", { id: "sf-checkout", class: "sf-checkout" });
  const add = (e: FakeEl) => form.appendChild(e);
  const name = add(new FakeEl("input", { name: "name" }));
  add(new FakeEl("p", { class: "sf-error", "data-for": "name", hidden: "" }));
  const phone = add(new FakeEl("input", { name: "phone" }));
  add(new FakeEl("p", { class: "sf-error", "data-for": "phone", hidden: "" }));
  const radios = methods.map((m) => add(new FakeEl("input", { type: "radio", name: "fulfilment", value: m })));
  if (methods.length === 1) radios[0].checked = true;
  add(new FakeEl("p", { class: "sf-error", "data-for": "fulfilment", hidden: "" }));
  const addressField = new FakeEl("label", { id: "sf-address-field", hidden: "" });
  const address = addressField.appendChild(new FakeEl("textarea", { name: "address" }));
  add(addressField);
  add(new FakeEl("p", { class: "sf-error", "data-for": "address", hidden: "" }));
  const note = add(new FakeEl("textarea", { name: "note" }));
  const counter = add(new FakeEl("small", { class: "sf-counter", "data-counter": "note" }));
  const remember = add(new FakeEl("input", { type: "checkbox", name: "remember" }));
  const block = add(new FakeEl("p", { id: "sf-checkout-block", hidden: "" }));
  const submit = add(new FakeEl("button", { class: "sf-button sf-wa sf-submit", type: "submit" }));
  const fallback = add(new FakeEl("p", { id: "sf-wa-fallback", hidden: "" }));
  fallback.appendChild(new FakeEl("a"));
  const sent = new FakeEl("div", { id: "sf-sent", hidden: "" });
  const yes = sent.appendChild(new FakeEl("button", { "data-sent": "yes" }));
  const no = sent.appendChild(new FakeEl("button", { "data-sent": "no" }));
  const byId: Record<string, FakeEl> = {
    "sf-checkout": form, "sf-checkout-block": block, "sf-address-field": addressField, "sf-wa-fallback": fallback, "sf-sent": sent,
  };
  return { page: { body: new FakeEl("body"), byId }, form, name, phone, radios, address, addressField, note, counter, remember, block, submit, fallback, sent, yes, no };
}

function fullCart(storage = memoryStorage()) {
  const { cart } = run({ storage });
  cart.add(item({ id: "halloumi", title: "Halloumi 250g", unit: "u-pack", name: "Pack of 6", factor: 6, price: 12.5 }), 2);
  cart.add(item({ id: "water", title: "Water 1.5L", name: "Piece", price: 0.75 }), 1);
  return storage;
}

test("checkout: form rules — name required, phone optional but plausible, a fulfilment method, address for delivery", () => {
  const p = checkoutPage();
  const { checkout } = run({ storage: fullCart(), page: p.page, checkout: true });
  const v = () => checkout.values();
  assert.deepEqual(plain(checkout.validate(v())), { name: "field_required", fulfilment: "field_required" });
  p.name.value = "  Rana  ";
  p.phone.value = "71 315 744";
  p.radios[1].checked = true; // delivery
  assert.deepEqual(plain(checkout.validate(v())), { address: "field_required" });
  p.address.value = "Hamra, Bliss street";
  assert.deepEqual(plain(checkout.validate(v())), {});
  assert.equal(v().name, "Rana");
  p.phone.value = "call me";
  assert.deepEqual(plain(checkout.validate(v())), { phone: "invalid_phone" });
  p.phone.value = "+961 (71) 315-744";
  assert.deepEqual(plain(checkout.validate(v())), {});
  p.name.value = "x".repeat(120);
  assert.equal(v().name.length, 80, "trimmed to the field limit");
});

test("checkout: only one method → preselected; the address field follows the delivery choice", () => {
  const only = checkoutPage(["delivery"]);
  const a = run({ storage: fullCart(), page: only.page, checkout: true });
  assert.equal(a.checkout.values().fulfilment, "delivery");
  assert.equal(only.addressField.hidden, false);
  const both = checkoutPage();
  run({ storage: fullCart(), page: both.page, checkout: true });
  assert.equal(both.addressField.hidden, true);
  both.radios[1].checked = true;
  both.form.dispatch("change");
  assert.equal(both.addressField.hidden, false);
  both.note.value = "ring twice";
  both.form.dispatch("input");
  assert.equal(both.counter.textContent, "10/300");
});

test("checkout: the WhatsApp message lists every line, totals, fulfilment, contact and the confirmation note", () => {
  const p = checkoutPage();
  const { checkout } = run({ storage: fullCart(), page: p.page, checkout: true });
  const base = { name: "Rana", phone: "71 315 744", fulfilment: "pickup", address: "", note: "ring the bell twice", remember: false };
  assert.equal(checkout.buildMessage(base), [
    "New order — Beirut Market", "https://beirut-market.myomnipos.com/", "",
    "2 × Halloumi 250g (Pack of 6) — $25.00", "1 × Water 1.5L (Piece) — $0.75", "",
    "Total: $25.75 · 2,304,625 LL", "Pickup — Back door", "Name: Rana", "Phone: 71 315 744", "Note: ring the bell twice", "",
    "Prices to be confirmed by the shop.",
  ].join("\n"));
  const delivery = checkout.buildMessage({ ...base, fulfilment: "delivery", address: "Hamra", phone: "", note: "" });
  assert.match(delivery, /\nDelivery: Hamra\nName: Rana\n\nPrices/);
  assert.doesNotMatch(delivery, /Phone:|Note:/, "empty optional fields are left out");
  assert.equal(checkout.waUrl("a b&c"), "https://wa.me/96170123456?text=a%20b%26c");
});

test("checkout: fractional quantities show up to 3 decimals; unavailable lines are left out", () => {
  const storage = memoryStorage();
  const { cart } = run({ storage });
  cart.add(item({ id: "labneh", title: "Labneh", name: "kg", dec: true, price: 6.5 }), 1.25);
  const saved = plain(cart.load());
  saved.lines.push({ ...saved.lines[0], id: "gone", unit: "u-x", title: "Old pack", unavailable: true });
  storage.data.set(KEY, JSON.stringify(saved));
  const { checkout } = run({ storage, page: checkoutPage().page, checkout: true });
  const text = checkout.buildMessage({ name: "R", phone: "", fulfilment: "pickup", address: "", note: "", remember: false });
  assert.match(text, /^1\.25 × Labneh \(kg\) — \$8\.13$/m);
  assert.doesNotMatch(text, /Old pack/);
});

test("checkout: blocked below the minimum order, below a listing minimum, with an empty cart, or when the message is too long", () => {
  const small = memoryStorage();
  run({ storage: small }).cart.add(item({ price: 2 }), 1);
  const p = checkoutPage();
  const { cart } = run({ storage: small, page: p.page, checkout: true });
  assert.equal(p.submit.disabled, true);
  assert.equal(p.block.hidden, false);
  assert.equal(p.block.textContent, "Add $8.00 more to reach the minimum order.");
  cart.add(item({ id: "bread", title: "Arabic Bread", min: 12, price: 1 }), 10);
  assert.equal(p.submit.disabled, true, "cart changes re-check the form");
  assert.equal(p.block.textContent, "Some products are below their minimum quantity.");
  cart.setQty("bread", "base", 12);
  assert.equal(p.submit.disabled, false);
  assert.equal(p.block.hidden, true);
  cart.clear();
  assert.equal(p.submit.disabled, true, "empty cart");

  const big = memoryStorage();
  const filler = run({ storage: big });
  for (let i = 0; i < 50; i++) filler.cart.add(item({ id: `id-${i}`, title: "حليب كامل الدسم بالفانيليا ".repeat(3) + i, price: 1 }), 1);
  const q = checkoutPage();
  const r = run({ storage: big, page: q.page, checkout: true });
  assert.ok(r.checkout.tooLong(r.checkout.buildMessage(r.checkout.values())));
  assert.equal(q.block.textContent, "Too long — split it.");
  assert.equal(q.submit.disabled, true);
});

test("checkout: sending opens wa.me in a new tab, shows the fallback link, then asks 'did you send it?' on return", () => {
  const storage = fullCart();
  const p = checkoutPage();
  const r = run({ storage, page: p.page, checkout: true });
  p.form.dispatch("submit");
  assert.equal(r.opened.length, 0, "invalid form: nothing opened");
  assert.equal(p.form.querySelector('.sf-error[data-for="name"]')!.hidden, false);
  p.name.value = "Rana";
  p.radios[0].checked = true;
  p.form.dispatch("submit");
  assert.equal(r.opened.length, 1);
  assert.match(r.opened[0], /^https:\/\/wa\.me\/96170123456\?text=New%20order/);
  assert.equal(p.fallback.hidden, false);
  assert.equal(p.fallback.children[0].href, r.opened[0]);
  assert.equal(p.sent.hidden, true);
  r.returnToPage();
  assert.equal(p.sent.hidden, false);
  p.no.dispatch("click");
  assert.equal(p.sent.hidden, true);
  assert.equal(r.cart.load().lines.length, 2, "No keeps the cart");
  p.form.dispatch("submit");
  r.returnToPage();
  p.yes.dispatch("click");
  assert.equal(r.cart.load().lines.length, 0, "Yes empties the cart");
  assert.equal(JSON.parse(storage.data.get(KEY)!).lines.length, 0);
});

test("checkout: 'remember my details' saves them for the next checkout; unticking forgets them", () => {
  const storage = fullCart();
  const p = checkoutPage();
  run({ storage, page: p.page, checkout: true });
  p.name.value = "Rana";
  p.phone.value = "71315744";
  p.radios[1].checked = true;
  p.address.value = "Hamra";
  p.remember.checked = true;
  p.form.dispatch("submit");
  assert.deepEqual(JSON.parse(storage.data.get("sf-buyer:v1:beirut-market")!), { name: "Rana", phone: "71315744", address: "Hamra", fulfilment: "delivery" });
  const next = checkoutPage();
  run({ storage, page: next.page, checkout: true });
  assert.deepEqual([next.name.value, next.phone.value, next.address.value, next.radios[1].checked, next.remember.checked], ["Rana", "71315744", "Hamra", true, true]);
  next.remember.checked = false;
  next.form.dispatch("submit");
  assert.equal(storage.data.has("sf-buyer:v1:beirut-market"), false);
});

test("checkout.js never talks to the network or sets cookies", () => {
  assert.doesNotMatch(CHECKOUT, /fetch\(|XMLHttpRequest|sendBeacon|navigator\.|document\.cookie/);
});
