// The storefront handler on plain Node http: production on Render (server.ts) and local runs (dev-server.ts).
// Serves the public/ assets itself, answers /healthz for the platform, and hands everything else to
// src/http.ts. The store is picked from the Host header only — X-Forwarded-Host is client-controlled and the
// edge cache keys on Host, so trusting it would let one request poison another store's cached page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorefrontConfig } from './config.js';
import type { DataSource, OrderGateway } from './data.js';
import { CACHE_IMMUTABLE, handle } from './http.js';
import { visitorNetwork } from './network.js';
import { ASSET_VERSION } from './assets.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSETS: Record<string, string> = {
  '/storefront.css': 'text/css; charset=utf-8',
  '/storefront.js': 'text/javascript; charset=utf-8',
  '/placeholder.svg': 'image/svg+xml',
  '/cart.js': 'text/javascript; charset=utf-8',
  '/order.js': 'text/javascript; charset=utf-8',
  '/checkout.js': 'text/javascript; charset=utf-8',
};

const MAX_BODY_BYTES = 16 * 1024;
let warned = false;

export interface NodeServerOptions {
  config: StorefrontConfig;
  data: DataSource;
  gateway?: OrderGateway;
  /** Cache-Control for public/ assets: immutable in production, no-cache locally so edits show up. */
  assetCache?: string;
}

export function createStorefrontServer({ config, data, gateway, assetCache = CACHE_IMMUTABLE }: NodeServerOptions): http.Server {
  // Without the key, stores in online mode render as ordering off (contracts/storefront-routes-s2.md).
  if (!config.orderGatewayKey && !warned) {
    console.warn('ORDER_GATEWAY_KEY missing: online ordering is off on this storefront');
    warned = true;
  }
  // Read once: the files only change with a deploy (and ASSET_VERSION with them).
  const assetCacheMap = new Map<string, Buffer>();
  const readAsset = (p: string) => {
    if (assetCache !== CACHE_IMMUTABLE) return fs.readFileSync(path.join(PUBLIC_DIR, p));
    let b = assetCacheMap.get(p);
    if (!b) assetCacheMap.set(p, (b = fs.readFileSync(path.join(PUBLIC_DIR, p))));
    return b;
  };

  return http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      if (!['GET', 'HEAD', 'POST'].includes(method)) {
        res.writeHead(405, { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.end();
        return;
      }
      // Only the order routes take a body (contracts/storefront-routes-s2.md): small JSON or a one-field form.
      let body = '';
      let network = '';
      if (method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > MAX_BODY_BYTES) {
            res.writeHead(413, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
            res.end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks).toString('utf8');
        network = visitorNetwork(req.headers, req.socket.remoteAddress, config.orderGatewayKey || '').hash;
      }
      const pathname = (req.url || '/').split('?')[0];
      if (method !== 'POST' && pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('ok');
        return;
      }
      const type = ASSETS[pathname];
      if (type && method !== 'POST') {
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': assetCache, 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : readAsset(pathname));
        return;
      }
      const out = await handle(
        { host: String(req.headers.host || ''), url: req.url || '/', method, body, headers: req.headers, network },
        { config, data, gateway, assetVersion: ASSET_VERSION },
      );
      res.writeHead(out.status, out.headers);
      res.end(req.method === 'HEAD' ? undefined : typeof out.body === 'string' ? out.body : Buffer.from(out.body));
    } catch (e) {
      console.error('storefront error', e);
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Internal error');
    }
  });
}
