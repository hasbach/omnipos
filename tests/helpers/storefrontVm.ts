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
  focus() { this.focused = true; }
  select() { this.selected = true; }
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

function run(opts: { storage?: ReturnType<typeof memoryStorage>; config?: any; page?: Page; checkout?: boolean; globals?: Record<string, any>; order?: boolean } = {}) {
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
  const ctx = vm.createContext({ window, document, Intl, JSON, Math, Number, String, Object, Array, Date, isFinite, encodeURIComponent, setTimeout: () => 0, clearTimeout: () => {}, URL, Uint8Array, ...opts.globals });
  vm.runInContext(SOURCE, ctx);
  if (opts.checkout) vm.runInContext(CHECKOUT, ctx);
  if (opts.order) vm.runInContext(fs.readFileSync("storefront/public/order.js", "utf8"), ctx);
  const returnToPage = () => { for (const fn of document.listeners.visibilitychange || []) fn(); };
  return { order: window.OmniOrder, window, ctx, cart: window.OmniCart, checkout: window.OmniCheckout, storage, document, page, opened, returnToPage };
}

const item = (over: Partial<any> = {}) => ({
  id: "00000000-0000-4000-8000-000000000001", unit: "base", title: "Whole Milk 1L", img: null, name: "pcs", factor: 1,
  price: 1.5, price_lbp: null, min: null, dec: false, base: "pcs", ...over,
});
const KEY = "sf-cart:v1:beirut-market";
// Objects made inside the vm context have another realm's prototypes; compare them as plain data.
const plain = (o: any) => JSON.parse(JSON.stringify(o));


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

export { FakeEl, memoryStorage, CONFIG, run, item, plain, checkoutPage };
