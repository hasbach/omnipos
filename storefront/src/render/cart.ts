// Cart page (spec 003 US1; checkout form added by US2). The server renders a per-store shell that is the same
// for every visitor (cacheable, noindex); public/cart.js fills the lines and totals from the visitor's browser.
import { attr, html } from '../escape.js';
import type { PageContext } from '../http.js';
import { t } from '../i18n.js';
import { contactButtons } from '../contact.js';
import type { PageMeta } from './layout.js';

export function renderCart(ctx: PageContext): { meta: PageMeta; body: string } {
  const { lang, store } = ctx;
  const notes = [
    t(lang, 'prices_confirmed_note'),
    t(lang, 'pay_on_handover_note'),
    ...(store.delivery_enabled ? [t(lang, 'delivery_charge_note')] : []),
  ];
  const body = `<p class="sf-back"><a href="${attr(ctx.link('/'))}">${html(t(lang, 'continue_shopping'))}</a></p>
<section class="sf-cart">
<h1>${html(t(lang, 'cart'))}</h1>
<p id="sf-cart-storage-note" class="sf-note" hidden>${html(t(lang, 'storage_unavailable'))}</p>
<div id="sf-cart-empty" class="sf-empty" hidden><p>${html(t(lang, 'cart_empty'))}</p>
<p><a class="sf-button" href="${attr(ctx.link('/'))}">${html(t(lang, 'continue_shopping'))}</a></p></div>
<div id="sf-cart-full" hidden>
<ul id="sf-cart-lines" class="sf-cart-lines"></ul>
<div id="sf-cart-issues" class="sf-cart-issues" role="alert"></div>
<p id="sf-cart-total" class="sf-cart-total"></p>
<ul class="sf-cart-notes">${notes.map((n) => `<li>${html(n)}</li>`).join('')}</ul>
</div>
<noscript><p class="sf-empty">${html(t(lang, 'needs_javascript'))}</p>
${contactButtons(lang, store, { whatsapp: t(lang, 'wa_store', { store: store.name, url: ctx.canonicalHome }), subject: store.name })}</noscript>
</section>`;
  return { meta: { title: `${t(lang, 'cart')} — ${store.name}`, description: null, image: null, canonical: `${ctx.canonicalHome}cart` }, body };
}
