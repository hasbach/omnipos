// The HTML document around every storefront page: language/direction, meta tags, stylesheet, header, footer.
import { attr, html } from '../escape.js';
import { isRtl, t } from '../i18n.js';
import type { Lang } from '../router.js';
import type { PublicStore } from '../data.js';

export interface PageMeta {
  title: string;
  description?: string | null;
  /** Absolute image URL for link previews. */
  image?: string | null;
  canonical?: string | null;
}

export interface LayoutInput {
  lang: Lang;
  meta: PageMeta;
  body: string;
  store?: PublicStore | null;
  /** Link to the store home (header). */
  homeHref?: string;
  assetVersion: string;
  websiteUrl: string;
  noindex?: boolean;
}

export const imgUrl = (path: string) => `/img/${path.split('/').map(encodeURIComponent).join('/')}`;

function header(store: PublicStore | null | undefined, homeHref: string): string {
  if (!store) return '';
  const logo = store.logo_path
    ? `<img class="sf-logo" src="${attr(imgUrl(store.logo_path))}" alt="" width="40" height="40">`
    : `<span class="sf-logo sf-logo-initial" aria-hidden="true">${html(store.name.trim().charAt(0).toUpperCase() || '·')}</span>`;
  return `<header class="sf-header"><a class="sf-brand" href="${attr(homeHref)}">${logo}<span class="sf-name">${html(store.name)}</span></a></header>`;
}

export function layout(i: LayoutInput): string {
  const { lang, meta } = i;
  const color = i.store?.primary_color && /^#[0-9a-f]{6}$/i.test(i.store.primary_color) ? i.store.primary_color : null;
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${attr(meta.title)}">`,
    meta.description ? `<meta property="og:description" content="${attr(meta.description)}">` : '',
    meta.description ? `<meta name="description" content="${attr(meta.description)}">` : '',
    meta.image ? `<meta property="og:image" content="${attr(meta.image)}">` : '',
    meta.canonical ? `<meta property="og:url" content="${attr(meta.canonical)}"><link rel="canonical" href="${attr(meta.canonical)}">` : '',
  ].filter(Boolean).join('\n');
  const preview = i.store?.is_preview ? `<div class="sf-preview" role="status">${html(t(lang, 'preview_banner'))}</div>` : '';
  return `<!doctype html>
<html lang="${lang}" dir="${isRtl(lang) ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(meta.title)}</title>
${og}
${i.noindex ? '<meta name="robots" content="noindex">' : ''}
${color ? `<meta name="theme-color" content="${attr(color)}">` : ''}
<link rel="stylesheet" href="/storefront.css?v=${attr(i.assetVersion)}">
${color ? `<style>:root{--sf-accent:${color}}</style>` : ''}
</head>
<body>
${preview}
${header(i.store, i.homeHref || '/')}
<main class="sf-main">
${i.body}
</main>
<footer class="sf-footer"><a href="${attr(i.websiteUrl)}" rel="noopener">${html(t(lang, 'powered_by'))}</a></footer>
<script src="/storefront.js?v=${attr(i.assetVersion)}" defer></script>
</body>
</html>`;
}
