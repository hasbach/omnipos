// Storefront routing and response headers (contracts/storefront-routes.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, CACHE_PAGE, CACHE_SHORT, CACHE_PREVIEW } from "../storefront/src/http.js";
import { route } from "../storefront/src/router.js";
import { FixtureSource, demoFixture } from "../storefront/src/fixture.js";
import { loadConfig } from "../storefront/src/config.js";

const config = loadConfig({ STOREFRONT_DOMAIN: "myomnipos.com", OMNIPOS_WEBSITE_URL: "https://omnipos.example" });
const make = () => {
  const fx = demoFixture(10);
  const data = new FixtureSource(fx);
  return { fx, data, get: (host: string, url: string) => handle({ host, url }, { config, data, assetVersion: "test" }) };
};
const body = (r: { body: string | Uint8Array }) => (typeof r.body === "string" ? r.body : "");

test("host form and path form show the same store; links stay in their own form", async () => {
  const { get } = make();
  const host = await get("beirut-market.myomnipos.com", "/");
  const path = await get("myomnipos.com", "/s/beirut-market");
  assert.equal(host.status, 200);
  assert.equal(path.status, 200);
  assert.match(body(host), /href="\/p\/00000000-0000-4000-8000-000000000001"/);
  assert.match(body(path), /href="\/s\/beirut-market\/p\/00000000-0000-4000-8000-000000000001"/);
  // Any other host (localhost, preview deployments) works like the apex.
  assert.equal((await get("localhost:3200", "/s/beirut-market")).status, 200);
});

test("addresses are matched case-insensitively", async () => {
  const { get } = make();
  assert.equal((await get("Beirut-Market.MYOMNIPOS.com", "/")).status, 200);
  assert.equal((await get("myomnipos.com", "/s/BEIRUT-MARKET")).status, 200);
});

test("route(): product pages, unknown paths, invalid addresses, nested subdomains", () => {
  const d = "myomnipos.com";
  assert.equal(route("a-shop.myomnipos.com", "/p/00000000-0000-4000-8000-000000000001/cola-can", d).kind, "product");
  assert.equal(route("a-shop.myomnipos.com", "/p/not-a-uuid", d).kind, "notFound");
  assert.equal(route("a-shop.myomnipos.com", "/admin", d).kind, "notFound");
  assert.equal(route("x.y.myomnipos.com", "/", d).kind, "notFound");
  assert.equal(route("myomnipos.com", "/s/bad_address!", d).kind, "notFound");
  assert.equal(route("myomnipos.com", "/img/a/b.webp", d).kind, "img");
  const r = route("a-shop.myomnipos.com", "/?c=Dairy&q=%20milk%20&page=0&lang=de&preview=ok_token-1", d) as any;
  assert.deepEqual(r.params, { category: "Dairy", search: "milk", page: 1, lang: null, preview: "ok_token-1" });
});

test("apex root redirects to the OmniPOS website; reserved subdomains to the apex", async () => {
  const { get } = make();
  const apex = await get("myomnipos.com", "/");
  assert.equal(apex.status, 302);
  assert.equal(apex.headers.Location, "https://omnipos.example");
  for (const sub of ["www", "api", "mail", "admin"]) {
    const r = await get(`${sub}.myomnipos.com`, "/");
    assert.equal(r.status, 301, sub);
    assert.equal(r.headers.Location, "https://myomnipos.com/");
  }
});

test("unknown and non-public stores get the same neutral page, cached briefly", async () => {
  const { fx, get } = make();
  const unknown = await get("nope.myomnipos.com", "/");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers["Cache-Control"], CACHE_SHORT);
  fx.store.status = "paused";
  const paused = await get("beirut-market.myomnipos.com", "/");
  assert.equal(paused.status, 404);
  assert.equal(body(paused), body(unknown), "paused looks exactly like unknown");
  fx.store.status = "active";
  fx.store.mode = "wholesale";
  assert.equal(body(await get("beirut-market.myomnipos.com", "/")), body(unknown), "wholesale looks exactly like unknown");
});

