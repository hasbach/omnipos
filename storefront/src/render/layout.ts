// The HTML document around every storefront page: language/direction, meta tags, stylesheet, header, footer.
import { attr, html } from '../escape.js';
import { isRtl, LANG_NAMES, t } from '../i18n.js';
import type { Lang } from '../router.js';
import type { PublicStore } from '../data.js';
import { metaTags, type PageMeta } from '../seo.js';

export type { PageMeta };

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
  /** Same page in each language (store pages only). */
  langLinks?: { lang: Lang; href: string }[];
}

export const imgUrl = (path: string) => `/img/${path.split('/').map(encodeURIComponent).join('/')}`;

function header(store: PublicStore | null | undefined, homeHref: string): string {
  if (!store) return '';
  const logo = store.logo_path
    ? `<img class="sf-logo" src="${attr(imgUrl(store.logo_path))}" alt="" width="40" height="40">`
    : `<span class="sf-logo sf-logo-initial" aria-hidden="true">${html(store.name.trim().charAt(0).toUpperCase() || '·')}</span>`;
  return `<header class="sf-header"><a class="sf-brand" href="${attr(homeHref)}">${logo}<span class="sf-name">${html(store.name)}</span></a></header>`;
}

function languageSwitcher(current: Lang, links: { lang: Lang; href: string }[] | undefined): string {
  if (!links?.length) return '';
  return `<nav class="sf-langs" aria-label="${attr(t(current, 'language'))}">${links.map((l) =>
    `<a href="${attr(l.href)}" hreflang="${l.lang}" lang="${l.lang}" data-lang="${l.lang}"${l.lang === current ? ' aria-current="true"' : ''}>${html(LANG_NAMES[l.lang])}</a>`).join('')}</nav>`;
}

export function layout(i: LayoutInput): string {
  const { lang } = i;
  const color = i.store?.primary_color && /^#[0-9a-f]{6}$/i.test(i.store.primary_color) ? i.store.primary_color : null;
  const preview = i.store?.is_preview ? `<div class="sf-preview" role="status">${html(t(lang, 'preview_banner'))}</div>` : '';
  return `<!doctype html>
<html lang="${lang}" dir="${isRtl(lang) ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags(i.meta, lang)}
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
<footer class="sf-footer">${languageSwitcher(lang, i.langLinks)}<a href="${attr(i.websiteUrl)}" rel="noopener">${html(t(lang, 'powered_by'))}</a></footer>
<script src="/storefront.js?v=${attr(i.assetVersion)}" defer></script>
</body>
</html>`;
}
