// Commerce layer — specs/001-commerce-domain-foundation/plan.md (Slice A: store & listings).
//
// Model
//  - Commerce is opt-in per tenant: settings key `commerce_enabled` ('1' = on; absent or '0' = off).
//    While off, nothing here changes how the shop works and the cloud public catalog returns nothing.
//  - A store (`stores`) and its listings (`store_listings`) are authored locally and synced like
//    products. A listing REFERENCES a product and never copies its price, stock or units.
//  - Public (anonymous) reads go through cloud functions with an explicit field allow-list
//    (supabase/migrations/2026-10-18_commerce_store_foundation.sql), never through raw tables.
import { db, logAction } from './db.js';
import { ValidationError, validationErrorBody } from './errors.js';
import { tierUnitPrice, uomUnitPrice } from './pricing.js';
import { RESERVED_SLUGS } from '../storefront/src/reserved.js';

// ---- commerce flag -------------------------------------------------------------------------------

export function isCommerceEnabled(tenantId: number): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'commerce_enabled'").get(tenantId) as any;
  return row?.value === '1';
}

/** Turns commerce on/off. Off keeps every store and listing; it only stops them being public. */
export function setCommerceEnabled(tenantId: number, userId: number | null, enabled: boolean): boolean {
  const before = isCommerceEnabled(tenantId);
  if (before !== enabled) {
    // Upsert (not INSERT OR REPLACE) so the row keeps its global_id and syncs as an update.
    db.prepare(
      "INSERT INTO settings (tenant_id, key, value) VALUES (?, 'commerce_enabled', ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value"
    ).run(tenantId, enabled ? '1' : '0');
    logAction(tenantId, userId, 'commerce_toggle', JSON.stringify({ entity: 'tenant', before: { enabled: before }, after: { enabled } }));
  }
  return enabled;
}

/** Same rule as the cloud public functions: a lifetime online license, or one that hasn't expired. */
export function isOnlineLicenseValid(tenantId: number): boolean {
  const t = db.prepare("SELECT online_license_type, online_license_expiry FROM tenants WHERE id = ?").get(tenantId) as any;
  if (!t) return false;
  if (t.online_license_type === 'lifetime') return true;
  if (!t.online_license_expiry) return false;
  const expiry = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(String(t.online_license_expiry)) ? String(t.online_license_expiry) : String(t.online_license_expiry).replace(' ', 'T') + 'Z');
  return Number.isFinite(expiry) && expiry > Date.now();
}

/** The tenant's first live store, as a small summary (the UI manages one store in Slice A). */
export function storeSummary(tenantId: number) {
  return (db.prepare(
    "SELECT id, global_id, name, slug, mode, status FROM stores WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1"
  ).get(tenantId) as any) || null;
}

export function commerceStatus(tenantId: number) {
  return { enabled: isCommerceEnabled(tenantId), online_license_valid: isOnlineLicenseValid(tenantId), store: storeSummary(tenantId) };
}

// ---- shared validation helpers ---------------------------------------------------------------------

const fail = (message: string, code: string, field?: string, status = 400) => new ValidationError(message, status, { code, field });

function requireCommerceOn(tenantId: number) {
  if (!isCommerceEnabled(tenantId)) throw fail('Turn on the online store first.', 'COMMERCE_OFF', undefined, 409);
}

/** Optional text: undefined = not sent (keep), '' / null = clear, else trimmed and length-checked. */
function optText(body: any, key: string, max: number, code: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw fail(`${key} must be text.`, code, key);
  const s = v.trim();
  if (s.length > max) throw fail(`${key} must be at most ${max} characters.`, code, key);
  return s === '' ? null : s;
}

function audit(tenantId: number, userId: number | null, action: string, entity: string, id: number, before: any, after: any) {
  const changedBefore: any = {};
  const changedAfter: any = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) { changedBefore[k] = before?.[k] ?? null; changedAfter[k] = after?.[k] ?? null; }
  }
  logAction(tenantId, userId, action, JSON.stringify({ entity, id, before: changedBefore, after: changedAfter }));
}

