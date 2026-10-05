import { formatMoney } from '../../lib/format';

interface CurrencyInfo { code: string; symbol: string; rate?: number }

/**
 * For a statement payment row paid in a non-USD currency, the original amount in its own currency
 * (e.g. "895,000 LL"); null for USD / rows without an original amount. `credit` is always USD.
 */
export function originalAmountLabel(
  row: { currency?: string | null; amount_original?: number | null },
  currencies: CurrencyInfo[],
): string | null {
  const code = row.currency;
  if (!code || code === 'USD' || row.amount_original == null) return null;
  const cur = currencies.find((c) => c.code === code);
  return formatMoney(row.amount_original, { code, symbol: cur?.symbol || code, rate: cur?.rate });
}
