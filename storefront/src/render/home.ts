// Store home (spec 002 US1): identity, search, categories, product grid, pager. Works without JavaScript:
// search is a GET form, categories and pages are plain links that keep each other's filters.
import { attr, html } from '../escape.js';
import type { ListingPage, PublicListing } from '../data.js';
import { formatLocal, formatUsd, stockLabel } from '../format.js';
import { PAGE_SIZE, type PageContext } from '../http.js';
import { t } from '../i18n.js';
import { imgUrl, type PageMeta } from './layout.js';
import { contactButtons } from '../contact.js';
import { summary } from '../seo.js';

export function productCard(ctx: PageContext, l: PublicListing): string {
  const local = formatLocal(ctx.store, l.price, l.price_lbp);
  const src = l.images[0] ? imgUrl(l.images[0]) : `/placeholder.svg?v=${ctx.assetVersion}`;
  return `<li><a class="sf-card" href="${attr(ctx.link(`/p/${l.listing_id}`))}">
<img src="${attr(src)}" alt="" loading="lazy" width="400" height="400">
<span class="sf-card-body">
<span class="sf-card-title">${html(l.title)}</span>
<span class="sf-price">${html(formatUsd(l.price))}</span>${local ? `\n<span class="sf-local">${html(local)}</span>` : ''}
<span class="sf-stock sf-stock-${l.stock_state}">${html(stockLabel(ctx.lang, l.stock_state, l.stock))}</span>
</span></a></li>`;
}

function searchForm(ctx: PageContext): string {
  const { category, search, lang, preview } = ctx.params;
  const hidden = [
    category ? `<input type="hidden" name="c" value="${attr(category)}">` : '',
    lang ? `<input type="hidden" name="lang" value="${attr(lang)}">` : '',
    ctx.store.is_preview && preview ? `<input type="hidden" name="preview" value="${attr(preview)}">` : '',
  ].join('');
  return `<form class="sf-search" role="search" method="get" action="${attr(ctx.base || '/')}">
<input type="search" name="q" value="${attr(search || '')}" placeholder="${attr(t(ctx.lang, 'search_placeholder'))}" aria-label="${attr(t(ctx.lang, 'search_placeholder'))}" maxlength="60">${hidden}
<button class="sf-button" type="submit">${html(t(ctx.lang, 'search'))}</button>
</form>`;
}

function categoryChips(ctx: PageContext): string {
  if (ctx.store.categories.length === 0) return '';
  const { category, search } = ctx.params;
  const chip = (label: string, value: string | null) => {
    const current = (category || null) === value;
    return `<a class="sf-chip" href="${attr(ctx.link('/', { c: value, q: search }))}"${current ? ' aria-current="page"' : ''}>${html(label)}</a>`;
  };
  return `<nav class="sf-categories" aria-label="${attr(t(ctx.lang, 'category'))}">
${chip(t(ctx.lang, 'all_products'), null)}
${ctx.store.categories.map((c) => chip(c.name, c.name)).join('\n')}
</nav>`;
}

function pager(ctx: PageContext, total: number): string {
  const pages = Math.ceil(total / PAGE_SIZE);
  const page = ctx.params.page;
  if (pages <= 1 || page > pages) return '';
  const { category, search } = ctx.params;
  const href = (p: number) => attr(ctx.link('/', { c: category, q: search, page: p > 1 ? p : null }));
  return `<nav class="sf-pager" aria-label="${attr(t(ctx.lang, 'page_of', { page, pages }))}">
${page > 1 ? `<a class="sf-button sf-button-secondary" href="${href(page - 1)}" rel="prev">${html(t(ctx.lang, 'previous'))}</a>` : ''}
<span>${html(t(ctx.lang, 'page_of', { page, pages }))}</span>
${page < pages ? `<a class="sf-button sf-button-secondary" href="${href(page + 1)}" rel="next">${html(t(ctx.lang, 'next'))}</a>` : ''}
</nav>`;
}

export function renderHome(ctx: PageContext, page: ListingPage): { meta: PageMeta; body: string } {
  const { store, lang } = ctx;
  const filtered = !!(ctx.params.category || ctx.params.search);
  const cover = store.cover_path ? `<img class="sf-cover" src="${attr(imgUrl(store.cover_path))}" alt="">` : '';
  const hero = `<section class="sf-hero">${cover}
<h1>${html(store.name)}</h1>
${store.description ? `<p>${html(store.description)}</p>` : ''}
${contactButtons(lang, store, { whatsapp: t(lang, 'wa_store', { store: store.name, url: ctx.canonicalHome }), subject: store.name })}
</section>`;

  let list: string;
  if (page.rows.length > 0) {
    list = `<p class="sf-count">${html(t(lang, 'products_count', { count: page.total }))}</p>
<ul class="sf-grid">
${page.rows.map((l) => productCard(ctx, l)).join('\n')}
</ul>
${pager(ctx, page.total)}`;
  } else if (page.total > 0) {
    // Past the last page.
    list = `<div class="sf-empty"><p><a href="${attr(ctx.link('/', { c: ctx.params.category, q: ctx.params.search }))}">${html(t(lang, 'back_to_first_page'))}</a></p></div>`;
  } else {
    list = `<div class="sf-empty"><p>${html(t(lang, filtered ? 'no_products_found' : 'no_products_yet'))}</p></div>`;
  }

  return {
    meta: {
      title: store.name,
      description: summary(store.description),
      image: store.cover_path || store.logo_path ? `${ctx.canonicalHome.replace(/\/$/, '')}${imgUrl((store.cover_path || store.logo_path)!)}` : null,
      canonical: ctx.canonicalHome,
    },
    body: `${hero}
${searchForm(ctx)}
${categoryChips(ctx)}
${list}`,
  };
}
