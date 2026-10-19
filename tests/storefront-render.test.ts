// Storefront pages (specs/002-tenant-online-store), rendered by the real handler on the in-memory fixture
// store. No network, no database: storefront code is plain TypeScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../storefront/src/http.js";
import { FixtureSource, demoFixture } from "../storefront/src/fixture.js";
import { loadConfig } from "../storefront/src/config.js";

const config = loadConfig({ STOREFRONT_DOMAIN: "myomnipos.com", OMNIPOS_WEBSITE_URL: "https://omnipos.example" });

function setup(mutate?: (fx: ReturnType<typeof demoFixture>) => void) {
  const fx = demoFixture(60);
  mutate?.(fx);
  const data = new FixtureSource(fx);
  const get = async (url: string, host = "beirut-market.myomnipos.com") => {
    const r = await handle({ host, url }, { config, data, assetVersion: "test" });
    return { ...r, html: typeof r.body === "string" ? r.body : "" };
  };
  return { fx, data, get };
}

const cards = (html: string) => (html.match(/class="sf-card"/g) || []).length;

test("home: identity, categories in the shop's order, first page of 48 cards and a pager", async () => {
  const { get } = setup((fx) => { (fx.store as any).category_order = undefined; });
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(r.html, /<h1>Beirut Market<\/h1>/);
  assert.match(r.html, /Fresh groceries in Hamra\./);
  assert.equal(cards(r.html), 48);
  assert.match(r.html, /All products/);
  for (const c of ["Bakery", "Beverages", "Cleaning", "Dairy", "Pantry"]) assert.match(r.html, new RegExp(`>${c}<`));
  assert.match(r.html, /Page 1 of 2/);
  assert.match(r.html, /href="\/\?page=2"/);
  assert.match(r.html, /60 products/);
});

test("home cards: title, USD + local price, stock label, link to the product page, placeholder without a photo", async () => {
  const { get } = setup();
  const r = await get("/");
  // Sorted by title: "Arabic Bread" (listing 4, $0.75) is the first card.
  assert.match(r.html, /href="\/p\/00000000-0000-4000-8000-000000000004"/);
  assert.match(r.html, /\$0\.75/);
  assert.match(r.html, /67,125 LL/, "0.75 × 89,500 rounded to a whole LL");
  assert.match(r.html, /Low stock/);
  assert.match(r.html, /Out of stock/);
  assert.match(r.html, /src="\/placeholder\.svg\?v=test"/);
});

test("home cards use the product's own local price and the photo when present", async () => {
  const { get } = setup((fx) => {
    fx.listings[3].price_lbp = 150000;
    fx.listings[3].images = ["aaaaaaaa-0000-4000-8000-000000000001/l/00000000-0000-4000-8000-000000000004/abcdefghijklmnopqrstuv.webp"];
  });
  const r = await get("/");
  assert.match(r.html, /150,000 LL/);
  assert.match(r.html, /src="\/img\/aaaaaaaa-0000-4000-8000-000000000001\/l\/00000000-0000-4000-8000-000000000004\/abcdefghijklmnopqrstuv\.webp"/);
});

test("local prices hidden when the store turns them off or has no local currency", async () => {
  const off = setup((fx) => { fx.store.show_local_price = false; });
  assert.doesNotMatch((await off.get("/")).html, / LL</);
  const none = setup((fx) => { fx.store.local_currency_code = null; });
  assert.doesNotMatch((await none.get("/")).html, / LL</);
});

test("category filter: only that category, chip marked current, kept in pager links", async () => {
  const { get } = setup((fx) => { for (let i = 0; i < 60; i++) fx.listings.push({ ...fx.listings[0], listing_id: `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Extra milk ${i}` }); });
  const r = await get("/?c=Dairy");
  assert.equal(r.status, 200);
  assert.match(r.html, /aria-current="page"[^>]*>Dairy</);
  assert.doesNotMatch(r.html, /Arabic Bread/);
  assert.equal(cards(r.html), 48);
  assert.match(r.html, /href="\/\?c=Dairy&amp;page=2"/);
});