// ---- stores --------------------------------------------------------------------------------------

export const STORE_MODES = ['retail', 'wholesale', 'hybrid'] as const;
export const STORE_LANGUAGES = ['en', 'ar', 'fr'] as const;
const STORE_SETTING_FLAGS = ['show_exact_stock', 'hide_out_of_stock', 'show_local_price'] as const;
const STORE_SETTING_DEFAULTS = { show_exact_stock: 0, hide_out_of_stock: 0, show_local_price: 1, category_order: [] as string[] };

// One list for the back office, the storefront router and the cloud claim_store_slug (spec 002 FR-004);
// it lives in the storefront folder because that folder is deployed on its own.
export { RESERVED_SLUGS } from '../storefront/src/reserved.js';

const STORE_COLS = 'id, global_id, tenant_id, name, slug, mode, status, description, logo_path, cover_path, primary_color, contact_phone, contact_whatsapp, contact_email, address, default_language, settings, created_at, updated_at';

function parseStoreSettings(raw: any) {
  let s: any = {};
  try { s = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { s = {}; }
  return { ...STORE_SETTING_DEFAULTS, ...s };
}

function storeView(row: any) {
  if (!row) return null;
  const { tenant_id, ...rest } = row;
  return { ...rest, settings: parseStoreSettings(row.settings), public_url: row.slug ? `/s/${row.slug}` : null };
}

function loadStore(tenantId: number, storeId: number): any {
  const row = db.prepare(`SELECT ${STORE_COLS} FROM stores WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`).get(storeId, tenantId);
  if (!row) throw fail('This store does not exist.', 'STORE_NOT_FOUND', undefined, 404);
  return row;
}

/** Validates the editable store fields present in `body` (slug and status have their own flows). */
function storeFields(body: any, existingSettings?: any) {
  const out: Record<string, any> = {};
  if ('name' in body || !existingSettings) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80) throw fail('The store name must be 1 to 80 characters.', 'STORE_NAME_INVALID', 'name');
    out.name = name;
  }
  if ('mode' in body) {
    if (!STORE_MODES.includes(body.mode)) throw fail('Choose retail, wholesale or hybrid.', 'STORE_MODE_INVALID', 'mode');
    out.mode = body.mode;
  }
  const texts: [string, number][] = [['description', 1000], ['contact_phone', 30], ['contact_whatsapp', 30], ['address', 300], ['logo_path', 300], ['cover_path', 300]];
  for (const [k, max] of texts) {
    const v = optText(body, k, max, 'STORE_FIELD_TOO_LONG');
    if (v !== undefined) out[k] = v;
  }
  const email = optText(body, 'contact_email', 120, 'STORE_EMAIL_INVALID');
  if (email !== undefined) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid email address.', 'STORE_EMAIL_INVALID', 'contact_email');
    out.contact_email = email;
  }
  const color = optText(body, 'primary_color', 7, 'STORE_COLOR_INVALID');
  if (color !== undefined) {
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw fail('Use a colour like #1a2b3c.', 'STORE_COLOR_INVALID', 'primary_color');
    out.primary_color = color ? color.toLowerCase() : null;
  }
  if ('default_language' in body) {
    if (!STORE_LANGUAGES.includes(body.default_language)) throw fail('Choose English, Arabic or French.', 'STORE_LANGUAGE_INVALID', 'default_language');
    out.default_language = body.default_language;
  }
  if ('settings' in body) {
    const incoming = body.settings;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw fail('Invalid store settings.', 'STORE_SETTINGS_INVALID', 'settings');
    const merged: any = { ...parseStoreSettings(existingSettings) };
    for (const [k, v] of Object.entries(incoming)) {
      if ((STORE_SETTING_FLAGS as readonly string[]).includes(k)) {
        if (![true, false, 0, 1].includes(v as any)) throw fail(`${k} must be on or off.`, 'STORE_SETTINGS_INVALID', `settings.${k}`);
        merged[k] = v ? 1 : 0;
      } else if (k === 'category_order') {
        if (!Array.isArray(v) || v.length > 200 || v.some((c) => typeof c !== 'string' || c.trim().length === 0 || c.length > 60)) {
          throw fail('category_order must be a list of category names.', 'STORE_SETTINGS_INVALID', 'settings.category_order');
        }
        merged[k] = (v as string[]).map((c) => c.trim());
      } else {
        throw fail(`Unknown store setting: ${k}.`, 'STORE_SETTINGS_INVALID', `settings.${k}`);
      }
    }
    out.settings = JSON.stringify(merged);
  }
  return out;
}

