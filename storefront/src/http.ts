// The storefront request handler, independent of the hosting platform (src/node-server.ts serves it on Node http
// for Render and dev-server.ts; tests call it directly). Caching rules: contracts/storefront-routes.md.
import type { StorefrontConfig } from './config.js';
import { type DataSource, type PublicStore, type OrderGateway, SupabaseOrderGateway, UpstreamError, normalizeStore } from './data.js';
import { url } from './escape.js';
import { fetchImage } from './img.js';
import { LANGS, type Lang, type PageParams, route, storeBase } from './router.js';
import { layout, type PageMeta } from './render/layout.js';
import { statusBody, renderStatusPage } from './render/status.js';
import { renderHome } from './render/home.js';
import { renderProduct } from './render/product.js';
import { renderCart } from './render/cart.js';
import { t } from './i18n.js';
import { onlineOrdering, orderingEnabled, orderJsonScript, orderPayload } from './ordering.js';

export interface StoreRequest { host: string; url: string; method?: string; body?: string; headers?: Record<string, string | string[] | undefined>; network?: string }
export interface StoreResponse { status: number; headers: Record<string, string>; body: string | Uint8Array }

export interface Deps {
  config: StorefrontConfig;
  data: DataSource;
  gateway?: OrderGateway;
  /** Changes when storefront.css / .js change (cache-busting query). */
  assetVersion: string;
  fetchImpl?: typeof fetch;
}

export const CACHE_PAGE = 'public, s-maxage=240, stale-while-revalidate=60';
export const CACHE_SHORT = 'public, s-maxage=60';
export const CACHE_PREVIEW = 'private, no-store';
export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const PAGE_SIZE = 48;

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };

function htmlResponse(status: number, body: string, cache: string, extra: Record<string, string> = {}): StoreResponse {
  return { status, body, headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache, ...extra } };
}

/** Everything a page renderer needs to build links and text. */
export interface PageContext {
  lang: Lang;
  store: PublicStore;
  address: string;
  form: 'host' | 'path';
  params: PageParams;
  base: string;
  /** Absolute URL of the store home in its canonical (host) form. */
  canonicalHome: string;
  assetVersion: string;
  websiteUrl: string;
  /** Link inside the store, keeping the visitor's language override and an active preview token. */
  link(path: string, extra?: Record<string, string | number | null | undefined>): string;
}

export function resolveLang(params: PageParams, store: PublicStore | null): Lang {
  if (params.lang) return params.lang;
  const d = store?.default_language;
  return LANGS.includes(d as Lang) ? (d as Lang) : 'en';
}

