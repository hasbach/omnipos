// Neutral status pages. "Store unavailable" is deliberately the same for an unknown address and for a store
// that is paused / draft / wholesale / off / unlicensed: the public catalog never reveals which (spec FR-016).
import { attr, html } from '../escape.js';
import { t } from '../i18n.js';
import type { Lang } from '../router.js';
import type { PageContext } from '../http.js';
import { normalizeStore } from '../data.js';
import { contactButtons } from '../contact.js';
import { formatLocalAmount, formatUsd } from '../format.js';
import { ORDER_UI_KEYS } from '../ordering.js';
import { layout } from './layout.js';

export type StatusKind = 'store_unavailable' | 'page_not_found' | 'product_unavailable' | 'temporarily_unavailable';

export function statusBody(lang: Lang, kind: StatusKind, link?: { href: string; label: string }): string {
  return `<section class="sf-status">
<h1>${html(t(lang, `${kind}_title`))}</h1>
<p>${html(t(lang, `${kind}_text`))}</p>
${link ? `<p><a class="sf-button" href="${attr(link.href)}">${html(link.label)}</a></p>` : ''}
</section>`;
}

/** The catalog may already be paused or changed; use the public order snapshot. */
export function renderStatusPage(ctx: PageContext, order: any, flags: Record<string, unknown>): string {
  const { lang } = ctx;
  const store = normalizeStore({ ...order.store, mode: 'retail' });
  const state = String(order.state);
  const stateKey = state === 'cancelled' ? 'cancelled_' + (order.cancelled_by === 'customer' ? 'customer' : 'shop') : state;
  const accepted = order.confirmed_total_usd != null;
  // The shop's symbol ("LL") like the cart shows, when the live store still has the order's currency.
  const currency = ctx.store.local_currency_code === order.local_currency && ctx.store.local_currency_symbol
    ? ctx.store.local_currency_symbol : String(order.local_currency || '');
  // <bdi>: amounts stay intact inside Arabic text ("$10.50", not "10.50$").
  const money = (usd: unknown, local: unknown) => `<bdi>${html(formatUsd(Number(usd) || 0))}</bdi>` +
    (local != null && order.local_currency ? ` · <bdi>${html(formatLocalAmount(Number(local), currency))}</bdi>` : '');
  const lines = (order.lines || []).map((line: any) => `<li><strong>${html(String(line.product_name))}</strong> <span>${html(String(line.unit_name))}</span>
<p>${html(t(lang, 'ordered_qty', { qty: String(line.ordered_qty) }))}${line.confirmed_qty != null ? ' · ' + html(t(lang, 'confirmed_qty', { qty: String(line.confirmed_qty) })) : ''}</p>
${line.shortfall_reason ? `<p>${html(t(lang, 'shortfall_' + line.shortfall_reason))}</p>` : ''}
<p>${money(line.unit_price_usd, line.unit_price_local)} × <bdi>${html(String(accepted ? line.confirmed_qty : line.ordered_qty))}</bdi>&nbsp;— ${money(accepted ? Math.round(Number(line.unit_price_usd) * Number(line.confirmed_qty) * 100) / 100 : line.line_total_usd, accepted ? (line.unit_price_local == null ? null : Math.round(Number(line.unit_price_local) * Number(line.confirmed_qty))) : line.line_total_local)}</p></li>`).join('');
  const statusKey = String(flags.key || '');
  const body = `<section class="sf-order-status" data-state="${attr(state)}">
<h1>${html(t(lang, 'order_number', { number: String(order.number) }))}</h1>
<span class="sf-state">${html(t(lang, 'badge_' + state))}</span><p>${html(t(lang, 'state_' + stateKey))}</p>
${order.reason && (state === 'rejected' || state === 'cancelled' && order.cancelled_by !== 'customer') ? `<p>${html(String(order.reason))}</p>` : ''}
${flags.cancelled ? `<p role="status">${html(t(lang, 'cancelled_notice'))}</p>` : ''}
${flags.not_cancellable ? `<p role="status">${html(t(lang, 'not_cancellable_notice'))}</p>` : ''}
<p>${html(String(order.first_name || '').trim().split(/\s+/)[0])}</p>
<ul class="sf-review-lines">${lines}</ul>
<p class="sf-cart-total">${html(t(lang, 'total'))}: ${money(accepted ? order.confirmed_total_usd : order.total_usd, accepted ? order.confirmed_total_local : order.total_local)}</p>
<p>${html(t(lang, order.fulfilment === 'delivery' ? 'delivery' : 'pickup'))}</p>
<p>${html(String(order.fulfilment === 'delivery' ? order.address || '' : order.store.pickup_note || ''))}</p>
${state === 'submitted' ? `<form method="post" action="${attr(ctx.link('/o/' + statusKey + '/cancel'))}"><label class="sf-check"><input type="checkbox" name="confirm" value="1" required> ${html(t(lang, 'cancel_confirm'))}</label><button class="sf-button" type="submit">${html(t(lang, 'cancel_order'))}</button></form>` : ['confirmed', 'ready'].includes(state) ? `<p>${html(t(lang, 'cannot_cancel_contact'))}</p>` : ''}
${contactButtons(lang, store, { whatsapp: t(lang, 'wa_store', { store: store.name, url: ctx.canonicalHome }), subject: String(order.number) })}
<p><a href="${attr(ctx.link('/'))}">${html(t(lang, 'back_to_store'))}</a></p><section id="sf-myorders"></section></section>`;
  const json = JSON.stringify({ address: ctx.address, base: ctx.base, status: { number: order.number, key: statusKey, at: order.submitted_at, state }, ui: Object.fromEntries(ORDER_UI_KEYS.map(k => [k, t(lang, k)])) }).replace(/</g, '\\u003c');
  return layout({ lang, meta: { title: t(lang, 'order_number', { number: String(order.number) }) }, body, store, homeHref: ctx.link('/'), assetVersion: ctx.assetVersion, websiteUrl: ctx.websiteUrl, noindex: true, refresh: ['submitted', 'confirmed', 'ready'].includes(state), statusJson: json });
}