export function listStores(tenantId: number) {
  return (db.prepare(`SELECT ${STORE_COLS} FROM stores WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id`).all(tenantId) as any[]).map(storeView);
}

export function createStore(tenantId: number, userId: number | null, body: any) {
  requireCommerceOn(tenantId);
  const f = storeFields(body || {});
  if (!('settings' in f)) f.settings = JSON.stringify(STORE_SETTING_DEFAULTS);
  const cols = Object.keys(f);
  const info = db.prepare(`INSERT INTO stores (tenant_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(tenantId, ...cols.map((c) => f[c]));
  const row = loadStore(tenantId, Number(info.lastInsertRowid));
  audit(tenantId, userId, 'store_create', 'store', row.id, {}, storeView(row));
  return storeView(row);
}

export function updateStore(tenantId: number, userId: number | null, storeId: number, body: any) {
  requireCommerceOn(tenantId);
  const before = loadStore(tenantId, storeId);
  const f = storeFields(body || {}, before.settings);
  const cols = Object.keys(f);
  if (cols.length) {
    db.prepare(`UPDATE stores SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`).run(...cols.map((c) => f[c]), storeId, tenantId);
  }
  const after = loadStore(tenantId, storeId);
  if (cols.length) audit(tenantId, userId, 'store_update', 'store', storeId, storeView(before), storeView(after));
  return storeView(after);
}

const STATUS_TRANSITIONS: Record<string, string[]> = { draft: ['active'], active: ['paused'], paused: ['active'] };

export function setStoreStatus(tenantId: number, userId: number | null, storeId: number, status: any) {
  requireCommerceOn(tenantId);
  const store = loadStore(tenantId, storeId);
  if (status === store.status) return storeView(store);
  if (!['active', 'paused'].includes(status) || !(STATUS_TRANSITIONS[store.status] || []).includes(status)) {
    throw fail(`A ${store.status} store cannot become ${status}.`, 'STORE_BAD_TRANSITION', 'status');
  }
  if (status === 'active' && !store.slug) throw fail('Choose the store web address before opening the store.', 'STORE_NOT_READY', 'slug', 409);
  db.prepare('UPDATE stores SET status = ? WHERE id = ? AND tenant_id = ?').run(status, storeId, tenantId);
  audit(tenantId, userId, 'store_status_change', 'store', storeId, { status: store.status }, { status });
  return storeView(loadStore(tenantId, storeId));
}

export function deleteStore(tenantId: number, userId: number | null, storeId: number) {
  requireCommerceOn(tenantId);
  const store = loadStore(tenantId, storeId);
  db.transaction(() => {
    db.prepare('UPDATE store_listings SET deleted_at = CURRENT_TIMESTAMP WHERE store_id = ? AND tenant_id = ? AND deleted_at IS NULL').run(storeId, tenantId);
    db.prepare('UPDATE stores SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?').run(storeId, tenantId);
  })();
  audit(tenantId, userId, 'store_delete', 'store', storeId, { name: store.name, slug: store.slug }, { deleted: true });
}

// ---- store web address (slug): one global namespace, claimed in the cloud (research R3) -----------

export function normalizeSlug(raw: any): string {
  const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (slug.length < 3 || slug.length > 40 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw fail('Use 3 to 40 letters (a-z), digits or single hyphens, not at the start or end.', 'STORE_SLUG_INVALID', 'slug');
  }
  if (RESERVED_SLUGS.includes(slug)) throw fail('This web address is reserved. Choose another one.', 'STORE_SLUG_RESERVED', 'slug');
  return slug;
}

export type SlugClaimResult = { ok: boolean; code: string };
export type SlugClaimer = (tenantId: number, storeGlobalId: string, slug: string) => Promise<SlugClaimResult | null>;

// Default claimer: the tenant's live cloud session (null = offline / signed out / call failed).
const defaultClaimer: SlugClaimer = async (tenantId, storeGlobalId, slug) => {
  const { getActiveSession } = await import('./session.js');
  const s = getActiveSession();
  if (!s || s.localId !== tenantId) return null;
  try {
    const { data, error } = await s.client.rpc('claim_store_slug', { p_store: storeGlobalId, p_slug: slug });
    if (error) return null;
    const r = Array.isArray(data) ? data[0] : data;
    return r && typeof r.code === 'string' ? { ok: !!r.ok, code: r.code } : null;
  } catch {
    return null;
  }
};
let slugClaimer: SlugClaimer = defaultClaimer;
/** Test hook: replace the cloud call (pass nothing to restore the real one). */
export function __setSlugClaimer(fn?: SlugClaimer) { slugClaimer = fn || defaultClaimer; }

export async function claimSlug(tenantId: number, userId: number | null, storeId: number, rawSlug: any) {
  requireCommerceOn(tenantId);
  const store = loadStore(tenantId, storeId);
  const slug = normalizeSlug(rawSlug);
  if (store.slug === slug) return storeView(store);
  const result = await slugClaimer(tenantId, store.global_id, slug);
  if (!result) throw fail('Choosing the web address needs an internet connection. Everything else works offline.', 'STORE_SLUG_NEEDS_ONLINE', 'slug', 503);
  if (!result.ok) {
    if (result.code === 'taken') throw fail('This web address is already used by another store.', 'STORE_SLUG_TAKEN', 'slug', 409);
    if (result.code === 'reserved') throw fail('This web address is reserved. Choose another one.', 'STORE_SLUG_RESERVED', 'slug');
    if (result.code === 'invalid') throw fail('Use 3 to 40 letters (a-z), digits or single hyphens, not at the start or end.', 'STORE_SLUG_INVALID', 'slug');
    throw fail('The cloud refused this web address for this store.', 'STORE_SLUG_REFUSED', 'slug', 409);
  }
  // Re-read: the store may have changed while the cloud call was in flight.
  loadStore(tenantId, storeId);
  db.prepare('UPDATE stores SET slug = ? WHERE id = ? AND tenant_id = ?').run(slug, storeId, tenantId);
  audit(tenantId, userId, 'store_slug_change', 'store', storeId, { slug: store.slug }, { slug });
  return storeView(loadStore(tenantId, storeId));
}

// ---- listings ------------------------------------------------------------------------------------

const LISTING_COLS = 'l.id, l.global_id, l.store_id, l.product_id, l.published, l.title, l.description, l.images, l.store_category, l.sort_order, l.min_quantity, l.orderable_unit_ids, l.updated_at';
// Only what the back office needs from the product — never cost, cost_lbp or min_price.
const PRODUCT_COLS = 'p.id AS p_id, p.name AS p_name, p.barcode AS p_barcode, p.category AS p_category, p.price AS p_price, p.price_lbp AS p_price_lbp, p.stock AS p_stock, p.reorder_point AS p_reorder_point, p.track_inventory AS p_track_inventory, p.active AS p_active, p.unit AS p_unit';

const parseJsonArray = (v: any): any[] | null => {
  if (v === null || v === undefined || v === '') return null;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
};

export function stockState(p: { stock?: number | null; reorder_point?: number | null; track_inventory?: number | null }): 'in_stock' | 'low_stock' | 'out_of_stock' {
  if (p.track_inventory === 0) return 'in_stock';
  const stock = Number(p.stock || 0);
  if (stock <= 0) return 'out_of_stock';
  const rp = Number(p.reorder_point || 0);
  if (rp > 0 && stock <= rp) return 'low_stock';
  return 'in_stock';
}

function unitsFor(tenantId: number, productIds: number[]): Map<number, any[]> {
  const map = new Map<number, any[]>();
  if (!productIds.length) return map;
  const rows = db.prepare(
    `SELECT id, product_id, name, factor, price, price_lbp FROM product_units WHERE tenant_id = ? AND deleted_at IS NULL AND product_id IN (${productIds.map(() => '?').join(',')}) ORDER BY sort_order, factor, id`
  ).all(tenantId, ...productIds) as any[];
  for (const r of rows) (map.get(r.product_id) || map.set(r.product_id, []).get(r.product_id)!).push(r);
  return map;
}

/** One listing as the back office sees it: channel fields + values derived from the product NOW. */
function deriveListing(row: any, units: any[], store: any, enabled: boolean) {
  const product = row.p_id ? {
    id: row.p_id, name: row.p_name, barcode: row.p_barcode, category: row.p_category, price: row.p_price, price_lbp: row.p_price_lbp,
    stock: row.p_stock, reorder_point: row.p_reorder_point, track_inventory: row.p_track_inventory, active: row.p_active, unit: row.p_unit,
  } : null;
  const orderable = parseJsonArray(row.orderable_unit_ids);
  const published = row.published === 1;
  let reason: string | null = null;
  if (!published) reason = 'not_published';
  else if (!product) reason = 'product_deleted';
  else if (product.active === 0) reason = 'product_disabled';
  else if (store.status !== 'active' || store.deleted_at) reason = 'store_not_active';
  else if (!enabled) reason = 'commerce_off';

  const priceProduct = product ? { price: Number(product.price) || 0 } : null;
  return {
    id: row.id,
    global_id: row.global_id,
    store_id: row.store_id,
    product_id: row.product_id,
    published,
    title: row.title,
    description: row.description,
    images: parseJsonArray(row.images) || [],
    store_category: row.store_category,
    sort_order: row.sort_order ?? 0,
    min_quantity: row.min_quantity,
    orderable_unit_ids: orderable,
    display_title: row.title || product?.name || '',
    category: row.store_category || product?.category || null,
    visible: reason === null,
    unavailable_reason: reason,
    stock_state: product ? stockState(product) : 'out_of_stock',
    // Retail tier only in Slice A (public visitors), same rule as the cloud store_public_listings.
    price: priceProduct ? tierUnitPrice(priceProduct, 'retail') : null,
    price_lbp: product?.price_lbp ?? null,
    unit: product?.unit || 'pcs',
    units: priceProduct
      ? units
          .filter((u) => !orderable || orderable.includes(u.id))
          .map((u) => ({ id: u.id, name: u.name, factor: u.factor, price: uomUnitPrice(priceProduct, u, 'retail'), price_lbp: u.price_lbp ?? null }))
      : [],
    product: product ? { id: product.id, name: product.name, barcode: product.barcode, active: product.active, stock: product.stock } : null,
  };
}

function loadProductForListing(tenantId: number, productId: number) {
  const p = db.prepare('SELECT id FROM products WHERE id = ? AND tenant_id = ?').get(productId, tenantId);
  if (!p) throw fail('This product does not exist.', 'PRODUCT_NOT_FOUND', 'product_id', 404);
}

function listingRow(tenantId: number, where: string, ...params: any[]) {
  return db.prepare(
    `SELECT ${LISTING_COLS}, ${PRODUCT_COLS} FROM store_listings l LEFT JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
     WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND ${where}`
  ).get(tenantId, ...params) as any;
}

function viewOne(tenantId: number, row: any) {
  const store = loadStore(tenantId, row.store_id);
  return deriveListing(row, unitsFor(tenantId, row.p_id ? [row.p_id] : []).get(row.p_id) || [], store, isCommerceEnabled(tenantId));
}

/** Validates the listing channel fields present in `body`. */
function listingFields(tenantId: number, productId: number, body: any) {
  const out: Record<string, any> = {};
  if ('published' in body) {
    if (![true, false, 0, 1].includes(body.published)) throw fail('published must be on or off.', 'LISTING_FIELD_INVALID', 'published');
    out.published = body.published ? 1 : 0;
  }
  for (const [k, max] of [['title', 120], ['description', 4000], ['store_category', 60]] as [string, number][]) {
    const v = optText(body, k, max, 'LISTING_FIELD_TOO_LONG');
    if (v !== undefined) out[k] = v;
  }
  if ('images' in body) {
    const imgs = body.images ?? [];
    if (!Array.isArray(imgs) || imgs.length > 8 || imgs.some((p: any) => typeof p !== 'string' || !p.trim() || p.length > 300)) {
      throw fail('Up to 8 images are allowed.', 'LISTING_IMAGES_INVALID', 'images');
    }
    out.images = JSON.stringify(imgs.map((p: string) => p.trim()));
  }
  if ('sort_order' in body) {
    const n = Number(body.sort_order ?? 0);
    if (!Number.isInteger(n)) throw fail('Sort order must be a whole number.', 'LISTING_FIELD_INVALID', 'sort_order');
    out.sort_order = n;
  }
  if ('min_quantity' in body) {
    const v = body.min_quantity;
    if (v === null || v === '' || v === undefined) out.min_quantity = null;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw fail('The minimum quantity must be greater than zero.', 'LISTING_MIN_QTY_INVALID', 'min_quantity');
      out.min_quantity = n;
    }
  }
  if ('orderable_unit_ids' in body) {
    const ids = body.orderable_unit_ids;
    if (ids === null) out.orderable_unit_ids = null;
    else {
      if (!Array.isArray(ids) || ids.some((x: any) => !Number.isInteger(x))) throw fail('Choose units of this product.', 'LISTING_UNIT_INVALID', 'orderable_unit_ids');
      const own = new Set((db.prepare('SELECT id FROM product_units WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL').all(tenantId, productId) as any[]).map((r) => r.id));
      if (ids.some((x: number) => !own.has(x))) throw fail('Choose units of this product.', 'LISTING_UNIT_INVALID', 'orderable_unit_ids');
      out.orderable_unit_ids = JSON.stringify([...new Set(ids)]);
    }
  }
  return out;
}

export function upsertListing(tenantId: number, userId: number | null, storeId: number, productId: number, body: any) {
  requireCommerceOn(tenantId);
  loadStore(tenantId, storeId);
  loadProductForListing(tenantId, productId);
  const f = listingFields(tenantId, productId, body || {});
  const existing = listingRow(tenantId, 'l.store_id = ? AND l.product_id = ?', storeId, productId);
  let id: number;
  if (existing) {
    id = existing.id;
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE store_listings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`).run(...cols.map((c) => f[c]), id, tenantId);
  } else {
    const cols = Object.keys(f);
    const info = db.prepare(`INSERT INTO store_listings (tenant_id, store_id, product_id${cols.map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?${cols.map(() => ', ?').join('')})`)
      .run(tenantId, storeId, productId, ...cols.map((c) => f[c]));
    id = Number(info.lastInsertRowid);
  }
  const row = listingRow(tenantId, 'l.id = ?', id);
  const view = viewOne(tenantId, row);
  const wasPublished = existing ? existing.published === 1 : false;
  if (view.published !== wasPublished) {
    audit(tenantId, userId, view.published ? 'listing_publish' : 'listing_unpublish', 'listing', id, { published: wasPublished }, { published: view.published });
  }
  const { published: _p, ...otherChanges } = f;
  if (Object.keys(otherChanges).length) {
    const pick = (r: any) => (r ? Object.fromEntries(Object.keys(otherChanges).map((k) => [k, r[k]])) : {});
    audit(tenantId, userId, 'listing_update', 'listing', id, pick(existing), pick(row));
  }
  return view;
}

