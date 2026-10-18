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
