// The storefront request handler, independent of the hosting platform (src/node-server.ts serves it on Node http
// for Render and dev-server.ts; tests call it directly). Caching rules: contracts/storefront-routes.md.
import type { StorefrontConfig } from './config.js';
import { type DataSource, type PublicStore, UpstreamError } from './data.js';
import { url } from './escape.js';
import { fetchImage } from './img.js';
import { LANGS, type Lang, type PageParams, route, storeBase } from './router.js';
import { layout, type PageMeta } from './render/layout.js';
import { statusBody } from './render/status.js';
import { renderHome } from './render/home.js';
import { renderProduct } from './render/product.js';
import { t } from './i18n.js';

export interface StoreRequest { host: string; url: string }
export interface StoreResponse { status: number; headers: Record<string, string>; body: string | Uint8Array }

export interface Deps {
  config: StorefrontConfig;
  data: DataSource;
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
    langLinks?: { lang: Lang; href: string }[]) =>
    layout({ lang, meta, body, store, homeHref, assetVersion: deps.assetVersion, websiteUrl: config.websiteUrl, noindex, langLinks });

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
        : url(`${base}/p/${r.listingId}`, { preview: keepPreview, lang: l }),
    }));

    if (r.kind === 'home') {
      const page = await deps.data.listListings(r.address, {
        category: r.params.category, search: r.params.search, limit: PAGE_SIZE, offset: (r.params.page - 1) * PAGE_SIZE,
      }, preview);
      const out = renderHome(ctx, page);
      return htmlResponse(200, shell(lang, out.meta, out.body, store, homeHref, store.is_preview, langLinks), cache, extra);
    }

    const listing = await deps.data.getListing(r.address, r.listingId, preview);
    if (!listing) {
      const body = statusBody(lang, 'product_unavailable', { href: homeHref, label: t(lang, 'visit_store') });
      return htmlResponse(404, shell(lang, { title: t(lang, 'product_unavailable_title') }, body, store, homeHref, true), preview ? CACHE_PREVIEW : CACHE_SHORT, extra);
    }
    const out = renderProduct(ctx, listing);
    return htmlResponse(200, shell(lang, out.meta, out.body, store, homeHref, store.is_preview, langLinks), cache, extra);
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    const lang = r.params.lang || 'en';
    return htmlResponse(503, shell(lang, { title: t(lang, 'temporarily_unavailable_title') }, statusBody(lang, 'temporarily_unavailable')), 'no-store', { 'Retry-After': '30' });
  }
}