export function deleteListing(tenantId: number, userId: number | null, storeId: number, productId: number) {
  requireCommerceOn(tenantId);
  loadStore(tenantId, storeId);
  const existing = listingRow(tenantId, 'l.store_id = ? AND l.product_id = ?', storeId, productId);
  if (!existing) throw fail('This product is not listed in the store.', 'LISTING_NOT_FOUND', undefined, 404);
  db.prepare('UPDATE store_listings SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?').run(existing.id, tenantId);
  audit(tenantId, userId, 'listing_delete', 'listing', existing.id, { product_id: productId }, { deleted: true });
}

export const BULK_PUBLISH_MAX = 1000;

export function bulkPublish(tenantId: number, userId: number | null, storeId: number, body: any) {
  requireCommerceOn(tenantId);
  loadStore(tenantId, storeId);
  const ids = body?.product_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BULK_PUBLISH_MAX || ids.some((x: any) => !Number.isInteger(x))) {
    throw fail(`Choose 1 to ${BULK_PUBLISH_MAX} products.`, 'LISTING_BULK_INVALID', 'product_ids');
  }
  if (typeof body.published !== 'boolean') throw fail('published must be on or off.', 'LISTING_FIELD_INVALID', 'published');
  const unique = [...new Set(ids as number[])];
  const own = (db.prepare(`SELECT COUNT(*) c FROM products WHERE tenant_id = ? AND id IN (${unique.map(() => '?').join(',')})`).get(tenantId, ...unique) as any).c;
  if (own !== unique.length) throw fail('Some products do not belong to this business.', 'LISTING_TENANT_MISMATCH', 'product_ids');
  const published = body.published ? 1 : 0;
  let created = 0;
  let updated = 0;
  db.transaction(() => {
    const find = db.prepare('SELECT id, published FROM store_listings WHERE tenant_id = ? AND store_id = ? AND product_id = ? AND deleted_at IS NULL');
    const ins = db.prepare('INSERT INTO store_listings (tenant_id, store_id, product_id, published) VALUES (?, ?, ?, ?)');
    const upd = db.prepare('UPDATE store_listings SET published = ? WHERE id = ? AND tenant_id = ?');
    for (const pid of unique) {
      const row = find.get(tenantId, storeId, pid) as any;
      if (!row) { ins.run(tenantId, storeId, pid, published); created++; }
      else if (row.published !== published) { upd.run(published, row.id, tenantId); updated++; }
    }
  })();
  logAction(tenantId, userId, 'listing_bulk_publish', JSON.stringify({ entity: 'store', id: storeId, after: { published: !!published, products: unique.length, created, updated } }));
  return { created, updated };
}