export async function handle(req: StoreRequest, deps: Deps): Promise<StoreResponse> {
  const { config } = deps;
  const r = route(req.host, req.url, config.storefrontDomain);

  // Online orders (003 Slice 2): POST + private routes, never cached (contracts/storefront-routes-s2.md).
  const orderResponse = await handleOrderRoute(r, req, deps);
  if (orderResponse) return orderResponse;
  // handleOrderRoute answers every order kind; this only narrows the type for the page routes below.
  if (r.kind === 'orderQuote' || r.kind === 'orderSubmit' || r.kind === 'orderStatus' || r.kind === 'orderCancel') {
    return orderJson(404, { ok: false, code: 'not_found' });
  }
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) return orderJson(405, { ok: false, code: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
  if (r.kind === 'img') {
    const img = await fetchImage(r.path, config.supabaseUrl, deps.fetchImpl);
    return {
      status: img.status, body: img.body,
      headers: { ...BASE_HEADERS, 'Content-Type': img.contentType, 'Cache-Control': img.status === 200 ? CACHE_IMMUTABLE : CACHE_SHORT },
    };
  }
  if (r.kind === 'apexRoot') {
    return { status: 302, body: '', headers: { ...BASE_HEADERS, Location: config.websiteUrl, 'Cache-Control': 'public, s-maxage=3600' } };
  }
  if (r.kind === 'reservedRedirect') {
    return { status: 301, body: '', headers: { ...BASE_HEADERS, Location: `https://${config.storefrontDomain}/`, 'Cache-Control': 'public, s-maxage=3600' } };
  }

  const shell = (lang: Lang, meta: PageMeta, body: string, store: PublicStore | null = null, homeHref = '/', noindex = false,
    langLinks?: { lang: Lang; href: string }[], order?: { cartHref: string; json: string; checkout?: boolean; online?: boolean }) =>
    layout({ lang, meta, body, store, homeHref, assetVersion: deps.assetVersion, websiteUrl: config.websiteUrl, noindex, langLinks, order });

  if (r.kind === 'notFound') {
    const lang = r.params.lang || 'en';
    return htmlResponse(404, shell(lang, { title: t(lang, 'page_not_found_title') }, statusBody(lang, 'page_not_found')), CACHE_SHORT);
  }

  const preview = r.params.preview;
  const cache = preview ? CACHE_PREVIEW : CACHE_PAGE;
  const extra: Record<string, string> = preview ? { 'X-Robots-Tag': 'noindex' } : {};
  try {
    const store = await deps.data.getStore(r.address, preview);
    if (!store) {
      const lang = r.params.lang || 'en';
      const body = statusBody(lang, 'store_unavailable', { href: config.websiteUrl, label: t(lang, 'omnipos_link') });
      return htmlResponse(404, shell(lang, { title: t(lang, 'store_unavailable_title') }, body, null, '/', true), preview ? CACHE_PREVIEW : CACHE_SHORT, extra);
    }
    const lang = resolveLang(r.params, store);
    const base = storeBase(r);
    const keep = { lang: r.params.lang, preview: store.is_preview ? preview : null };
    const ctx: PageContext = {
      lang, store, address: r.address, form: r.form, params: r.params, base,
      canonicalHome: `https://${r.address}.${config.storefrontDomain}/`,
      assetVersion: deps.assetVersion, websiteUrl: config.websiteUrl,
      link: (path, more = {}) => url(`${base}${path}` || '/', { ...keep, ...more }),
    };
    const homeHref = ctx.link('/');
    // The same page in each language (explicit ?lang= so the choice sticks), keeping filters and a preview token.
    const keepPreview = store.is_preview ? preview : null;
    const langLinks = LANGS.map((l) => ({
      lang: l,
      href: r.kind === 'home'
        ? url(`${base}/`, { c: r.params.category, q: r.params.search, page: r.params.page > 1 ? r.params.page : null, preview: keepPreview, lang: l })
        : r.kind === 'cart'
          ? url(`${base}/cart`, { preview: keepPreview, lang: l })
          : url(`${base}/p/${r.listingId}`, { preview: keepPreview, lang: l }),
    }));
    // 003: store-level ordering data (same for every visitor); the cart itself stays in the browser.
    const ordering = orderingEnabled(store, config.orderGatewayKey);
    const order = ordering
      ? {
          cartHref: ctx.link('/cart'),
          json: orderJsonScript(orderPayload({ store, lang, address: r.address, canonicalHome: ctx.canonicalHome, link: ctx.link, assetVersion: deps.assetVersion, gatewayKey: config.orderGatewayKey })),
        }
      : undefined;

    if (r.kind === 'cart') {
      if (!ordering) {
        return { status: 302, body: '', headers: { ...BASE_HEADERS, Location: homeHref, 'Cache-Control': preview ? CACHE_PREVIEW : CACHE_SHORT } };
      }
      const out = renderCart(ctx, onlineOrdering(store, config.orderGatewayKey));
      return htmlResponse(200, shell(lang, out.meta, out.body, store, homeHref, true, langLinks, { ...order!, checkout: true, online: onlineOrdering(store, config.orderGatewayKey) }), cache, extra);
    }

    if (r.kind === 'home') {
      const page = await deps.data.listListings(r.address, {
        category: r.params.category, search: r.params.search, limit: PAGE_SIZE, offset: (r.params.page - 1) * PAGE_SIZE,
      }, preview);
      const out = renderHome(ctx, page, ordering);
      return htmlResponse(200, shell(lang, out.meta, out.body, store, homeHref, store.is_preview, langLinks, order), cache, extra);
    }

    const listing = await deps.data.getListing(r.address, r.listingId, preview);
    if (!listing) {
      const body = statusBody(lang, 'product_unavailable', { href: homeHref, label: t(lang, 'visit_store') });
      return htmlResponse(404, shell(lang, { title: t(lang, 'product_unavailable_title') }, body, store, homeHref, true), preview ? CACHE_PREVIEW : CACHE_SHORT, extra);
    }
    const out = renderProduct(ctx, listing, ordering);
    return htmlResponse(200, shell(lang, out.meta, out.body, store, homeHref, store.is_preview, langLinks, order), cache, extra);
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    const lang = r.params.lang || 'en';
    return htmlResponse(503, shell(lang, { title: t(lang, 'temporarily_unavailable_title') }, statusBody(lang, 'temporarily_unavailable')), 'no-store', { 'Retry-After': '30' });
  }
}

// ---- online orders ------------------------------------------------------------------------------------

const ORDER_HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const PRIVATE_PAGE_HEADERS = { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };
const MAX_BODY_BYTES = 16 * 1024;

function orderJson(status: number, value: unknown, extra: Record<string, string> = {}): StoreResponse {
  return { status, body: JSON.stringify(value), headers: { ...BASE_HEADERS, ...ORDER_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra } };
}

function header(req: StoreRequest, name: string): string | undefined {
  const v = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(v) ? v[0] : v;
}

/** The order routes, or null for every other route. */
async function handleOrderRoute(r: ReturnType<typeof route>, req: StoreRequest, deps: Deps): Promise<StoreResponse | null> {
  const { config } = deps;
  const method = req.method || 'GET';
  const search = new URL(req.url, 'http://x').searchParams;
  // A private link with a malformed key is a plain 404: it never reaches the gateway.
  if (r.kind === 'notFound' && /\/o(?:\/|$)/.test(new URL(req.url, 'http://x').pathname)) {
    const lang = r.params.lang || 'en';
    const page = layout({ lang, meta: { title: t(lang, 'page_not_found_title') }, body: statusBody(lang, 'page_not_found'), assetVersion: deps.assetVersion, websiteUrl: config.websiteUrl, noindex: true });
    return htmlResponse(404, page, CACHE_PREVIEW, PRIVATE_PAGE_HEADERS);
  }
  if (r.kind !== 'orderQuote' && r.kind !== 'orderSubmit' && r.kind !== 'orderStatus' && r.kind !== 'orderCancel') return null;

  const allow = r.kind === 'orderStatus' ? ['GET', 'HEAD'] : ['POST'];
  if (!allow.includes(method)) return orderJson(405, { ok: false, code: 'method_not_allowed' }, { Allow: allow.join(', ') });
  if (method === 'POST' && Buffer.byteLength(req.body || '') > MAX_BODY_BYTES) return orderJson(413, { ok: false, code: 'too_large' });
  // An owner preview never creates or changes orders.
  if (search.has('preview')) return orderJson(400, { ok: false, code: 'refused' });
  if (!config.orderGatewayKey) return orderJson(200, { ok: false, code: 'store_unavailable' });
  const gateway = deps.gateway || new SupabaseOrderGateway(config.supabaseUrl, config.supabaseAnonKey, config.orderGatewayKey, deps.fetchImpl);
  const base = storeBase(r);

  try {
    if (r.kind === 'orderQuote' || r.kind === 'orderSubmit') {
      if ((header(req, 'content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return orderJson(415, { ok: false, code: 'bad_request' });
      }
      let payload: any;
      try { payload = JSON.parse(req.body || ''); } catch { payload = null; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return orderJson(400, { ok: false, code: 'bad_request' });
      // New orders only while the store is public and in online mode.
      const store = await deps.data.getStore(r.address);
      if (!store || !onlineOrdering(store, config.orderGatewayKey)) return orderJson(200, { ok: false, code: 'store_unavailable' });
      if (r.kind === 'orderQuote') return orderJson(200, await gateway.quote(r.address, payload.lines));
      const result = await gateway.submit(r.address, { ...payload, network: req.network || '' });
      const sent = result.code === 'created' || result.code === 'existing';
      // The status link keeps the shopper's language (the page otherwise falls back to the store's).
      const statusUrl = url(base + '/o/' + payload.status_key, { lang: r.params.lang });
      return orderJson(200, sent ? { ...result, status_url: statusUrl } : result);
    }

    // Status and cancel keep working when the store is later paused or stops taking orders (spec edge case:
    // open orders can still be followed and cancelled), so they don't depend on the store gate.
    if (r.kind === 'orderCancel') {
      const confirmed = new URLSearchParams(req.body || '').get('confirm') === '1';
      const result = confirmed ? await gateway.cancel(r.key) : { ok: false, code: 'not_cancellable' };
      // Back to the page in the visitor's language.
      const flag = result.code === 'cancelled' ? { cancelled: 1 } : { not_cancellable: 1 };
      const location = url(base + '/o/' + r.key, { lang: r.params.lang, ...flag });
      return { status: 303, body: '', headers: { ...BASE_HEADERS, ...ORDER_HEADERS, Location: location } };
    }

    const result = await gateway.status(r.key);
    const order = result.ok ? result.order : null;
    // The link belongs to one store: opened under another address it is treated as unknown.
    const lang0 = resolveLang(r.params, null);
    if (!order || String(order.store?.slug || '').toLowerCase() !== r.address.toLowerCase()) {
      const page = layout({ lang: lang0, meta: { title: t(lang0, 'page_not_found_title') }, body: statusBody(lang0, 'page_not_found'), assetVersion: deps.assetVersion, websiteUrl: config.websiteUrl, noindex: true });
      return htmlResponse(404, page, CACHE_PREVIEW, PRIVATE_PAGE_HEADERS);
    }
    const store = (await deps.data.getStore(r.address).catch(() => null)) || normalizeStore({ ...order.store, mode: 'retail' });
    const lang = resolveLang(r.params, store);
    const ctx: PageContext = {
      lang, store, address: r.address, form: r.form, params: r.params, base,
      canonicalHome: 'https://' + r.address + '.' + config.storefrontDomain + '/',
      assetVersion: deps.assetVersion, websiteUrl: config.websiteUrl,
      link: (path, extra = {}) => url(base + path, { lang: r.params.lang, ...extra }),
    };
    const flags = { key: r.key, cancelled: search.has('cancelled'), not_cancellable: search.has('not_cancellable') };
    return htmlResponse(200, renderStatusPage(ctx, order, flags), CACHE_PREVIEW, PRIVATE_PAGE_HEADERS);
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    if (r.kind === 'orderStatus' || r.kind === 'orderCancel') {
      // Pages, not API calls: the same "temporarily unavailable" page as the store pages.
      const lang = r.params.lang || 'en';
      const page = layout({ lang, meta: { title: t(lang, 'temporarily_unavailable_title') }, body: statusBody(lang, 'temporarily_unavailable'), assetVersion: deps.assetVersion, websiteUrl: config.websiteUrl, noindex: true });
      return htmlResponse(503, page, 'no-store', { ...PRIVATE_PAGE_HEADERS, 'Retry-After': '30' });
    }
    return orderJson(503, { ok: false, code: 'unavailable' }, { 'Retry-After': '30' });
  }
}