// Product photos in the POS catalog (Settings -> pos_show_images).
//
// A product's photo is the first photo of its online-store listing. The photo FILES are never part
// of sync (only the listing's small `images` path list is): the first time a register shows a
// product it downloads that one photo from the public store-images bucket and keeps a copy next to
// the database, so afterwards the POS shows it from disk — offline too — and sync stays light.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db, dbDir } from './db.js';
import { imageBase } from './commerce.js';

const CACHE_DIR = path.join(dbDir, 'product-images');
const MAX_BYTES = 3 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15000;

const keyOf = (storagePath: string) => crypto.createHash('sha1').update(storagePath).digest('hex').slice(0, 16);

/** productId -> storage path of its first listing photo (a published listing wins over a draft). */
export function productImagePaths(tenantId: number): Map<number, string> {
  const out = new Map<number, string>();
  let rows: any[] = [];
  try {
    rows = db.prepare(
      "SELECT product_id, images FROM store_listings WHERE tenant_id = ? AND deleted_at IS NULL AND images IS NOT NULL AND images NOT IN ('', '[]') ORDER BY published DESC, id"
    ).all(tenantId) as any[];
  } catch {
    return out; // no online-store tables on this database
  }
  for (const r of rows) {
    if (out.has(r.product_id)) continue;
    try {
      const first = JSON.parse(r.images)?.[0];
      if (typeof first === 'string' && first && !first.split('/').includes('..')) out.set(r.product_id, first);
    } catch { /* malformed list: no photo */ }
  }
  return out;
}

/** Adds `image_url` (a local, cache-busting URL) to every product that has a photo. */
export function attachProductImages<T extends { id: number }>(tenantId: number, products: T[]): T[] {
  const paths = productImagePaths(tenantId);
  if (paths.size === 0) return products;
  return products.map((p) => {
    const sp = paths.get(p.id);
    return sp ? { ...p, image_url: `/api/pos/product-image/${p.id}?v=${keyOf(sp)}` } : p;
  });
}

type Fetcher = (url: string, signal: AbortSignal) => Promise<{ ok: boolean; bytes: Uint8Array }>;
const httpFetch: Fetcher = async (url, signal) => {
  const res = await fetch(url, { signal });
  if (!res.ok) return { ok: false, bytes: new Uint8Array() };
  return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
};
let fetcher: Fetcher = httpFetch;
/** Test hook: replace the downloader (null = the real one). */
export function __setProductImageFetcher(f: Fetcher | null) { fetcher = f || httpFetch; }
/** Test hook: where the copies are kept. */
export const productImageCacheDir = CACHE_DIR;

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Absolute path of the local copy of a product's photo, downloading it once when missing.
 * null = the product has no photo, or it could not be downloaded (offline and never cached).
 */
export function getProductImageFile(tenantId: number, productId: number): Promise<string | null> {
  const storagePath = productImagePaths(tenantId).get(productId);
  if (!storagePath) return Promise.resolve(null);
  const dir = path.join(CACHE_DIR, String(tenantId));
  const file = path.join(dir, `${productId}-${keyOf(storagePath)}.webp`);
  if (fs.existsSync(file)) return Promise.resolve(file);

  const running = inFlight.get(file);
  if (running) return running;
  const job = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const url = imageBase() + storagePath.split('/').map(encodeURIComponent).join('/');
      const res = await fetcher(url, ctrl.signal);
      if (!res.ok || res.bytes.length < 16 || res.bytes.length > MAX_BYTES) return null;
      fs.mkdirSync(dir, { recursive: true });
      // The photo changed (new storage path): drop this product's older copies.
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${productId}-`)) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* in use */ } }
      }
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, res.bytes);
      fs.renameSync(tmp, file);
      return file;
    } catch {
      return null; // offline / timeout: the tile simply shows no photo for now
    } finally {
      clearTimeout(timer);
      inFlight.delete(file);
    }
  })();
  inFlight.set(file, job);
  return job;
}
