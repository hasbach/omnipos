// Dual-currency (USD + local) helpers for showing a stored order total.
//
// Transactions are stored in USD (`total_amount`). The local-currency value of an order uses, in order:
//   1. the sale-time rate stored on the transaction: if tx.local_rate > 0 -> usd * tx.local_rate
//      (symbol from the configured currency matching tx.local_currency, else the configured local one)
//   2. if the tx's OWN currency is the local currency and its exchange_rate > 1 -> usd * tx.exchange_rate
//   3. otherwise the current configured rate: usd * localCurrency.rate  ("current rate" fallback)
// The local currency is any configured currency whose code is not 'USD' (never hardcode 'LBP').

import { formatNumber, type CurrencyLike } from './format';

type TxLike = { currency?: string | null; exchange_rate?: number | null; local_rate?: number | null; local_currency?: string | null };

export function localCurrencyOf<T extends CurrencyLike>(currencies: T[] | null | undefined): T | null {
  // Same pick as the server's localCurrencyFor(): the default non-USD currency first, else the first non-USD one.
  const list = (currencies || []).filter(c => String(c.code).toUpperCase() !== 'USD');
  return list.find(c => (c as any).is_default) || list[0] || null;
}

export interface OrderLocal {
  amount: number;
  rate: number;
  currency: CurrencyLike;
  /** true = rate recorded with the sale; false = the current configured rate fallback. */
  stored: boolean;
}

export function orderLocal(
  usd: number,
  tx: TxLike | null | undefined,
  currencies: CurrencyLike[] | null | undefined,
): OrderLocal | null {
  const configured = localCurrencyOf(currencies);
  const u = Number.isFinite(usd) ? usd : 0;
  const storedRate = Number(tx?.local_rate);
  if (storedRate > 0) {
    const cur = (tx?.local_currency && (currencies || []).find(c => c.code === tx.local_currency))
      || configured
      || (tx?.local_currency ? { code: tx.local_currency, symbol: tx.local_currency } : null);
    if (!cur) return null;
    return { amount: Math.round(u * storedRate), rate: storedRate, currency: cur, stored: true };
  }
  if (!configured) return null;
  const txRate = Number(tx?.exchange_rate) || 1;
  if (tx?.currency === configured.code && txRate > 1) {
    return { amount: Math.round(u * txRate), rate: txRate, currency: configured, stored: true };
  }
  const rate = configured.rate || 1;
  return { amount: Math.round(u * rate), rate, currency: configured, stored: false };
}

/** Whole local-currency amount only (null when no local currency is configured). */
export function usdToLocal(usd: number, tx: TxLike | null | undefined, currencies: CurrencyLike[] | null | undefined): number | null {
  return orderLocal(usd, tx, currencies)?.amount ?? null;
}

/** "1,118,750 LL" — whole units followed by the currency symbol. */
export function formatLocal(amount: number, local: CurrencyLike): string {
  return `${formatNumber(amount, { decimals: 0 })} ${local.symbol || local.code}`;
}

/** "89,500" for the "@ rate" annotation. */
export function formatRate(rate: number): string {
  return formatNumber(rate, { decimals: Number.isInteger(rate) ? 0 : 2 });
}

/**
 * The local currency with the party's own rate (stakeholder.local_rate) overriding the global one.
 * Returns null for USD-only tenants. `source` says which rate is in effect.
 */
export function effectiveLocalCurrency<T extends CurrencyLike>(
  currencies: T[] | null | undefined,
  party?: { local_rate?: number | null } | null,
): (T & { rate: number; source: 'party' | 'global' }) | null {
  const base = localCurrencyOf(currencies);
  if (!base) return null;
  const pr = Number(party?.local_rate);
  if (pr > 0) return { ...base, rate: pr, source: 'party' };
  return { ...base, rate: base.rate || 1, source: 'global' };
}