test("search by title or barcode; 'no products found' when nothing matches; search kept with category", async () => {
  const { get } = setup();
  const byTitle = await get("/?q=labneh");
  assert.match(byTitle.html, /Labneh 500g/);
  assert.doesNotMatch(byTitle.html, /Halloumi/);
  const byBarcode = await get("/?q=6221000000002");
  assert.equal(cards(byBarcode.html), 1);
  const none = await get("/?q=caviar");
  assert.equal(cards(none.html), 0);
  assert.match(none.html, /No products found\./);
  const form = (await get("/?c=Dairy&q=milk")).html;
  assert.match(form, /name="q"[^>]*value="milk"/);
  assert.match(form, /type="hidden" name="c" value="Dairy"/);
});

test("out-of-range page shows the empty state with a link back to page 1", async () => {
  const { get } = setup();
  const r = await get("/?page=9");
  assert.equal(cards(r.html), 0);
  assert.match(r.html, /Back to the first page/);
  assert.match(r.html, /href="\/"/);
});

test("hide out of stock: those products disappear from the grid, the counts and the categories", async () => {
  const { get } = setup((fx) => { fx.store.hide_out_of_stock = true; });
  const r = await get("/");
  assert.doesNotMatch(r.html, /Manakish Zaatar/);
  assert.doesNotMatch(r.html, /Out of stock/);
  assert.match(r.html, /54 products/);
});

test("a store with no visible products shows 'No products available yet'", async () => {
  const { get } = setup((fx) => { fx.listings = []; });
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(r.html, /No products available yet\./);
  assert.doesNotMatch(r.html, /sf-pager/);
});

test("store-provided text is HTML-escaped everywhere", async () => {
  const { get } = setup((fx) => {
    fx.store.name = 'Bad <script>alert(1)</script> "Shop"';
    fx.store.description = "<img src=x onerror=alert(1)>";
    fx.listings[0].title = "<b>Milk</b>";
    fx.listings[0].category = "Dairy<script>";
  });
  const r = await get("/");
  assert.doesNotMatch(r.html, /<script>alert/);
  assert.doesNotMatch(r.html, /<img src=x/);
  assert.doesNotMatch(r.html, /<b>Milk<\/b>/);
  assert.match(r.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;Shop&quot;/);
  assert.match(r.html, /&lt;b&gt;Milk&lt;\/b&gt;/);
});

// ---- product page (US2) ----------------------------------------------------------------------------------

const P1 = "00000000-0000-4000-8000-000000000001"; // Whole Milk 1L, $1.50, has a Pack unit (index 0 % 4 === 0)
const PHOTO = (n: number) => `aaaaaaaa-0000-4000-8000-000000000001/l/${P1}/photo${n}abcdefghijklmnop.webp`;

test("product page: title, description with line breaks, category, USD + local price, units, stock + indicative note", async () => {
  const { get } = setup();
  const r = await get(`/p/${P1}`);
  assert.equal(r.status, 200);
  assert.match(r.html, /<h1>Whole Milk 1L<\/h1>/);
  assert.match(r.html, /class="sf-description">Whole Milk 1L — fresh from our shelves\.\nSecond line\.</);
  assert.match(r.html, /href="\/\?c=Dairy"[^>]*>Dairy</);
  assert.match(r.html, /\$1\.50/);
  assert.match(r.html, /134,250 LL/);
  assert.match(r.html, /Sold as/);
  assert.match(r.html, /Pack/);
  assert.match(r.html, /6 × pcs/);
  assert.match(r.html, /\$8\.25/, "pack price 1.50 × 5.5");
  assert.match(r.html, /738,375 LL/, "pack local price 8.25 × 89,500");
  assert.match(r.html, /In stock/);
  assert.match(r.html, /Availability is indicative/);
  assert.match(r.html, /src="\/placeholder\.svg\?v=test"/, "placeholder without photos");
});

