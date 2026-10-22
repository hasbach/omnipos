// Cart page (spec 003 US1) with the WhatsApp checkout (US2). The server renders a per-store shell that is the same
// for every visitor (cacheable, noindex); public/cart.js fills the lines and totals from the visitor's browser.
import { attr, html } from '../escape.js';
import type { PageContext } from '../http.js';
import { t } from '../i18n.js';
import { contactButtons } from '../contact.js';
import { formatUsd } from '../format.js';
import type { PageMeta } from './layout.js';

const error = (name: string) => `<p class="sf-error" data-for="${name}" hidden></p>`;

/** Checkout form (US2): name, phone, pickup / delivery, address, note, remember. Read only by checkout.js,
 *  which turns it into a WhatsApp message; nothing is submitted to OmniPOS. */
function checkoutForm(ctx: PageContext, online: boolean): string {
  const { lang, store } = ctx;
  const methods = [
    ...(store.pickup_enabled ? [{ value: 'pickup', label: t(lang, 'pickup'), note: store.pickup_note }] : []),
    ...(store.delivery_enabled ? [{ value: 'delivery', label: t(lang, 'delivery'), note: store.delivery_note }] : []),
  ];
  const only = methods.length === 1 ? methods[0].value : null;
  const choices = methods.map((m) => `<label class="sf-choice"><input type="radio" name="fulfilment" value="${m.value}"${only ? ' checked' : ''}>
<span>${html(m.label)}${m.note ? `<small>${html(m.note)}</small>` : ''}</span></label>`).join('\n');
  return `<form id="sf-checkout" class="sf-checkout" novalidate>
<h2>${html(t(lang, 'checkout'))}</h2>
<label class="sf-field"><span>${html(t(lang, 'your_name'))}</span><input name="name" maxlength="80" autocomplete="name" required></label>
${error('name')}
<label class="sf-field"><span>${html(t(lang, online ? 'phone_required' : 'your_phone'))}${online ? '' : ` <small>(${html(t(lang, 'optional'))})</small>`}</span><input name="phone" type="tel" maxlength="30" autocomplete="tel" inputmode="tel"${online ? ' required' : ''}></label>
${error('phone')}${online ? '<div class="sf-trap" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>' : ''}
<fieldset class="sf-choices"><legend>${html(t(lang, 'fulfilment'))}</legend>
${choices}
</fieldset>
${error('fulfilment')}
<label class="sf-field" id="sf-address-field"${only === 'delivery' ? '' : ' hidden'}><span>${html(t(lang, 'delivery_address'))}</span><textarea name="address" maxlength="300" rows="2" autocomplete="street-address"></textarea></label>
${error('address')}
<label class="sf-field"><span>${html(t(lang, 'note'))} <small>(${html(t(lang, 'optional'))})</small></span><textarea name="note" maxlength="300" rows="2"></textarea><small class="sf-counter" data-counter="note">0/300</small></label>
${online ? error('note') : ''}<label class="sf-check"><input type="checkbox" name="remember"> <span>${html(t(lang, 'remember_details'))}</span></label>
${store.min_order_usd ? `<p class="sf-note">${html(t(lang, 'minimum_order', { price: formatUsd(store.min_order_usd) }))}</p>` : ''}
<p id="sf-checkout-block" class="sf-cart-warn" role="alert" hidden></p>
<button class="sf-button sf-wa sf-submit" type="submit">${html(t(lang, online ? 'review_order' : 'order_on_whatsapp'))}</button>
<p id="sf-wa-fallback" class="sf-note" hidden><a target="_blank" rel="noopener">${html(t(lang, 'open_whatsapp'))}</a></p>
</form>`;
}

/** "Did you send it?" — shown when the visitor comes back from WhatsApp (US2 AS5). */
function sentDialog(ctx: PageContext): string {
  const { lang } = ctx;
  return `<div id="sf-sent" class="sf-dialog" role="dialog" aria-labelledby="sf-sent-q" hidden>
<p id="sf-sent-q">${html(t(lang, 'sent_question'))}</p>
<div class="sf-dialog-actions"><button class="sf-button" type="button" data-sent="yes">${html(t(lang, 'sent_yes'))}</button>
<button class="sf-button sf-button-secondary" type="button" data-sent="no">${html(t(lang, 'sent_no'))}</button></div>
</div>`;
}

export function renderCart(ctx: PageContext, online = false): { meta: PageMeta; body: string } {
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
${online ? '<div id="sf-quote" aria-live="polite"></div>\n' : ''}${checkoutForm(ctx, online)}
</div>
${sentDialog(ctx)}${online ? `<div id="sf-confirm" class="sf-confirm" aria-live="polite" hidden></div><section id="sf-myorders"></section>
${contactButtons(lang, store, { whatsapp: t(lang, 'wa_store', { store: store.name, url: ctx.canonicalHome }), subject: store.name })}` : ''}
<noscript><p class="sf-empty">${html(t(lang, 'needs_javascript'))}</p>
${contactButtons(lang, store, { whatsapp: t(lang, 'wa_store', { store: store.name, url: ctx.canonicalHome }), subject: store.name })}</noscript>
</section>`;
  return { meta: { title: `${t(lang, 'cart')} — ${store.name}`, description: null, image: null, canonical: `${ctx.canonicalHome}cart` }, body };
}
