// Storefront on Node http (Render production server and dev server): assets, health check, Host-only routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createStorefrontServer } from "../storefront/src/node-server.js";
import { CACHE_IMMUTABLE, CACHE_PAGE } from "../storefront/src/http.js";
import { FixtureSource, demoFixture } from "../storefront/src/fixture.js";
import { loadConfig } from "../storefront/src/config.js";

const config = loadConfig({ STOREFRONT_DOMAIN: "myomnipos.com", OMNIPOS_WEBSITE_URL: "https://omnipos.example" });

async function withServer(fn: (get: (path: string, host: string, extra?: Record<string, string>) => Promise<Response>) => Promise<void>) {
  const server = createStorefrontServer({ config, data: new FixtureSource(demoFixture(10)) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // fetch() won't let us set Host, so go through node:http.
  const http = await import("node:http");
  const get = (path: string, host: string, extra: Record<string, string> = {}) =>
    new Promise<Response>((resolve, reject) => {
      http.get({ port, path, host: "127.0.0.1", headers: { Host: host, ...extra } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(new Response(res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 304 ? null : Buffer.concat(chunks), {
          status: res.statusCode, headers: Object.entries(res.headers).map(([k, v]) => [k, String(v)]) as [string, string][],
        })));
      }).on("error", reject);
    });
  try { await fn(get); } finally { server.close(); }
}

test("node server: health check, immutable assets, store pages from the Host header", async () => {
  await withServer(async (get) => {
    const health = await get("/healthz", "omnipos-storefront.onrender.com");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("cache-control"), "no-store");

    const css = await get("/storefront.css?v=abc", "beirut-market.myomnipos.com");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    assert.equal(css.headers.get("cache-control"), CACHE_IMMUTABLE);
    assert.ok((await css.text()).length > 100);

    const order = await get('/order.js?v=abc', 'beirut-market.myomnipos.com');
    assert.equal(order.status, 200);
    assert.match(order.headers.get('content-type') || '', /javascript/);
    assert.equal(order.headers.get('cache-control'), CACHE_IMMUTABLE);
    assert.match(await order.text(), /window.OmniOrder/);

    const home = await get("/", "beirut-market.myomnipos.com");
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("cache-control"), CACHE_PAGE);
    assert.equal(home.headers.get("set-cookie"), null, "cookies would stop the edge from caching");
    assert.match(await home.text(), /Beirut Market/);
  });
});

test("node server: X-Forwarded-Host is ignored (the edge caches by Host)", async () => {
  await withServer(async (get) => {
    const spoofed = await get("/", "never-claimed.myomnipos.com", { "X-Forwarded-Host": "beirut-market.myomnipos.com" });
    assert.equal(spoofed.status, 404);
    assert.doesNotMatch(await spoofed.text(), /Beirut Market/);
  });
});

test('node server: POST body, cap, methods and Host isolation', async () => {
  const { FixtureOrderGateway } = await import('../storefront/src/fixture.js');
  const data = new FixtureSource(demoFixture(10, { ordering: 'online' }));
  const gateway = new FixtureOrderGateway(data);
  const server = createStorefrontServer({ config: { ...config, orderGatewayKey: 'fixture' }, data, gateway });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const http = await import('node:http');
  const post = (body: string, host = 'beirut-market.myomnipos.com', method = 'POST') => new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/order/quote', method, headers: { Host: host, 'Content-Type': 'application/json', 'X-Forwarded-Host': 'beirut-market.myomnipos.com' } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }); req.on('error', reject); req.end(body);
  });
  try {
    assert.equal(JSON.parse((await post('{"lines":[]}')).body).code, 'ok');
    const large = await post('x'.repeat(16385)); assert.equal(large.status,413); assert.equal(large.headers['cache-control'],'no-store');
    assert.equal(JSON.parse((await post('{}','unknown.myomnipos.com')).body).code,'store_unavailable');
    const bad = await post('',undefined,'PUT'); assert.equal(bad.status,405); assert.ok(bad.headers.allow);
  } finally { server.close(); }
});
