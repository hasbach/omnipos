// Ordering on the storefront (spec 003, Slice 1 — WhatsApp order). Everything here is store- or listing-level
// data, identical for every visitor of a URL, so pages stay cacheable (research R1). The cart itself lives in
// the visitor's browser (public/cart.js).
import type { PublicListing, PublicStore } from './data.js';
import { whatsappDigits } from './phone.js';
import { LANGS, type Lang } from './router.js';
import { t } from './i18n.js';

/** Ordering is offered: WhatsApp mode, a usable WhatsApp number and at least one way to receive the goods. */
export function orderingEnabled(store: PublicStore, key: string | undefined = process.env.ORDER_GATEWAY_KEY): boolean {
  return onlineOrdering(store, key) || store.ordering_mode === 'whatsapp' && !!whatsappDigits(store.contact_whatsapp) && (store.pickup_enabled || store.delivery_enabled);
}

export interface OrderUnit { key: string; name: string; factor: number; price: number; price_lbp: number | null }

/** Units a listing can be ordered in: the base unit first (when orderable), then the orderable units. */
export function orderableUnits(l: PublicListing): OrderUnit[] {
  const out: OrderUnit[] = [];
  if (l.base_orderable) out.push({ key: 'base', name: l.unit, factor: 1, price: l.price, price_lbp: l.price_lbp });
  for (const u of l.units) out.push({ key: u.unit_id, name: u.name, factor: u.factor, price: u.price, price_lbp: u.price_lbp });
  return out;
}

export function canOrder(l: PublicListing): boolean {
  return l.stock_state !== 'out_of_stock' && orderableUnits(l).length > 0;
}

// Base units sold by measure: quantities may have up to 3 decimals (research R10).
const MEASURED = new Set([
  'kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'g', 'gr', 'gram', 'grams', 'gramme',
  'l', 'lt', 'ltr', 'liter', 'liters', 'litre', 'litres', 'ml', 'm', 'meter', 'metre', 'mètre', 'cm',
  'كغ', 'كلغ', 'كيلو', 'كيلوغرام', 'غ', 'غرام', 'ل', 'لتر', 'مل', 'م', 'متر', 'سم',
]);
export function isMeasuredUnit(name: string | null | undefined): boolean {
  return !!name && MEASURED.has(name.trim().toLowerCase().replace(/\.$/, ''));
}

/** Strings cart.js shows (page language). */
export const UI_KEYS = [
  'added_to_cart', 'cart_limit_lines', 'cart_limit_qty', 'invalid_quantity', 'minimum_qty', 'unavailable_line',
  'remove', 'increase', 'decrease', 'total', 'quantity', 'each',
  // checkout (cart page)
  'amount_to_minimum', 'minimum_blocks', 'order_too_long', 'field_required', 'invalid_phone',
] as const;
/** Online checkout and device-history strings (page language). */
export const ORDER_UI_KEYS = [
  'review_order', 'place_order', 'phone_required', 'quote_changed', 'price_was', 'line_unavailable',
  'order_placed', 'order_number', 'status_link', 'copy_link', 'my_orders', 'forget_order', 'too_many_orders',
  'order_failed', 'cloud_unreachable', 'send_whatsapp_instead', 'pay_on_handover_note', 'back_to_store',
  'listing_unavailable', 'unit_not_orderable', 'out_of_stock',
  'badge_submitted', 'badge_confirmed', 'badge_ready', 'badge_completed', 'badge_rejected', 'badge_cancelled', 'badge_expired',
] as const;

/** Strings of the WhatsApp message (store language — the shop reads it). */
export const MSG_KEYS = [
  'msg_new_order', 'msg_total', 'msg_pickup', 'msg_delivery', 'msg_name', 'msg_phone', 'msg_note', 'msg_prices_confirmed',
] as const;

export interface OrderPayload {
  address: string;
  home: string;
  cart: string;
  product: string;
  placeholder: string;
  storeName: string;
  wa?: string;
  mode?: 'online';
  api?: { quote: string; submit: string };
  local: { show: boolean; code: string | null; symbol: string | null; rate: number | null };
  pickup: { on: boolean; note: string };
  delivery: { on: boolean; note: string };
  minOrderUsd: number | null;
  ui: Record<string, string>;
  msg: Record<string, string>;
}

export interface PayloadInput {
  store: PublicStore;
  lang: Lang;
  address: string;
  canonicalHome: string;
  /** Link builder of the page (keeps ?lang= and an active preview token). */
  link: (path: string) => string;
  assetVersion: string;
  gatewayKey?: string;
}

export function orderPayload(i: PayloadInput): OrderPayload {
  const { store, lang } = i;
  const storeLang: Lang = LANGS.includes(store.default_language as Lang) ? (store.default_language as Lang) : 'en';
  const online = onlineOrdering(store, i.gatewayKey);
  return {
    ...(online ? { mode: 'online' as const, api: { quote: i.link('/order/quote'), submit: i.link('/order') } } : {}),
    address: i.address,
    home: i.canonicalHome,
    cart: i.link('/cart'),
    // Product link template: cart.js replaces __ID__ with the listing id.
    product: i.link('/p/__ID__'),
    placeholder: `/placeholder.svg?v=${i.assetVersion}`,
    storeName: store.name,
    ...(online && !whatsappDigits(store.contact_whatsapp) ? {} : { wa: whatsappDigits(store.contact_whatsapp) || '' }),
    local: {
      show: store.show_local_price && !!store.local_currency_code,
      code: store.local_currency_code, symbol: store.local_currency_symbol, rate: store.local_rate,
    },
    pickup: { on: store.pickup_enabled, note: store.pickup_note },
    delivery: { on: store.delivery_enabled, note: store.delivery_note },
    minOrderUsd: store.min_order_usd,
    ui: Object.fromEntries([...UI_KEYS, ...(online ? ORDER_UI_KEYS : [])].map((k) => [k, t(lang, k)])),
    msg: Object.fromEntries(MSG_KEYS.map((k) => [k, t(storeLang, k)])),
  };
}

/** The payload as an inline JSON block; `<` escaped so store text can never close the script element. */
export function orderJsonScript(p: OrderPayload): string {
  return `<script type="application/json" id="sf-order">${JSON.stringify(p).replace(/</g, '\\u003c')}</script>`;
}

export function onlineOrdering(store: PublicStore, key: string | undefined = process.env.ORDER_GATEWAY_KEY): boolean {
  return store.ordering_mode === 'online' && (store.pickup_enabled || store.delivery_enabled) && !!key;
}
