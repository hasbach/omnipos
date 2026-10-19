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
import { canOrder, isMeasuredUnit, orderableUnits } from '../ordering.js';

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

/** 003: unit picker + quantity + "Add to cart". Hidden until cart.js runs (no JS = no ordering). The data
 *  attributes are listing-level, so the page stays the same for every visitor. */
export function orderForm(ctx: PageContext, l: PublicListing): string {
  const units = orderableUnits(l);
  const dec = isMeasuredUnit(l.unit);
  const options = units.map((u) => {
    const label = u.key === 'base' ? u.name : `${u.name} (${t(ctx.lang, 'unit_contains', { count: u.factor, unit: l.unit })})`;
    return `<option value="${attr(u.key)}" data-unit="${attr(u.key)}" data-name="${attr(u.name)}" data-factor="${u.factor}" data-price="${u.price}" data-price-lbp="${u.price_lbp ?? ''}">${html(label)}</option>`;
  }).join('');
  const onlyBase = units.length === 1 && units[0].key === 'base';
  const min = l.min_quantity && l.min_quantity > 0 ? l.min_quantity : null;
  const start = onlyBase && min ? min : 1;
  const step = dec && units[0]?.key === 'base' ? '0.001' : '1';
  return `<form class="sf-order" data-id="${attr(l.listing_id)}" data-title="${attr(l.title)}" data-img="${attr(l.images[0] || '')}" data-min="${min ?? ''}" data-base="${attr(l.unit)}" data-dec="${dec ? 1 : 0}" hidden>
<label class="sf-field"><span>${html(t(ctx.lang, 'unit'))}</span><select name="unit"${units.length === 1 ? ' disabled' : ''}>${options}</select></label>
<label class="sf-field"><span>${html(t(ctx.lang, 'quantity'))}</span><input name="qty" type="number" inputmode="${dec ? 'decimal' : 'numeric'}" min="${step}" max="999" step="${step}" value="${start}"></label>
<button class="sf-button" type="submit">${html(t(ctx.lang, 'add_to_cart'))}</button>
${min ? `<p class="sf-note">${html(t(ctx.lang, 'minimum_note', { min, unit: l.unit }))}</p>` : ''}
<p class="sf-order-status" role="status"></p>
</form>`;
}

export function renderProduct(ctx: PageContext, l: PublicListing, ordering = false): { meta: PageMeta; body: string } {
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
${ordering && canOrder(l) ? orderForm(ctx, l) : ''}
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
