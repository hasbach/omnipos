// Storefront pages (specs/002-tenant-online-store), rendered by the real handler on the in-memory fixture
// store. No network, no database: storefront code is plain TypeScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../storefront/src/http.js";
import { FixtureSource, demoFixture } from "../storefront/src/fixture.js";
import { loadConfig } from "../storefront/src/config.js";

const config = loadConfig({ STOREFRONT_DOMAIN: "omnipos.shop", OMNIPOS_WEBSITE_URL: "https://omnipos.example" });

function setup(mutate?: (fx: ReturnType<typeof demoFixture>) => void) {
  const fx = demoFixture(60);
  mutate?.(fx);
  const data = new FixtureSource(fx);
  const get = async (url: string, host = "beirut-market.omnipos.shop") => {
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
  assert.match(text, new RegExp(`https://beirut-market\.omnipos\.shop/p/${P1}`));
  assert.match(r.html, /href="tel:\+9611234567"/);
  assert.match(r.html, /href="mailto:hello@beirut-market\.test\?subject=Whole%20Milk%201L"/);

  const none = setup((fx) => { fx.store.contact_whatsapp = null; fx.store.contact_phone = null; fx.store.contact_email = null; });
  const r2 = await none.get(`/p/${P1}`);
  assert.doesNotMatch(r2.html, /wa\.me|tel:|mailto:/);
  assert.doesNotMatch(r2.html, /class="sf-contact"/);
});

test("WhatsApp numbers: digits only; 00 prefix dropped; numbers without digits give no button", async () => {
  const { whatsappLink } = await import("../storefront/src/contact.js");
  assert.equal(whatsappLink("+961 70-123 456", "hi"), "https://wa.me/96170123456?text=hi");
  assert.equal(whatsappLink("00961 70 123 456", "hi"), "https://wa.me/96170123456?text=hi");
  assert.equal(whatsappLink("n/a", "hi"), null);
  assert.equal(whatsappLink(null, "hi"), null);
});

test("store home shows the contact buttons too, with a store message", async () => {
  const { get } = setup();
  const r = await get("/");
  assert.match(r.html, /class="sf-contact"/);
  const wa = new URL(r.html.match(/href="(https:\/\/wa\.me\/[^"]+)"/)![1].replace(/&amp;/g, "&"));
  assert.match(wa.searchParams.get("text")!, /Beirut Market/);
  assert.match(wa.searchParams.get("text")!, /https:\/\/beirut-market\.omnipos\.shop\//);
});

test("link previews: product title, price and first photo as absolute URLs; canonical in host form", async () => {
  const { get } = setup((fx) => { fx.listings[0].images = [PHOTO(1)]; });
  const r = await get(`/s/beirut-market/p/${P1}`, "omnipos.shop"); // path form: canonical still host form
  assert.match(r.html, /<title>Whole Milk 1L — Beirut Market<\/title>/);
  assert.match(r.html, /<meta property="og:title" content="Whole Milk 1L — Beirut Market">/);
  assert.match(r.html, /<meta property="og:description" content="\$1\.50[^"]*">/);
  assert.match(r.html, new RegExp(`<meta property="og:image" content="https://beirut-market\.omnipos\.shop/img/${PHOTO(1).replace(/\//g, "\/")}">`));
  assert.match(r.html, new RegExp(`<link rel="canonical" href="https://beirut-market\.omnipos\.shop/p/${P1}">`));
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
