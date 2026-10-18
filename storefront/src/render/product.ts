// Product page (spec 002 US2): photo gallery (main first; scroll-snap, works without JS), title, category,
// retail price in USD and local currency, units it is sold in, indicative stock, description, contact buttons.
import { attr, html } from '../escape.js';
import type { PublicListing } from '../data.js';
import { formatLocal, formatUsd, stockLabel } from '../format.js';
import type { PageContext } from '../http.js';
import { t } from '../i18n.js';
import { contactButtons } from '../contact.js';
import { summary } from '../seo.js';
import { imgUrl, type PageMeta } from './layout.js';

function gallery(ctx: PageContext, l: PublicListing): string {
  const srcs = l.images.length ? l.images.map(imgUrl) : [`/placeholder.svg?v=${ctx.assetVersion}`];
  const imgs = srcs.map((src, i) =>
    `<img class="sf-gallery-img" src="${attr(src)}" alt="${attr(srcs.length > 1 ? t(ctx.lang, 'photo_of', { n: i + 1, count: srcs.length }) : l.title)}" width="800" height="800"${i ? ' loading="lazy"' : ''}>`);
  const dots = srcs.length > 1
    ? `<div class="sf-dots" aria-hidden="true">${srcs.map((_, i) => `<span class="sf-dot"${i === 0 ? ' data-active' : ''}></span>`).join('')}</div>`
    : '';
  const empty = l.images.length ? '' : ' sf-gallery-empty';
  return `<div class="sf-gallery-wrap${empty}"><div class="sf-gallery" tabindex="0">${imgs.join('')}</div>${dots}</div>`;
}

function priceLine(ctx: PageContext, usd: number, local: number | null): string {
  const l = formatLocal(ctx.store, usd, local);
  return `<span class="sf-price">${html(formatUsd(usd))}</span>${l ? ` <span class="sf-local">${html(l)}</span>` : ''}`;
}

function units(ctx: PageContext, l: PublicListing): string {
  if (!l.units.length) return '';
  const row = (name: string, contents: string | null, usd: number, local: number | null) =>
    `<li><span class="sf-unit-name">${html(name)}${contents ? ` <span class="sf-unit-contents">(${html(contents)})</span>` : ''}</span><span>${priceLine(ctx, usd, local)}</span></li>`;
  return `<section class="sf-units"><h2>${html(t(ctx.lang, 'sold_as'))}</h2><ul>
${row(l.unit, null, l.price, l.price_lbp)}
${l.units.map((u) => row(u.name, t(ctx.lang, 'unit_contains', { count: u.factor, unit: l.unit }), u.price, u.price_lbp)).join('\n')}
</ul></section>`;
}

export function renderProduct(ctx: PageContext, l: PublicListing): { meta: PageMeta; body: string } {
  const { lang, store } = ctx;
  const canonical = `${ctx.canonicalHome}p/${l.listing_id}`;
  const shareUrl = ctx.params.lang ? `${canonical}?lang=${ctx.params.lang}` : canonical;
  const local = formatLocal(store, l.price, l.price_lbp);
  const priceText = local ? `${formatUsd(l.price)} · ${local}` : formatUsd(l.price);
  const category = l.category
    ? `<a class="sf-chip" href="${attr(ctx.link('/', { c: l.category }))}">${html(l.category)}</a>`
    : '';
  const body = `<p class="sf-back"><a href="${attr(ctx.link('/'))}">${html(t(lang, 'back_to_store'))}</a></p>
<article class="sf-product">
${gallery(ctx, l)}
<div class="sf-product-info">
<h1>${html(l.title)}</h1>
${category}
<p class="sf-product-price">${priceLine(ctx, l.price, l.price_lbp)}</p>
<p class="sf-stock sf-stock-${l.stock_state}">${html(stockLabel(lang, l.stock_state, l.stock))}</p>
<p class="sf-note">${html(t(lang, 'availability_note'))}</p>
${units(ctx, l)}
${l.description ? `<p class="sf-description">${html(l.description)}</p>` : ''}
${contactButtons(lang, store, { whatsapp: t(lang, 'wa_product', { product: l.title, url: shareUrl }), subject: l.title })}
</div>
</article>`;
  const descr = summary(l.description, 120);
  return {
    meta: {
      title: `${l.title} — ${store.name}`,
      description: descr ? `${priceText} — ${descr}` : priceText,
      image: l.images[0] ? `${ctx.canonicalHome.replace(/\/$/, '')}${imgUrl(l.images[0])}` : null,
      canonical,
    },
    body,
  };
}
