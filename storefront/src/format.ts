// Money and stock display (display only — spec 002 research R10). USD with 2 decimals; the local price is the
// product's own local price when set, otherwise USD × the store's local rate rounded to a whole local amount.
import type { PublicStore, StockState } from './data.js';
import type { Lang } from './router.js';
import { t } from './i18n.js';

const usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const wholeFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatUsd(amount: number): string {
  return `$${usdFmt.format(Number(amount) || 0)}`;
}

/** Local-currency price text, or null when the store doesn't show local prices / has no local currency. */
export function formatLocal(store: PublicStore, usd: number, ownLocal: number | null): string | null {
  if (!store.show_local_price || !store.local_currency_code) return null;
  let amount: number | null = ownLocal !== null && ownLocal > 0 ? ownLocal : null;
  if (amount === null) {
    if (!store.local_rate || store.local_rate <= 0) return null;
    amount = Math.round((Number(usd) || 0) * store.local_rate);
  }
  const symbol = store.local_currency_symbol || store.local_currency_code;
  return `${wholeFmt.format(amount)} ${symbol}`;
}

/** A local amount already computed elsewhere (an order's stored totals), formatted like formatLocal. */
export function formatLocalAmount(amount: number, currency: string): string {
  return `${wholeFmt.format(Math.round(Number(amount) || 0))} ${currency}`;
}

export function stockLabel(lang: Lang, state: StockState, exact: number | null): string {
  if (exact !== null && state !== 'out_of_stock') return t(lang, 'stock_exact', { count: wholeFmt.format(Math.max(0, exact)) });
  return t(lang, state);
}
