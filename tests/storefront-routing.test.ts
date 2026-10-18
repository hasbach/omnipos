// Storefront routing and response headers (contracts/storefront-routes.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, CACHE_PAGE, CACHE_SHORT, CACHE_PREVIEW } from "../storefront/src/http.js";
import { route } from "../storefront/src/router.js";
import { FixtureSource, demoFixture } from "../storefront/src/fixture.js";
import { loadConfig } from "../storefront/src/config.js";

const config = loadConfig({ STOREFRONT_DOMAIN: "omnipos.shop", OMNIPOS_WEBSITE_URL: "https://omnipos.example" });
const make = () => {
  const fx = demoFixture(10);
  const data = new FixtureSource(fx);
  return { fx, data, get: (host: string, url: string) => handle({ host, url }, { config, data, assetVersion: "test" }) };
};
const body = (r: { body: string | Uint8Array }) => (typeof r.body === "string" ? r.body : "");

test("host form and path form show the same store; links stay in their own form", async () => {
  const { get } = make();
  const host = await get("beirut-market.omnipos.shop", "/");
  const path = await get("omnipos.shop", "/s/beirut-market");
  assert.equal(host.status, 200);
  assert.equal(path.status, 200);
  assert.match(body(host), /href="\/p\/00000000-0000-4000-8000-000000000001"/);
  assert.match(body(path), /href="\/s\/beirut-market\/p\/00000000-0000-4000-8000-000000000001"/);
  // Any other host (localhost, preview deployments) works like the apex.
  assert.equal((await get("localhost:3200", "/s/beirut-market")).status, 200);
});

test("addresses are matched case-insensitively", async () => {
  const { get } = make();
  assert.equal((await get("Beirut-Market.OMNIPOS.shop", "/")).status, 200);
  assert.equal((await get("omnipos.shop", "/s/BEIRUT-MARKET")).status, 200);
});

test("route(): product pages, unknown paths, invalid addresses, nested subdomains", () => {
  const d = "omnipos.shop";
  assert.equal(route("a-shop.omnipos.shop", "/p/00000000-0000-4000-8000-000000000001/cola-can", d).kind, "product");
  assert.equal(route("a-shop.omnipos.shop", "/p/not-a-uuid", d).kind, "notFound");
  assert.equal(route("a-shop.omnipos.shop", "/admin", d).kind, "notFound");
  assert.equal(route("x.y.omnipos.shop", "/", d).kind, "notFound");
  assert.equal(route("omnipos.shop", "/s/bad_address!", d).kind, "notFound");
  assert.equal(route("omnipos.shop", "/img/a/b.webp", d).kind, "img");
  const r = route("a-shop.omnipos.shop", "/?c=Dairy&q=%20milk%20&page=0&lang=de&preview=ok_token-1", d) as any;
  assert.deepEqual(r.params, { category: "Dairy", search: "milk", page: 1, lang: null, preview: "ok_token-1" });
});

test("apex root redirects to the OmniPOS website; reserved subdomains to the apex", async () => {
  const { get } = make();
  const apex = await get("omnipos.shop", "/");
  assert.equal(apex.status, 302);
  assert.equal(apex.headers.Location, "https://omnipos.example");
  for (const sub of ["www", "api", "mail", "admin"]) {
    const r = await get(`${sub}.omnipos.shop`, "/");
    assert.equal(r.status, 301, sub);
    assert.equal(r.headers.Location, "https://omnipos.shop/");
  }
});

test("unknown and non-public stores get the same neutral page, cached briefly", async () => {
  const { fx, get } = make();
  const unknown = await get("nope.omnipos.shop", "/");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers["Cache-Control"], CACHE_SHORT);
  fx.store.status = "paused";
  const paused = await get("beirut-market.omnipos.shop", "/");
  assert.equal(paused.status, 404);
  assert.equal(body(paused), body(unknown), "paused looks exactly like unknown");
  fx.store.status = "active";
  fx.store.mode = "wholesale";
  assert.equal(body(await get("beirut-market.omnipos.shop", "/")), body(unknown), "wholesale looks exactly like unknown");
});

test("cache headers per route kind; no cookies; security headers", async () => {
  const { fx, get } = make();
  const home = await get("beirut-market.omnipos.shop", "/");
  assert.equal(home.headers["Cache-Control"], CACHE_PAGE);
  assert.equal(home.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(home.headers["X-Content-Type-Options"], "nosniff");
  assert.ok(home.headers["Referrer-Policy"]);
  const product = await get("beirut-market.omnipos.shop", "/p/00000000-0000-4000-8000-000000000001");
  assert.equal(product.headers["Cache-Control"], CACHE_PAGE);
  const gone = await get("beirut-market.omnipos.shop", "/p/00000000-0000-4000-8000-000000000999");
  assert.equal(gone.status, 404);
  assert.equal(gone.headers["Cache-Control"], CACHE_SHORT);
  const notFound = await get("beirut-market.omnipos.shop", "/nothing-here");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers["Cache-Control"], CACHE_SHORT);
  const badImg = await get("omnipos.shop", "/img/../../etc/passwd");
  assert.equal(badImg.status, 404);

  fx.previewTokens.push("tok_1");
  fx.store.status = "draft";
  const preview = await get("beirut-market.omnipos.shop", "/?preview=tok_1");
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
  const r = await handle({ host: "beirut-market.omnipos.shop", url: "/" }, { config, data: failing as any, assetVersion: "t" });
  assert.equal(r.status, 503);
  assert.equal(r.headers["Cache-Control"], "no-store");
});