test("product page gallery: photos in order, main photo first, swipeable list", async () => {
  const { get } = setup((fx) => { fx.listings[0].images = [PHOTO(1), PHOTO(2), PHOTO(3)]; });
  const r = await get(`/p/${P1}`);
  const srcs = [...r.html.matchAll(/<img class="sf-gallery-img" src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, [1, 2, 3].map((n) => `/img/${PHOTO(n)}`));
  assert.match(r.html, /class="sf-gallery"/);
});

test("contact buttons: WhatsApp pre-filled with product name and link, Call and Email only when filled in", async () => {
  const { get } = setup();
  const r = await get(`/p/${P1}`);
  const wa = r.html.match(/href="(https:\/\/wa\.me\/[^"]+)"/);
  assert.ok(wa, "WhatsApp link present");
  const waUrl = new URL(wa![1].replace(/&amp;/g, "&"));
  assert.equal(waUrl.pathname, "/96170123456");
  const text = waUrl.searchParams.get("text")!;
  assert.match(text, /Whole Milk 1L/);
  assert.match(text, new RegExp(`https://beirut-market\.myomnipos.com/p/${P1}`));
  assert.match(r.html, /href="tel:\+9611234567"/);
  assert.match(r.html, /href="mailto:hello@beirut-market\.test\?subject=Whole%20Milk%201L"/);

  const none = setup((fx) => { fx.store.contact_whatsapp = null; fx.store.contact_phone = null; fx.store.contact_email = null; });
  const r2 = await none.get(`/p/${P1}`);
  assert.doesNotMatch(r2.html, /wa\.me|tel:|mailto:/);
  assert.doesNotMatch(r2.html, /class="sf-contact"/);
});

test("WhatsApp numbers: digits only; 00 prefix dropped; local numbers get +961; numbers without digits give no button", async () => {
  const { whatsappLink } = await import("../storefront/src/contact.js");
  assert.equal(whatsappLink("+961 70-123 456", "hi"), "https://wa.me/96170123456?text=hi");
  assert.equal(whatsappLink("00961 70 123 456", "hi"), "https://wa.me/96170123456?text=hi");
  assert.equal(whatsappLink("71315744", "hi"), "https://wa.me/96171315744?text=hi");
  assert.equal(whatsappLink("03 123 456", "hi"), "https://wa.me/9613123456?text=hi");
  assert.equal(whatsappLink("96171315744", "hi"), "https://wa.me/96171315744?text=hi");
  assert.equal(whatsappLink("+33 6 12 34 56 78", "hi"), "https://wa.me/33612345678?text=hi");
  assert.equal(whatsappLink("12345", "hi"), null);
  assert.equal(whatsappLink("n/a", "hi"), null);
  assert.equal(whatsappLink(null, "hi"), null);
});

