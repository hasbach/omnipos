// The storefront handler on plain Node http: production on Render (server.ts) and local runs (dev-server.ts).
// Serves the public/ assets itself, answers /healthz for the platform, and hands everything else to
// src/http.ts. The store is picked from the Host header only — X-Forwarded-Host is client-controlled and the
// edge cache keys on Host, so trusting it would let one request poison another store's cached page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorefrontConfig } from './config.js';
import type { DataSource } from './data.js';
import { CACHE_IMMUTABLE, handle } from './http.js';
import { ASSET_VERSION } from './assets.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ASSETS: Record<string, string> = {
  '/storefront.css': 'text/css; charset=utf-8',
  '/storefront.js': 'text/javascript; charset=utf-8',
  '/placeholder.svg': 'image/svg+xml',
  '/cart.js': 'text/javascript; charset=utf-8',
};

export interface NodeServerOptions {
  config: StorefrontConfig;
  data: DataSource;
  /** Cache-Control for public/ assets: immutable in production, no-cache locally so edits show up. */
  assetCache?: string;
}

export function createStorefrontServer({ config, data, assetCache = CACHE_IMMUTABLE }: NodeServerOptions): http.Server {
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
      const pathname = (req.url || '/').split('?')[0];
      if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('ok');
        return;
      }
      const type = ASSETS[pathname];
      if (type) {
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': assetCache, 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : readAsset(pathname));
        return;
      }
      const out = await handle({ host: String(req.headers.host || ''), url: req.url || '/' }, { config, data, assetVersion: ASSET_VERSION });
      res.writeHead(out.status, out.headers);
      res.end(req.method === 'HEAD' ? undefined : typeof out.body === 'string' ? out.body : Buffer.from(out.body));
    } catch (e) {
      console.error('storefront error', e);
      res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Internal error');
    }
  });
}