export function listListings(tenantId: number, storeId: number, q: any = {}) {
  const store = loadStore(tenantId, storeId);
  const where: string[] = ['l.tenant_id = @t', 'l.store_id = @s', 'l.deleted_at IS NULL'];
  const params: any = { t: tenantId, s: storeId };
  if (q.published === '1' || q.published === 'true' || q.published === true) where.push('l.published = 1');
  if (q.published === '0' || q.published === 'false' || q.published === false) where.push('l.published = 0');
  if (typeof q.category === 'string' && q.category.trim()) { where.push('COALESCE(l.store_category, p.category) = @cat'); params.cat = q.category.trim(); }
  if (typeof q.search === 'string' && q.search.trim()) {
    where.push("(LOWER(COALESCE(l.title, p.name, '')) LIKE @q OR LOWER(IFNULL(p.barcode, '')) LIKE @q)");
    params.q = `%${q.search.trim().toLowerCase().slice(0, 60)}%`;
  }
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  const from = `FROM store_listings l LEFT JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT COUNT(*) c ${from}`).get(params) as any).c;
  const rows = db.prepare(`SELECT ${LISTING_COLS}, ${PRODUCT_COLS} ${from} ORDER BY l.sort_order, LOWER(COALESCE(l.title, p.name, '')), l.id LIMIT ${limit} OFFSET ${offset}`).all(params) as any[];
  const units = unitsFor(tenantId, rows.filter((r) => r.p_id).map((r) => r.p_id));
  const enabled = isCommerceEnabled(tenantId);
  return { rows: rows.map((r) => deriveListing(r, units.get(r.p_id) || [], store, enabled)), total };
}