test("cache headers per route kind; no cookies; security headers", async () => {
  const { fx, get } = make();
  const home = await get("beirut-market.myomnipos.com", "/");
  assert.equal(home.headers["Cache-Control"], CACHE_PAGE);
  assert.equal(home.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(home.headers["X-Content-Type-Options"], "nosniff");
  assert.ok(home.headers["Referrer-Policy"]);
  const product = await get("beirut-market.myomnipos.com", "/p/00000000-0000-4000-8000-000000000001");
  assert.equal(product.headers["Cache-Control"], CACHE_PAGE);
  const gone = await get("beirut-market.myomnipos.com", "/p/00000000-0000-4000-8000-000000000999");
  assert.equal(gone.status, 404);
  assert.equal(gone.headers["Cache-Control"], CACHE_SHORT);
  const notFound = await get("beirut-market.myomnipos.com", "/nothing-here");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers["Cache-Control"], CACHE_SHORT);
  const badImg = await get("myomnipos.com", "/img/../../etc/passwd");
  assert.equal(badImg.status, 404);

  fx.previewTokens.push("tok_1");
  fx.store.status = "draft";
  const preview = await get("beirut-market.myomnipos.com", "/?preview=tok_1");
  assert.equal(preview.status, 200);
  assert.equal(preview.headers["Cache-Control"], CACHE_PREVIEW);
  assert.equal(preview.headers["X-Robots-Tag"], "noindex");
  assert.match(body(preview), /Preview — this store is not public/);
  assert.match(body(preview), /href="\/p\/[^"]+\?preview=tok_1"/, "links keep the preview token");

  for (const r of [home, product, gone, notFound, preview]) {
    assert.equal(Object.keys(r.headers).some((h) => h.toLowerCase() === "set-cookie"), false);
  }
});

test("upstream failure: 503 page, not cached", async () => {
  const { UpstreamError } = await import("../storefront/src/data.js");
  const failing = { getStore: async () => { throw new UpstreamError("down"); }, listListings: async () => ({ rows: [], total: 0 }), getListing: async () => null };
  const r = await handle({ host: "beirut-market.myomnipos.com", url: "/" }, { config, data: failing as any, assetVersion: "t" });
  assert.equal(r.status, 503);
  assert.equal(r.headers["Cache-Control"], "no-store");
});

// ---- speed and cost (US6) ---------------------------------------------------------------------------------

test("identical URLs give identical bodies and cache headers (CDN-cacheable; nothing varies per visitor)", async () => {
  const { get } = make();
  for (const url of ["/", "/?c=Dairy", "/p/00000000-0000-4000-8000-000000000001", "/?lang=ar"]) {
    const a = await get("beirut-market.myomnipos.com", url);
    const b = await get("beirut-market.myomnipos.com", url);
    assert.equal(body(a), body(b), url);
    assert.deepEqual(a.headers, b.headers, url);
    assert.equal(a.headers.Vary, undefined, `${url} must not vary`);
  }
});

test("asset version matches all six assets (sha256, LF-normalised)", async () => {
  const fs = await import("fs");
  const crypto = await import("crypto");
  const { ASSET_VERSION } = await import("../storefront/src/assets.js");
  const content = ["storefront.css", "storefront.js", "placeholder.svg", "cart.js", "checkout.js", "order.js"]
    .map((f) => fs.readFileSync(`storefront/public/${f}`, "utf8").replace(/\r\n/g, "\n")).join("");
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 10);
  assert.equal(ASSET_VERSION, hash, `update storefront/src/assets.ts to '${hash}'`);
  const home = await make().get("beirut-market.myomnipos.com", "/");
  assert.ok(body(home).includes("/storefront.css?v=test"), "pages reference the versioned stylesheet");
});

test('online order budgets: order.js ≤ 12 KB LF and a 50-line status page ≤ 30 KB', async () => {
  const fs = await import('node:fs');
  const { LIMITS } = await import('../storefront/src/limits.js');
  const { FixtureOrderGateway } = await import('../storefront/src/fixture.js');
  const source = fs.readFileSync('storefront/public/order.js', 'utf8');
  assert.ok(!source.includes('\r'));
  assert.ok(Buffer.byteLength(source) <= LIMITS.orderJsBytes);
  const data = new FixtureSource(demoFixture(60, { ordering: 'online' }));
  const gateway = new FixtureOrderGateway(data);
  const key = 'a'.repeat(32);
  const result = await gateway.submit(data.fx.store.slug, { attempt: 'budget', status_key: key, network: 'n', customer: { name: 'Jane', phone: '70123456', fulfilment: 'pickup' }, lines: [{ listing: data.fx.listings[0].listing_id, unit: 'base', qty: 10, price: 1.5 }], expected_total_usd: 15 });
  assert.equal(result.code, 'created');
  result.order.lines = Array.from({ length: 50 }, () => ({ ...result.order.lines[0] }));
  for (const lang of ['en', 'ar', 'fr']) {
    const r = await handle({ host: 'beirut-market.myomnipos.com', url: '/o/' + key + '?lang=' + lang }, { data, gateway, config: { ...config, orderGatewayKey: 'test' }, assetVersion: 'test' });
    assert.equal(r.status, 200);
    const bytes = Buffer.byteLength(body(r));
    assert.ok(bytes <= LIMITS.statusHtmlBytes, `${lang} status page is ${bytes} bytes`);
    console.log(`${lang} 50-line status HTML: ${bytes} bytes`);
  }
});

