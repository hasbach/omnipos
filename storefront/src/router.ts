// Turns a request (Host header + path + query) into what to show — contracts/storefront-routes.md.
//   <address>.<domain>/            store home (host form)
//   <address>.<domain>/p/<id>      product page
//   <domain>/s/<address>[/p/<id>]  same pages, path form
//   any host /img/<path>           proxied photo
// Hosts other than the storefront domain (localhost, preview deployments) behave like the apex.
import { RESERVED_SUBDOMAINS } from './config.js';

export type Lang = 'en' | 'ar' | 'fr';
export const LANGS: readonly Lang[] = ['en', 'ar', 'fr'];

export interface PageParams {
  category: string | null;
  search: string | null;
  page: number;
  lang: Lang | null;
  preview: string | null;
}

export type Route =
  | { kind: 'home'; address: string; form: 'host' | 'path'; params: PageParams }
  | { kind: 'product'; address: string; form: 'host' | 'path'; listingId: string; params: PageParams }
  | { kind: 'img'; path: string }
  | { kind: 'apexRoot' }
  | { kind: 'reservedRedirect' }
  | { kind: 'notFound'; params: PageParams };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function clip(v: string | null, max: number): string | null {
  if (v === null) return null;
  const s = v.trim().slice(0, max);
  return s === '' ? null : s;
}

export function parseParams(q: URLSearchParams): PageParams {
  const page = parseInt(q.get('page') || '1', 10);
  const lang = q.get('lang');
  const preview = q.get('preview');
  return {
    category: clip(q.get('c'), 60),
    search: clip(q.get('q'), 60),
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 10000) : 1,
    lang: LANGS.includes(lang as Lang) ? (lang as Lang) : null,
    preview: preview && preview.length <= 64 && /^[A-Za-z0-9_-]+$/.test(preview) ? preview : null,
  };
}

/** Store pages below the store root: '' (home) or 'p/<uuid>[/<slug>]'. */
function storeRoute(address: string, rest: string[], form: 'host' | 'path', params: PageParams): Route {
  if (!ADDRESS.test(address) || address.length > 40) return { kind: 'notFound', params };
  const parts = rest.filter(Boolean);
  if (parts.length === 0) return { kind: 'home', address, form, params };
  if (parts[0] === 'p' && parts[1] && UUID.test(parts[1]) && parts.length <= 3) {
    return { kind: 'product', address, form, listingId: parts[1].toLowerCase(), params };
  }
  return { kind: 'notFound', params };
}

export function route(hostHeader: string, pathAndQuery: string, storefrontDomain: string): Route {
  const host = (hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  const u = new URL(pathAndQuery || '/', 'http://x');
  const params = parseParams(u.searchParams);
  let segments: string[];
  try {
    segments = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return { kind: 'notFound', params };
  }

  if (segments[0] === 'img') return { kind: 'img', path: segments.slice(1).join('/') };

  const domain = storefrontDomain.toLowerCase();
  if (host.endsWith(`.${domain}`)) {
    const sub = host.slice(0, -(domain.length + 1));
    if (sub.includes('.')) return { kind: 'notFound', params };
    if (RESERVED_SUBDOMAINS.includes(sub)) return { kind: 'reservedRedirect' };
    return storeRoute(sub, segments, 'host', params);
  }

  // Apex (or any other host): path form only.
  if (segments.length === 0) return { kind: 'apexRoot' };
  if (segments[0] === 's' && segments[1]) return storeRoute(segments[1].toLowerCase(), segments.slice(2), 'path', params);
  return { kind: 'notFound', params };
}

/** Root of a store's pages for links: '' in host form, '/s/<address>' in path form. */
export function storeBase(r: { address: string; form: 'host' | 'path' }): string {
  return r.form === 'host' ? '' : `/s/${r.address}`;
}
