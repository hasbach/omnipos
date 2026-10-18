// Product page — minimal version (title, price, stock); the full page (gallery, units, contact, link previews)
// is built with User Story 2 (tasks T018–T021).
import { html } from '../escape.js';
import type { PublicListing } from '../data.js';
import { formatLocal, formatUsd, stockLabel } from '../format.js';
import type { PageContext } from '../http.js';
import type { PageMeta } from './layout.js';

export function renderProduct(ctx: PageContext, l: PublicListing): { meta: PageMeta; body: string } {
  const local = formatLocal(ctx.store, l.price, l.price_lbp);
  return {
    meta: { title: `${l.title} — ${ctx.store.name}` },
    body: `<article class="sf-product">
<h1>${html(l.title)}</h1>
<p class="sf-price">${html(formatUsd(l.price))}${local ? ` <span class="sf-local">${html(local)}</span>` : ''}</p>
<p class="sf-stock sf-stock-${l.stock_state}">${html(stockLabel(ctx.lang, l.stock_state, l.stock))}</p>
</article>`,
  };
}