test("store home shows the contact buttons too, with a store message", async () => {
  const { get } = setup();
  const r = await get("/");
  assert.match(r.html, /class="sf-contact"/);
  const wa = new URL(r.html.match(/href="(https:\/\/wa\.me\/[^"]+)"/)![1].replace(/&amp;/g, "&"));
  assert.match(wa.searchParams.get("text")!, /Beirut Market/);
  assert.match(wa.searchParams.get("text")!, /https:\/\/beirut-market\.myomnipos.com\//);
});

test("link previews: product title, price and first photo as absolute URLs; canonical in host form", async () => {
  const { get } = setup((fx) => { fx.listings[0].images = [PHOTO(1)]; });
  const r = await get(`/s/beirut-market/p/${P1}`, "myomnipos.com"); // path form: canonical still host form
  assert.match(r.html, /<title>Whole Milk 1L — Beirut Market<\/title>/);
  assert.match(r.html, /<meta property="og:title" content="Whole Milk 1L — Beirut Market">/);
  assert.match(r.html, /<meta property="og:description" content="\$1\.50[^"]*">/);
  assert.match(r.html, new RegExp(`<meta property="og:image" content="https://beirut-market\.myomnipos.com/img/${PHOTO(1).replace(/\//g, "\/")}">`));
  assert.match(r.html, new RegExp(`<link rel="canonical" href="https://beirut-market\.myomnipos.com/p/${P1}">`));
  assert.match(r.html, /<meta property="og:locale" content="en_US">/);
  assert.match(r.html, /<meta name="twitter:card" content="summary_large_image">/);
});

test("product no longer available: 404 page with a link back to the store, never stale details", async () => {
  const { get } = setup((fx) => { fx.listings[0].published = false; });
  const r = await get(`/p/${P1}`);
  assert.equal(r.status, 404);
  assert.match(r.html, /This product is no longer available/);
  assert.match(r.html, /href="\/"[^>]*>Visit the store</);
  assert.doesNotMatch(r.html, /Whole Milk/);
});

test("exact stock appears on the product page only when the store turns it on", async () => {
  const off = await setup().get(`/p/${P1}`);
  assert.doesNotMatch(off.html, /40 in stock/);
  const on = await setup((fx) => { fx.store.show_exact_stock = true; }).get(`/p/${P1}`);
  assert.match(on.html, /40 in stock/);
});

// ---- languages and phones (US3) ---------------------------------------------------------------------------

test("i18n: English, Arabic and French have exactly the same keys and no empty strings", async () => {
  const { __dicts } = await import("../storefront/src/i18n.js");
  const en = Object.keys(__dicts.en).sort();
  for (const lang of ["ar", "fr"] as const) {
    assert.deepEqual(Object.keys(__dicts[lang]).sort(), en, `${lang} keys`);
    for (const [k, v] of Object.entries(__dicts[lang])) assert.ok(String(v).trim(), `${lang}.${k} empty`);
  }
  // Placeholders survive translation.
  for (const lang of ["ar", "fr"] as const) {
    for (const k of en) {
      const vars = (__dicts.en[k].match(/\{\w+\}/g) || []).sort();
      assert.deepEqual((__dicts[lang][k].match(/\{\w+\}/g) || []).sort(), vars, `${lang}.${k} placeholders`);
    }
  }
});

test("default language = store language; Arabic pages are right-to-left", async () => {
  const { get } = setup((fx) => { fx.store.default_language = "ar"; });
  const r = await get("/");
  assert.match(r.html, /<html lang="ar" dir="rtl">/);
  assert.match(r.html, /كل المنتجات/);
  assert.match(r.html, /<meta property="og:locale" content="ar_LB">/);
  assert.doesNotMatch(r.html, />All products</);
});

test("?lang= overrides the store language and is kept in every store link", async () => {
  const { get } = setup();
  const r = await get("/?lang=fr");
  assert.match(r.html, /<html lang="fr" dir="ltr">/);
  assert.match(r.html, /Tous les produits/);
  assert.match(r.html, /href="\/p\/00000000-0000-4000-8000-000000000004\?lang=fr"/);
  assert.match(r.html, /href="\/\?lang=fr&amp;c=Dairy"/);
  assert.match(r.html, /type="hidden" name="lang" value="fr"/);
  const ar = await get(`/p/${P1}?lang=ar`);
  assert.match(ar.html, /dir="rtl"/);
  assert.match(ar.html, /href="\/\?lang=ar"[^>]*>العودة إلى المتجر</);
  // The WhatsApp message is in the page language and links back to it.
  const wa = new URL(ar.html.match(/href="(https:\/\/wa\.me\/[^"]+)"/)![1].replace(/&amp;/g, "&"));
  assert.match(wa.searchParams.get("text")!, /مرحباً/);
  assert.match(wa.searchParams.get("text")!, /\?lang=ar/);
});

test("language switcher: one link per language to the same page; the current one is marked", async () => {
  const { get } = setup();
  const r = await get("/?c=Dairy&page=1");
  assert.match(r.html, /class="sf-langs"/);
  assert.match(r.html, /href="\/\?c=Dairy&amp;lang=ar"[^>]*data-lang="ar"[^>]*>العربية</);
  assert.match(r.html, /href="\/\?c=Dairy&amp;lang=fr"[^>]*data-lang="fr"[^>]*>Français</);
  assert.match(r.html, /aria-current="true"[^>]*>English</);
  const product = await get(`/p/${P1}`);
  assert.ok(product.html.includes(`href="/p/${P1}?lang=ar"`), "product page switcher keeps the product");
});

test("status pages are translated too", async () => {
  const { get } = setup((fx) => { fx.store.status = "paused"; });
  const r = await get("/?lang=fr");
  assert.match(r.html, /<html lang="fr"/);
  assert.match(r.html, /Cette boutique n’est pas disponible/);
});

test("stylesheet is RTL-safe and phone-first: no physical left/right properties, 2-column grid on phones", async () => {
  const fs = await import("fs");
  const css = fs.readFileSync("storefront/public/storefront.css", "utf8");
  const physical = css.match(/(margin|padding|border)-(left|right)|(^|[;{\s])(left|right)\s*:|text-align:\s*(left|right)|float:\s*(left|right)/gm);
  assert.equal(physical, null, `physical properties found: ${physical}`);
  assert.match(css, /\.sf-grid \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /overflow-x: hidden/);
});

// ---- privacy and gates (US4) ------------------------------------------------------------------------------

test("every non-public state shows one identical neutral page, with no products and no reason", async () => {
  const states: [string, (fx: ReturnType<typeof demoFixture>) => void][] = [
    ["paused", (fx) => { fx.store.status = "paused"; }],
    ["draft", (fx) => { fx.store.status = "draft"; }],
    ["wholesale", (fx) => { fx.store.mode = "wholesale"; }],
    ["commerce off", (fx) => { fx.store.commerce_on = false; }],
    ["license expired", (fx) => { fx.store.licensed = false; }],
  ];
  const unknown = await setup().get("/", "never-claimed.myomnipos.com");
  assert.equal(unknown.status, 404);
  for (const [label, mutate] of states) {
    const r = await setup(mutate).get("/");
    assert.equal(r.status, 404, label);
    assert.equal(r.headers["Cache-Control"], "public, s-maxage=60", label);
    assert.equal(r.html, unknown.html, `${label} looks exactly like an unknown address`);
    assert.doesNotMatch(r.html, /Beirut Market|Whole Milk|sf-card/, label);
    assert.match(r.html, /<meta name="robots" content="noindex">/, label);
    const product = await setup(mutate).get(`/p/${P1}`);
    assert.equal(product.html, unknown.html, `${label}: product links reveal nothing either`);
  }
  // Hybrid stores are public (retail prices).
  assert.equal((await setup((fx) => { fx.store.mode = "hybrid"; }).get("/")).status, 200);
});

test("allow-list: no rendered page contains cost, tier prices, reorder levels, internal ids or barcodes", async () => {
  const { fx, get } = setup((f) => { f.store.show_exact_stock = true; });
  // Make sure a leak would be visible: the fixture carries these on the internal rows.
  const barcode = fx.listings[0].barcode!;
  const pages = [await get("/"), await get("/?c=Dairy&q=milk"), await get(`/p/${P1}`), await get(`/p/${P1}?lang=ar`), await get("/?page=99"),
    await get("/p/00000000-0000-4000-8000-000000000999")];
  for (const p of pages) {
    for (const bad of [/cost/i, /min_price/, /wholesale/i, /reorder/i, /tenant_id/, /global_id/, /track_inventory/, new RegExp(barcode)]) {
      assert.doesNotMatch(p.html, bad, `forbidden ${bad} in a ${p.status} page`);
    }
  }
});

test("search by barcode finds the product but never prints the barcode", async () => {
  const { fx, get } = setup();
  const barcode = fx.listings[1].barcode!;
  const r = await get(`/?q=${barcode}`);
  assert.equal(cards(r.html), 1);
  // The visitor's own search text is echoed (search box, links that keep the search) — never inside a product card.
  assert.match(r.html, new RegExp(`name="q" value="${barcode}"`));
  const grid = r.html.slice(r.html.indexOf('<ul class="sf-grid">'), r.html.indexOf("</ul>"));
  assert.ok(grid.length > 0);
  assert.ok(!grid.includes(barcode), "barcode printed in a card");
});

// ---- 003 Slice 1: cart controls (WhatsApp ordering) ---------------------------------------------------

function setupOrdering(mutate?: (fx: ReturnType<typeof demoFixture>) => void) {
  const fx = demoFixture(60, { ordering: true });
  mutate?.(fx);
  const data = new FixtureSource(fx);
  const get = async (url: string, host = "beirut-market.myomnipos.com") => {
    const r = await handle({ host, url }, { config, data, assetVersion: "test" });
    return { ...r, html: typeof r.body === "string" ? r.body : "" };
  };
  return { fx, data, get };
}
const lid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const orderJson = (html: string) => {
  const m = html.match(/<script type="application\/json" id="sf-order">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
};

test("003: ordering off — pages carry no cart link, controls, sf-order block or cart.js", async () => {
  const { get } = setup();
  for (const url of ["/", `/p/${lid(1)}`]) {
    const { html } = await get(url);
    for (const s of ["sf-order", "cart.js", "sf-cart-link", "data-sf-add", "Add to cart"]) assert.ok(!html.includes(s), `${url}: ${s}`);
  }
  // Ordering mode on but no usable WhatsApp number, or no way to receive the goods: still off.
  const noNumber = (fx: any) => { fx.store.contact_whatsapp = null; };
  const noFulfilment = (fx: any) => { fx.store.pickup_enabled = false; fx.store.delivery_enabled = false; };
  for (const m of [noNumber, noFulfilment]) {
    const { html } = await setupOrdering(m).get("/");
    assert.ok(!html.includes("cart.js"));
  }
});

test("003: ordering on — header cart link and the sf-order block with store-level data only", async () => {
  const { get } = setupOrdering();
  const { html } = await get("/");
  assert.match(html, /<a class="sf-cart-link" href="\/cart" hidden>Cart <span class="sf-cart-count" hidden><\/span><\/a>/);
  assert.match(html, /<script src="\/cart\.js\?v=test" defer><\/script>/);
  const p = orderJson(html);
  assert.deepEqual(
    { address: p.address, home: p.home, cart: p.cart, product: p.product, wa: p.wa, local: p.local, pickup: p.pickup, delivery: p.delivery, min: p.minOrderUsd },
    {
      address: "beirut-market", home: "https://beirut-market.myomnipos.com/", cart: "/cart", product: "/p/__ID__", wa: "96170123456",
      local: { show: true, code: "LBP", symbol: "LL", rate: 89500 }, pickup: { on: true, note: "Back door after 4 pm" },
      delivery: { on: true, note: "Hamra and Ras Beirut only" }, min: 10,
    },
  );
  assert.equal(p.ui.added_to_cart, "Added to your cart.");
  // Path form keeps its own links; ?lang= is kept in the cart link and the strings follow the page language.
  const path = await get("/s/beirut-market?lang=fr", "myomnipos.com");
  assert.equal(orderJson(path.html).cart, "/s/beirut-market/cart?lang=fr");
  assert.equal(orderJson(path.html).ui.added_to_cart, "Ajouté à votre panier.");
});

test("003: product page form lists only orderable units with their price data, hidden until JS", async () => {
  const { get } = setupOrdering();
  const milk = (await get(`/p/${lid(1)}`)).html;
  assert.match(milk, /<form class="sf-order" data-id="00000000-0000-4000-8000-000000000001" data-title="Whole Milk 1L" data-img="" data-min="" data-base="pcs" data-dec="0" hidden>/);
  assert.match(milk, /<option value="base" data-unit="base" data-name="pcs" data-factor="1" data-price="1.5" data-price-lbp="">pcs<\/option>/);
  assert.match(milk, /<option value="u-0" data-unit="u-0" data-name="Pack" data-factor="6" data-price="8.25" data-price-lbp="">Pack \(6 × pcs\)<\/option>/);
  assert.match(milk, /step="1"/);

  const halloumi = (await get(`/p/${lid(3)}`)).html; // pack only
  assert.doesNotMatch(halloumi, /data-unit="base"/);
  assert.match(halloumi, /data-unit="30000000-0000-4000-8000-000000000003"/);
  assert.match(halloumi, /<select name="unit" disabled>/);

  const labneh = (await get(`/p/${lid(2)}`)).html; // kg
  assert.match(labneh, /data-dec="1"/);
  assert.match(labneh, /step="0\.001"/);
  assert.match(labneh, /inputmode="decimal"/);

  const bread = (await get(`/p/${lid(4)}`)).html; // minimum 6
  assert.match(bread, /data-min="6"/);
  assert.match(bread, /value="6"/);
  assert.match(bread, /Minimum order: 6 pcs\./);

  const manakish = (await get(`/p/${lid(5)}`)).html; // out of stock
  assert.doesNotMatch(manakish, /class="sf-order"/);
  assert.match(manakish, /class="sf-button sf-wa"/, "contact buttons stay");
});

test("003: cards — Add for one unit without a minimum, Choose otherwise, nothing when out of stock", async () => {
  const { get } = setupOrdering();
  const { html } = await get("/");
  const card = (n: number) => html.split("<li>").find((c) => c.includes(`/p/${lid(n)}"`)) || "";
  assert.match(card(2), /<button class="sf-button sf-add" type="button" hidden data-sf-add data-id="00000000-0000-4000-8000-000000000002"/, "Labneh: kg only");
  assert.match(card(3), /data-sf-add[^>]*data-unit="30000000-0000-4000-8000-000000000003"/, "Halloumi: pack only");
  const milkCard = (await get("/?q=whole")).html.split("<li>").find((c) => c.includes(`/p/${lid(1)}"`)) || "";
  assert.match(milkCard, /data-sf-choose/, "Whole Milk (sorted onto page 2): piece or pack");
  assert.match(card(4), /data-sf-choose/, "Arabic Bread: minimum 6");
  assert.doesNotMatch(card(5), /sf-add/, "Manakish: out of stock");
  // The control sits after the card link, never inside it.
  for (const n of [2, 3, 4]) {
    const c = card(n);
    assert.ok(c.indexOf("</a>") < c.indexOf("sf-add"), `card ${n}`);
  }
});

test("003: store text is escaped in data attributes and in the sf-order JSON", async () => {
  const { get } = setupOrdering((fx) => {
    fx.store.name = `Joe's "Best" </script><script>alert(1)</script>`;
    fx.store.pickup_note = "<b>back</b>";
    fx.listings[0].title = `"><img src=x onerror=alert(1)>`;
  });
  const home = (await get("/")).html;
  assert.ok(!home.includes("</script><script>alert(1)"), "no script break-out");
  assert.ok(!home.includes(`"><img src=x`), "attribute stays closed");
  const p = orderJson(home);
  assert.equal(p.storeName, `Joe's "Best" </script><script>alert(1)</script>`);
  assert.equal(p.pickup.note, "<b>back</b>");
  const product = (await get(`/p/${lid(1)}`)).html;
  assert.match(product, /data-title="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/);
});

test("003: the same URL gives the same page for everyone; no cookies, no Vary", async () => {
  const { get } = setupOrdering();
  for (const url of ["/", `/p/${lid(1)}`, "/cart"]) {
    const a = await get(url);
    const b = await get(url);
    assert.equal(a.html, b.html, url);
    assert.equal(a.headers["Set-Cookie"], undefined, url);
    assert.equal(a.headers.Vary, undefined, url);
  }
});

test("003: cart page — store shell, notes, noscript contact, cacheable and noindex; 302 home when ordering is off", async () => {
  const { get } = setupOrdering();
  const r = await get("/cart");
  assert.equal(r.status, 200);
  assert.equal(r.headers["Cache-Control"], "public, s-maxage=240, stale-while-revalidate=60");
  assert.match(r.html, /<meta name="robots" content="noindex">/);
  const expected = ['id="sf-cart-lines"', 'id="sf-cart-total"', 'id="sf-cart-empty"', 'id="sf-cart-full" hidden',
    "Prices and availability are confirmed by the shop.", "You pay on pickup or delivery.", "Any delivery charge is agreed with the shop.",
    "<noscript>", "Ordering needs JavaScript"];
  for (const s of expected) assert.ok(r.html.includes(s), s);
  assert.match(r.html, /<title>Cart — Beirut Market<\/title>/);
  const ar = await get("/cart?lang=ar");
  assert.match(ar.html, /<html lang="ar" dir="rtl">/);
  assert.match(ar.html, /السلة/);

  const off = setup();
  const redirect = await off.get("/cart");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.Location, "/");
  assert.equal(redirect.headers["Cache-Control"], "public, s-maxage=60");
  const pathOff = await off.get("/s/beirut-market/cart?lang=fr", "myomnipos.com");
  assert.equal(pathOff.headers.Location, "/s/beirut-market/?lang=fr");
  // A store that isn't public answers like its home: the neutral unavailable page.
  const closed = await setupOrdering((fx) => { fx.store.status = "paused"; }).get("/cart");
  assert.equal(closed.status, 404);
  assert.match(closed.html, /This store isn’t available/);
});

test("003: cart page checkout form — fields checkout.js reads, methods the store offers, checkout.js only here", async () => {
  const { get } = setupOrdering();
  const cart = (await get("/cart")).html;
  const expected = ['<form id="sf-checkout"', 'name="name" maxlength="80"', 'name="phone" type="tel" maxlength="30"',
    'name="fulfilment" value="pickup"', 'name="fulfilment" value="delivery"', 'id="sf-address-field" hidden', 'name="address" maxlength="300"',
    'name="note" maxlength="300"', 'data-counter="note"', 'name="remember"', 'id="sf-checkout-block"', 'class="sf-button sf-wa sf-submit"',
    'id="sf-wa-fallback"', 'id="sf-sent"', 'data-sent="yes"', 'data-sent="no"', 'data-for="name"', 'data-for="address"',
    "Minimum order: $10.00", "Back door after 4 pm", "Hamra and Ras Beirut only", "Order on WhatsApp"];
  for (const s of expected) assert.ok(cart.includes(s), s);
  assert.match(cart, /<script src="\/checkout\.js\?v=test" defer><\/script>/);
  assert.doesNotMatch((await get("/")).html, /checkout\.js/, "only the cart page loads checkout.js");

  // A single method is preselected; with delivery only, the address field starts visible.
  const deliveryOnly = (await setupOrdering((fx) => { fx.store.pickup_enabled = false; }).get("/cart")).html;
  assert.match(deliveryOnly, /value="delivery" checked/);
  assert.doesNotMatch(deliveryOnly, /value="pickup"/);
  assert.match(deliveryOnly, /<label class="sf-field" id="sf-address-field">/);
});

test("003: WhatsApp message strings follow the store's language, page strings the visitor's", async () => {
  const { get } = setupOrdering((fx) => { fx.store.default_language = "ar"; });
  const p = orderJson((await get("/cart?lang=fr")).html);
  assert.equal(p.ui.field_required, "Obligatoire.");
  assert.equal(p.msg.msg_new_order, "طلب جديد — {store}");
  assert.equal(p.msg.msg_prices_confirmed, "الأسعار بانتظار تأكيد المتجر.");
});