test("page weight: home with 48 cards ≤ 60 KB, stylesheet ≤ 24 KB, script ≤ 10 KB", async () => {
  const fs = await import("fs");
  const { LIMITS } = await import("../storefront/src/limits.js");
  const data = new FixtureSource(demoFixture(200));
  const r = await handle({ host: "beirut-market.myomnipos.com", url: "/" }, { config, data, assetVersion: "0123456789" });
  const html = body(r);
  assert.equal((html.match(/class="sf-card"/g) || []).length, 48);
  assert.ok(Buffer.byteLength(html) <= LIMITS.homeHtmlBytes, `home is ${Buffer.byteLength(html)} bytes`);
  assert.ok(fs.statSync("storefront/public/storefront.css").size <= LIMITS.cssBytes);
  assert.ok(fs.statSync("storefront/public/storefront.js").size <= LIMITS.jsBytes);
});

test("003 page weight: home with 48 cards and ordering on ≤ 60 KB; cart.js ≤ 16 KB; checkout.js ≤ 10 KB", async () => {
  const fs = await import("fs");
  const { LIMITS } = await import("../storefront/src/limits.js");
  const data = new FixtureSource(demoFixture(200, { ordering: true }));
  const r = await handle({ host: "beirut-market.myomnipos.com", url: "/" }, { config, data, assetVersion: "0123456789" });
  const html = body(r);
  assert.equal((html.match(/class="sf-card"/g) || []).length, 48);
  assert.ok(html.includes("/cart.js?v="), "ordering is on");
  assert.ok(Buffer.byteLength(html) <= LIMITS.homeHtmlBytes, `home is ${Buffer.byteLength(html)} bytes`);
  // Sizes as deployed (LF line endings), whatever the checkout's line endings are.
  const size = (f: string) => Buffer.byteLength(fs.readFileSync(`storefront/public/${f}`, "utf8").replace(/\r\n/g, "\n"));
  assert.ok(size("cart.js") <= LIMITS.cartJsBytes, `cart.js is ${size("cart.js")} bytes`);
  assert.ok(size("checkout.js") <= LIMITS.checkoutJsBytes, `checkout.js is ${size("checkout.js")} bytes`);
  assert.ok(size("storefront.css") <= LIMITS.cssBytes, `storefront.css is ${size("storefront.css")} bytes`);
});

test("003 cart route: same answer in host and path form; previews never cached; unknown store neutral", async () => {
  const data = new FixtureSource(demoFixture(60, { ordering: true }));
  data.fx.previewTokens.push("tok_123");
  const get = (host: string, url: string) => handle({ host, url }, { config, data, assetVersion: "test" });
  const hostForm = await get("beirut-market.myomnipos.com", "/cart");
  const pathForm = await get("myomnipos.com", "/s/beirut-market/cart");
  for (const r of [hostForm, pathForm]) {
    assert.equal(r.status, 200);
    assert.equal(r.headers["Cache-Control"], "public, s-maxage=240, stale-while-revalidate=60");
    assert.equal(r.headers["Set-Cookie"], undefined);
  }
  assert.match(body(pathForm), /href="\/s\/beirut-market\/cart" hidden>/, "path form links to its own cart");
  const preview = await get("beirut-market.myomnipos.com", "/cart?preview=tok_123");
  assert.equal(preview.headers["Cache-Control"], "private, no-store");
  assert.equal(preview.headers["X-Robots-Tag"], "noindex");
  const unknown = await get("nobody-here.myomnipos.com", "/cart");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers["Cache-Control"], "public, s-maxage=60");
  assert.equal((await get("beirut-market.myomnipos.com", "/cart/extra")).status, 404);
});

test("a burst on one page costs one data-source call per render, and the CDN header lets the edge absorb the rest", async () => {
  const { data, get } = make();
  const before = data.calls;
  const r = await get("beirut-market.myomnipos.com", "/");
  assert.equal(data.calls - before, 2, "home = store + listings");
  assert.match(r.headers["Cache-Control"], /s-maxage=240/);
});