/** Every live listing of one product, one per store (the product editor's "Online store" card). */
export function productListings(tenantId: number, productId: number) {
  loadProductForListing(tenantId, productId);
  const rows = db.prepare(
    `SELECT ${LISTING_COLS}, ${PRODUCT_COLS} FROM store_listings l
     JOIN stores s ON s.id = l.store_id AND s.tenant_id = l.tenant_id AND s.deleted_at IS NULL
     LEFT JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
     WHERE l.tenant_id = ? AND l.product_id = ? AND l.deleted_at IS NULL ORDER BY l.store_id`
  ).all(tenantId, productId) as any[];
  const units = unitsFor(tenantId, [productId]).get(productId) || [];
  const enabled = isCommerceEnabled(tenantId);
  return rows.map((r) => deriveListing(r, units, loadStore(tenantId, r.store_id), enabled));
}

// ---- routes (contracts/backoffice-api.md; permissions in server/permissions.ts ROUTE_RULES) ---------

export function setupCommerceRoutes(app: any, authenticate: any) {
  app.get('/api/commerce/status', authenticate, (req: any, res: any) => {
    res.json(commerceStatus(req.session.tenantId));
  });

  app.put('/api/commerce/status', authenticate, (req: any, res: any) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
      const err = new ValidationError('enabled must be true or false.', 400, { code: 'COMMERCE_ENABLED_INVALID', field: 'enabled' });
      return res.status(err.status).json(validationErrorBody(err));
    }
    setCommerceEnabled(req.session.tenantId, req.session.userId ?? null, enabled);
    res.json(commerceStatus(req.session.tenantId));
  });

  // Thin wrappers: tenant from the session, user for the audit log, ValidationError -> { error, code, field }.
  const handle = (fn: (tenantId: number, userId: number | null, req: any) => any) => async (req: any, res: any) => {
    try {
      res.json(await fn(req.session.tenantId, req.session.userId ?? null, req));
    } catch (e: any) {
      if (e instanceof ValidationError) return res.status(e.status).json(validationErrorBody(e));
      res.status(500).json({ error: e?.message || String(e) });
    }
  };
  const id = (v: any) => Number(v);

  app.get('/api/commerce/stores', authenticate, handle((t) => listStores(t)));
  app.post('/api/commerce/stores', authenticate, handle((t, u, req) => createStore(t, u, req.body)));
  app.put('/api/commerce/stores/:id', authenticate, handle((t, u, req) => updateStore(t, u, id(req.params.id), req.body)));
  app.post('/api/commerce/stores/:id/slug', authenticate, handle((t, u, req) => claimSlug(t, u, id(req.params.id), req.body?.slug)));
  app.post('/api/commerce/stores/:id/status', authenticate, handle((t, u, req) => setStoreStatus(t, u, id(req.params.id), req.body?.status)));
  app.delete('/api/commerce/stores/:id', authenticate, handle((t, u, req) => { deleteStore(t, u, id(req.params.id)); return { ok: true }; }));

  app.get('/api/commerce/stores/:id/listings', authenticate, handle((t, _u, req) => listListings(t, id(req.params.id), req.query)));
  app.post('/api/commerce/stores/:id/listings/bulk', authenticate, handle((t, u, req) => bulkPublish(t, u, id(req.params.id), req.body)));
  app.put('/api/commerce/stores/:id/listings/:productId', authenticate, handle((t, u, req) => upsertListing(t, u, id(req.params.id), id(req.params.productId), req.body)));
  app.delete('/api/commerce/stores/:id/listings/:productId', authenticate, handle((t, u, req) => { deleteListing(t, u, id(req.params.id), id(req.params.productId)); return { ok: true }; }));
  app.get('/api/commerce/products/:productId/listings', authenticate, handle((t, _u, req) => productListings(t, id(req.params.productId))));
}
